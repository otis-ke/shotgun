// Market feed, versioned bot configs (optimizer) and the bot manager (ports of backend/deriv/feed,
// backend/ai_engine/optimizer and backend/bots/manager). Bots share one feed and one analysis per
// closed candle but never touch each other's settings or positions.
import { binomialZ, decide, expectedValue } from './ai.js'
import { analyze } from './analysis.js'
import { computeAll } from './indicators.js'
import { frameFromCandles } from './series.js'
import { STRATEGIES } from './strategies.js'

const now = () => Date.now() / 1000
const clone = (x) => JSON.parse(JSON.stringify(x))
const CLOSED = ['won', 'lost', 'sold']

// ---------------- market feed ----------------
export class MarketFeed {
  constructor(client) { this.client = client; this.buffers = new Map(); this.refs = new Map(); this.lastPrice = {}; this.closedCbs = []; this.tickCbs = [] }
  onCandleClosed(cb) { this.closedCbs.push(cb) }
  onTick(cb) { this.tickCbs.push(cb) }
  key(s, g) { return `${s}:${g}` }

  async ensure(symbol, gran) {
    const k = this.key(symbol, gran)
    this.refs.set(k, (this.refs.get(k) || 0) + 1)
    if (this.buffers.has(k)) return
    this.buffers.set(k, new Map())
    try {
      await this.client.subscribe(`candles:${k}`, { ticks_history: symbol, style: 'candles', granularity: gran, count: 1000, end: 'latest', adjust_start_time: 1 },
        (m) => this.onMsg(symbol, gran, m))
    } catch (e) { this.buffers.delete(k); this.refs.delete(k); throw e }
  }

  async release(symbol, gran) {
    const k = this.key(symbol, gran), n = Math.max(0, (this.refs.get(k) || 0) - 1)
    this.refs.set(k, n)
    if (n === 0 && this.buffers.has(k)) { this.buffers.delete(k); await this.client.unsubscribe(`candles:${k}`) }
  }

  async onMsg(symbol, gran, msg) {
    const buf = this.buffers.get(this.key(symbol, gran))
    if (!buf) return
    if (msg.candles) { for (const c of msg.candles) buf.set(+c.epoch, c); this.trim(buf); return }   // snapshot (also fills gaps after reconnect)
    const o = msg.ohlc
    if (!o) return
    const epoch = +o.open_time, price = +o.close
    this.lastPrice[symbol] = { symbol, price, epoch: +o.epoch }
    const tick = { ...this.lastPrice[symbol], granularity: gran, time: epoch, open: +o.open, high: +o.high, low: +o.low, close: price }
    for (const cb of this.tickCbs) cb(symbol, tick)
    const isNew = !buf.has(epoch)
    buf.set(epoch, { epoch, open: o.open, high: o.high, low: o.low, close: o.close })
    this.trim(buf)
    if (isNew) { const df = this.frame(symbol, gran, true); for (const cb of this.closedCbs) await cb(symbol, gran, df) }
  }

  trim(buf, max = 1500) { if (buf.size > max) [...buf.keys()].sort((a, b) => a - b).slice(0, buf.size - max).forEach((k) => buf.delete(k)) }

  /** Last candle is still forming -> never used for signals (no look-ahead). */
  frame(symbol, gran, closedOnly = true) {
    const buf = this.buffers.get(this.key(symbol, gran))
    if (!buf) return null
    let keys = [...buf.keys()].sort((a, b) => a - b)
    if (closedOnly) keys = keys.slice(0, -1)
    return frameFromCandles(keys.map((k) => buf.get(k)))
  }
}

