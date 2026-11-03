// Market analysis engine (port of backend/analysis): structure, S/R, zones, candles, divergence, regime.
import { atr, computeAll, rankCache } from './indicators.js'
import { isNum, last, mean, sliceFrame } from './series.js'

/** Confirmed swing highs/lows as [index, price]; a pivot at i needs k bars each side. */
export function swings(df, k = 3) {
  const h = df.high, l = df.low, highs = [], lows = []
  for (let i = k; i < h.length - k; i++) {
    let hmax = -Infinity, lmin = Infinity, hc = 0, lc = 0
    for (let j = i - k; j <= i + k; j++) { hmax = Math.max(hmax, h[j]); lmin = Math.min(lmin, l[j]) }
    for (let j = i - k; j <= i + k; j++) { if (h[j] === h[i]) hc++; if (l[j] === l[i]) lc++ }
    if (h[i] === hmax && hc === 1) highs.push([i, h[i]])
    if (l[i] === lmin && lc === 1) lows.push([i, l[i]])
  }
  return [highs, lows]
}

export function marketStructure(df, k = 3) {
  const [highs, lows] = swings(df, k)
  const res = { structure: 'undefined', last_high: null, last_low: null, hh: false, hl: false, lh: false, ll: false, bos: null }
  if (highs.length < 2 || lows.length < 2) return res
  const h1 = highs.at(-2)[1], h2 = highs.at(-1)[1], l1 = lows.at(-2)[1], l2 = lows.at(-1)[1]
  Object.assign(res, { last_high: h2, last_low: l2, hh: h2 > h1, lh: h2 < h1, hl: l2 > l1, ll: l2 < l1 })
  res.structure = res.hh && res.hl ? 'bullish' : res.lh && res.ll ? 'bearish' : 'ranging'
  const close = last(df.close)
  if (close > h2) res.bos = 'up'
  else if (close < l2) res.bos = 'down'
  return res
}

const tail = (df, n) => sliceFrame(df, Math.max(0, df.close.length - n))

export function supportResistance(df, k = 3, lookback = 300, tolAtr = 0.5, maxLevels = 8) {
  const d = tail(df, lookback)
  if (d.close.length < 30) return []
  let a = last(atr(d))
  if (!isNum(a) || !a) a = mean(d.high.map((h, i) => h - d.low[i]))
  const [highs, lows] = swings(d, k)
  const pts = [...highs.map(([, p]) => [p, 'R']), ...lows.map(([, p]) => [p, 'S'])]
  pts.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
  const clusters = []
  for (const [p] of pts) {
    if (clusters.length && Math.abs(p - mean(clusters.at(-1))) <= tolAtr * a) clusters.at(-1).push(p)
    else clusters.push([p])
  }
  const close = last(d.close)
  const levels = clusters.map((c) => {
    const m = mean(c)
    return { price: m, touches: c.length, type: m > close ? 'resistance' : 'support', distance_atr: a ? (m - close) / a : 0 }
  })
  levels.sort((x, y) => y.touches - x.touches || Math.abs(x.distance_atr) - Math.abs(y.distance_atr))
  return levels.slice(0, maxLevels)
}

export function supplyDemandZones(df, lookback = 300, impulseAtr = 2) {
  const d = tail(df, lookback), a = atr(d), zones = []
  for (let i = 15; i < d.close.length - 3; i++) {
    if (!isNum(a[i])) continue
    const move = d.close[i + 3] - d.close[i]
    const body = Math.abs(d.close[i] - d.open[i])
    if (body < 0.5 * a[i] && Math.abs(move) >= impulseAtr * a[i]) {
      zones.push({ type: move > 0 ? 'demand' : 'supply', low: d.low[i], high: d.high[i], age: d.close.length - i })
    }
  }
  return zones.slice(-6)
}

export function candlePatterns(df) {
  const n = df.close.length
  if (n < 3) return {}
  const g = (k, i) => df[k][n - 3 + i]
  const o = [0, 1, 2].map((i) => g('open', i)), h = [0, 1, 2].map((i) => g('high', i))
  const l = [0, 1, 2].map((i) => g('low', i)), c = [0, 1, 2].map((i) => g('close', i))
  const body = c.map((x, i) => Math.abs(x - o[i]))
  const rng = h.map((x, i) => Math.max(x - l[i], 1e-12))
  const upW = h.map((x, i) => x - Math.max(o[i], c[i])), loW = l.map((x, i) => Math.min(o[i], c[i]) - x)
  const i = 2, j = 1
  const p = {
    bullish_engulfing: c[j] < o[j] && c[i] > o[i] && c[i] >= o[j] && o[i] <= c[j] && body[i] > body[j],
    bearish_engulfing: c[j] > o[j] && c[i] < o[i] && c[i] <= o[j] && o[i] >= c[j] && body[i] > body[j],
    hammer: loW[i] >= 2 * body[i] && upW[i] <= 0.35 * rng[i] && body[i] / rng[i] < 0.4,
    shooting_star: upW[i] >= 2 * body[i] && loW[i] <= 0.35 * rng[i] && body[i] / rng[i] < 0.4,
    doji: body[i] / rng[i] < 0.1,
    inside_bar: h[i] < h[j] && l[i] > l[j],
    strong_bull: c[i] > o[i] && body[i] / rng[i] > 0.7,
    strong_bear: c[i] < o[i] && body[i] / rng[i] > 0.7,
  }
  p.bullish_rejection = p.hammer || (loW[i] > 0.5 * rng[i] && c[i] > o[i])
  p.bearish_rejection = p.shooting_star || (upW[i] > 0.5 * rng[i] && c[i] < o[i])
  return p
}

