// In-browser replacement for the Python REST API. The dashboard calls the same paths; each signed-in
// Deriv user gets their own runtime (Deriv connection, feed, bots, risk, execution, memory) inside
// this tab, and all data stays in this browser. Bots trade only while the tab is open.
import { PerformanceMemory } from './ai.js'
import { BotManager, Configs, DEFAULT_BOTS, MarketFeed, botStats, durationBars } from './bots.js'
import { analyze } from './analysis.js'
import { authorizeToken, DerivClient } from './deriv.js'
import { ExecutionEngine } from './execution.js'
import { computeAll } from './indicators.js'
import { JOBS } from './jobs.js'
import { RiskManager } from './risk.js'
import { frameFromCandles } from './series.js'
import { getItem, setItem, Store } from './store.js'
import { STRATEGIES } from './strategies.js'

const env = import.meta.env || {}
export const CONFIG = {
  brand: env.VITE_BRAND_NAME || 'Otis Trade',
  tagline: env.VITE_BRAND_TAGLINE || 'Automated trading for Deriv accounts',
  supportEmail: env.VITE_SUPPORT_EMAIL || '',
  appId: env.VITE_DERIV_APP_ID || '1089',
  wsUrl: env.VITE_DERIV_WS_URL || 'wss://ws.derivws.com/websockets/v3',
  oauthUrl: env.VITE_DERIV_OAUTH_URL || 'https://oauth.deriv.com/oauth2/authorize',
  signupUrl: 'https://deriv.com/signup/',
  affiliate: env.VITE_DERIV_AFFILIATE_TOKEN || '',
}
const REAL_CONFIRM = 'I ACCEPT REAL MONEY RISK'
// Deriv's shared test app (1089) only redirects to Deriv's own page, so OAuth needs the owner's app id.
// It can be set at build time (VITE_DERIV_APP_ID) or here in the browser without a rebuild.
const APP_ID_KEY = 'ot:app_id', SHARED_APP_ID = '1089'
export const appId = () => String(getItem(APP_ID_KEY) || CONFIG.appId)
const SESSION = 'ot:session'
const now = () => Date.now() / 1000

class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }
const fail = (status, message) => { throw new HttpError(status, message) }

// ---------------- event bus (replaces the server WebSocket) ----------------
const listeners = new Set()
export const bus = { publish: (type, data) => listeners.forEach((fn) => { try { fn({ type, data }) } catch (e) { console.error(e) } }) }
export function localEvents(onMessage, onState) {
  listeners.add(onMessage)
  onState?.(true)
  return () => listeners.delete(onMessage)
}

// ---------------- background jobs ----------------
let worker = null, jobSeq = 0
const jobWaiters = new Map()
function runJob(kind, payload) {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return Promise.resolve().then(() => JOBS[kind](payload))
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => { const w = jobWaiters.get(data.id); jobWaiters.delete(data.id); data.error ? w.reject(new HttpError(400, data.error)) : w.resolve(data.result) }
  }
  const id = ++jobSeq
  return new Promise((resolve, reject) => { jobWaiters.set(id, { resolve, reject }); worker.postMessage({ id, kind, payload }) })
}

// ---------------- runtime per signed-in user ----------------
class Runtime {
  constructor(sess) {
    const acct = sess.accounts.find((a) => a.loginid === sess.active_loginid) || sess.accounts[0]
    this.sess = sess
    this.store = new Store(sess.uid)
    this.client = new DerivClient(CONFIG.wsUrl, appId(), acct.token)
    this.feed = new MarketFeed(this.client)
    this.risk = new RiskManager(this.store)
    this.memory = new PerformanceMemory(this.store)
    this.configs = new Configs(this.store)
    this.exe = new ExecutionEngine(this.client, this.store, this.risk, this.memory, bus)
    this.bots = new BotManager({ client: this.client, feed: this.feed, exe: this.exe, store: this.store, configs: this.configs, memory: this.memory, bus })
    this.watched = new Map()
    this.history = new Map()
  }

