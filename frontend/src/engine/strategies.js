// The six specialist strategies (port of backend/strategies). Vectorised and causal: the value at
// bar t only uses closed bars <= t and trades enter at the next bar's open. Same code for live and backtests.
import { donchian, ema, rankCache } from './indicators.js'
import {
  and, ge, gt, isNum, lastAndPrev, le, lt, map2, or, rmax, rmin, rollingAny, rollingSumB, shift, shiftB, sub,
} from './series.js'

// ---------- shared causal building blocks ----------
export function confirmedSwings(df, k = 3) {
  const w = 2 * k + 1
  const hmax = rmax(df.high, w), lmin = rmin(df.low, w)
  const candH = shift(df.high, k), candL = shift(df.low, k)
  const isSh = candH.map((v, i) => v === hmax[i]), isSl = candL.map((v, i) => v === lmin[i])
  const [lastSh, prevSh] = lastAndPrev(candH, isSh)
  const [lastSl, prevSl] = lastAndPrev(candL, isSl)
  return { last_sh: lastSh, prev_sh: prevSh, last_sl: lastSl, prev_sl: prevSl, new_sh: isSh, new_sl: isSl }
}

export function candleFlags(df) {
  const { open: o, high: h, low: l, close: c } = df
  const body = c.map((x, i) => Math.abs(x - o[i]))
  const rng = h.map((x, i) => (x - l[i] === 0 ? NaN : x - l[i]))
  const upW = h.map((x, i) => x - Math.max(o[i], c[i])), loW = l.map((x, i) => Math.min(o[i], c[i]) - x)
  const po = shift(o), pc = shift(c), pbody = shift(body)
  const out = {}
  out.bull_engulf = c.map((x, i) => pc[i] < po[i] && x > o[i] && x >= po[i] && o[i] <= pc[i] && body[i] > pbody[i])
  out.bear_engulf = c.map((x, i) => pc[i] > po[i] && x < o[i] && x <= po[i] && o[i] >= pc[i] && body[i] > pbody[i])
  out.hammer = c.map((_, i) => loW[i] >= 2 * body[i] && upW[i] <= 0.35 * rng[i] && body[i] / rng[i] < 0.4)
  out.star = c.map((_, i) => upW[i] >= 2 * body[i] && loW[i] <= 0.35 * rng[i] && body[i] / rng[i] < 0.4)
  out.bull_reject = c.map((x, i) => out.hammer[i] || (loW[i] > 0.5 * rng[i] && x > o[i]))
  out.bear_reject = c.map((x, i) => out.star[i] || (upW[i] > 0.5 * rng[i] && x < o[i]))
  out.strong_bull = c.map((x, i) => x > o[i] && body[i] / rng[i] > 0.6)
  out.strong_bear = c.map((x, i) => x < o[i] && body[i] / rng[i] > 0.6)
  return out
}

/** Higher-timeframe trend from `factor`x aggregated candles; only completed HTF candles count. */
export function htfTrend(df, factor = 4, fast = 21, slow = 50) {
  const n = df.close.length
  if (factor <= 1) return new Array(n).fill(0)
  const groups = Math.ceil(n / factor), close = [], complete = []
  for (let g = 0; g < groups; g++) {
    const end = Math.min(n, (g + 1) * factor)
    close.push(df.close[end - 1]); complete.push(end - g * factor === factor)
  }
  const e1 = ema(close, fast), e2 = ema(close, slow)
  const t = close.map((c, g) => {
    if (!complete[g]) return NaN
    return c > e1[g] && e1[g] > e2[g] ? 1 : c < e1[g] && e1[g] < e2[g] ? -1 : 0
  })
  // a HTF candle is known only once complete -> applies to the NEXT group's bars
  const known = shift(t); let lastV = 0
  for (let g = 0; g < groups; g++) { if (isNum(known[g])) lastV = known[g]; known[g] = lastV }
  return df.close.map((_, i) => known[Math.floor(i / factor)])
}

function combine(comps, weights, base = 30) {
  const n = Object.values(comps)[0].length
  return new Array(n).fill(0).map((_, i) => {
    let s = base
    for (const k in weights) s += weights[k] * (comps[k][i] === true ? 1 : 0)
    return Math.min(100, Math.max(0, s))
  })
}

const dirOf = (up, dn) => up.map((u, i) => (u ? 1 : dn[i] ? -1 : 0))
const pick = (d, up, dn) => d.map((x, i) => (x > 0 && up[i] === true) || (x < 0 && dn[i] === true))
const nz = (d) => d.map((x) => x !== 0)
const between = (a, lo, hi) => a.map((v) => v >= lo && v <= hi)

