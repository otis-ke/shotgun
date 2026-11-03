import { useState } from 'react'
import { api, fmt, GRANULARITIES } from '../api'
import { Card, LineChart, pnlCls, useApi } from '../components'

export default function Backtest() {
  const [strats] = useApi('/strategies')
  const [f, setF] = useState({ symbol: 'R_100', granularity: 300, days: 30, family: 'rise_fall', duration_bars: 3,
    payout_ratio: 0.9, barrier_atr_mult: 1, multiplier: 50, sl_pct: 50, tp_pct: 50, min_score: 0, walk_forward: false, folds: 4,
    risk_pct: 1, initial_balance: 1000 })
  const [sel, setSel] = useState(['trend', 'price_action', 'scalping'])
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const run = async () => {
    setBusy(true); setErr(null)
    try {
      setRes(await api('/backtest', { method: 'POST', body: {
        strategies: sel, symbol: f.symbol, granularity: +f.granularity, days: +f.days, walk_forward: f.walk_forward, folds: +f.folds,
        min_score: +f.min_score, contract: { family: f.family, duration_bars: +f.duration_bars, payout_ratio: +f.payout_ratio,
          barrier_atr_mult: +f.barrier_atr_mult, multiplier: +f.multiplier, sl_pct: +f.sl_pct, tp_pct: +f.tp_pct,
          risk_pct: +f.risk_pct, initial_balance: +f.initial_balance } } }))
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const rows = res ? Object.entries(res.results).map(([k, r]) => [k, r.oos_stats || r.stats, r]) : []
  return (
    <>
      <h1>Backtesting & Strategy Comparison</h1>
      <div className="alert info">Signals use closed candles only and contracts enter at the next candle's open. Equal exit price counts as a loss (Deriv Rise/Fall rule). Use the payout your Deriv proposals actually show — results are very sensitive to it.</div>
      <Card>
        <div className="form">
          <label className="f">Market<input value={f.symbol} onChange={set('symbol')} /></label>
          <label className="f">Timeframe<select value={f.granularity} onChange={set('granularity')}>{GRANULARITIES.map((g) => <option key={g} value={g}>{fmt.gran(g)}</option>)}</select></label>
          <label className="f">History (days)<input type="number" value={f.days} onChange={set('days')} /></label>
          <label className="f">Contract<select value={f.family} onChange={set('family')}>{['rise_fall', 'higher_lower', 'touch', 'no_touch', 'multiplier'].map((x) => <option key={x}>{x}</option>)}</select></label>
          <label className="f">Duration (candles)<input type="number" value={f.duration_bars} onChange={set('duration_bars')} /></label>
          {f.family !== 'multiplier' && <label className="f">Payout ratio<input type="number" step="0.01" value={f.payout_ratio} onChange={set('payout_ratio')} /></label>}
          {['touch', 'no_touch', 'higher_lower'].includes(f.family) && <label className="f">Barrier (ATR ×)<input type="number" step="0.1" value={f.barrier_atr_mult} onChange={set('barrier_atr_mult')} /></label>}
          {f.family === 'multiplier' && <>
            <label className="f">Multiplier<input type="number" value={f.multiplier} onChange={set('multiplier')} /></label>
            <label className="f">Stop loss % stake<input type="number" value={f.sl_pct} onChange={set('sl_pct')} /></label>
            <label className="f">Take profit % stake<input type="number" value={f.tp_pct} onChange={set('tp_pct')} /></label></>}
          <label className="f">Min score<input type="number" value={f.min_score} onChange={set('min_score')} /></label>
          <label className="f">Risk % / trade<input type="number" step="0.1" value={f.risk_pct} onChange={set('risk_pct')} /></label>
          <label className="f">Start balance<input type="number" value={f.initial_balance} onChange={set('initial_balance')} /></label>
          <label className="f row" style={{ flexDirection: 'row', gap: 6 }}><input type="checkbox" checked={f.walk_forward} onChange={set('walk_forward')} />Walk-forward (OOS)</label>
          {f.walk_forward && <label className="f">Folds<input type="number" value={f.folds} onChange={set('folds')} /></label>}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          {(strats || []).map((s) => <label key={s.id} className="row mini" style={{ gap: 4 }}><input type="checkbox" checked={sel.includes(s.id)}
            onChange={(e) => setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} />{s.name}</label>)}
        </div>
        <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={busy || !sel.length} onClick={run}>{busy ? 'Running…' : 'Run backtest'}</button></div>
      </Card>
      {err && <div className="alert err">{err}</div>}
      {res && (
        <>
          <Card title={`Comparison — ${res.symbol} ${fmt.gran(res.granularity)}, ${res.bars} candles (${fmt.time(res.from)} → ${fmt.time(res.to)}) · breakeven win rate ${fmt.pct(res.breakeven_win_rate)}`}>
            <div className="scroll"><table><thead><tr><th>Strategy</th>{f.walk_forward && <th>Validation</th>}<th className="num">Trades</th><th className="num">Win rate</th><th className="num">Profit factor</th><th className="num">Net</th><th className="num">Return</th><th className="num">Max DD</th><th className="num">Expectancy</th><th className="num">Avg ret/stake</th><th className="num">Max loss streak</th></tr></thead>
              <tbody>{rows.map(([k, s, r]) => (
                <tr key={k}><td>{k}</td>{f.walk_forward && <td className={r.passed_validation ? 'up' : 'down'}>{r.passed_validation ? 'passed' : 'failed'} ({r.positive_folds}/{r.folds})</td>}
                  <td className="num">{s.trades}</td><td className="num">{fmt.pct(s.win_rate)}</td><td className="num">{fmt.num(s.profit_factor)}</td>
                  <td className={`num ${pnlCls(s.net_profit)}`}>{fmt.num(s.net_profit)}</td><td className={`num ${pnlCls(s.return_pct)}`}>{fmt.num(s.return_pct)}%</td>
                  <td className="num">{fmt.num(s.max_drawdown_pct)}%</td><td className="num">{fmt.num(s.expectancy, 3)}</td><td className="num">{fmt.num(s.avg_return_pct)}%</td>
                  <td className="num">{s.max_consecutive_losses}</td></tr>))}</tbody></table></div>
          </Card>
          {!f.walk_forward && <div className="grid g2">{rows.map(([k, , r]) => (
            <Card key={k} title={`${k} equity`}>{r.equity?.length > 1 ? <LineChart data={dedupe(r.equity)} /> : <div className="empty">No trades</div>}</Card>))}</div>}
        </>)}
    </>
  )
}

function dedupe(eq) {
  const m = new Map(); eq.forEach(([t, v]) => m.set(t, v))
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }))
}
