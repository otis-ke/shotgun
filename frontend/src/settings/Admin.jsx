import { api, fmt } from '../api'
import { Action, Badge, Card, Kpi, pnlCls, useApi } from '../components'

export default function Admin() {
  const [ov, reload, err] = useApi('/admin/overview', [], 15000)
  const [errors] = useApi('/admin/errors', [], 15000)
  if (err) return <div className="alert err">{err}</div>
  if (!ov) return <div className="muted">Loading…</div>
  const online = ov.users.filter((u) => u.online).length
  const botsRunning = ov.users.reduce((n, u) => n + u.running_bots.length, 0)
  return (
    <>
      <div className="row between"><h1>Site administration</h1>
        <Action onClick={() => api('/admin/backup', { method: 'POST' })} onDone={(r) => alert(r.path ? `Backup: ${r.path}` : 'Use pg_dump for PostgreSQL')}>Backup database</Action></div>
      <div className="kpis">
        <Kpi label="Users" value={ov.users.length} />
        <Kpi label="Active connections" value={online} />
        <Kpi label="Bots running" value={botsRunning} />
        <Kpi label="Market feed" value={ov.market_feed?.connected ? 'online' : 'offline'} cls={ov.market_feed?.connected ? 'up' : 'down'} />
        <Kpi label="Uptime" value={`${Math.round(ov.uptime / 3600)} h`} />
      </div>
      <Card title="Users">
        <div className="scroll" style={{ maxHeight: 600 }}><table><thead><tr><th>User</th><th>Account</th><th>Joined</th><th>Last sign-in</th><th>Status</th><th>Running bots</th><th className="num">Trades</th><th className="num">Net P/L</th><th /></tr></thead>
          <tbody>{ov.users.map((u) => (
            <tr key={u.id}><td>{u.fullname || '—'}<div className="mini">{u.email}</div></td><td className="mono mini">{u.active_loginid}</td>
              <td className="mini">{fmt.time(u.created_at)}</td><td className="mini">{fmt.ago(u.last_login)}</td>
              <td>{u.disabled ? <Badge v="disabled" cls="down" /> : u.online ? <Badge v="online" cls="up" /> : <Badge v="offline" cls="" />}{u.is_admin && <> <Badge v="admin" cls="active" /></>}</td>
              <td className="mini">{u.running_bots.join(', ') || '—'}</td><td className="num">{u.stats.trades}</td>
              <td className={`num ${pnlCls(u.stats.net_profit)}`}>{fmt.num(u.stats.net_profit)}</td>
              <td>{!u.is_admin && <Action className={`btn sm ${u.disabled ? 'good' : 'bad'}`}
                confirm={u.disabled ? 'Re-enable this user?' : 'Disable this user? Their bots stop and they are signed out.'}
                onClick={() => api(`/admin/users/${u.id}/disable?disabled=${!u.disabled}`, { method: 'POST' })} onDone={reload}>{u.disabled ? 'Enable' : 'Disable'}</Action>}</td></tr>))}</tbody></table></div>
      </Card>
      <Card title="Server errors & warnings">
        {!errors?.length ? <div className="empty">No errors</div> :
          <div className="scroll" style={{ maxHeight: 500 }}>{errors.map((e, i) => (
            <div key={i} style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}>
              <div className="row between mini"><span className={e.level === 'ERROR' ? 'down' : 'warn'}>{e.level} · {e.logger}</span><span>{fmt.time(e.ts)}</span></div>
              <div>{e.message}</div>{e.exception && <pre>{e.exception}</pre>}</div>))}</div>}
      </Card>
    </>
  )
}