  async start() {
    this.configs.seedDefaults()
    this.memory.refresh()
    this.client.on((kind, data) => this.onConn(kind, data))
    this.feed.onTick((_, t) => bus.publish('tick', t))
    this.client.start()
    await this.client.waitReady(10000)
    this.bots.restoreEnabled()
    let n = 0
    this.timer = setInterval(() => this.tick(++n).catch((e) => console.warn('monitor', e)), 30000)
  }

  stop() {
    clearInterval(this.timer)
    for (const [b, rt] of Object.entries(this.bots.rt)) if (rt.running) this.bots.stopBot(b, false).catch(() => {})
    this.client.stop()
  }

  async onConn(kind, data) {
    bus.publish('connection', { event: kind, ...data, health: this.client.health })
    if (kind === 'disconnected') this.store.audit('connection', 'Deriv connection lost', { error: data.error }, 'WARN')
    if (kind === 'auth_failed') { this.store.audit('security', `Deriv rejected the saved login: ${data.error}`, {}, 'WARN'); signOutLocal(); globalThis.window?.dispatchEvent(new Event('dat-logout')) }
    if (kind === 'authorized') {
      this.store.audit('connection', `authorized ${data.loginid} (virtual=${data.is_virtual})`)
      try { await this.client.subscribe('balance', { balance: 1 }, (m) => this.onBalance(m)) } catch { /* ignore */ }
      this.exe.reconcile()
    }
  }

  onBalance(msg) {
    const b = msg.balance
    if (b?.balance == null) return
    this.client.account.balance = +b.balance
    this.risk.recordBalance(+b.balance, this.client.health.loginid)
    bus.publish('balance', { balance: b.balance, currency: b.currency })
  }

  async tick(n) {
    if (this.client.health.authorized) {
      if (this.exe.unresolvedOrders().length) await this.exe.reconcile()
      await this.exe.pollOpen()
    }
    if (n % 120 === 0) await this.bots.checkDegradation()
    if (n % 2 === 0 && this.client.health.authorized && this.client.account.balance != null) {
      this.store.insert('equity', { ts: now(), balance: this.client.account.balance, currency: this.client.health.currency, loginid: this.client.health.loginid })
    }
  }

  /** Historical candles for backtests/validation (paginated, cached for this tab). */
  async candles(symbol, gran, start, end) {
    const key = `${symbol}:${gran}`, cached = this.history.get(key) || []
    const have = cached.filter((c) => c.epoch >= start && c.epoch <= end)
    if (have.length >= ((end - start) / gran) * 0.97) return have
    if (!this.client.health.connected) fail(503, 'market data connection is down - try again shortly')
    const data = await this.client.historyRange(symbol, gran, start, end)
    if (!data.length) fail(503, 'no historical data returned')
    const merged = new Map([...cached, ...data].map((c) => [+c.epoch, { epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }]))
    this.history.set(key, [...merged.values()].sort((a, b) => a.epoch - b.epoch))
    return data.map((c) => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }))
  }
}

let runtime = null, starting = null

const session = () => getItem(SESSION)
export function signOutLocal() { runtime?.stop(); runtime = null; starting = null; setItem(SESSION, null) }

async function rt() {
  const s = session()
  if (!s) fail(401, 'not signed in')
  if (runtime && runtime.sess.uid === s.uid && runtime.sess.active_loginid === s.active_loginid) return runtime
  if (!starting) {
    runtime?.stop()
    const r = new Runtime(s)
    starting = r.start().then(() => { runtime = r; starting = null; return r }, (e) => { starting = null; throw e })
  }
  return starting
}

const publicUser = (s) => ({ id: s.uid, email: s.email, fullname: s.fullname, is_admin: false, active_loginid: s.active_loginid,
  accounts: s.accounts.map(({ loginid, currency, is_virtual }) => ({ loginid, currency, is_virtual })) })

