// Per-user storage in the browser (replaces the server database). Each Deriv user gets their own
// namespace; writes are synchronous so an order row exists BEFORE its buy is sent.
const CAPS = { signals: 1500, trades: 4000, orders: 1500, audit: 1500, equity: 3000, bot_configs: 600 }

let mem = null   // fallback when localStorage is unavailable (private mode / tests)
const ls = () => {
  try { if (globalThis.localStorage) { globalThis.localStorage.setItem('ot:probe', '1'); return globalThis.localStorage } } catch { /* ignore */ }
  mem ??= new Map()
  return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
    get length() { return mem.size }, key: (i) => [...mem.keys()][i] }
}

export function getItem(k, def = null) { try { const v = ls().getItem(k); return v == null ? def : JSON.parse(v) } catch { return def } }
export function setItem(k, v) {
  try { v == null ? ls().removeItem(k) : ls().setItem(k, JSON.stringify(v)) } catch (e) {
    if (e?.name === 'QuotaExceededError') throw new Error('browser storage is full - clear old history in Settings')
    throw e
  }
}

export class Store {
  constructor(uid) { this.p = `ot:${uid}:`; this.cache = {} }
  all(t) { return (this.cache[t] ??= getItem(this.p + t, [])) }
  save(t) {
    let rows = this.all(t)
    const cap = CAPS[t]
    if (cap && rows.length > cap) {   // drop oldest closed rows first; never drop open trades/unresolved orders
      const keep = (r) => r.status === 'open' || ['PENDING', 'SENT', 'UNKNOWN'].includes(r.status)
      const excess = rows.length - cap
      let dropped = 0
      rows = rows.filter((r) => (dropped < excess && !keep(r) ? (dropped++, false) : true))
      this.cache[t] = rows
    }
    setItem(this.p + t, rows)
  }
  insert(t, row) {
    const rows = this.all(t)
    const idKey = `seq:${t}`, id = (this.kv(idKey, 0) || 0) + 1
    this.setKv(idKey, id)
    const r = { id, ...row }
    rows.push(r); this.save(t)
    return r
  }
  update(t, pred, changes) {
    let n = 0
    for (const r of this.all(t)) if (pred(r)) { Object.assign(r, changes); n++ }
    if (n) this.save(t)
    return n
  }
  where(t, pred) { return this.all(t).filter(pred) }
  kv(k, def = null) { const v = getItem(`${this.p}kv:${k}`); return v == null ? def : v }
  setKv(k, v) { setItem(`${this.p}kv:${k}`, v) }
  audit(category, message, extra = {}, level = 'INFO') {
    this.insert('audit', { ts: Date.now() / 1000, level, category, message, data: extra })
  }
  clearHistory() {
    for (const t of ['signals', 'audit', 'equity']) { this.cache[t] = []; setItem(this.p + t, []) }
  }
}
