import { fmt } from '../api'
import { Card, LineChart, pnlCls, useApi } from '../components'

export default function Analytics() {
  const [p] = useApi('/analytics/performance', [], 30000)
  const [c] = useApi('/analytics/calibration', [], 60000)
  const [deg] = useApi('/analytics/degradation', [], 60000)
  if (!p) return <div className="muted">Loading…</div>
  const daily = p.daily_pnl.map((d) => ({ time: d.date, value: d.pnl }))
  const bal = p.balance_history.map((b) => ({ time: Math.floor(b.ts), value: b.balance }))
  const regimes = c?.regimes || {}
  const regimeNames = [...new Set(Object.values(regimes).flatMap((r) => Object.keys(r)))]
  return (
    <>
      <h1>Performance Analytics</h1>
      <div className="grid g2">
        <Card title="Cumulative P/L (settled trades)">{p.equity_curve.length > 1 ? <LineChart data={uniq(p.equity_curve)} /> : <div className="empty">Not enough trades yet</div>}</Card>
        <Card title="Daily P/L">{daily.length ? <LineChart data={daily} histogram /> : <div className="empty">No settled trades yet</div>}</Card>
      </div>
      {bal.length > 1 && <Card title="Account balance (sampled every minute)"><LineChart data={uniq(bal)} color="#7b61ff" /></Card>}
      <Card title="Strategy comparison (live / demo record)">
        <table><thead><tr><th>Bot</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Net P/L</th><th className="num">Profit factor</th><th className="num">Expectancy</th><th className="num">Max DD</th><th className="num">Open</th><th>Health</th></tr></thead>
          <tbody>{Object.entries(p.by_bot).map(([b, s]) => {
            const d = (deg || []).find((x) => x.bot_id === b)
            return <tr key={b}><td>{b}</td><td className="num">{s.trades}</td><td className="num">{fmt.pct(s.win_rate)}</td>
              <td className={`num ${pnlCls(s.net_profit)}`}>{fmt.num(s.net_profit)}</td><td className="num">{fmt.num(s.profit_factor)}</td>
              <td className="num">{fmt.num(s.expectancy, 3)}</td><td className="num">{fmt.num(s.max_drawdown)}</td><td className="num">{s.open}</td>
              <td className={d?.degraded ? 'down' : 'muted'}>{d ? (d.degraded ? `degraded (z=${d.z})` : d.trades >= 30 ? `ok (z=${d.z})` : `${d.trades}/30 trades`) : '—'}</td></tr>
          })}</tbody></table>
      </Card>
      <div className="grid g2">
        <Card title="Score calibration (out-of-sample + recorded trades)">
          {!c || !Object.keys(c.calibration).length ? <div className="empty">Run walk-forward validations to calibrate confidence scores.</div> :
            Object.entries(c.calibration).map(([s, d]) => (
              <div key={s} style={{ marginBottom: 12 }}>
                <div className="row between"><b>{s}</b><span className="mini">{d.samples} samples · base win rate {fmt.pct(d.base_win_rate)} {d.ready ? '' : '· not enough data'}</span></div>
                <table><tbody><tr>{d.bins.map((b, i) => <td key={i} className="num mini">score ≥{fmt.num(b.score_from, 0)}<br /><b className="mono">{fmt.pct(b.win_rate, 0)}</b> <span className="muted">n={b.n}</span></td>)}</tr></tbody></table>
              </div>))}
        </Card>
        <Card title="Win rate by market regime">
          {!regimeNames.length ? <div className="empty">No regime data yet</div> :
            <div className="scroll"><table><thead><tr><th>Strategy</th>{regimeNames.map((r) => <th key={r} className="num">{r}</th>)}</tr></thead>
              <tbody>{Object.entries(regimes).map(([s, rs]) => <tr key={s}><td>{s}</td>{regimeNames.map((r) =>
                <td key={r} className="num">{rs[r] ? <>{fmt.pct(rs[r].win_rate, 0)} <span className="muted mini">({rs[r].n})</span></> : '—'}</td>)}</tr>)}</tbody></table></div>}
        </Card>
      </div>
    </>
  )
}

function uniq(arr) {
  const m = new Map(); arr.forEach((p) => m.set(p.time, p.value))
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }))
}