const oauthUrl = () => `${CONFIG.oauthUrl}?${new URLSearchParams({ app_id: appId(), l: 'EN' })}`
const signupUrl = () => (CONFIG.affiliate ? `${CONFIG.signupUrl}?t=${encodeURIComponent(CONFIG.affiliate)}` : CONFIG.signupUrl)

// ---------------- routes ----------------
const routes = []
const on = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn])
const CLOSED = ['won', 'lost', 'sold']

on('GET', '/site', () => ({ brand: CONFIG.brand, tagline: CONFIG.tagline, support_email: CONFIG.supportEmail, oauth_url: oauthUrl(),
  signup_url: signupUrl(), app_id: appId(), oauth_ready: appId() !== SHARED_APP_ID, static: true }))

on('PUT', '/site/app-id', ({ body }) => {
  const id = body.app_id == null || body.app_id === '' ? null : String(body.app_id).trim()
  if (id && !/^\d{1,9}$/.test(id)) fail(400, 'a Deriv app id is a number')
  setItem(APP_ID_KEY, id)
  return { app_id: appId(), oauth_ready: appId() !== SHARED_APP_ID }
})

// Registers this site with Deriv using an admin-scope API token (used once, never stored) and saves the app id.
on('POST', '/site/register-app', async ({ body }) => {
  const redirect = String(body.redirect_uri || '')
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(redirect)) fail(400, 'redirect address must be https')
  if (!body.token) fail(400, 'paste an API token that has the Admin scope')
  const c = new DerivClient(CONFIG.wsUrl, SHARED_APP_ID, null, { timeout: 15000 })
  c.start()
  try {
    if (!(await c.waitReady(15000))) fail(503, 'could not reach Deriv')
    await c.request({ authorize: String(body.token) })
    const r = (await c.request({ app_register: 1, name: CONFIG.brand, scopes: ['read', 'trade', 'trading_information'],
      redirect_uri: redirect, homepage: redirect })).app_register
    setItem(APP_ID_KEY, String(r.app_id))
    return { app_id: String(r.app_id), oauth_ready: true }
  } catch (e) { if (e instanceof HttpError) throw e; fail(400, e.message) } finally { c.stop() }
})

on('POST', '/auth/deriv', async ({ body }) => {
  const accounts = (body.accounts || []).filter((a) => a.token).slice(0, 20)
  if (!accounts.length) fail(401, 'no accounts returned by Deriv')
  const results = await Promise.allSettled(accounts.map((a) => authorizeToken(CONFIG.wsUrl, appId(), a.token)))
  const verified = [], users = new Set()
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return   // disabled / self-excluded accounts may fail - skip them
    const a = r.value, req = accounts[i]
    if (req.loginid && a.loginid !== req.loginid) fail(401, 'token/account mismatch')
    users.add(String(a.user_id || a.email || a.loginid))
    verified.push({ loginid: a.loginid, currency: a.currency || (req.currency || '').toUpperCase(), is_virtual: !!a.is_virtual, token: req.token, email: a.email, fullname: a.fullname })
  })
  if (!verified.length) fail(401, 'Deriv rejected every account token')
  if (users.size !== 1) fail(401, 'accounts belong to different Deriv users')
  const prev = session(), uid = [...users][0]
  const keep = prev?.uid === uid && verified.some((a) => a.loginid === prev.active_loginid) ? prev.active_loginid : null
  const s = { uid, email: (verified[0].email || '').toLowerCase(), fullname: verified[0].fullname || '', created_at: now(),
    active_loginid: keep || (verified.find((a) => a.is_virtual) || verified[0]).loginid,   // demo first - real money is never the default
    accounts: verified.map(({ email, fullname, ...a }) => a) }
  signOutLocal()
  setItem(SESSION, s)
  new Store(uid).audit('security', 'signed in with Deriv')
  return { token: 'browser-session', user: publicUser(s) }
})

on('GET', '/auth/me', () => { const s = session(); if (!s) fail(401, 'not signed in'); return publicUser(s) })