// ---------------- versioned bot configurations ----------------
export const DEFAULT_BOTS = {
  trend: { name: 'Trend Following Bot', strategy: 'trend', symbols: ['R_100'], granularity: 300, contract: { family: 'rise_fall', duration: 3, duration_unit: 'm' } },
  price_action: { name: 'Price Action Bot', strategy: 'price_action', symbols: ['R_75'], granularity: 300, contract: { family: 'rise_fall', duration: 15, duration_unit: 'm' } },
  scalping: { name: 'Scalping Bot', strategy: 'scalping', symbols: ['1HZ100V'], granularity: 60, contract: { family: 'rise_fall', duration: 3, duration_unit: 'm' } },
  reversal: { name: 'Reversal Bot', strategy: 'reversal', symbols: ['R_50'], granularity: 300, contract: { family: 'rise_fall', duration: 15, duration_unit: 'm' } },
  breakout: { name: 'Breakout Bot', strategy: 'breakout', symbols: ['R_25'], granularity: 300, contract: { family: 'rise_fall', duration: 15, duration_unit: 'm' } },
  volatility: { name: 'Volatility Bot', strategy: 'volatility', symbols: ['1HZ75V'], granularity: 300, contract: { family: 'rise_fall', duration: 10, duration_unit: 'm' } },
  smart_ai: { name: 'Smart AI Bot', strategy: 'smart_ai', symbols: ['R_100'], granularity: 300, contract: { family: 'rise_fall', duration: 15, duration_unit: 'm' }, min_agree: 2, min_ev: 0.02 },
}
const COMMON = { enabled: false, params: {}, min_confidence: 70, auto_execute: false, max_stake: null, payout_assumption: 0.9, cooldown_bars: 1, allow_uncalibrated_demo: true }
const OPERATIONAL = ['enabled', 'symbols', 'min_confidence', 'auto_execute', 'max_stake', 'payout_assumption', 'cooldown_bars', 'name', 'allow_uncalibrated_demo', 'min_agree', 'min_ev']

export const durationBars = (c, gran) => {
  const unit = { s: 1, m: 60, h: 3600, d: 86400, t: 2 }[c.duration_unit || 'm']
  return Math.max(1, Math.round(((c.duration ?? 5) * unit) / gran))
}

