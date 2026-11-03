// Browser client for the official Deriv WebSocket API v3 (port of backend/deriv/client).
// * unique req_id per request, responses routed to the waiting promise
// * subscriptions restored after reconnect; their messages are handled strictly in order
// * requests are NEVER retried - a buy whose socket drops reports ConnectionLost and is reconciled

export class DerivError extends Error {
  constructor(code, message, details) { super(`${code}: ${message}`); this.code = code; this.details = details }
}
export class ConnectionLost extends Error {}
export class NotConnected extends Error {}
export class Timeout extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class DerivClient {
  constructor(url, appId, token = null, { timeout = 20000, ping = 25000 } = {}) {
    this.url = `${url}?app_id=${appId}&l=EN`
    this.token = token; this.timeout = timeout; this.pingMs = ping
    this.health = { connected: false, authorized: false, loginid: null, is_virtual: null, currency: null,
      last_message: 0, latency_ms: null, reconnects: 0, last_error: null, connected_since: null }
    this.account = {}
    this.ws = null; this.nextId = 1; this.pending = new Map(); this.subs = new Map()
    this.stopped = true; this.listeners = []; this.readyWaiters = []
  }

  on(fn) { this.listeners.push(fn) }
  emit(kind, data = {}) { for (const fn of this.listeners) { try { fn(kind, data) } catch (e) { console.error(e) } } }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.loop()
  }

  get ready() { return this.ws && this.health.connected && (!this.token || this.health.authorized) }

  waitReady(ms = 15000) {
    if (this.ready) return Promise.resolve(true)
    return new Promise((res) => {
      const t = setTimeout(() => { this.readyWaiters = this.readyWaiters.filter((w) => w !== done); res(false) }, ms)
      const done = () => { clearTimeout(t); res(true) }
      this.readyWaiters.push(done)
    })
  }

  stop() {
    this.stopped = true
    try { this.ws?.close() } catch { /* ignore */ }
    this.failPending(new ConnectionLost('client stopped'))
    clearInterval(this.pinger)
  }

  async loop() {
    let backoff = 1000
    while (!this.stopped) {
      const closed = await this.connectOnce().catch((e) => { this.health.last_error = String(e.message || e); return null })
      if (closed) await closed
      if (this.stopped) break
      this.health.reconnects++
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 60000)
      if (this.health.connected_since && Date.now() / 1000 - this.health.connected_since > 60) backoff = 1000
    }
  }

  connectOnce() {
    return new Promise((resolveOpen, rejectOpen) => {
      const ws = new WebSocket(this.url)
      let opened = false
      const closed = new Promise((resolveClosed) => {
        ws.onclose = (e) => {
          clearInterval(this.pinger)
          const was = this.health.connected
          Object.assign(this.health, { connected: false, authorized: false })
          if (this.ws === ws) this.ws = null
          this.failPending(new ConnectionLost('connection dropped'))
          for (const s of this.subs.values()) s.subId = null
          if (!opened) rejectOpen(new Error(`could not connect (${e.code})`))
          else { if (was) this.emit('disconnected', { error: this.health.last_error }); resolveClosed() }
        }
      })
      ws.onerror = () => { this.health.last_error = 'network error' }
      ws.onmessage = (e) => {
        this.health.last_message = Date.now() / 1000
        let msg; try { msg = JSON.parse(e.data) } catch { return }
        this.dispatch(msg)
      }
      ws.onopen = async () => {
        opened = true
        this.ws = ws
        Object.assign(this.health, { connected: true, connected_since: Date.now() / 1000, last_error: null })
        this.pinger = setInterval(() => this.ping(), this.pingMs)
        resolveOpen(closed)
        try {
          await this.onConnected()
          this.readyWaiters.splice(0).forEach((w) => w())
          this.emit('connected')
        } catch (err) {
          this.health.last_error = err.message
          this.emit('error', { error: err.message })
          if (err instanceof DerivError) { this.stop(); this.emit('auth_failed', { error: err.message }) }
          else ws.close()
        }
      }
    })
  }

  async onConnected() {
    if (this.token) {
      const a = (await this.request({ authorize: this.token })).authorize
      this.account = a
      Object.assign(this.health, { authorized: true, loginid: a.loginid, is_virtual: !!a.is_virtual, currency: a.currency })
      this.emit('authorized', { loginid: a.loginid, is_virtual: a.is_virtual })
    }
    for (const s of this.subs.values()) { try { await this.activate(s) } catch { /* retried on next reconnect */ } }
  }

  async ping() {
    const t0 = performance.now()
    try {
      await this.request({ ping: 1 }, 15000)
      this.health.latency_ms = Math.round(performance.now() - t0)
      this.misses = 0
    } catch {
      this.misses = (this.misses || 0) + 1
      if (this.misses >= 2) { this.misses = 0; try { this.ws?.close() } catch { /* ignore */ } }   // dead link -> reconnect
    }
  }

  dispatch(msg) {
    const p = msg.req_id != null ? this.pending.get(msg.req_id) : null
    if (p) { this.pending.delete(msg.req_id); clearTimeout(p.timer); p.resolve(msg); return }
    const subId = msg.subscription?.id
    if (!subId) return
    for (const s of this.subs.values()) {
      if (s.subId === subId || (s.subId === null && s.reqId === msg.req_id)) { s.subId = subId; this.push(s, msg); return }
    }
  }

  push(sub, msg) {   // one ordered chain per subscription; callbacks may await other requests
    sub.chain = sub.chain.then(() => sub.callback(msg)).catch((e) => console.error(`subscription ${sub.key}`, e))
  }

  failPending(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  request(payload, timeout = null) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new NotConnected('not connected to Deriv'))
    const reqId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Timeout('Deriv did not answer in time')) }, timeout || this.timeout)
      this.pending.set(reqId, { resolve, reject, timer })
      try { this.ws.send(JSON.stringify({ ...payload, req_id: reqId })) } catch (e) {
        clearTimeout(timer); this.pending.delete(reqId); reject(new ConnectionLost(String(e)))
      }
    }).then((msg) => {
      if (msg.error) throw new DerivError(msg.error.code || 'Error', msg.error.message || '', msg.error.details)
      return msg
    })
  }

  async subscribe(key, payload, callback) {
    await this.unsubscribe(key)
    const sub = { key, request: { ...payload, subscribe: 1 }, callback, subId: null, reqId: null, chain: Promise.resolve() }
    this.subs.set(key, sub)
    if (this.ws) return this.activate(sub)
    return null
  }

  async activate(sub) {
    const reqId = this.nextId++
    sub.reqId = reqId
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Timeout('subscription timed out')) }, this.timeout)
      this.pending.set(reqId, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ ...sub.request, req_id: reqId }))
    })
    if (msg.error) throw new DerivError(msg.error.code, msg.error.message)
    if (msg.subscription?.id) sub.subId = msg.subscription.id
    this.push(sub, msg)
    return msg
  }

  async unsubscribe(key) {
    const sub = this.subs.get(key)
    this.subs.delete(key)
    if (sub?.subId && this.ws) { try { await this.request({ forget: sub.subId }, 5000) } catch { /* ignore */ } }
  }

  // ---------- typed helpers ----------
  async activeSymbols() { return (await this.request({ active_symbols: 'brief', product_type: 'basic' })).active_symbols }
  async contractsFor(symbol) { return (await this.request({ contracts_for: symbol })).contracts_for }
  async candles(symbol, granularity, count = 500, end = 'latest') {
    const r = await this.request({ ticks_history: symbol, style: 'candles', granularity, end, adjust_start_time: 1, count: Math.min(count, 5000) }, 40000)
    return r.candles || []
  }
  /** Paginate ticks_history across long periods (max 5000 candles per call). */
  async historyRange(symbol, granularity, start, end) {
    let out = [], cursor = end
    while (cursor > start) {
      const batch = (await this.candles(symbol, granularity, 5000, cursor)).filter((c) => c.epoch >= start)
      if (!batch.length) break
      out = batch.concat(out)
      if (batch[0].epoch <= start || batch.length < 2) break
      cursor = batch[0].epoch - 1
      await sleep(300)   // be polite with rate limits
    }
    const dedup = new Map(out.map((c) => [c.epoch, c]))
    return [...dedup.keys()].sort((a, b) => a - b).map((k) => dedup.get(k))
  }
  async proposal(params) { return (await this.request({ proposal: 1, ...params })).proposal }
  async buy(id, maxPrice, passthrough) {
    return (await this.request({ buy: id, price: Math.round(maxPrice * 100) / 100, ...(passthrough ? { passthrough } : {}) }, 30000)).buy
  }
  async sell(cid, price = 0) { return (await this.request({ sell: +cid, price })).sell }
  async contractStatus(cid) { return (await this.request({ proposal_open_contract: 1, contract_id: +cid })).proposal_open_contract }
  async portfolio() { return (await this.request({ portfolio: 1 })).portfolio.contracts }
  async profitTable(limit = 50, dateFrom = null) {
    return (await this.request({ profit_table: 1, description: 1, limit, sort: 'DESC', ...(dateFrom ? { date_from: dateFrom } : {}) })).profit_table.transactions
  }
  async statement(limit = 50) { return (await this.request({ statement: 1, description: 1, limit })).statement.transactions }
  async balance() { return (await this.request({ balance: 1 })).balance }
}

/** One-shot authorize on a fresh socket (used to verify OAuth tokens). */
export async function authorizeToken(url, appId, token, timeout = 15000) {
  const c = new DerivClient(url, appId, null, { timeout })
  c.start()
  try {
    if (!(await c.waitReady(timeout))) throw new Error('could not reach Deriv')
    return (await c.request({ authorize: token })).authorize
  } finally { c.stop() }
}