on('POST', '/auth/logout', async ({ query }) => {
  const r = runtime
  if (r && query.get('revoke') === 'true') {
    for (const [b, x] of Object.entries(r.bots.rt)) if (x.running) await r.bots.stopBot(b)
    try { await r.client.request({ logout: 1 }, 8000) } catch { /* best effort */ }
    r.store.audit('security', 'signed out and revoked Deriv access')
  }
  signOutLocal()
  return { ok: true }
})

on('POST', '/account/switch', async ({ body }) => {
  const s = session(); if (!s) fail(401, 'not signed in')
  if (!s.accounts.some((a) => a.loginid === body.loginid)) fail(400, `account ${body.loginid} not linked`)
  if (runtime && Object.values(runtime.bots.rt).some((x) => x.running)) fail(400, 'stop all bots before switching account')
  setItem(SESSION, { ...s, active_loginid: body.loginid })
  new Store(s.uid).audit('security', `active account switched to ${body.loginid}`)
  const r = await rt()
  return { loginid: r.client.health.loginid, is_virtual: r.client.health.is_virtual }
})

on('GET', '/status', async () => {
  const r = await rt(), c = r.client
  return { user: publicUser(r.sess), health: c.health, mode: r.bots.mode(), emergency_stop: r.store.kv('global_stop'),
    suspension: r.risk.suspension(), real_authorization: r.store.kv('real_trading_authorization'),
    trading_permission: r.exe.tradingPermission(), balance: c.account.balance ?? null, currency: c.health.currency,
    unresolved_orders: r.exe.unresolvedOrders().length, market_feed: c.health.connected }
})

on('POST', '/deriv/authorize-real', async ({ body }) => {
  const r = await rt(), h = r.client.health
  if (!h.authorized || h.is_virtual) fail(400, 'switch to your REAL account first')
  if (body.loginid !== h.loginid) fail(400, `account id mismatch (active: ${h.loginid})`)
  if (body.confirmation !== REAL_CONFIRM) fail(400, `type exactly: "${REAL_CONFIRM}"`)
  r.store.setKv('real_trading_authorization', { authorized: true, loginid: h.loginid, at: now() })
  r.store.audit('security', `REAL-MONEY trading authorized for ${h.loginid}`, {}, 'WARN')
  return { authorized: true }
})
on('DELETE', '/deriv/authorize-real', async () => {
  const r = await rt(); r.store.setKv('real_trading_authorization', null); r.store.audit('security', 'real-money authorization revoked'); return { authorized: false }
})

on('GET', '/account/transactions', async ({ query }) => {
  const r = await rt(), n = +(query.get('limit') || 50)
  try { return { statement: await r.client.statement(n), profit_table: await r.client.profitTable(n) } } catch (e) { fail(503, e.message) }
})

function pnlSince(store, ts) {
  return +store.where('trades', (t) => t.sell_time >= ts && CLOSED.includes(t.status)).reduce((s, t) => s + (t.profit || 0), 0).toFixed(2)
}

on('GET', '/dashboard', async () => {
  const r = await rt(), d = new Date(), bal = r.client.account.balance ?? null
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000
  const week = day - ((d.getUTCDay() + 6) % 7) * 86400, month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
  const st = botStats(r.store), risk = r.risk.state(bal, r.client.health.loginid)
  return {
    balance: bal, currency: r.client.health.currency, available_balance: bal != null ? +(bal - risk.exposure).toFixed(2) : null,
    pnl: { total: st.net_profit, daily: pnlSince(r.store, day), weekly: pnlSince(r.store, week), monthly: pnlSince(r.store, month) },
    stats: st, risk, open_trades: r.store.where('trades', (t) => t.status === 'open').sort((a, b) => b.buy_time - a.buy_time),
    active_bots: Object.entries(r.bots.rt).filter(([, x]) => x.running).map(([b]) => b),
    recent_signals: r.store.all('signals').slice(-25).reverse(), market: Object.values(r.bots.snapshots),
    prices: r.feed.lastPrice, mode: r.bots.mode(), health: r.client.health,
  }
})

