import { useEffect, useState } from 'react'
import { api, fmt } from '../api'
import { useLive } from '../App'
import { Action, Card, useApi } from '../components'

const MODES = [
  ['demo', 'Demo', 'Full automation, but only on a Deriv demo (virtual) account. Refuses to trade if a real account is connected.'],
  ['manual', 'Manual', 'Bots analyse and generate signals. You approve every trade.'],
  ['semi', 'Semi-automatic', 'Bots with “auto-execute” enabled trade on their own within the limits; others wait for approval.'],
  ['full', 'Full auto', 'All enabled bots trade automatically. Risk limits stop trading when breached.'],
]
const RISK = [
  ['risk_pct_per_trade', 'Risk per trade (%)', 0.1], ['fixed_stake', 'Fixed stake (overrides %)', 0.01], ['min_stake', 'Min stake', 0.01],
  ['max_stake', 'Max stake per trade', 1], ['max_daily_loss_pct', 'Max daily loss (%)', 0.5], ['max_drawdown_pct', 'Max drawdown (%)', 0.5],
  ['max_consecutive_losses', 'Max consecutive losses', 1], ['cooldown_minutes', 'Cooldown after loss streak (min)', 5],
  ['max_open_trades', 'Max simultaneous trades', 1], ['max_open_per_symbol', 'Max open per market', 1],
  ['max_trades_per_hour', 'Max trades per hour', 1], ['max_exposure_pct', 'Max exposure (% balance)', 0.5],
  ['daily_profit_target_pct', 'Daily profit target (%)', 0.5], ['min_balance', 'Balance protection floor', 1],
]
const PHRASE = 'I ACCEPT REAL MONEY RISK'

