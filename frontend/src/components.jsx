import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, LineStyle } from 'lightweight-charts'
import { api, fmt } from './api'

export function Kpi({ label, value, cls = '' }) {
  return <div className="kpi"><div className="l">{label}</div><div className={`v ${cls}`}>{value}</div></div>
}

export const pnlCls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')

export function Badge({ v, cls }) { return <span className={`badge ${cls ?? v}`}>{v}</span> }

export function Card({ title, right, children, className = '' }) {
  return (
    <div className={`card ${className}`}>
      {(title || right) && <div className="row between" style={{ marginBottom: 10 }}>{title && <h2 style={{ margin: 0 }}>{title}</h2>}{right}</div>}
      {children}
    </div>
  )
}

export function useApi(path, deps = [], interval = 0) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    if (!path) return
    try { setData(await api(path)); setError(null) } catch (e) { setError(e.message) }
  }, [path])
  useEffect(() => {
    load()
    if (!interval) return
    const t = setInterval(load, interval)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps])
  return [data, load, error, setData]
}

export function Action({ onClick, children, className = 'btn', confirm, disabled, onDone }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className={className} disabled={busy || disabled} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return
        setBusy(true); setErr(null)
        try { const r = await onClick(); onDone?.(r) } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }}>{busy ? '…' : children}</button>
      {err && <span className="down mini">{err}</span>}
    </span>
  )
}

const chartOpts = (h) => ({
  height: h,
  layout: { background: { color: 'transparent' }, textColor: '#7d8a9c', fontFamily: 'IBM Plex Mono' },
  grid: { vertLines: { color: '#1a212b' }, horzLines: { color: '#1a212b' } },
  rightPriceScale: { borderColor: '#222b37' },
  timeScale: { borderColor: '#222b37', timeVisible: true, secondsVisible: false },
  crosshair: { mode: 0 },
})

/** Candlestick chart with optional overlays and horizontal levels. Live bars via `liveBar`. */
export function CandleChart({ candles, overlays = [], levels = [], liveBar, height = 420, markers = [] }) {
  const el = useRef(null)
  const chart = useRef(null)
  const series = useRef(null)
  const over = useRef([])
  const lines = useRef([])

  useEffect(() => {
    const c = createChart(el.current, { ...chartOpts(height), autoSize: true })
    series.current = c.addSeries(CandlestickSeries, {
      upColor: '#22c38e', downColor: '#f0506e', borderVisible: false, wickUpColor: '#22c38e', wickDownColor: '#f0506e',
    })
    chart.current = c
    return () => { c.remove(); chart.current = null }
  }, [height])

  useEffect(() => {
    if (!series.current || !candles) return
    series.current.setData(candles)
    over.current.forEach((s) => chart.current.removeSeries(s))
    over.current = overlays.map((o) => {
      const s = chart.current.addSeries(LineSeries, { color: o.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      s.setData(o.data)
      return s
    })
    chart.current.timeScale().fitContent()
  }, [candles, overlays])

  useEffect(() => {
    if (!series.current) return
    lines.current.forEach((l) => series.current.removePriceLine(l))
    lines.current = levels.map((lv) => series.current.createPriceLine({
      price: lv.price, color: lv.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: lv.title,
    }))
  }, [levels, candles])

  useEffect(() => {
    if (liveBar && series.current && candles?.length) {
      try { series.current.update(liveBar) } catch { /* older bar */ }
    }
  }, [liveBar, candles])

  return <div ref={el} className="chart" style={{ height }} />
}

export function LineChart({ data, height = 240, color = '#4c9cff', histogram = false }) {
  const el = useRef(null)
  useEffect(() => {
    const c = createChart(el.current, { ...chartOpts(height), autoSize: true })
    const s = histogram
      ? c.addSeries(HistogramSeries, { color })
      : c.addSeries(LineSeries, { color, lineWidth: 2 })
    s.setData(histogram ? (data || []).map((d) => ({ ...d, color: d.value >= 0 ? '#22c38e' : '#f0506e' })) : (data || []))
    c.timeScale().fitContent()
    return () => c.remove()
  }, [data, height, color, histogram])
  return <div ref={el} className="chart sm" style={{ height }} />
}

export function ema(values, n) {
  const k = 2 / (n + 1); let prev = null
  return values.map((v, i) => {
    if (i < n - 1) return null
    if (prev === null) prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n
    else prev = v * k + prev * (1 - k)
    return prev
  })
}

export function bollinger(values, n = 20, k = 2) {
  return values.map((_, i) => {
    if (i < n - 1) return null
    const w = values.slice(i - n + 1, i + 1)
    const m = w.reduce((a, b) => a + b, 0) / n
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n)
    return { up: m + k * sd, mid: m, lo: m - k * sd }
  })
}

export function Stat({ label, value, cls }) { return <div><b className={cls}>{value}</b><span>{label}</span></div> }

export const statusFor = (h) => h?.connected ? (h.authorized ? (h.is_virtual ? 'DEMO' : 'REAL') : 'MARKET DATA') : 'OFFLINE'
export { fmt }