on('GET', '/markets/symbols', async () => {
  const r = await rt()
  try {
    return (await r.client.activeSymbols()).map((x) => ({ symbol: x.symbol, name: x.display_name, market: x.market_display_name,
      submarket: x.submarket_display_name, open: !!x.exchange_is_open }))
  } catch (e) { fail(503, e.message) }
})

on('GET', '/markets/candles', async ({ query }) => {
  const r = await rt(), symbol = query.get('symbol'), gran = +(query.get('granularity') || 60), count = +(query.get('count') || 500)
  const df = r.feed.frame(symbol, gran, false)
  if (df && df.close.length >= 10) {
    return df.t.slice(-count).map((t, i, a) => { const k = df.t.length - a.length + i; return { time: t, open: df.open[k], high: df.high[k], low: df.low[k], close: df.close[k] } })
  }
  try {
    return (await r.client.candles(symbol, gran, count)).map((c) => ({ time: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }))
  } catch (e) { fail(503, e.message) }
})

on('POST', '/markets/watch', async ({ body }) => {
  const r = await rt(), key = `${body.symbol}:${body.granularity || 60}`
  if (!r.watched.has(key)) {
    if (r.watched.size >= 6) {   // keep a handful of live chart streams per tab
      const [old] = [...r.watched.entries()].sort((a, b) => a[1] - b[1])[0]
      r.watched.delete(old)
      const i = old.lastIndexOf(':'); await r.feed.release(old.slice(0, i), +old.slice(i + 1))
    }
    await r.feed.ensure(body.symbol, body.granularity || 60)
  }
  r.watched.set(key, now())
  return { ok: true }
})

on('GET', '/markets/analysis', async ({ query }) => {
  const r = await rt(), symbol = query.get('symbol'), gran = +(query.get('granularity') || 300)
  let df = r.feed.frame(symbol, gran)
  if (!df || df.close.length < 100) {
    const raw = await r.client.candles(symbol, gran, 1000)
    df = frameFromCandles(raw.slice(0, -1))
  }
  if (df.close.length < 60) fail(400, 'not enough market data yet')
  const f = computeAll(df), snap = analyze(symbol, gran, df, f)
  snap.signals = {}
  for (const sid of Object.keys(STRATEGIES)) {
    let params = null
    try { params = r.configs.active(sid).params } catch { /* defaults */ }
    try { snap.signals[sid] = STRATEGIES[sid].latest(df, f, params) } catch { snap.signals[sid] = null }
  }
  return snap
})

const bot = (r, id) => { if (!(id in r.bots.rt)) fail(404, 'unknown bot'); return id }

on('GET', '/bots', async () => { const r = await rt(); return Object.keys(r.bots.rt).map((b) => r.bots.status(b)) })
on('GET', '/bots/:id', async ({ p }) => {
  const r = await rt(); bot(r, p.id)
  return { ...r.bots.status(p.id), versions: r.configs.versions(p.id).slice(0, 30), degradation: r.configs.degradation(p.id) }
})
on('POST', '/bots/:id/start', async ({ p }) => { const r = await rt(); bot(r, p.id); await r.bots.startBot(p.id); return r.bots.status(p.id) })
on('POST', '/bots/:id/stop', async ({ p }) => { const r = await rt(); bot(r, p.id); await r.bots.stopBot(p.id); return r.bots.status(p.id) })
on('PATCH', '/bots/:id', async ({ p, body }) => {
  const r = await rt(); bot(r, p.id)
  r.configs.updateOperational(p.id, body)
  if ('symbols' in body) await r.bots.restartBot(p.id)
  return r.bots.status(p.id)
})

let busyJob = false
async function exclusive(fn) {
  if (busyJob) fail(429, 'a backtest or validation is already running in this tab')
  busyJob = true
  try { return await fn() } finally { busyJob = false }
}

