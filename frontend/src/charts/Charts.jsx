import { useEffect, useMemo, useState } from 'react'
import { api, fmt, GRANULARITIES } from '../api'
import { useLive } from '../App'
import { Badge, Card, useApi } from '../components'
import { LiveChart } from '../dashboard/Dashboard'

const IND = [
  ['EMA 9 / 21', (i) => `${fmt.num(i.ema9, 3)} / ${fmt.num(i.ema21, 3)}`], ['EMA 50 / 200', (i) => `${fmt.num(i.ema50, 3)} / ${fmt.num(i.ema200, 3)}`],
  ['RSI 14', (i) => fmt.num(i.rsi, 1)], ['MACD / signal / hist', (i) => `${fmt.num(i.macd_macd, 4)} / ${fmt.num(i.macd_signal, 4)} / ${fmt.num(i.macd_hist, 4)}`],
  ['ADX / +DI / −DI', (i) => `${fmt.num(i.adx, 1)} / ${fmt.num(i.plus_di, 1)} / ${fmt.num(i.minus_di, 1)}`], ['ATR 14', (i) => fmt.num(i.atr, 4)],
  ['Bollinger (U/M/L)', (i) => `${fmt.num(i.bb_upper, 3)} / ${fmt.num(i.bb_mid, 3)} / ${fmt.num(i.bb_lower, 3)}`],
  ['Stochastic %K / %D', (i) => `${fmt.num(i.stoch_k, 1)} / ${fmt.num(i.stoch_d, 1)}`], ['CCI 20', (i) => fmt.num(i.cci, 1)],
  ['Parabolic SAR', (i) => `${fmt.num(i.psar_sar, 3)} (${i.psar_trend > 0 ? 'bull' : 'bear'})`],
  ['Ichimoku T/K', (i) => `${fmt.num(i.ichi_tenkan, 3)} / ${fmt.num(i.ichi_kijun, 3)}`], ['Ichimoku cloud A/B', (i) => `${fmt.num(i.ichi_span_a, 3)} / ${fmt.num(i.ichi_span_b, 3)}`],
  ['Donchian 20 (U/L)', (i) => `${fmt.num(i.don_upper, 3)} / ${fmt.num(i.don_lower, 3)}`],
  ['VWAP', (i) => i.vwap == null ? 'n/a — no volume data on Deriv' : fmt.num(i.vwap, 3)],
]

export default function Charts() {
  const { ticks } = useLive()
  const [symbols] = useApi('/markets/symbols')
  const [symbol, setSymbol] = useState('R_100')
  const [gran, setGran] = useState(300)
  const [a, setA] = useState(null)
  const [err, setErr] = useState(null)
  const load = () => api(`/markets/analysis?symbol=${symbol}&granularity=${gran}`).then((x) => { setA(x); setErr(null) }).catch((e) => setErr(e.message))
  useEffect(() => { setA(null); load(); const t = setInterval(load, Math.max(30000, gran * 1000)); return () => clearInterval(t) /* eslint-disable-next-line */ }, [symbol, gran])

  const levels = useMemo(() => (a?.levels || []).slice(0, 6).map((l) => ({
    price: l.price, color: l.type === 'support' ? '#22c38e' : '#f0506e', title: `${l.type[0].toUpperCase()}×${l.touches}` })), [a])
  const groups = useMemo(() => {
    const g = {}
    ;(symbols || []).forEach((s) => { (g[s.submarket || s.market] ||= []).push(s) })
    return g
  }, [symbols])

  return (
    <>
      <div className="row between"><h1>Charts & Market Analysis</h1>
        <div className="row">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {!symbols && <option>{symbol}</option>}
            {Object.entries(groups).map(([g, list]) => <optgroup key={g} label={g}>{list.map((s) => <option key={s.symbol} value={s.symbol}>{s.name}{s.open ? '' : ' (closed)'}</option>)}</optgroup>)}
          </select>
          <select value={gran} onChange={(e) => setGran(+e.target.value)}>{GRANULARITIES.map((g) => <option key={g} value={g}>{fmt.gran(g)}</option>)}</select>
          <button className="btn" onClick={load}>Re-analyse</button>
        </div></div>
      <Card><LiveChart symbol={symbol} gran={gran} tick={ticks[symbol]} height={460} levels={levels} />
        <div className="mini" style={{ marginTop: 6 }}>Blue EMA 21 · Orange EMA 50 · dashed lines = support/resistance clusters (touch count).</div></Card>
      {err && <div className="alert err">{err}</div>}
      {a && (
        <div className="grid g3">
          <Card title="Market state">
            <table><tbody>
              <tr><td>Regime</td><td><Badge v={a.regime.name} /></td></tr>
              <tr><td>Trend (EMA stack)</td><td className={a.trend > 0 ? 'up' : a.trend < 0 ? 'down' : ''}>{a.trend > 0 ? 'Up' : a.trend < 0 ? 'Down' : 'None'}</td></tr>
              <tr><td>Structure</td><td>{a.structure.structure} {a.structure.hh && 'HH'} {a.structure.hl && 'HL'} {a.structure.lh && 'LH'} {a.structure.ll && 'LL'}</td></tr>
              <tr><td>Break of structure</td><td>{a.structure.bos || '—'}</td></tr>
              <tr><td>Consolidation</td><td>{a.consolidation.in_range ? `yes (${fmt.num(a.consolidation.width_atr, 1)} ATR wide)` : 'no'}</td></tr>
              <tr><td>RSI divergence</td><td>{a.rsi_div || '—'}</td></tr>
              <tr><td>MACD divergence</td><td>{a.macd_div || '—'}</td></tr>
              <tr><td>ATR percentile</td><td>{fmt.pct(a.regime.atr_percentile, 0)}</td></tr>
              <tr><td>Patterns</td><td className="mini">{Object.entries(a.patterns).filter(([, v]) => v).map(([k]) => k.replace(/_/g, ' ')).join(', ') || '—'}</td></tr>
            </tbody></table>
          </Card>
          <Card title="Indicators (last closed candle)">
            <table><tbody>{IND.map(([k, f]) => <tr key={k}><td className="mini">{k}</td><td className="num">{f(a.indicators)}</td></tr>)}</tbody></table>
          </Card>
          <Card title="Specialist signals now">
            <table><tbody>{Object.entries(a.signals).map(([k, s]) => (
              <tr key={k}><td>{k.replace('_', ' ')}</td><td>{s ? <><Badge v={s.direction} cls={s.direction === 'UP' ? 'up' : 'down'} /> <span className="mono">{fmt.num(s.score, 0)}</span>
                <div className="mini">{s.reasons.join(', ')}</div></> : <span className="muted">no setup</span>}</td></tr>))}</tbody></table>
            <h2 style={{ marginTop: 14 }}>Supply / demand zones</h2>
            {(a.zones || []).length ? a.zones.map((z, i) => <div key={i} className="mini mono">{z.type} {fmt.num(z.low, 3)}–{fmt.num(z.high, 3)} ({z.age} bars ago)</div>) : <div className="mini">none detected</div>}
          </Card>
        </div>)}
    </>
  )
}
