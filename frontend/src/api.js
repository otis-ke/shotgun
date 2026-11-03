// API client. Deriv OAuth tokens pass through the browser once (the redirect), are posted to the
// backend and removed from the address bar. Only our own site session token is stored.
const KEY = 'dat_session'

export const session = {
  get: () => { try { return localStorage.getItem(KEY) } catch { return null } },
  set: (t) => { try { localStorage.setItem(KEY, t) } catch { /* ignore */ } },
  clear: () => { try { localStorage.removeItem(KEY) } catch { /* ignore */ } },
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const t = session.get()
  if (t) headers.Authorization = `Bearer ${t}`
  const res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  let data = null
  try { data = await res.json() } catch { /* empty */ }
  if (res.status === 401 && path !== '/auth/login') {
    session.clear()
    window.dispatchEvent(new Event('dat-logout'))
  }
  if (!res.ok) throw new ApiError(res.status, (data && (data.detail?.toString?.() || JSON.stringify(data.detail))) || res.statusText)
  return data
}

export function connectEvents(onMessage, onState) {
  let ws, closed = false, retry = 1000
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(session.get() || '')}`)
    ws.onopen = () => { retry = 1000; onState?.(true) }
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)) } catch { /* ignore */ } }
    ws.onclose = () => {
      onState?.(false)
      if (!closed) setTimeout(open, retry = Math.min(retry * 2, 15000))
    }
  }
  open()
  return () => { closed = true; ws?.close() }
}

export const fmt = {
  money: (v, cur = '') => v === null || v === undefined ? '—' : `${v < 0 ? '-' : ''}${cur ? cur + ' ' : ''}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  pct: (v, d = 1) => v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`,
  num: (v, d = 2) => v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d),
  time: (ts) => ts ? new Date(ts * 1000).toLocaleString() : '—',
  ago: (ts) => {
    if (!ts) return '—'
    const s = Math.max(0, Date.now() / 1000 - ts)
    if (s < 60) return `${Math.round(s)}s ago`
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    if (s < 86400) return `${Math.round(s / 3600)}h ago`
    return `${Math.round(s / 86400)}d ago`
  },
  gran: (g) => g >= 86400 ? `${g / 86400}d` : g >= 3600 ? `${g / 3600}h` : g >= 60 ? `${g / 60}m` : `${g}s`,
}

export const GRANULARITIES = [60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400]