on('POST', '/bots/:id/validate', async ({ p, body }) => {
  const r = await rt(); bot(r, p.id)
  const days = body.days ?? 30, folds = body.folds ?? 4
  if (!(days >= 1 && days <= 365) || !(folds >= 2 && folds <= 8)) fail(400, 'days 1-365, folds 2-8')
  const cand = r.configs.candidate(p.id, body.overrides || {})
  return exclusive(async () => {
    const end = Math.floor(now())
    const candles = await r.candles(body.symbol || cand.symbols[0], cand.granularity, end - Math.floor(days * 86400), end)
    if (candles.length < 800) fail(400, `only ${candles.length} candles - use a longer period`)
    const c = cand.contract
    const cfg = { family: c.family || 'rise_fall', duration_bars: durationBars(c, cand.granularity), payout_ratio: cand.payout_assumption ?? 0.9,
      barrier_atr_mult: c.barrier_atr_mult ?? 1.0, multiplier: c.multiplier || 50, sl_pct: c.sl_pct_of_stake || 50, tp_pct: c.tp_pct_of_stake || 50,
      cooldown_bars: cand.cooldown_bars ?? 1 }
    const wf = await runJob('validate', { candles, strategy: cand.strategy, params: cand.params, cfg, folds, optimise: body.optimise ?? true })
    const res = r.configs.saveValidation(p.id, cand, wf, { bars: candles.length, from: candles[0].epoch, to: candles.at(-1).epoch })
    r.memory.refresh()
    return res
  })
})

on('POST', '/bots/:id/deploy/:ver', async ({ p }) => {
  const r = await rt(); bot(r, p.id); r.configs.deploy(p.id, +p.ver); await r.bots.restartBot(p.id); return r.bots.status(p.id)
})

on('GET', '/signals', async ({ query }) => {
  const r = await rt(), st = query.get('status'), b = query.get('bot_id'), n = Math.min(+(query.get('limit') || 100), 1000)
  return r.store.where('signals', (s) => (!st || s.status === st) && (!b || s.bot_id === b)).slice(-n).reverse()
})
on('POST', '/signals/:id/approve', async ({ p }) => { const r = await rt(); return r.bots.approve(+p.id) })
on('POST', '/signals/:id/reject', async ({ p }) => { const r = await rt(); r.bots.reject(+p.id); return { ok: true } })

on('GET', '/trades', async ({ query }) => {
  const r = await rt(), st = query.get('status'), b = query.get('bot_id'), n = Math.min(+(query.get('limit') || 200), 5000)
  return r.store.where('trades', (t) => (!st || t.status === st) && (!b || t.bot_id === b)).sort((a, b2) => b2.buy_time - a.buy_time).slice(0, n)
})
on('POST', '/trades/:cid/sell', async ({ p }) => {
  const r = await rt()
  if (!r.store.where('trades', (t) => t.contract_id === p.cid).length) fail(404, 'trade not found')
  try { return await r.exe.sell(p.cid) } catch (e) { fail(400, e.message) }
})
on('GET', '/orders', async ({ query }) => { const r = await rt(); return r.store.all('orders').slice(-(+(query.get('limit') || 100))).reverse() })

on('GET', '/risk', async () => { const r = await rt(); return r.risk.state(r.client.account.balance ?? null, r.client.health.loginid) })
on('PUT', '/risk', async ({ body }) => { const r = await rt(); try { return r.risk.updateConfig(body) } catch (e) { fail(400, e.message) } })
on('POST', '/risk/resume', async () => { const r = await rt(); r.risk.resume(); return { ok: true } })
on('POST', '/risk/reset-peak', async () => {
  const r = await rt(), bal = r.client.account.balance
  if (bal == null) fail(400, 'balance unknown')
  r.risk.resetPeak(bal, r.client.health.loginid); return { peak: bal }
})

on('GET', '/mode', async () => ({ mode: (await rt()).bots.mode() }))
on('PUT', '/mode', async ({ body }) => ({ mode: (await rt()).bots.setMode(body.mode) }))
on('POST', '/emergency-stop', async () => (await rt()).bots.emergencyStop('dashboard'))
on('DELETE', '/emergency-stop', async () => { (await rt()).bots.clearEmergencyStop(); return { ok: true } })

