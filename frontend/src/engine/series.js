// Array helpers that mirror the pandas operations the Python engine uses.
// Missing values are NaN; any comparison with NaN is false, exactly like pandas.

export const isNum = (v) => typeof v === 'number' && !Number.isNaN(v)
export const nans = (n) => new Array(n).fill(NaN)
export const last = (a) => a[a.length - 1]

export function shift(a, k = 1) {
  const n = a.length, o = nans(n)
  for (let i = 0; i < n; i++) { const j = i - k; if (j >= 0 && j < n) o[i] = a[j] }
  return o
}

export function shiftB(a, k = 1) {
  return shift(a, k).map((v) => v === true)
}

export const map2 = (a, b, fn) => a.map((v, i) => fn(v, b[i], i))
export const sub = (a, b) => map2(a, b, (x, y) => x - y)
export const add = (a, b) => map2(a, b, (x, y) => x + y)
export const mul = (a, k) => a.map((x) => x * k)
export const div0 = (a, b) => map2(a, b, (x, y) => (y === 0 ? NaN : x / y))     // x / y.replace(0, nan)
export const and = (...xs) => xs[0].map((_, i) => xs.every((x) => x[i] === true))
export const or = (...xs) => xs[0].map((_, i) => xs.some((x) => x[i] === true))
export const not = (a) => a.map((v) => !v)
export const gt = (a, b) => a.map((v, i) => v > (Array.isArray(b) ? b[i] : b))
export const lt = (a, b) => a.map((v, i) => v < (Array.isArray(b) ? b[i] : b))
export const ge = (a, b) => a.map((v, i) => v >= (Array.isArray(b) ? b[i] : b))
export const le = (a, b) => a.map((v, i) => v <= (Array.isArray(b) ? b[i] : b))

export function diff(a) { return a.map((v, i) => (i === 0 ? NaN : v - a[i - 1])) }

export function ffill(a) {
  const o = a.slice(); let lastV = NaN
  for (let i = 0; i < o.length; i++) { if (isNum(o[i])) lastV = o[i]; else o[i] = lastV }
  return o
}

/** where(mask) then ffill, plus the value of the event before that one (pandas dropna().shift(1).reindex().ffill()). */
export function lastAndPrev(vals, mask) {
  const n = vals.length, lastA = nans(n), prevA = nans(n)
  let l = NaN, p = NaN
  for (let i = 0; i < n; i++) {
    if (mask[i] === true && isNum(vals[i])) { p = l; l = vals[i] }
    lastA[i] = l; prevA[i] = p
  }
  return [lastA, prevA]
}

/** pandas ewm(alpha, adjust=False, min_periods); leading/isolated NaNs are skipped. */
export function ewm(a, alpha, minPeriods = 0) {
  const o = nans(a.length)
  let y = NaN, cnt = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    if (isNum(x)) { y = cnt === 0 ? x : (1 - alpha) * y + alpha * x; cnt++ }
    if (cnt >= Math.max(minPeriods, 1)) o[i] = y
  }
  return o
}

/** Generic rolling window over non-NaN values; fn(values) -> number. */
export function rolling(a, w, fn, minPeriods = w) {
  const o = nans(a.length)
  for (let i = 0; i < a.length; i++) {
    const vals = []
    for (let j = Math.max(0, i - w + 1); j <= i; j++) if (isNum(a[j])) vals.push(a[j])
    if (vals.length >= minPeriods && vals.length > 0) o[i] = fn(vals)
  }
  return o
}

export const rmean = (a, w, mp = w) => rolling(a, w, (v) => v.reduce((s, x) => s + x, 0) / v.length, mp)
export const rmax = (a, w, mp = w) => rolling(a, w, (v) => Math.max(...v), mp)
export const rmin = (a, w, mp = w) => rolling(a, w, (v) => Math.min(...v), mp)
export const rstd0 = (a, w, mp = w) => rolling(a, w, (v) => {
  const m = v.reduce((s, x) => s + x, 0) / v.length
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length)
}, mp)

/** rolling(lb, min_periods=1).max().astype(bool) on a boolean series. */
export function rollingAny(b, w) {
  const o = new Array(b.length).fill(false)
  let lastTrue = -Infinity
  for (let i = 0; i < b.length; i++) { if (b[i] === true) lastTrue = i; o[i] = i - lastTrue < w }
  return o
}

export function rollingSumB(b, w) {
  const o = new Array(b.length).fill(0)
  let s = 0
  for (let i = 0; i < b.length; i++) {
    s += b[i] === true ? 1 : 0
    if (i >= w) s -= b[i - w] === true ? 1 : 0
    o[i] = s
  }
  return o
}

/** pandas rolling(w, min_periods).rank(pct=True): average-tie rank of the last value / count. */
export function rollingRankPct(a, w, minPeriods) {
  const o = nans(a.length)
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    if (!isNum(x)) continue
    let less = 0, eq = 0, cnt = 0
    for (let j = Math.max(0, i - w + 1); j <= i; j++) {
      const v = a[j]
      if (!isNum(v)) continue
      cnt++
      if (v < x) less++
      else if (v === x) eq++
    }
    if (cnt >= minPeriods) o[i] = (less + (eq + 1) / 2) / cnt
  }
  return o
}

export const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length

/** numpy.quantile, linear interpolation. */
export function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Frame = { t, open, high, low, close } arrays (closed candles, oldest first). */
export function frameFromCandles(candles) {
  const f = { t: [], open: [], high: [], low: [], close: [] }
  for (const c of candles) {
    f.t.push(+c.epoch); f.open.push(+c.open); f.high.push(+c.high); f.low.push(+c.low); f.close.push(+c.close)
  }
  return f
}

export function sliceFrame(df, from, to) {
  return { t: df.t.slice(from, to), open: df.open.slice(from, to), high: df.high.slice(from, to),
    low: df.low.slice(from, to), close: df.close.slice(from, to) }
}

export const len = (df) => df.close.length