export class Configs {
  constructor(store) { this.store = store }
  rows(bot) { return this.store.where('bot_configs', (r) => r.bot_id === bot) }
  seedDefaults() {
    for (const [bot, cfg] of Object.entries(DEFAULT_BOTS)) {
      if (this.rows(bot).length) continue
      const full = { ...clone(COMMON), ...clone(cfg) }
      if (STRATEGIES[cfg.strategy]) full.params = STRATEGIES[cfg.strategy].params()
      this.store.insert('bot_configs', { bot_id: bot, version: 1, params: full, status: 'active', note: 'factory defaults', validation: null, created_at: now() })
    }
  }
  active(bot) {
    const r = this.rows(bot).filter((x) => x.status === 'active').sort((a, b) => b.version - a.version)[0]
    if (!r) throw Object.assign(new Error(`unknown bot ${bot}`), { status: 404 })
    return { ...clone(r.params), _version: r.version, _validation: r.validation, _created_at: r.created_at }
  }
  versions(bot) { return clone(this.rows(bot)).sort((a, b) => b.version - a.version) }
  nextVersion(bot) { return Math.max(0, ...this.rows(bot).map((r) => r.version)) + 1 }
  archiveActive(bot) { this.store.update('bot_configs', (r) => r.bot_id === bot && r.status === 'active', { status: 'archived' }) }
  strip(cfg) { return Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith('_'))) }

  /** Operational settings don't change trading logic -> versioned and applied immediately. */
  updateOperational(bot, changes) {
    const bad = Object.keys(changes).filter((k) => !OPERATIONAL.includes(k))
    if (bad.length) throw Object.assign(new Error(`not an operational setting: ${bad.join(', ')} (strategy changes need validation)`), { status: 400 })
    const cur = this.active(bot), ver = this.nextVersion(bot)
    this.archiveActive(bot)
    this.store.insert('bot_configs', { bot_id: bot, version: ver, params: { ...this.strip(cur), ...changes }, status: 'active',
      note: `operational change: ${Object.keys(changes).sort().join(', ')}`, validation: cur._validation, created_at: now() })
    this.store.audit('config', `${bot} operational settings changed`, { changes, version: ver })
    return this.active(bot)
  }

  /** Candidate config for validation (active config + overrides). */
  candidate(bot, overrides = {}) {
    const cand = this.strip(this.active(bot))
    for (const [k, v] of Object.entries(overrides || {})) cand[k] = (k === 'params' || k === 'contract') && v && typeof v === 'object' ? { ...cand[k], ...v } : v
    if (cand.strategy === 'smart_ai') throw Object.assign(new Error('Smart AI is validated through its specialists - validate those bots'), { status: 400 })
    return cand
  }

  /** Store a walk-forward result as a proposed (passed) or rejected version - never auto-deployed. */
  saveValidation(bot, cand, wf, dataInfo) {
    const pairs = this.store.kv('validation_pairs', {}) || {}
    pairs[cand.strategy] = wf.calibration_pairs.slice(-3000)
    this.store.setKv('validation_pairs', pairs)
    this.store.setKv(`validation_regimes:${cand.strategy}`, wf.regime_counts)
    cand.params = wf.recommended_params
    const validation = Object.fromEntries(Object.entries(wf).filter(([k]) => !['calibration_pairs', 'oos_index', 'regime_counts'].includes(k)))
    validation.data = dataInfo
    const ver = this.nextVersion(bot), status = wf.passed_validation ? 'proposed' : 'rejected'
    this.store.insert('bot_configs', { bot_id: bot, version: ver, params: cand, validation, created_at: now(), status, note: `walk-forward ${wf.passed_validation ? 'PASSED' : 'FAILED'}` })
    this.store.audit('optimizer', `${bot} v${ver} walk-forward ${wf.passed_validation ? 'passed' : 'failed'}`, { oos: wf.oos_stats })
    return { version: ver, status, ...validation }
  }

  deploy(bot, version) {
    const row = this.rows(bot).find((r) => r.version === version)
    if (!row) throw Object.assign(new Error(`${bot} v${version} not found`), { status: 400 })
    if (row.status === 'rejected') throw Object.assign(new Error('this version failed validation and cannot be deployed'), { status: 400 })
    if (row.status === 'proposed' && !row.validation?.passed_validation) throw Object.assign(new Error('version has no passing validation'), { status: 400 })
    const restored = row.status === 'archived'
    this.archiveActive(bot)
    this.store.update('bot_configs', (r) => r.id === row.id, { status: 'active' })
    this.store.audit('config', `${bot} ${restored ? 'restored' : 'deployed'} v${version}`)
    return this.active(bot)
  }

  /** Is the live record significantly worse than the validated OOS expectation? */
  degradation(bot, minTrades = 30) {
    const cfg = this.active(bot), expected = cfg._validation?.oos_stats?.win_rate
    const t = this.store.where('trades', (x) => x.bot_id === bot && x.buy_time >= cfg._created_at && CLOSED.includes(x.status))
    const n = t.length, w = t.filter((x) => x.status === 'won').length
    const be = 1 / (1 + (cfg.payout_assumption ?? 0.9)), ref = expected ?? be
    const z = n ? binomialZ(w, n, ref) : null
    return { bot_id: bot, trades: n, win_rate: n ? +(w / n).toFixed(4) : null, expected: ref, breakeven: +be.toFixed(4),
      z: z != null ? +z.toFixed(2) : null, degraded: n >= minTrades && z != null && z < -2 }
  }
}

export function botStats(store, bot = null) {
  const t = store.where('trades', (x) => CLOSED.includes(x.status) && (!bot || x.bot_id === bot)).sort((a, b) => a.sell_time - b.sell_time)
  const n = t.length, pnl = t.map((x) => x.profit || 0), wins = pnl.filter((p) => p > 0).length
  const gp = pnl.filter((p) => p > 0).reduce((a, b) => a + b, 0), gl = -pnl.filter((p) => p <= 0).reduce((a, b) => a + b, 0)
  let eq = 0, peak = 0, dd = 0
  for (const p of pnl) { eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq) }
  const sum = pnl.reduce((a, b) => a + b, 0)
  return { trades: n, wins, losses: n - wins, win_rate: n ? +(wins / n).toFixed(4) : null, net_profit: +sum.toFixed(2),
    profit_factor: gl ? +(gp / gl).toFixed(3) : null, max_drawdown: +dd.toFixed(2),
    open: store.where('trades', (x) => x.status === 'open' && (!bot || x.bot_id === bot)).length, expectancy: n ? +(sum / n).toFixed(4) : null }
}

