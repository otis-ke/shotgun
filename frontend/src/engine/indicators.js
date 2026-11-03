// Technical indicators (port of backend/indicators). All causal: value at bar t uses bars <= t.
import {
  diff, div0, ewm, isNum, map2, nans, rmax, rmean, rmin, rolling, rollingRankPct, rstd0, shift, sub,
} from './series.js'

const wilder = (s, n) => ewm(s, 1 / n, n)
export const sma = (s, n) => rmean(s, n, n)
export const ema = (s, n) => ewm(s, 2 / (n + 1), n)

export function rsi(s, n = 14) {
  const d = diff(s)
  const up = wilder(d.map((x) => (isNum(x) ? Math.max(x, 0) : NaN)), n)
  const dn = wilder(d.map((x) => (isNum(x) ? -Math.min(x, 0) : NaN)), n)
  return up.map((u, i) => {
    if (!isNum(u)) return NaN
    if (dn[i] === 0) return 100
    return 100 - 100 / (1 + u / dn[i])
  })
}

export function macd(s, fast = 12, slow = 26, signal = 9) {
  const line = sub(ema(s, fast), ema(s, slow))
  const sig = ewm(line, 2 / (signal + 1), signal)
  return { macd: line, signal: sig, hist: sub(line, sig) }
}

export function trueRange(df) {
  const pc = shift(df.close)
  return df.high.map((h, i) => {
    const vals = [h - df.low[i], Math.abs(h - pc[i]), Math.abs(df.low[i] - pc[i])].filter(isNum)
    return vals.length ? Math.max(...vals) : NaN
  })
}

export const atr = (df, n = 14) => wilder(trueRange(df), n)

export function adx(df, n = 14) {
  const up = diff(df.high), dn = diff(df.low).map((x) => -x)
  const plusDm = up.map((u, i) => (u > dn[i] && u > 0 ? u : 0))
  const minusDm = dn.map((d, i) => (d > up[i] && d > 0 ? d : 0))
  const tr = wilder(trueRange(df), n)
  const pdi = map2(wilder(plusDm, n), tr, (a, b) => (100 * a) / b)
  const mdi = map2(wilder(minusDm, n), tr, (a, b) => (100 * a) / b)
  const dx = pdi.map((p, i) => { const s = p + mdi[i]; return s === 0 ? NaN : (100 * Math.abs(p - mdi[i])) / s })
  return { adx: wilder(dx, n), plus_di: pdi, minus_di: mdi }
}

export function bollinger(s, n = 20, k = 2) {
  const mid = sma(s, n), sd = rstd0(s, n, n)
  const upper = map2(mid, sd, (m, d) => m + k * d), lower = map2(mid, sd, (m, d) => m - k * d)
  return { mid, upper, lower, width: div0(sub(upper, lower), mid), pct_b: div0(sub(s, lower), sub(upper, lower)) }
}

export function stochastic(df, k = 14, d = 3, smooth = 3) {
  const ll = rmin(df.low, k), hh = rmax(df.high, k)
  const raw = df.close.map((c, i) => { const r = hh[i] - ll[i]; return r === 0 ? NaN : (100 * (c - ll[i])) / r })
  const kline = rmean(raw, smooth, smooth)
  return { k: kline, d: rmean(kline, d, d) }
}

export function cci(df, n = 20) {
  const tp = df.high.map((h, i) => (h + df.low[i] + df.close[i]) / 3)
  const m = rmean(tp, n, n)
  const md = rolling(tp, n, (v) => { const mu = v.reduce((s, x) => s + x, 0) / v.length; return v.reduce((s, x) => s + Math.abs(x - mu), 0) / v.length }, n)
  return tp.map((t, i) => (md[i] === 0 ? NaN : (t - m[i]) / (0.015 * md[i])))
}

export function parabolicSar(df, step = 0.02, maxStep = 0.2) {
  const h = df.high, l = df.low, n = h.length
  const sar = nans(n), trend = new Array(n).fill(0)
  if (n < 3) return { sar, trend }
  let up = h[1] > h[0]
  let af = step, ep = up ? h[1] : l[1]
  let s = up ? l[0] : h[0]
  for (let i = 1; i < n; i++) {
    s = s + af * (ep - s)
    if (up) {
      s = Math.min(s, l[i - 1], i > 1 ? l[i - 2] : l[i - 1])
      if (l[i] < s) { up = false; s = ep; ep = l[i]; af = step } else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, maxStep) }
    } else {
      s = Math.max(s, h[i - 1], i > 1 ? h[i - 2] : h[i - 1])
      if (h[i] > s) { up = true; s = ep; ep = h[i]; af = step } else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, maxStep) }
    }
    sar[i] = s; trend[i] = up ? 1 : -1
  }
  return { sar, trend }
}

export function ichimoku(df, t = 9, k = 26, s = 52) {
  const mid = (n) => map2(rmax(df.high, n), rmin(df.low, n), (a, b) => (a + b) / 2)
  const tenkan = mid(t), kijun = mid(k)
  return { tenkan, kijun, span_a: shift(map2(tenkan, kijun, (a, b) => (a + b) / 2), k), span_b: shift(mid(s), k) }
}

/** Channel of the previous n bars. */
export function donchian(df, n = 20) {
  const upper = shift(rmax(df.high, n)), lower = shift(rmin(df.low, n))
  return { upper, lower, mid: map2(upper, lower, (a, b) => (a + b) / 2) }
}

/** Wide indicator set (backend/indicators.compute_all). Deriv candles carry no volume -> no VWAP. */
export function computeAll(df) {
  const c = df.close
  const f = { t: df.t, open: df.open, high: df.high, low: df.low, close: c }
  for (const n of [9, 21, 50, 200]) f[`ema${n}`] = ema(c, n)
  f.sma20 = sma(c, 20)
  f.rsi = rsi(c)
  const m = macd(c); f.macd_macd = m.macd; f.macd_signal = m.signal; f.macd_hist = m.hist
  Object.assign(f, adx(df))
  f.atr = atr(df)
  const b = bollinger(c); for (const k in b) f[`bb_${k}`] = b[k]
  const st = stochastic(df); f.stoch_k = st.k; f.stoch_d = st.d
  f.cci = cci(df)
  const ps = parabolicSar(df); f.psar_sar = ps.sar; f.psar_trend = ps.trend
  const ic = ichimoku(df); for (const k in ic) f[`ichi_${k}`] = ic[k]
  const dc = donchian(df); for (const k in dc) f[`don_${k}`] = dc[k]
  f.vwap = nans(c.length)
  return f
}

/** Memoised rolling percentile ranks used by regime and two strategies (expensive, shared). */
export function rankCache(f, key) {
  f._rank ??= {}
  if (!f._rank[key]) {
    const src = key === 'atr_pct' ? div0(f.atr, f.close) : f[key]
    f._rank[key] = rollingRankPct(src, 200, 50)
  }
  return f._rank[key]
}