function output(d, score, comps) {
  return { dir: d, score: score.map((s, i) => (d[i] !== 0 ? s : 0)), comps }
}

class Strategy {
  constructor(o) { Object.assign(this, { minBars: 250, ...o }) }
  params(overrides) {
    const p = { ...this.default_params }
    for (const k in overrides || {}) if (k in p) p[k] = overrides[k]
    return p
  }
  /** Signal for the last closed bar, or null. */
  latest(df, f, overrides) {
    if (df.close.length < this.minBars) return null
    const g = this.generate(df, f, this.params(overrides))
    const i = df.close.length - 1
    if (!g.dir[i]) return null
    const reasons = Object.keys(g.comps).filter((k) => g.comps[k][i]).map((k) => k.replaceAll('_', ' '))
    const feats = {}
    for (const k of ['rsi', 'adx', 'atr', 'macd_hist', 'bb_width', 'cci', 'stoch_k']) feats[k] = isNum(f[k][i]) ? f[k][i] : null
    return { strategy: this.id, direction: g.dir[i] > 0 ? 'UP' : 'DOWN', score: g.score[i], reasons, features: feats }
  }
}

const TREND = new Strategy({
  id: 'trend', name: 'Trend Following',
  description: 'EMA 9/21 cross in the direction of EMA 50/200, confirmed by ADX, MACD and HTF trend.',
  default_params: { fast: 9, slow: 21, adx_min: 22, cross_lookback: 3, htf_factor: 4, require_htf: true, require_macd: true },
  param_space: { adx_min: [18, 22, 26, 30], cross_lookback: [1, 3, 5], htf_factor: [3, 4, 6], require_macd: [true, false] },
  generate(df, f, p) {
    const c = df.close, ef = ema(c, p.fast), es = ema(c, p.slow), pef = shift(ef), pes = shift(es)
    const upX = ef.map((v, i) => v > es[i] && pef[i] <= pes[i]), dnX = ef.map((v, i) => v < es[i] && pef[i] >= pes[i])
    const recentUp = and(rollingAny(upX, p.cross_lookback), gt(ef, es)), recentDn = and(rollingAny(dnX, p.cross_lookback), lt(ef, es))
    const longUp = gt(f.ema50, f.ema200), longDn = lt(f.ema50, f.ema200)
    const strong = ge(f.adx, p.adx_min)
    const diUp = gt(f.plus_di, f.minus_di), diDn = gt(f.minus_di, f.plus_di)
    const macdUp = and(gt(f.macd_hist, 0), gt(f.macd_macd, f.macd_signal)), macdDn = and(lt(f.macd_hist, 0), lt(f.macd_macd, f.macd_signal))
    const h = htfTrend(df, p.htf_factor)
    let up = and(recentUp, longUp, strong, diUp), dn = and(recentDn, longDn, strong, diDn)
    if (p.require_macd) { up = and(up, macdUp); dn = and(dn, macdDn) }
    if (p.require_htf) { up = and(up, gt(h, 0)); dn = and(dn, lt(h, 0)) }
    const d = dirOf(up, dn), on = nz(d)
    const comps = {
      ema_9_21_cross: pick(d, recentUp, recentDn), ema_50_200_aligned: pick(d, longUp, longDn),
      adx_strong: and(strong, on), adx_very_strong: and(ge(f.adx, p.adx_min + 10), on),
      macd_confirms: pick(d, macdUp, macdDn), htf_aligned: pick(d, gt(h, 0), lt(h, 0)),
      price_above_ema200: pick(d, gt(c, f.ema200), lt(c, f.ema200)),
    }
    const score = combine(comps, { ema_9_21_cross: 10, ema_50_200_aligned: 10, adx_strong: 8, adx_very_strong: 10,
      macd_confirms: 10, htf_aligned: 12, price_above_ema200: 5 })
    return output(d, score, comps)
  },
})

