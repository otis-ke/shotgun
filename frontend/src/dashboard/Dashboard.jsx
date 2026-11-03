import { useEffect, useMemo, useState } from 'react'
import { api, fmt } from '../api'
import { useLive } from '../App'
import { Badge, Card, CandleChart, Kpi, pnlCls, useApi, ema, Action } from '../components'

export default function Dashboard() {
  const { subscribe, ticks, status } = useLive()
  const [d, reload, err] = useApi('/dashboard', [], 15000)
  useEffect(() => subscribe((m) => {
    if (['trade_opened', 'trade_closed', 'signal', 'signal_update', 'balance', 'bot', 'analysis'].includes(m.type)) reload()
  }), [subscribe, reload])

  const syms = useMemo(() => {
    const s = new Set((d?.market || []).map((m) => `${m.symbol}:${m.granularity}`))
    if (!s.size) s.add('R_100:60')
    return [...s]
  }, [d?.market])
  const [sel, setSel] = useState(null)
  const cur = sel && syms.includes(sel) ? sel : syms[0]
  const [symbol, gran] = cur.split(':')

  if (err) return <div className="alert err">{err}</div>
  if (!d) return <div className="muted">Loading…</div>
  const cur$ = d.currency || ''
  const r = d.risk || {}
  const lim = r.limits || {}
  const s = d.stats || {}

  return (
    <>
      <div className="row between"><h1>Dashboard</h1><span className="mini">Statistics are calculated only from recorded trades.</span></div>
      {status?.health && !status.health.is_virtual && status.health.authorized && !status.trading_permission?.[0] && <div className="alert warn">You're on a REAL account. Bots won't trade it until you authorize real-money trading in Settings — or switch back to your demo account in the top bar.</div>}
      <div className="kpis">
        <Kpi label="Balance" value={fmt.money(d.balance, cur$)} />
        <Kpi label="Available" value={fmt.money(d.available_balance, cur$)} />
        <Kpi label="Total P/L" value={fmt.money(d.pnl.total)} cls={pnlCls(d.pnl.total)} />
        <Kpi label="Today P/L" value={fmt.money(d.pnl.daily)} cls={pnlCls(d.pnl.daily)} />
        <Kpi label="Week P/L" value={fmt.money(d.pnl.weekly)} cls={pnlCls(d.pnl.weekly)} />
        <Kpi label="Month P/L" value={fmt.money(d.pnl.monthly)} cls={pnlCls(d.pnl.monthly)} />
        <Kpi label="Active bots" value={d.active_bots.length} />
        <Kpi label="Running trades" value={d.open_trades.length} />
        <Kpi label="Won / Lost" value={<><span className="up">{s.wins}</span> / <span className="down">{s.losses}</span></>} />
        <Kpi label="Win rate" value={fmt.pct(s.win_rate)} />
        <Kpi label="Max drawdown" value={fmt.money(s.max_drawdown)} cls="down" />
        <Kpi label="Exposure" value={`${fmt.money(r.exposure)} (${fmt.num(r.exposure_pct, 1)}%)`} />
      </div>

      <div className="grid g-main">
        <Card title="Live market" right={
          <select value={cur} onChange={(e) => setSel(e.target.value)}>{syms.map((x) => <option key={x} value={x}>{x.replace(':', ' · ')}s</option>)}</select>}>
          <LiveChart symbol={symbol} gran={+gran} tick={ticks[symbol]} />
        </Card>
        <Card title="Risk exposure">
          <RiskBar label="Daily loss" v={-Math.min(0, r.daily_pnl_pct || 0)} max={lim.max_daily_loss_pct} />
          <RiskBar label="Drawdown" v={r.drawdown_pct} max={lim.max_drawdown_pct} />
          <RiskBar label="Consecutive losses" v={r.consecutive_losses} max={lim.max_consecutive_losses} unit="" />
          <RiskBar label="Open trades" v={r.open_trades} max={lim.max_open_trades} unit="" />
          <RiskBar label="Exposure" v={r.exposure_pct} max={lim.max_exposure_pct} />
          <RiskBar label="Trades / hour" v={r.trades_last_hour} max={lim.max_trades_per_hour} unit="" />
          {r.suspension && <div className="alert err" style={{ marginTop: 10 }}>Suspended: {r.suspension.reason}
            {r.suspension.until && <> until {fmt.time(r.suspension.until)}</>}</div>}
        </Card>
      </div>

      <Card title="Market conditions">
        {!d.market.length ? <div className="empty">Start a bot to stream and analyse its markets.</div> :
          <div className="scroll"><table><thead><tr><th>Market</th><th>Price</th><th>Regime</th><th>Trend</th><th>Structure</th><th className="num">ADX</th><th className="num">RSI</th><th className="num">ATR</th><th>Patterns</th></tr></thead>
            <tbody>{d.market.map((m) => (
              <tr key={`${m.symbol}${m.granularity}`}>
                <td className="mono">{m.symbol} <span className="muted">{fmt.gran(m.granularity)}</span></td>
                <td className="num">{fmt.num(ticks[m.symbol]?.price ?? m.close, 3)}</td>
                <td><Badge v={m.regime.name} cls={m.regime.name.includes('up') ? 'up' : m.regime.name.includes('down') ? 'down' : ''} /></td>
                <td className={m.trend > 0 ? 'up' : m.trend < 0 ? 'down' : 'muted'}>{m.trend > 0 ? '▲ up' : m.trend < 0 ? '▼ down' : 'flat'}</td>
                <td>{m.structure.structure}{m.structure.bos && <span className="mini"> · BOS {m.structure.bos}</span>}</td>
                <td className="num">{fmt.num(m.indicators.adx, 1)}</td>
                <td className="num">{fmt.num(m.indicators.rsi, 1)}</td>
                <td className="num">{fmt.num(m.indicators.atr, 3)}</td>
                <td className="mini">{Object.entries(m.patterns).filter(([, v]) => v).map(([k]) => k.replace(/_/g, ' ')).join(', ') || '—'}</td>
              </tr>))}</tbody></table></div>}
      </Card>

      <div className="grid g2">
        <Card title={`Running trades (${d.open_trades.length})`}>
          {!d.open_trades.length ? <div className="empty">No open positions</div> :
            <div className="scroll"><table><thead><tr><th>Contract</th><th>Bot</th><th>Market</th><th>Side</th><th className="num">Stake</th><th className="num">Payout</th><th>Opened</th><th /></tr></thead>
              <tbody>{d.open_trades.map((t) => (
                <tr key={t.contract_id}><td className="mono">{t.contract_id}</td><td>{t.bot_id}</td><td>{t.symbol}</td>
                  <td>{t.direction ? <Badge v={t.direction} cls={t.direction === 'UP' ? 'up' : 'down'} /> : t.contract_type}</td>
                  <td className="num">{fmt.money(t.stake)}</td><td className="num">{fmt.money(t.payout)}</td><td className="mini">{fmt.ago(t.buy_time)}</td>
                  <td>{t.contract_type?.startsWith('MULT') && <Action className="btn sm bad" confirm="Close this position at market?" onClick={() => api(`/trades/${t.contract_id}/sell`, { method: 'POST' })} onDone={reload}>Close</Action>}</td>
                </tr>))}</tbody></table></div>}
        </Card>
        <Card title="Recent signals">
          <div className="scroll"><table><thead><tr><th>Time</th><th>Bot</th><th>Market</th><th>Side</th><th className="num">Conf.</th><th className="num">p(win)</th><th>Status</th></tr></thead>
            <tbody>{d.recent_signals.map((s) => (
              <tr key={s.id} title={(s.reasons || []).join('\n') + (s.decision ? `\n→ ${s.decision}` : '')}>
                <td className="mini">{fmt.ago(s.ts)}</td><td>{s.bot_id}</td><td>{s.symbol}</td>
                <td><Badge v={s.direction} cls={s.direction === 'UP' ? 'up' : 'down'} /></td>
                <td className="num">{fmt.num(s.confidence, 0)}</td><td className="num">{fmt.pct(s.calibrated_p)}</td>
                <td><Badge v={s.status} /></td></tr>))}</tbody></table>
            {!d.recent_signals.length && <div className="empty">No signals yet</div>}</div>
        </Card>
      </div>
    </>
  )
}