export function divergence(df, osc, k = 3, maxGap = 40) {
  const [highs, lows] = swings(df, k), n = df.close.length
  if (lows.length >= 2) {
    const [i1, p1] = lows.at(-2), [i2, p2] = lows.at(-1)
    if (n - 1 - i2 <= k + 2 && i2 - i1 <= maxGap && p2 < p1 && osc[i2] > osc[i1]) return 'bullish'
  }
  if (highs.length >= 2) {
    const [i1, p1] = highs.at(-2), [i2, p2] = highs.at(-1)
    if (n - 1 - i2 <= k + 2 && i2 - i1 <= maxGap && p2 > p1 && osc[i2] < osc[i1]) return 'bearish'
  }
  return null
}

export function consolidation(df, n = 20, maxWidthAtr = 3) {
  const d = tail(df, n), a = last(atr(df)) || 0
  const hi = Math.max(...d.high), lo = Math.min(...d.low), width = hi - lo
  return { in_range: Boolean(a && width <= maxWidthAtr * a), high: hi, low: lo, width_atr: a ? width / a : null }
}

/** f = computeAll output; classifies trending/ranging/volatile/quiet at the last bar. */
export function regime(f) {
  const n = f.close.length
  const atrRank = last(rankCache(f, 'atr_pct')), bbwRank = last(rankCache(f, 'bb_width'))
  const adxV = last(f.adx), atrL = last(f.atr)
  const slope = n > 6 ? (f.ema50[n - 1] - f.ema50[n - 6]) / (atrL || 1) : 0
  let name
  if (!isNum(adxV)) name = 'unknown'
  else if (adxV >= 25 && Math.abs(slope) > 0.3) name = slope > 0 ? 'trending_up' : 'trending_down'
  else if (isNum(atrRank) && atrRank > 0.85) name = 'volatile'
  else if (isNum(bbwRank) && bbwRank < 0.15) name = 'quiet'
  else name = 'ranging'
  return { name, adx: isNum(adxV) ? adxV : null, ema50_slope_atr: isNum(slope) ? slope : null,
    atr_percentile: isNum(atrRank) ? atrRank : null, bb_width_percentile: isNum(bbwRank) ? bbwRank : null }
}

/** One regime label per bar (vectorised, causal) - used for regime-conditional validation stats. */
export function regimeSeries(f) {
  const atrRank = rankCache(f, 'atr_pct'), bbwRank = rankCache(f, 'bb_width')
  return f.close.map((_, i) => {
    const a = f.adx[i]
    if (!isNum(a)) return 'unknown'
    const at = f.atr[i], prev = i >= 5 ? f.ema50[i - 5] : NaN
    const slope = at === 0 ? NaN : (f.ema50[i] - prev) / at
    if (a >= 25 && slope > 0.3) return 'trending_up'
    if (a >= 25 && slope < -0.3) return 'trending_down'
    if (atrRank[i] > 0.85) return 'volatile'
    if (bbwRank[i] < 0.15) return 'quiet'
    return 'ranging'
  })
}

export function trendDirection(f) {
  const n = f.close.length - 1, c = f.close[n], e21 = f.ema21[n], e50 = f.ema50[n]
  if (!isNum(e21) || !isNum(e50)) return 0
  if (c > e21 && e21 > e50) return 1
  if (c < e21 && e21 < e50) return -1
  return 0
}

const KEYS = ['ema9', 'ema21', 'ema50', 'ema200', 'rsi', 'macd_macd', 'macd_signal', 'macd_hist', 'adx',
  'plus_di', 'minus_di', 'atr', 'bb_upper', 'bb_mid', 'bb_lower', 'bb_width', 'stoch_k', 'stoch_d', 'cci',
  'psar_sar', 'psar_trend', 'ichi_tenkan', 'ichi_kijun', 'ichi_span_a', 'ichi_span_b', 'don_upper', 'don_lower', 'vwap']

const clean = (v) => (isNum(v) ? Math.round(v * 1e6) / 1e6 : null)

export function analyze(symbol, granularity, df, f = null, htf = null) {
  f = f || computeAll(df)
  let htfTrend = null
  if (htf && htf.close.length >= 60) htfTrend = trendDirection(computeAll(htf))
  return {
    symbol, granularity, epoch: last(df.t), close: last(f.close), regime: regime(f), trend: trendDirection(f),
    htf_trend: htfTrend, structure: marketStructure(df), levels: supportResistance(df), zones: supplyDemandZones(df),
    patterns: candlePatterns(df), rsi_div: divergence(df, f.rsi), macd_div: divergence(df, f.macd_hist),
    consolidation: consolidation(df), indicators: Object.fromEntries(KEYS.map((k) => [k, clean(last(f[k]))])),
  }
}
