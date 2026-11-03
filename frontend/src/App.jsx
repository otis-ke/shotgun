import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { api, connectEvents, session, fmt } from './api'
import Dashboard from './dashboard/Dashboard'
import Bots from './bots/Bots'
import Charts from './charts/Charts'
import Analytics from './analytics/Analytics'
import Backtest from './analytics/Backtest'
import History from './history/History'
import Signals from './history/Signals'
import Logs from './history/Logs'
import Settings from './settings/Settings'
import Admin from './settings/Admin'

const Live = createContext(null)
export const useLive = () => useContext(Live)

const PAGES = [
  ['dashboard', 'Dashboard', Dashboard], ['bots', 'Bot Center', Bots], ['signals', 'Signals', Signals],
  ['charts', 'Charts & Analysis', Charts], ['backtest', 'Backtesting', Backtest], ['analytics', 'Analytics', Analytics],
  ['history', 'Trade History', History], ['logs', 'Activity Log', Logs], ['settings', 'Settings', Settings],
  ['admin', 'Admin', Admin, true],
]

/** Deriv redirects back with ?acct1=..&token1=..&cur1=..&acct2=.. after its own login page. */
function readOAuthRedirect() {
  const q = new URLSearchParams(location.search)
  const accounts = []
  for (let i = 1; q.get(`token${i}`); i++) {
    accounts.push({ loginid: q.get(`acct${i}`), token: q.get(`token${i}`), currency: q.get(`cur${i}`) })
  }
  return accounts
}

function useSite() {
  const [site, setSite] = useState(null)
  useEffect(() => { api('/site').then((s) => { setSite(s); document.title = s.brand }).catch(() => {}) }, [])
  return site
}

// Returning visitors skip the login screen: Deriv's OAuth page sends anyone already signed in to
// Deriv straight back here with fresh tokens. An explicit sign-out turns this off until the next login.
const flag = {
  get: (k) => { try { return localStorage.getItem(k) === '1' } catch { return false } },
  set: (k, on) => { try { on ? localStorage.setItem(k, '1') : localStorage.removeItem(k) } catch { /* ignore */ } },
}
const RETURNING = 'ot:returning', SIGNED_OUT = 'ot:signed_out'
const BASE = import.meta.env.BASE_URL

export function PolicyLinks() {
  return <span className="mini"><a href={`${BASE}privacy.html`}>Privacy Policy</a> · <a href={`${BASE}cookies.html`}>Cookie Policy</a></span>
}

function CookieNotice() {
  const [seen, setSeen] = useState(() => flag.get('ot:cookie_notice'))
  if (seen) return null
  return (
    <div className="cookie-notice" role="dialog" aria-label="Cookie notice">
      <span>We use only strictly necessary browser storage to keep you signed in and save your settings - no ads, no tracking. See our <a href={`${BASE}cookies.html`}>Cookie Policy</a>.</span>
      <button className="btn sm primary" onClick={() => { flag.set('ot:cookie_notice', true); setSeen(true) }}>OK</button>
    </div>
  )
}

function Login({ site, onDone }) {
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const accounts = readOAuthRedirect()
    if (!accounts.length) {
      if (site?.oauth_url && flag.get(RETURNING) && !flag.get(SIGNED_OUT)) { setBusy(true); location.replace(site.oauth_url) }
      return
    }
    history.replaceState(null, '', location.pathname)   // remove tokens from the address bar immediately
    setBusy(true)
    api('/auth/deriv', { method: 'POST', body: { accounts } })
      .then((r) => { session.set(r.token); flag.set(RETURNING, true); flag.set(SIGNED_OUT, false); onDone() })
      .catch((e) => { flag.set(RETURNING, false); setErr(e.message); setBusy(false) })
  }, [onDone, site])
  return (
    <div className="login">
      <div className="card">
        <div className="brand" style={{ padding: 0, fontSize: 20 }}>{site?.brand || '…'}<small>{site?.tagline}</small></div>
        {busy ? <div className="alert info">Signing you in with Deriv…</div> : <>
          <p className="muted" style={{ margin: 0 }}>Sign in with your Deriv account. You'll enter your password on Deriv's own website, then come straight back here — we never see your Deriv password.</p>
          <a className="btn primary" style={{ textAlign: 'center', textDecoration: 'none', padding: '10px' }} href={site?.oauth_url}
            onClick={() => flag.set(SIGNED_OUT, false)}>Log in with Deriv</a>
          <a className="btn" style={{ textAlign: 'center', textDecoration: 'none' }} href={site?.signup_url} target="_blank" rel="noreferrer">Create a free Deriv account</a>
        </>}
        {err && <div className="alert err">{err}</div>}
        <div className="mini">Trading involves risk; automated strategies can lose money. Start on a demo account. {site?.brand} is an independent application and is not operated by Deriv.</div>
        <PolicyLinks />
      </div>
      <CookieNotice />
    </div>
  )
}