export default function Settings() {
  const { status, refreshStatus, signOut } = useLive()
  const h = status?.health || {}
  const [risk, reloadRisk] = useApi('/risk')
  const [rf, setRf] = useState(null)
  const [riskMsg, setRiskMsg] = useState(null)
  const [conf, setConf] = useState({ loginid: '', confirmation: '' })
  useEffect(() => { if (risk) setRf(Object.fromEntries(RISK.map(([k]) => [k, risk.limits[k] ?? '']))) }, [risk])

  const realAuth = status?.real_authorization
  return (
    <>
      <h1>Settings</h1>
      <div className="grid g2">
        <Card title="Your Deriv accounts">
          <table><tbody>
            <tr><td>Signed in as</td><td>{status?.user?.fullname} <span className="muted">{status?.user?.email}</span></td></tr>
            <tr><td>Connection</td><td>{h.connected ? (h.authorized ? 'Connected' : 'Connecting…') : `Offline ${h.last_error ? '— ' + h.last_error : ''}`}{h.latency_ms ? <span className="muted"> · {h.latency_ms} ms</span> : null}</td></tr>
            <tr><td>Balance</td><td className="mono">{fmt.money(status?.balance, status?.currency)}</td></tr>
          </tbody></table>
          <h2 style={{ marginTop: 14 }}>Linked accounts</h2>
          <table><tbody>{(status?.user?.accounts || []).map((a) => (
            <tr key={a.loginid}><td className="mono">{a.loginid}</td><td>{a.is_virtual ? <span className="up">Demo</span> : <span className="down">Real</span>}</td><td>{a.currency}</td>
              <td>{a.loginid === status.user.active_loginid ? <span className="badge active">active</span> :
                <Action className="btn sm" onClick={() => api('/account/switch', { method: 'POST', body: { loginid: a.loginid } })} onDone={refreshStatus}>Use this account</Action>}</td></tr>))}</tbody></table>
          <div className="mini" style={{ margin: '10px 0' }}>Accounts come from your Deriv login. To add one (e.g. a new real account), open it on Deriv, then sign out here and log in with Deriv again. Switching account requires all bots to be stopped.</div>
          <div className="row">
            <button className="btn" onClick={() => signOut(true)}>Sign out on all devices</button>
            <Action className="btn bad" confirm="Stop all bots, revoke this site's access to your Deriv accounts and sign out?"
              onClick={() => api('/auth/logout?revoke=true', { method: 'POST' })} onDone={() => signOut(false)}>Disconnect Deriv & sign out</Action>
          </div>
        </Card>

        <Card title="Operating mode">
          {MODES.map(([k, l, d]) => (
            <label key={k} className="row" style={{ alignItems: 'flex-start', gap: 8, marginBottom: 10, cursor: 'pointer', flexWrap: 'nowrap' }}>
              <input type="radio" name="mode" checked={status?.mode === k} onChange={async () => {
                try { await api('/mode', { method: 'PUT', body: { mode: k } }) } catch (e) { alert(e.message) }
                refreshStatus()
              }} />
              <div><b>{l}</b><div className="mini">{d}</div></div>
            </label>))}
          <div className="mini">Trading permission: <b className={status?.trading_permission?.[0] ? 'up' : 'down'}>{status?.trading_permission?.[1]}</b></div>
        </Card>
      </div>

      <Card title="Real-money authorization">
        {h.authorized && !h.is_virtual ? (realAuth?.authorized && realAuth.loginid === h.loginid
          ? <div className="row between"><div className="alert warn" style={{ flex: 1 }}>Automated real-money trading is AUTHORIZED for {realAuth.loginid} since {fmt.time(realAuth.at)}.</div>
            <Action className="btn bad" onClick={() => api('/deriv/authorize-real', { method: 'DELETE' })} onDone={refreshStatus}>Revoke</Action></div>
          : <>
            <div className="alert err">A REAL account is connected. Bots will not place trades on it until you authorize below. Only do this after strategies have passed walk-forward validation and run profitably on demo. Losses are real and can reach your configured limits.</div>
            <div className="form" style={{ marginTop: 10 }}>
              <label className="f">Type the account id ({h.loginid})<input value={conf.loginid} onChange={(e) => setConf({ ...conf, loginid: e.target.value })} /></label>
              <label className="f">Type: {PHRASE}<input value={conf.confirmation} onChange={(e) => setConf({ ...conf, confirmation: e.target.value })} /></label>
              <Action className="btn bad" disabled={conf.loginid !== h.loginid || conf.confirmation !== PHRASE}
                onClick={() => api('/deriv/authorize-real', { method: 'POST', body: conf })} onDone={refreshStatus}>Authorize real-money trading</Action>
            </div></>)
          : <div className="mini">Your active account is {h.authorized ? 'a demo account — no authorization needed' : 'not connected yet'}. To trade real money, switch to your real account above; automated trading on it then needs this one-time authorization.</div>}
      </Card>

      <Card title="Risk management (applies to every bot, including Smart AI)">
        {!rf ? 'Loading…' : <>
          <div className="form">{RISK.map(([k, l, step]) => (
            <label key={k} className="f">{l}<input type="number" step={step} value={rf[k] ?? ''} placeholder="off" onChange={(e) => setRf({ ...rf, [k]: e.target.value })} /></label>))}</div>
          <div className="mini" style={{ margin: '8px 0' }}>Stake is a fixed fraction of the current balance and never increases after a loss — martingale and loss-chasing are impossible by design. Risk per trade is capped at 5%.</div>
          <div className="row">
            <Action className="btn primary" onClick={() => api('/risk', { method: 'PUT', body: Object.fromEntries(Object.entries(rf).map(([k, v]) => [k, v === '' ? null : +v])) })}
              onDone={() => { setRiskMsg('Saved'); reloadRisk() }}>Save risk settings</Action>
            {riskMsg && <span className="up mini">{riskMsg}</span>}
          </div>
        </>}
      </Card>

      <Card title="Maintenance">
        <div className="row">
          <Action onClick={() => api('/risk/resume', { method: 'POST' })} onDone={refreshStatus} confirm="Clear the current risk suspension?">Clear risk suspension</Action>
          <Action onClick={() => api('/risk/reset-peak', { method: 'POST' })} confirm="Reset the drawdown reference to the current balance?">Reset drawdown peak</Action>
          <Action onClick={() => api('/system/reconcile', { method: 'POST' })} onDone={(r) => alert(`Resolved ${r.resolved.length}, adopted ${r.adopted.length}`)}>Reconcile with Deriv</Action>
        </div>
      </Card>
    </>
  )
}
