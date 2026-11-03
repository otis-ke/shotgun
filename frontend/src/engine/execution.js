// Execution engine (port of backend/execution): approved signal -> proposal -> buy -> track -> settle.
// Duplicate-purchase protection: an order row is written BEFORE buy is sent, buy is never retried,
// and a buy whose connection drops becomes UNKNOWN and blocks new orders until reconciled
// against Deriv's own records (portfolio + profit table). Reconciliation never re-sends anything.
import { ConnectionLost, DerivError, NotConnected, Timeout } from './deriv.js'

const FAMILIES = {
  rise_fall: { UP: 'CALL', DOWN: 'PUT' }, higher_lower: { UP: 'CALL', DOWN: 'PUT', barrier: true },
  touch: { UP: 'ONETOUCH', DOWN: 'ONETOUCH', barrier: true }, no_touch: { UP: 'NOTOUCH', DOWN: 'NOTOUCH', barrier: true },
  digits_over_under: { UP: 'DIGITOVER', DOWN: 'DIGITUNDER', digit: true }, digits_even_odd: { UP: 'DIGITEVEN', DOWN: 'DIGITODD' },
  multiplier: { UP: 'MULTUP', DOWN: 'MULTDOWN' },
}

export function buildProposal(spec, direction, symbol, stake, currency, atr) {
  const s = { family: 'rise_fall', duration: 5, duration_unit: 'm', barrier_atr_mult: 0, ...spec }
  const fam = FAMILIES[s.family]
  if (!fam) throw new Error(`unknown contract family ${s.family}`)
  const p = { amount: Math.round(stake * 100) / 100, basis: 'stake', currency, symbol, contract_type: fam[direction] }
  if (s.family === 'multiplier') {
    if (!s.multiplier) throw new Error('multiplier contracts need a multiplier value')
    p.multiplier = s.multiplier
    const lo = {}
    if (s.sl_pct_of_stake) lo.stop_loss = Math.round(stake * s.sl_pct_of_stake) / 100
    if (s.tp_pct_of_stake) lo.take_profit = Math.round(stake * s.tp_pct_of_stake) / 100
    if (Object.keys(lo).length) p.limit_order = lo
    return p
  }
  if (s.duration <= 0) throw new Error('duration must be positive')
  if (s.family.startsWith('digits') && s.duration_unit !== 't') throw new Error('digit contracts use tick durations')
  p.duration = s.duration; p.duration_unit = s.duration_unit
  if (fam.barrier) {
    if (!(s.barrier_atr_mult > 0)) throw new Error(`${s.family} needs barrier_atr_mult > 0`)
    if (!atr) throw new Error('ATR required to place barrier')
    const off = Math.round(s.barrier_atr_mult * atr * 100) / 100
    let sign = direction === 'UP' ? '+' : '-'
    if (s.family === 'higher_lower') sign = direction === 'UP' ? '-' : '+'
    p.barrier = `${sign}${off}`
  }
  if (s.family === 'digits_over_under') {
    if (s.digit == null || s.digit < 0 || s.digit > 9) throw new Error('digits_over_under needs digit 0-9')
    p.barrier = String(s.digit)
  }
  return p
}

const now = () => Date.now() / 1000
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') : `${Date.now()}${Math.random().toString(16).slice(2)}`)
const f = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null }
const UNRESOLVED = ['PENDING', 'SENT', 'UNKNOWN']
const UP_TYPES = ['CALL', 'MULTUP', 'DIGITOVER', 'DIGITEVEN', 'ONETOUCH']

export class ExecutionEngine {
  constructor(client, store, risk, memory, bus) {
    Object.assign(this, { client, store, risk, memory, bus })
    this.lock = Promise.resolve(); this.contractsCache = new Map(); this.watch = new Set()
  }

  tradingPermission() {
    if (this.store.kv('global_stop')) return [false, 'EMERGENCY STOP is active']
    const h = this.client.health
    if (!h.connected || !h.authorized) return [false, 'not connected/authorized to Deriv']
    if (h.is_virtual) return [true, 'demo account']
    const a = this.store.kv('real_trading_authorization') || {}
    if (a.authorized && a.loginid === h.loginid) return [true, 'real account - authorized']
    return [false, `REAL account ${h.loginid} not authorized for automated trading`]
  }