function AccountSwitcher({ status, refresh }) {
  const u = status?.user
  const [busy, setBusy] = useState(false)
  if (!u) return null
  return (
    <select disabled={busy} value={u.active_loginid} onChange={async (e) => {
      setBusy(true)
      try { await api('/account/switch', { method: 'POST', body: { loginid: e.target.value } }) } catch (x) { alert(x.message) }
      setBusy(false); refresh()
    }}>
      {u.accounts.map((a) => <option key={a.loginid} value={a.loginid}>{a.is_virtual ? 'DEMO' : 'REAL'} · {a.loginid} · {a.currency}</option>)}
    </select>
  )
}

export default function App() {
  const site = useSite()
  const [authed, setAuthed] = useState(() => !!session.get() && !readOAuthRedirect().length)
  const [page, setPage] = useState(() => location.hash.slice(1) || 'dashboard')
  const [status, setStatus] = useState(null)
  const [wsUp, setWsUp] = useState(false)
  const [ticks, setTicks] = useState({})
  const [pending, setPending] = useState(0)
  const listeners = useRef(new Set())

  const refreshStatus = useCallback(() => api('/status').then(setStatus).catch(() => {}), [])
  const onLogin = useCallback(() => setAuthed(true), [])
  useEffect(() => { const f = () => setAuthed(false); window.addEventListener('dat-logout', f); return () => window.removeEventListener('dat-logout', f) }, [])
  useEffect(() => { if (authed) location.hash = page }, [page, authed])

  useEffect(() => {
    if (!authed) return
    refreshStatus()
    const loadPending = () => api('/signals?status=pending&limit=200').then((s) => setPending(s.length)).catch(() => {})
    loadPending()
    const t = setInterval(() => { refreshStatus(); loadPending() }, 10000)
    const stop = connectEvents((m) => {
      if (m.type === 'tick') setTicks((p) => ({ ...p, [m.data.symbol]: m.data }))
      if (['connection', 'balance', 'mode', 'emergency_stop', 'reconciled'].includes(m.type)) refreshStatus()
      if (['signal', 'signal_update', 'approval_needed'].includes(m.type)) loadPending()
      listeners.current.forEach((fn) => fn(m))
    }, setWsUp)
    return () => { clearInterval(t); stop() }
  }, [authed, refreshStatus])

  if (!authed) return <Login site={site} onDone={onLogin} />

  const subscribe = (fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn) }
  const isAdmin = status?.user?.is_admin
  const pages = PAGES.filter((p) => !p[3] || isAdmin)
  const Page = (pages.find((p) => p[0] === page) || pages[0])[2]
  const h = status?.health
  const estop = status?.emergency_stop
  const signOut = async (everywhere = false) => {
    try { await api(`/auth/logout${everywhere ? '?everywhere=true' : ''}`, { method: 'POST' }) } catch { /* ignore */ }
    flag.set(SIGNED_OUT, true)
    session.clear(); setAuthed(false)
  }

  return (
    <Live.Provider value={{ status, refreshStatus, ticks, subscribe, setPage, site, signOut }}>
      <div className="shell">
        <nav className="side">
          <div className="brand">{site?.brand}<small>{site?.tagline}</small></div>
          {pages.map(([id, label]) => (
            <button key={id} className={`nav ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}>
              {label}{id === 'signals' && pending > 0 && <span className="count">{pending}</span>}
            </button>
          ))}
          <div className="spacer" />
          <div className="mini" style={{ padding: '0 10px 6px' }}>{status?.user?.fullname || status?.user?.email}</div>
          <button className="nav" onClick={() => signOut(false)}>Sign out</button>
          <div style={{ padding: '6px 10px' }}><PolicyLinks /></div>
        </nav>
        <div className="main">
          <div className="topbar">
            <span className="mono"><span className={`dot ${h?.connected ? 'on' : 'off'}`} /></span>
            <AccountSwitcher status={status} refresh={refreshStatus} />
            <span className="mono">{fmt.money(status?.balance, status?.currency)}</span>
            <span className="badge active">MODE: {status?.mode?.toUpperCase() || '—'}</span>
            {!wsUp && <span className="badge pending">live feed reconnecting</span>}
            {status?.suspension && <span className="badge down">SUSPENDED: {status.suspension.reason}</span>}
            {status?.unresolved_orders > 0 && <span className="badge pending">{status.unresolved_orders} order(s) reconciling</span>}
            {h?.authorized && !h?.is_virtual && <span className="badge down">REAL MONEY</span>}
            <span className="grow" />
            <button className={`estop ${estop ? 'active' : ''}`} onClick={async () => {
              if (estop) { if (confirm('Clear emergency stop? Bots stay stopped until you start them.')) await api('/emergency-stop', { method: 'DELETE' }) }
              else await api('/emergency-stop', { method: 'POST' })
              refreshStatus()
            }}>{estop ? 'E-STOP ACTIVE — CLEAR' : 'EMERGENCY STOP'}</button>
          </div>
          <div className="page"><Page /></div>
        </div>
      </div>
      <CookieNotice />
    </Live.Provider>
  )
}