const PRICE_ACTION = new Strategy({
  id: 'price_action', name: 'Price Action',
  description: 'Market structure (HH/HL, LH/LL), S/R bounces and breakout-retests with candle confirmation.',
  default_params: { swing_k: 3, touch_atr: 0.4, retest_bars: 8 },
  param_space: { swing_k: [2, 3, 5], touch_atr: [0.25, 0.4, 0.6], retest_bars: [5, 8, 12] },
  generate(df, f, p) {
    const s = confirmedSwings(df, p.swing_k), cf = candleFlags(df), a = f.atr, { low, high, close } = df
    const bullStruct = and(gt(s.last_sh, s.prev_sh), gt(s.last_sl, s.prev_sl))
    const bearStruct = and(lt(s.last_sh, s.prev_sh), lt(s.last_sl, s.prev_sl))
    const nearSup = low.map((v, i) => Math.abs(v - s.last_sl[i]) <= p.touch_atr * a[i])
    const nearRes = high.map((v, i) => Math.abs(v - s.last_sh[i]) <= p.touch_atr * a[i])
    const bounceUp = and(nearSup, gt(close, s.last_sl), cf.bull_reject)
    const bounceDn = and(nearRes, lt(close, s.last_sh), cf.bear_reject)
    const lvlH = shift(s.last_sh), lvlL = shift(s.last_sl)
    const brokeUp = rollingAny(gt(close, lvlH), p.retest_bars), brokeDn = rollingAny(lt(close, lvlL), p.retest_bars)
    const retestUp = and(brokeUp, low.map((v, i) => v <= lvlH[i] + p.touch_atr * a[i]), gt(close, lvlH), or(cf.bull_reject, cf.bull_engulf))
    const retestDn = and(brokeDn, high.map((v, i) => v >= lvlL[i] - p.touch_atr * a[i]), lt(close, lvlL), or(cf.bear_reject, cf.bear_engulf))
    const d = dirOf(and(bullStruct, or(bounceUp, retestUp)), and(bearStruct, or(bounceDn, retestDn)))
    const comps = {
      bullish_or_bearish_structure: nz(d), sr_bounce: pick(d, bounceUp, bounceDn), breakout_retest: pick(d, retestUp, retestDn),
      engulfing: pick(d, cf.bull_engulf, cf.bear_engulf), rejection_candle: pick(d, cf.bull_reject, cf.bear_reject),
      ema_trend_agrees: pick(d, gt(f.ema21, f.ema50), lt(f.ema21, f.ema50)),
    }
    const score = combine(comps, { bullish_or_bearish_structure: 12, sr_bounce: 10, breakout_retest: 14, engulfing: 8,
      rejection_candle: 6, ema_trend_agrees: 10 })
    return output(d, score, comps)
  },
})

const SCALPING = new Strategy({
  id: 'scalping', name: 'Scalping', minBars: 220,
  description: 'Fast EMA momentum with RSI confirmation and a volatility window filter (short durations).',
  default_params: { fast: 5, slow: 13, mom_bars: 3, mom_atr: 0.6, rsi_lo: 50, rsi_hi: 70, vol_min_pct: 0.2, vol_max_pct: 0.9 },
  param_space: { mom_atr: [0.4, 0.6, 0.9], mom_bars: [2, 3, 5], vol_max_pct: [0.8, 0.9, 0.95] },
  generate(df, f, p) {
    const c = df.close, ef = ema(c, p.fast), es = ema(c, p.slow)
    const mom = map2(sub(c, shift(c, p.mom_bars)), f.atr, (x, y) => x / y)
    const volRank = rankCache(f, 'atr_pct')
    const volOk = volRank.map((v) => v >= p.vol_min_pct && v <= p.vol_max_pct)
    const ef2 = shift(ef, 2)
    const microUp = ef.map((v, i) => v > es[i] && v > ef2[i]), microDn = ef.map((v, i) => v < es[i] && v < ef2[i])
    const up = and(microUp, ge(mom, p.mom_atr), between(f.rsi, p.rsi_lo, p.rsi_hi), volOk)
    const dn = and(microDn, le(mom, -p.mom_atr), between(f.rsi, 100 - p.rsi_hi, 100 - p.rsi_lo), volOk)
    const d = dirOf(up, dn), on = nz(d)
    const comps = {
      micro_trend: on, strong_momentum: and(mom.map((v) => Math.abs(v) >= 1.5 * p.mom_atr), on), rsi_confirms: on,
      volatility_ok: and(volOk, on), stoch_agrees: pick(d, gt(f.stoch_k, f.stoch_d), lt(f.stoch_k, f.stoch_d)),
    }
    const score = combine(comps, { micro_trend: 12, strong_momentum: 14, rsi_confirms: 8, volatility_ok: 8, stoch_agrees: 8 })
    return output(d, score, comps)
  },
})