  unresolvedOrders() { return this.store.where('orders', (o) => UNRESOLVED.includes(o.status)) }

  async contractsFor(symbol) {
    const c = this.contractsCache.get(symbol)
    if (c && c[0] > now() - 3600) return c[1]
    const data = await this.client.contractsFor(symbol)
    this.contractsCache.set(symbol, [now(), data])
    return data
  }

  async checkAvailable(symbol, type, spec) {
    const avail = ((await this.contractsFor(symbol)).available || []).filter((c) => c.contract_type === type)
    if (!avail.length) return `${type} not offered on ${symbol}`
    if (spec.family === 'multiplier') return null
    const mult = { t: 1, s: 1, m: 60, h: 3600, d: 86400 }
    const secs = (x) => parseFloat(x) * mult[x.at(-1)]
    const dur = `${spec.duration}${spec.duration_unit}`
    for (const c of avail) {
      const mn = c.min_contract_duration, mx = c.max_contract_duration
      if (!mn || !mx || (mn.at(-1) === 't') !== (spec.duration_unit === 't')) continue
      if (secs(mn) <= secs(dur) && secs(dur) <= secs(mx)) return null
    }
    return `duration ${dur} not allowed for ${type} on ${symbol}`
  }

  /** One purchase at a time -> no race on risk limits. */
  execute(req) {
    const run = this.lock.then(() => this.executeInner(req))
    this.lock = run.catch(() => {})
    return run
  }

  async executeInner(req) {
    const res = (ok, status, message, extra = {}) => ({ ok, status, message, ...extra })
    const [ok, why] = this.tradingPermission()
    if (!ok) return res(false, 'BLOCKED', why)
    if (this.unresolvedOrders().length) return res(false, 'BLOCKED', 'an earlier order is unresolved - reconciling first')
    if (req.signal_id != null && this.store.where('orders', (o) => o.signal_id === req.signal_id).length) return res(false, 'DUPLICATE', 'signal already has an order')
    let bal = this.client.account.balance
    try { bal = (await this.client.balance()).balance; this.client.account.balance = bal } catch { /* use cached */ }
    const rd = this.risk.check({ balance: bal, symbol: req.symbol, loginid: this.client.health.loginid, botMaxStake: req.max_stake })
    if (!rd.approved) return res(false, 'RISK_REJECTED', rd.reasons.join('; '), { details: rd })
    const spec = { family: 'rise_fall', ...req.contract }
    let payload
    try { payload = buildProposal(spec, req.direction, req.symbol, rd.stake, this.client.health.currency || 'USD', req.atr) } catch (e) {
      return res(false, 'INVALID', e.message)
    }
    let prop
    try {
      const na = await this.checkAvailable(req.symbol, payload.contract_type, spec)
      if (na) return res(false, 'UNAVAILABLE', na)
      prop = await this.client.proposal(payload)
    } catch (e) { return res(false, 'PROPOSAL_FAILED', e.message) }
    const ask = +prop.ask_price, payout = +(prop.payout || 0)
    if (ask > rd.stake + 0.01) return res(false, 'RISK_REJECTED', `ask ${ask} exceeds approved stake ${rd.stake}`)
    if (spec.family !== 'multiplier') {
      const ratio = ask ? (payout - ask) / ask : 0
      if (ratio < (req.payout_assumption ?? 0.9) * 0.95) {
        return res(false, 'PAYOUT_TOO_LOW', `payout ratio ${ratio.toFixed(3)} below assumed ${(req.payout_assumption ?? 0.9).toFixed(3)}; edge estimate no longer valid`)
      }
    }
    const coid = uid()
    this.store.insert('orders', { coid, ts: now(), signal_id: req.signal_id ?? null, bot_id: req.bot_id, symbol: req.symbol,
      contract_type: payload.contract_type, request: { ...payload, proposal_id: prop.id }, stake: ask, payout, status: 'PENDING', updated_at: now() })
    this.risk.reserve(coid, req.symbol, ask, req.bot_id)
    this.setOrder(coid, 'SENT')
    this.store.audit('execution', `BUY sent ${req.bot_id} ${req.symbol} ${payload.contract_type} stake=${ask}`, { coid, payout, confidence: req.confidence })
    let buy
    try { buy = await this.client.buy(prop.id, ask, { coid }) } catch (e) {
      if (e instanceof DerivError) {   // definitive rejection - nothing was bought
        this.setOrder(coid, 'REJECTED', null, e.message); this.risk.release(coid)
        this.store.audit('execution', `BUY rejected by Deriv: ${e.message}`, { coid }, 'WARN')
        return res(false, 'REJECTED', e.message, { coid })
      }
      if (e instanceof ConnectionLost || e instanceof NotConnected || e instanceof Timeout) {
        this.setOrder(coid, 'UNKNOWN', null, `${e.constructor.name}: ${e.message}`)
        this.store.audit('execution', 'BUY outcome UNKNOWN - will reconcile, no retry', { coid }, 'WARN')
        this.reconcileSoon()
        return res(false, 'UNKNOWN', 'connection lost during purchase; reconciling', { coid })
      }
      throw e
    }
    const cid = String(buy.contract_id)
    this.recordTrade(coid, cid, req, payload, ask, f(buy.payout) ?? payout, f(buy.purchase_time) ?? now())
    return res(true, 'BOUGHT', `bought contract ${cid}`, { coid, contract_id: cid, details: { buy_price: ask, payout: buy.payout } })
  }