// ---------------- bot manager ----------------
export const MODES = ['demo', 'manual', 'semi', 'full']

export class BotManager {
  constructor({ client, feed, exe, store, configs, memory, bus }) {
    Object.assign(this, { client, feed, exe, store, configs, memory, bus })
    this.rt = Object.fromEntries(Object.keys(DEFAULT_BOTS).map((b) => [b, { running: false, last_signal: null, last_eval: null, errors: 0, subs: new Set() }]))
    this.snapshots = {}; this.analysisCache = new Map(); this.seen = new Set()
    feed.onCandleClosed((s, g, df) => this.onCandleClosed(s, g, df))
  }

  mode() { return this.store.kv('mode', 'demo') }
  setMode(mode) {
    if (!MODES.includes(mode)) throw Object.assign(new Error(`mode must be one of ${MODES.join(', ')}`), { status: 400 })
    const h = this.client.health
    if (mode !== 'demo' && h.authorized && !h.is_virtual) {
      const a = this.store.kv('real_trading_authorization') || {}
      if (!(a.authorized && a.loginid === h.loginid)) throw Object.assign(new Error('connected to a REAL account - authorize real trading first'), { status: 400 })
    }
    this.store.setKv('mode', mode)
    this.store.audit('mode', `operating mode set to ${mode}`)
    this.bus.publish('mode', { mode })
    return mode
  }

  async startBot(bot) {
    const cfg = this.configs.active(bot), rt = this.rt[bot]
    if (rt.running) return
    if (this.store.kv('global_stop')) throw Object.assign(new Error('emergency stop active - clear it first'), { status: 409 })
    for (const s of cfg.symbols) { await this.feed.ensure(s, cfg.granularity); rt.subs.add(`${s}:${cfg.granularity}`) }
    rt.running = true
    if (!cfg.enabled) this.configs.updateOperational(bot, { enabled: true })
    this.store.audit('bots', `${bot} started`, { symbols: cfg.symbols, granularity: cfg.granularity })
    this.bus.publish('bot', this.status(bot))
  }

  async stopBot(bot, persist = true) {
    const rt = this.rt[bot]
    for (const k of rt.subs) { const i = k.lastIndexOf(':'); await this.feed.release(k.slice(0, i), +k.slice(i + 1)) }
    rt.subs.clear(); rt.running = false
    if (persist && this.configs.active(bot).enabled) this.configs.updateOperational(bot, { enabled: false })
    this.store.audit('bots', `${bot} stopped`)
    this.bus.publish('bot', this.status(bot))
  }

  async restartBot(bot) { if (this.rt[bot].running) { await this.stopBot(bot, false); await this.startBot(bot) } }

  async restoreEnabled() {
    if (this.store.kv('global_stop')) return
    for (const b of Object.keys(this.rt)) { try { if (this.configs.active(b).enabled) await this.startBot(b) } catch (e) { console.warn(b, e) } }
  }

  async emergencyStop(reason = 'user') {
    this.store.setKv('global_stop', { reason, since: now() })
    for (const [b, rt] of Object.entries(this.rt)) if (rt.running) await this.stopBot(b, false)
    this.store.update('signals', (s) => s.status === 'pending', { status: 'expired', decision: 'emergency stop' })
    this.store.audit('bots', `EMERGENCY STOP: ${reason}`, {}, 'WARN')
    this.bus.publish('emergency_stop', { active: true, reason })
    return { stopped: true }
  }

  clearEmergencyStop() {
    this.store.setKv('global_stop', null)
    this.store.audit('bots', 'emergency stop cleared')
    this.bus.publish('emergency_stop', { active: false })
  }

  analysis(symbol, gran, df) {
    const key = `${symbol}:${gran}:${df.t.at(-1)}`
    if (this.analysisCache.has(key)) return this.analysisCache.get(key)
    const f = computeAll(df), snap = analyze(symbol, gran, df, f)
    for (const k of this.analysisCache.keys()) if (k.startsWith(`${symbol}:${gran}:`)) this.analysisCache.delete(k)
    this.analysisCache.set(key, [f, snap])
    this.snapshots[`${symbol}:${gran}`] = snap
    this.bus.publish('analysis', snap)
    return [f, snap]
  }