function RiskBar({ label, v, max, unit = '%' }) {
  const pct = max ? Math.min(100, ((v || 0) / max) * 100) : 0
  const color = pct >= 100 ? 'var(--down)' : pct >= 66 ? 'var(--warn)' : 'var(--up)'
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row between mini"><span>{label}</span><span className="mono">{fmt.num(v || 0, unit ? 2 : 0)}{unit} / {max ?? '—'}{unit}</span></div>
      <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} /></div>
    </div>
  )
}

export function LiveChart({ symbol, gran, tick, height = 380, levels = [] }) {
  const [candles, setCandles] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let alive = true
    setCandles(null); setErr(null)
    api('/markets/watch', { method: 'POST', body: { symbol, granularity: gran } }).catch(() => {})
    api(`/markets/candles?symbol=${symbol}&granularity=${gran}&count=400`)
      .then((c) => alive && setCandles(c)).catch((e) => alive && setErr(e.message))
    return () => { alive = false }
  }, [symbol, gran])
  const overlays = useMemo(() => {
    if (!candles?.length) return []
    const closes = candles.map((c) => c.close)
    const mk = (n, color) => ({ color, data: ema(closes, n).map((v, i) => v === null ? null : { time: candles[i].time, value: v }).filter(Boolean) })
    return [mk(21, '#4c9cff'), mk(50, '#f5a524')]
  }, [candles])
  const live = tick && tick.granularity === gran ? { time: tick.time, open: tick.open, high: tick.high, low: tick.low, close: tick.close } : null
  if (err) return <div className="alert err">{err}</div>
  if (!candles) return <div className="empty" style={{ height }}>Loading market data…</div>
  return <CandleChart candles={candles} overlays={overlays} liveBar={live} height={height} levels={levels} />
}