const REVERSAL = new Strategy({
  id: 'reversal', name: 'Reversal',
  description: 'RSI/MACD divergence at exhausted extremes with rejection candles near S/R.',
  default_params: { swing_k: 3, rsi_os: 30, rsi_ob: 70, extreme_lookback: 5, near_atr: 0.6 },
  param_space: { rsi_os: [25, 30, 35], extreme_lookback: [3, 5, 8], near_atr: [0.4, 0.6, 1.0] },
  generate(df, f, p) {
    const k = p.swing_k, s = confirmedSwings(df, k), cf = candleFlags(df), rsi = f.rsi, mh = f.macd_hist
    const rsiAt = shift(rsi, k), mhAt = shift(mh, k)
    const [rsiSl, rsiSlPrev] = lastAndPrev(rsiAt, s.new_sl), [rsiSh, rsiShPrev] = lastAndPrev(rsiAt, s.new_sh)
    const [mhSl, mhSlPrev] = lastAndPrev(mhAt, s.new_sl), [mhSh, mhShPrev] = lastAndPrev(mhAt, s.new_sh)
    const freshLow = rollingAny(s.new_sl, k + 3), freshHigh = rollingAny(s.new_sh, k + 3)
    const lowerLow = lt(s.last_sl, s.prev_sl), higherHigh = gt(s.last_sh, s.prev_sh)
    const bullRsi = and(freshLow, lowerLow, gt(rsiSl, rsiSlPrev)), bearRsi = and(freshHigh, higherHigh, lt(rsiSh, rsiShPrev))
    const bullMacd = and(freshLow, lowerLow, gt(mhSl, mhSlPrev)), bearMacd = and(freshHigh, higherHigh, lt(mhSh, mhShPrev))
    const oversold = rollingAny(lt(rsi, p.rsi_os), p.extreme_lookback), overbought = rollingAny(gt(rsi, p.rsi_ob), p.extreme_lookback)
    const pk = shift(f.stoch_k), pd = shift(f.stoch_d)
    const stochUp = f.stoch_k.map((v, i) => v > f.stoch_d[i] && pk[i] <= pd[i] && v < 40)
    const stochDn = f.stoch_k.map((v, i) => v < f.stoch_d[i] && pk[i] >= pd[i] && v > 60)
    const nearSup = df.low.map((v, i) => Math.abs(v - s.last_sl[i]) <= p.near_atr * f.atr[i])
    const nearRes = df.high.map((v, i) => Math.abs(v - s.last_sh[i]) <= p.near_atr * f.atr[i])
    const pmh = shift(mh)
    const exhUp = mh.map((v, i) => v > pmh[i] && v < 0), exhDn = mh.map((v, i) => v < pmh[i] && v > 0)
    const revUp = or(cf.bull_reject, cf.bull_engulf), revDn = or(cf.bear_reject, cf.bear_engulf)
    const up = and(oversold, or(bullRsi, bullMacd), or(revUp, stochUp))
    const dn = and(overbought, or(bearRsi, bearMacd), or(revDn, stochDn))
    const d = dirOf(up, dn)
    const comps = {
      rsi_divergence: pick(d, bullRsi, bearRsi), macd_divergence: pick(d, bullMacd, bearMacd), extreme_rsi: nz(d),
      reversal_candle: pick(d, revUp, revDn), sr_rejection: pick(d, nearSup, nearRes),
      momentum_exhaustion: pick(d, exhUp, exhDn), stochastic_cross: pick(d, stochUp, stochDn),
    }
    const score = combine(comps, { rsi_divergence: 10, macd_divergence: 10, extreme_rsi: 5, reversal_candle: 8,
      sr_rejection: 10, momentum_exhaustion: 7, stochastic_cross: 6 })
    return output(d, score, comps)
  },
})