  setOrder(coid, status, contractId = null, error = null) {
    const ch = { status, updated_at: now() }
    if (contractId) ch.contract_id = contractId
    if (error) ch.error = error
    this.store.update('orders', (o) => o.coid === coid, ch)
    this.bus.publish('order', { coid, status, contract_id: contractId, error })
  }

  recordTrade(coid, cid, req, payload, stake, payout, buyTime) {
    if (!this.store.where('trades', (t) => t.contract_id === cid).length) {
      this.store.insert('trades', { contract_id: cid, coid, bot_id: req.bot_id, symbol: req.symbol, contract_type: payload.contract_type,
        direction: req.direction, stake, payout, buy_time: buyTime, sell_time: null, entry_spot: null, exit_spot: null, profit: null,
        status: 'open', is_virtual: !!this.client.health.is_virtual, confidence: req.confidence ?? null, regime: req.regime ?? null,
        features: req.features || {} })
    }
    this.setOrder(coid, 'BOUGHT', cid)
    this.risk.release(coid)
    this.store.audit('execution', `BOUGHT ${cid} (${req.bot_id} ${req.symbol} ${req.direction})`, { coid })
    this.bus.publish('trade_opened', { contract_id: cid, bot_id: req.bot_id, symbol: req.symbol, direction: req.direction, stake, payout })
    this.track(cid)
  }

  async track(cid) {
    if (this.watch.has(cid)) return
    this.watch.add(cid)
    try { await this.client.subscribe(`poc:${cid}`, { proposal_open_contract: 1, contract_id: +cid }, (m) => m.proposal_open_contract?.contract_id && this.applyPoc(m.proposal_open_contract)) } catch {
      this.watch.delete(cid)   // poll fallback settles it
    }
  }

  async applyPoc(poc) {
    const cid = String(poc.contract_id)
    const done = !!poc.is_sold || ['won', 'lost', 'sold'].includes(poc.status)
    if (!done) { this.bus.publish('contract_update', { contract_id: cid, profit: poc.profit, current_spot: poc.current_spot, status: 'open' }); return }
    const profit = +(poc.profit || 0)
    let status = poc.status || (profit > 0 ? 'won' : 'lost')
    if (status === 'sold') status = profit > 0 ? 'won' : 'lost'
    const row = this.store.where('trades', (t) => t.contract_id === cid)[0]
    if (!row || row.status !== 'open') return
    this.store.update('trades', (t) => t.contract_id === cid, { status, profit, sell_time: f(poc.sell_time) ?? now(),
      entry_spot: f(poc.entry_spot), exit_spot: f(poc.exit_tick ?? poc.sell_spot) })
    this.watch.delete(cid)
    this.client.unsubscribe(`poc:${cid}`)
    this.store.audit('execution', `SETTLED ${cid} ${status} profit=${profit}`, { bot_id: row.bot_id })
    this.bus.publish('trade_closed', { contract_id: cid, status, profit, bot_id: row.bot_id })
    this.memory.refresh()
    try { const b = await this.client.balance(); this.client.account.balance = b.balance; this.risk.recordBalance(b.balance, this.client.health.loginid) } catch { /* ignore */ }
  }