on('POST', '/backtest', async ({ body }) => {
  const r = await rt()
  const b = { symbol: 'R_100', granularity: 300, days: 30, contract: { family: 'rise_fall', duration_bars: 3, payout_ratio: 0.9 }, params: {}, walk_forward: false, folds: 4, min_score: 0, ...body }
  const bad = (b.strategies || []).filter((x) => !STRATEGIES[x])
  if (bad.length || !b.strategies?.length) fail(400, `unknown strategies ${bad.join(', ')}`)
  if (!(b.days > 0 && b.days <= 365)) fail(400, 'days must be 1-365')
  return exclusive(async () => {
    const end = Math.floor(now())
    const candles = await r.candles(b.symbol, b.granularity, end - Math.floor(b.days * 86400), end)
    const cfg = { ...b.contract, min_score: b.min_score }
    const params = Object.fromEntries(b.strategies.map((x) => { let p = b.params[x]; if (!p) { try { p = r.configs.active(x).params } catch { p = null } } return [x, p] }))
    const results = await runJob('backtest', { candles, strategies: b.strategies, params, cfg, walk: b.walk_forward, folds: b.folds })
    return { symbol: b.symbol, granularity: b.granularity, bars: candles.length, from: candles[0].epoch, to: candles.at(-1).epoch,
      breakeven_win_rate: +(1 / (1 + (cfg.payout_ratio ?? 0.9))).toFixed(4), results }
  })
})

on('GET', '/strategies', () => Object.values(STRATEGIES).map((x) => ({ id: x.id, name: x.name, description: x.description, default_params: x.default_params, param_space: x.param_space })))

on('GET', '/analytics/performance', async () => {
  const r = await rt(), trades = r.store.where('trades', (t) => CLOSED.includes(t.status)).sort((a, b) => a.sell_time - b.sell_time)
  let eq = 0
  const curve = [], daily = {}
  for (const t of trades) {
    eq += t.profit || 0
    curve.push({ time: Math.floor(t.sell_time), value: +eq.toFixed(2) })
    const d = new Date(t.sell_time * 1000).toISOString().slice(0, 10)
    daily[d] = +((daily[d] || 0) + (t.profit || 0)).toFixed(2)
  }
  return { equity_curve: curve, daily_pnl: Object.keys(daily).sort().map((k) => ({ date: k, pnl: daily[k] })),
    by_bot: Object.fromEntries(Object.keys(DEFAULT_BOTS).map((b) => [b, botStats(r.store, b)])), balance_history: r.store.all('equity').slice(-2000) }
})
on('GET', '/analytics/calibration', async () => { const r = await rt(); return { calibration: r.memory.summary(), regimes: r.memory.regimeTable() } })
on('GET', '/analytics/degradation', async () => { const r = await rt(); return Object.keys(DEFAULT_BOTS).map((b) => r.configs.degradation(b)) })

on('GET', '/logs', async ({ query }) => {
  const r = await rt(), cat = query.get('category'), n = Math.min(+(query.get('limit') || 200), 2000)
  return r.store.where('audit', (a) => !cat || a.category === cat).slice(-n).reverse()
})
on('POST', '/system/reconcile', async () => (await rt()).exe.reconcile())

on('GET', '/admin/overview', () => fail(403, 'admin only'))
on('GET', '/admin/errors', () => fail(403, 'admin only'))

export const __testing = { runtime: rt }

/** Same contract as the server: resolves with JSON data or throws {status, message}. */
export async function localApi(path, { method = 'GET', body } = {}) {
  const url = new URL(path, 'http://local')
  for (const [m, re, fn] of routes) {
    if (m !== method) continue
    const match = url.pathname.match(re)
    if (match) return fn({ p: match.groups || {}, query: url.searchParams, body: body || {} })
  }
  fail(404, `no route ${method} ${url.pathname}`)
}