const BREAKOUT = new Strategy({
  id: 'breakout', name: 'Breakout',
  description: 'Donchian range breakout after a tight consolidation, with false-breakout filters.',
  default_params: { range_n: 20, max_width_atr: 4.0, min_close_beyond_atr: 0.15, min_body: 0.55, fail_lookback: 30 },
  param_space: { range_n: [15, 20, 30], max_width_atr: [3.0, 4.0, 5.0], min_close_beyond_atr: [0.1, 0.15, 0.3] },
  generate(df, f, p) {
    const dc = donchian(df, p.range_n), a = f.atr, { open, high, low, close } = df
    const width = map2(sub(dc.upper, dc.lower), a, (x, y) => x / y)
    const tight = le(width, p.max_width_atr)
    const bodyRatio = close.map((c, i) => { const r = high[i] - low[i]; return r === 0 ? NaN : Math.abs(c - open[i]) / r })
    const upBrk = close.map((c, i) => c > dc.upper[i] + p.min_close_beyond_atr * a[i] && bodyRatio[i] >= p.min_body && c > open[i])
    const dnBrk = close.map((c, i) => c < dc.lower[i] - p.min_close_beyond_atr * a[i] && bodyRatio[i] >= p.min_body && c < open[i])
    const rawUp = gt(close, dc.upper), rawDn = lt(close, dc.lower)
    const failedUp = and(shiftB(rawUp, 3), lt(close, shift(dc.upper, 3))), failedDn = and(shiftB(rawDn, 3), gt(close, shift(dc.lower, 3)))
    const fails = rollingSumB(or(failedUp, failedDn), p.fail_lookback)
    const clean = fails.map((x) => x < 2)
    const expanding = gt(a, shift(a, 3))
    const prevTight = shiftB(tight, 1)
    const d = dirOf(and(prevTight, upBrk, clean), and(prevTight, dnBrk, clean)), on = nz(d)
    const h = htfTrend(df, 4)
    const comps = {
      consolidation: on, decisive_close: on, very_tight_range: and(le(shift(width), p.max_width_atr * 0.7), on),
      no_recent_false_breaks: and(fails.map((x) => x === 0), on), volatility_expanding: and(expanding, on),
      macd_agrees: pick(d, gt(f.macd_hist, 0), lt(f.macd_hist, 0)), htf_aligned: pick(d, gt(h, 0), lt(h, 0)),
    }
    const score = combine(comps, { consolidation: 6, decisive_close: 8, very_tight_range: 10, no_recent_false_breaks: 8,
      volatility_expanding: 6, macd_agrees: 8, htf_aligned: 10 })
    return output(d, score, comps)
  },
})

const fmax = (a, b) => a.map((x, i) => (isNum(x) && isNum(b[i]) ? Math.max(x, b[i]) : isNum(x) ? x : b[i]))
const fmin = (a, b) => a.map((x, i) => (isNum(x) && isNum(b[i]) ? Math.min(x, b[i]) : isNum(x) ? x : b[i]))

const VOLATILITY = new Strategy({
  id: 'volatility', name: 'Volatility',
  description: 'Bollinger squeeze (contraction) followed by ATR-confirmed expansion in the momentum direction.',
  default_params: { squeeze_pct: 0.2, squeeze_lookback: 10, atr_rise_bars: 3 },
  param_space: { squeeze_pct: [0.1, 0.2, 0.3], squeeze_lookback: [5, 10, 20] },
  generate(df, f, p) {
    const bbwRank = rankCache(f, 'bb_width')
    const squeezed = rollingAny(le(bbwRank, p.squeeze_pct), p.squeeze_lookback)
    const expanding = and(gt(f.bb_width, shift(f.bb_width)), gt(f.atr, shift(f.atr, p.atr_rise_bars)))
    const pmh = shift(f.macd_hist)
    const momUp = f.macd_hist.map((v, i) => v > 0 && v > pmh[i]), momDn = f.macd_hist.map((v, i) => v < 0 && v < pmh[i])
    const prevSq = shiftB(squeezed, 1)
    const d = dirOf(and(prevSq, expanding, gt(df.close, f.bb_upper), momUp), and(prevSq, expanding, lt(df.close, f.bb_lower), momDn))
    const on = nz(d)
    const comps = {
      squeeze: on, expansion: on, momentum_confirms: on,
      psar_agrees: pick(d, gt(f.psar_trend, 0), lt(f.psar_trend, 0)),
      ichimoku_agrees: pick(d, gt(df.close, fmax(f.ichi_span_a, f.ichi_span_b)), lt(df.close, fmin(f.ichi_span_a, f.ichi_span_b))),
      cci_strong: pick(d, gt(f.cci, 100), lt(f.cci, -100)),
    }
    const score = combine(comps, { squeeze: 6, expansion: 6, momentum_confirms: 6, psar_agrees: 10, ichimoku_agrees: 12, cci_strong: 8 })
    return output(d, score, comps)
  },
})

export const STRATEGIES = Object.fromEntries([TREND, PRICE_ACTION, SCALPING, REVERSAL, BREAKOUT, VOLATILITY].map((s) => [s.id, s]))