  async pollOpen() {
    for (const t of this.store.where('trades', (x) => x.status === 'open')) {
      try {
        const poc = await this.client.contractStatus(t.contract_id)
        await this.applyPoc(poc)
        if (!this.watch.has(t.contract_id) && !poc.is_sold) await this.track(t.contract_id)
      } catch (e) { if (!(e instanceof DerivError)) return }
    }
  }

  async sell(cid) {
    const r = await this.client.sell(cid)
    this.store.audit('execution', `manual SELL ${cid}`, { result: r })
    return r
  }

  reconcileSoon(ms = 3000) {
    setTimeout(async () => { if (await this.client.waitReady(60000)) this.reconcile() }, ms)
  }

  async reconcile() {
    const out = { resolved: [], adopted: [] }
    const pending = this.unresolvedOrders()
    let portfolio, history
    try { portfolio = await this.client.portfolio(); history = await this.client.profitTable(100, Math.floor(now() - 86400)) } catch { return out }
    const known = new Set(this.store.all('trades').map((t) => t.contract_id))
    const cands = [
      ...portfolio.map((p) => ({ contract_id: String(p.contract_id), symbol: p.symbol || p.underlying, contract_type: p.contract_type,
        buy_price: +(p.buy_price || 0), purchase_time: +(p.purchase_time || 0), payout: p.payout, open: true })),
      ...history.map((h) => ({ contract_id: String(h.contract_id), symbol: h.underlying_symbol, contract_type: h.contract_type,
        buy_price: +(h.buy_price || 0), purchase_time: +(h.purchase_time || 0), payout: h.payout, shortcode: h.shortcode || '', open: false })),
    ]
    for (const o of pending) {
      const match = cands.find((c) => !known.has(c.contract_id) &&
        (c.contract_type === o.contract_type || (c.shortcode || '').includes(o.contract_type)) &&
        (c.symbol === o.symbol || (c.shortcode || '').includes(o.symbol)) &&
        Math.abs(c.buy_price - (o.stake || 0)) < 0.011 && o.ts - 5 <= c.purchase_time && c.purchase_time <= o.ts + 90)
      if (match) {
        known.add(match.contract_id)
        const req = { bot_id: o.bot_id, symbol: o.symbol, direction: UP_TYPES.includes(o.contract_type) ? 'UP' : 'DOWN', signal_id: o.signal_id }
        this.recordTrade(o.coid, match.contract_id, req, { contract_type: o.contract_type }, match.buy_price, +(match.payout || 0), match.purchase_time)
        out.resolved.push({ coid: o.coid, contract_id: match.contract_id })
        this.store.audit('reconcile', `order ${o.coid} matched contract ${match.contract_id}`)
      } else if (now() - o.ts > 120) {
        this.setOrder(o.coid, 'FAILED', null, 'no matching contract on account - not purchased')
        this.risk.release(o.coid)
        out.resolved.push({ coid: o.coid, contract_id: null })
        this.store.audit('reconcile', `order ${o.coid} confirmed NOT purchased`)
      }
    }
    for (const c of cands) {   // contracts opened outside this app still count toward exposure
      if (c.open && !known.has(c.contract_id)) {
        this.store.insert('trades', { contract_id: c.contract_id, bot_id: 'external', symbol: c.symbol, contract_type: c.contract_type,
          stake: c.buy_price, payout: f(c.payout), buy_time: c.purchase_time, status: 'open', is_virtual: !!this.client.health.is_virtual, features: {} })
        known.add(c.contract_id); out.adopted.push(c.contract_id)
        this.store.audit('reconcile', `adopted external open contract ${c.contract_id}`)
      }
    }
    for (const t of this.store.where('trades', (x) => x.status === 'open')) await this.track(t.contract_id)
    await this.pollOpen()
    if (out.resolved.length || out.adopted.length) this.bus.publish('reconciled', out)
    return out
  }
}