  async onCandleClosed(symbol, gran, df) {
    if (df.close.length < 60) return
    const [f, snap] = this.analysis(symbol, gran, df), epoch = df.t.at(-1)
    for (const [bot, rt] of Object.entries(this.rt)) {
      if (!rt.running || !rt.subs.has(`${symbol}:${gran}`)) continue
      const k = `${bot}:${symbol}:${epoch}`
      if (this.seen.has(k)) continue   // each bot evaluates each candle once (reconnect-safe)
      this.seen.add(k)
      try { await this.evaluate(bot, symbol, gran, df, f, snap); rt.last_eval = now() } catch (e) { rt.errors++; console.error(`bot ${bot}`, e) }
    }
    if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000))
  }

  async evaluate(bot, symbol, gran, df, f, snap) {
    const cfg = this.configs.active(bot), payout = cfg.payout_assumption ?? 0.9, be = 1 / (1 + payout)
    const demo = !!this.client.health.is_virtual, regime = snap.regime.name
    const allowUncal = demo && (cfg.allow_uncalibrated_demo ?? true)
    let direction, score, strat, raw, p, ev, reasons
    if (cfg.strategy === 'smart_ai') {
      const sigs = {}
      for (const sid of Object.keys(STRATEGIES)) {
        let params = null
        try { params = this.configs.active(sid).params } catch { /* defaults */ }
        sigs[sid] = STRATEGIES[sid].latest(df, f, params)
      }
      const d = decide(sigs, regime, snap.htf_trend, this.memory, payout, cfg.min_agree ?? 2, cfg.min_ev ?? 0.02, allowUncal)
      if (!d.trade) {
        this.rt[bot].last_signal = { ts: now(), symbol, action: 'no_trade', reasons: d.reasons }
        this.bus.publish('ai_decision', { bot_id: bot, symbol, trade: false, reasons: d.reasons, votes: d.votes })
        return
      }
      ;({ direction, confidence: score, strategy: strat, p_win: p, ev, reasons } = d)
      raw = sigs[strat].score
    } else {
      const s = STRATEGIES[cfg.strategy].latest(df, f, cfg.params)
      if (!s) return
      ;({ direction, score, strategy: strat } = s)
      raw = s.score
      const cal = this.memory.calibrator(strat)
      p = cal.ready ? cal.pWin(raw) : null
      ev = expectedValue(p, payout)
      reasons = [...s.reasons, `regime ${regime}`]
      if (p !== null) reasons.push(`calibrated p_win ${(p * 100).toFixed(1)}% vs breakeven ${(be * 100).toFixed(1)}% (n=${cal.n})`)
    }
    let status = 'pending', decision = ''
    const minConf = cfg.min_confidence ?? 70
    if (score < minConf) { status = 'rejected'; decision = `confidence ${score.toFixed(0)} < ${minConf}` }
    else if (p === null && !allowUncal) { status = 'rejected'; decision = 'strategy not yet validated out-of-sample (run walk-forward)' }
    else if (p !== null && (ev || 0) <= 0) { status = 'rejected'; decision = `calibrated EV ${ev >= 0 ? '+' : ''}${(ev ?? 0).toFixed(3)} <= 0` }
    const conflict = this.conflict(symbol, direction)
    if (status === 'pending' && conflict) { status = 'rejected'; decision = conflict }
    const row = this.store.insert('signals', { ts: now(), bot_id: bot, symbol, direction, contract_type: cfg.contract.family,
      confidence: Math.round(score * 10) / 10, calibrated_p: p, regime, reasons, features: { strategy: strat, raw_score: raw, ev, epoch: df.t.at(-1) },
      status, decision })
    const sig = { id: row.id, bot_id: bot, symbol, direction, confidence: row.confidence, p_win: p, ev, status, decision, reasons, regime }
    this.rt[bot].last_signal = sig
    this.bus.publish('signal', sig)
    if (status !== 'pending') return
    const mode = this.mode()
    if (mode === 'demo' && !demo) { this.setSignal(row.id, 'rejected', 'demo mode but connected account is REAL'); return }
    const auto = mode === 'demo' || mode === 'full' || (mode === 'semi' && cfg.auto_execute)
    if (!auto) { this.bus.publish('approval_needed', sig); return }
    await this.executeSignal(row.id, cfg, snap.indicators?.atr, strat, raw)
  }

  conflict(symbol, direction) {
    for (const t of this.store.where('trades', (x) => x.status === 'open' && x.symbol === symbol)) {
      if (t.direction && t.direction !== direction) return `conflicts with open ${t.direction} position from ${t.bot_id}`
    }
    const recent = this.store.where('signals', (s) => s.symbol === symbol && s.direction === direction && ['executed', 'pending', 'approved'].includes(s.status) && s.ts >= now() - 30)
    return recent.length ? `duplicate of signal from ${recent[0].bot_id}` : null
  }

  setSignal(id, status, decision) {
    this.store.update('signals', (s) => s.id === id, { status, decision })
    this.bus.publish('signal_update', { id, status, decision })
  }

  async executeSignal(id, cfg, atr, strat, raw) {
    const s = this.store.where('signals', (x) => x.id === id)[0]
    const res = await this.exe.execute({ bot_id: s.bot_id, symbol: s.symbol, direction: s.direction, contract: cfg.contract, confidence: s.confidence,
      signal_id: id, atr, regime: s.regime, payout_assumption: cfg.payout_assumption ?? 0.9, max_stake: cfg.max_stake,
      features: { strategy: strat, raw_score: raw, p_win: s.calibrated_p } })
    this.setSignal(id, res.ok ? 'executed' : 'rejected', res.ok ? `contract ${res.contract_id}` : res.message)
    return res
  }

  async approve(id) {
    const s = this.store.where('signals', (x) => x.id === id)[0]
    if (!s) throw Object.assign(new Error('signal not found'), { status: 400 })
    if (s.status !== 'pending') throw Object.assign(new Error(`signal is ${s.status}`), { status: 400 })
    const cfg = this.configs.active(s.bot_id)
    if (now() - s.ts > cfg.granularity) { this.setSignal(id, 'expired', 'setup older than one candle'); throw Object.assign(new Error('signal expired'), { status: 400 }) }
    const snap = this.snapshots[`${s.symbol}:${cfg.granularity}`] || {}
    this.store.audit('bots', `signal ${id} approved by user`)
    return this.executeSignal(id, cfg, snap.indicators?.atr, s.features?.strategy, s.features?.raw_score)
  }

  reject(id) {
    if (!this.store.where('signals', (x) => x.id === id).length) throw Object.assign(new Error('signal not found'), { status: 404 })
    this.setSignal(id, 'rejected', 'rejected by user')
  }

  status(bot) {
    const cfg = this.configs.active(bot), rt = this.rt[bot]
    return { id: bot, name: cfg.name, strategy: cfg.strategy, running: rt.running, enabled: cfg.enabled, symbols: cfg.symbols,
      granularity: cfg.granularity, contract: cfg.contract, params: cfg.params, min_confidence: cfg.min_confidence,
      auto_execute: cfg.auto_execute, max_stake: cfg.max_stake, payout_assumption: cfg.payout_assumption, version: cfg._version,
      validated: !!cfg._validation?.passed_validation, last_signal: rt.last_signal, last_eval: rt.last_eval, errors: rt.errors,
      description: STRATEGIES[cfg.strategy]?.description || 'Meta-strategy: weighs the specialists by validated performance and regime, stands aside on conflict.',
      stats: botStats(this.store, bot) }
  }

  async checkDegradation() {
    const out = []
    for (const [b, rt] of Object.entries(this.rt)) {
      let d
      try { d = this.configs.degradation(b) } catch { continue }
      out.push(d)
      if (d.degraded && rt.running && this.store.kv('auto_disable_degraded', true)) {
        await this.stopBot(b)
        this.store.audit('bots', `${b} auto-disabled: live win rate ${d.win_rate} significantly below expected ${d.expected} (z=${d.z})`, {}, 'WARN')
      }
    }
    return out
  }
}
