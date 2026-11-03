// Calibration (score -> out-of-sample win probability), performance memory and the Smart AI
// meta-strategy (port of backend/ai_engine). It never sizes trades; its output goes through risk.
import { quantile } from './series.js'

/** Isotonic (non-decreasing) regression via pool-adjacent-violators; predicts by linear interpolation. */
function isotonic(x, y) {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b])
  const ux = [], uy = [], uw = []
  for (const i of idx) {
    if (ux.length && ux.at(-1) === x[i]) { const k = ux.length - 1; uy[k] = (uy[k] * uw[k] + y[i]) / (uw[k] + 1); uw[k]++ }
    else { ux.push(x[i]); uy.push(y[i]); uw.push(1) }
  }
  const blocks = []
  for (let i = 0; i < ux.length; i++) {
    blocks.push({ v: uy[i], w: uw[i], from: i, to: i })
    while (blocks.length > 1 && blocks.at(-2).v > blocks.at(-1).v) {
      const b = blocks.pop(), a = blocks.pop()
      blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, from: a.from, to: b.to })
    }
  }
  const fy = new Array(ux.length)
  for (const b of blocks) for (let i = b.from; i <= b.to; i++) fy[i] = Math.min(1, Math.max(0, b.v))
  return (s) => {
    if (s <= ux[0]) return fy[0]
    if (s >= ux.at(-1)) return fy.at(-1)
    let lo = 0, hi = ux.length - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ux[m] <= s) lo = m; else hi = m }
    return fy[lo] + ((fy[hi] - fy[lo]) * (s - ux[lo])) / (ux[hi] - ux[lo])
  }
}

export class Calibrator {
  constructor(priorStrength = 20, minSamples = 30) {
    this.priorStrength = priorStrength; this.minSamples = minSamples
    this.n = 0; this.baseRate = null; this.iso = null; this.bins = []
  }
  fit(pairs) {
    this.n = pairs.length
    if (!pairs.length) return this
    const x = pairs.map((p) => +p[0]), y = pairs.map((p) => (p[1] ? 1 : 0))
    this.baseRate = y.reduce((a, b) => a + b, 0) / y.length
    if (this.n >= this.minSamples && new Set(x).size > 1) this.iso = isotonic(x, y)
    const sx = [...x].sort((a, b) => a - b)
    const edges = this.n >= 10 ? [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => quantile(sx, q)) : [sx[0], sx.at(-1)]
    this.bins = []
    for (let k = 0; k < edges.length - 1; k++) {
      const m = x.map((v, i) => [v, i]).filter(([v]) => v >= edges[k] && v <= edges[k + 1])
      if (m.length) this.bins.push([edges[k], m.reduce((s, [, i]) => s + y[i], 0) / m.length, m.length])
    }
    return this
  }
  get ready() { return this.n >= this.minSamples }
  pWin(score) {
    if (this.baseRate === null) return null
    const raw = this.iso ? this.iso(score) : this.baseRate
    const localN = Math.max(1, this.n / 5), w = localN / (localN + this.priorStrength)
    return Math.round((w * raw + (1 - w) * this.baseRate) * 1e4) / 1e4
  }
  describe() {
    return { samples: this.n, ready: this.ready, base_win_rate: this.baseRate,
      bins: this.bins.map((b) => ({ score_from: b[0], win_rate: Math.round(b[1] * 1e4) / 1e4, n: b[2] })) }
  }
}

/** EV per unit stake of an option contract: p*payout - (1-p). */
export const expectedValue = (p, payout) => (p == null ? null : Math.round((p * payout - (1 - p)) * 1e4) / 1e4)

export function binomialZ(wins, n, p0) {
  if (!n || p0 <= 0 || p0 >= 1) return null
  return (wins / n - p0) / Math.sqrt((p0 * (1 - p0)) / n)
}

/** What has each strategy actually achieved - from OOS validation pairs and recorded trades. */
export class PerformanceMemory {
  constructor(store) { this.store = store; this.cal = {}; this.reg = {}; this.built = false }
  refresh() {
    const pairs = {}, reg = {}
    const bump = (s, r, won, n = 1) => { const e = ((reg[s] ??= {})[r] ??= [0, 0]); e[0] += won; e[1] += n }
    for (const t of this.store.all('trades')) {
      if (!['won', 'lost', 'sold'].includes(t.status)) continue
      const strat = t.features?.strategy || t.bot_id, won = t.status === 'won'
      const raw = t.features?.raw_score ?? t.confidence
      if (raw != null) (pairs[strat] ??= []).push([+raw, won])
      bump(strat, t.regime || 'unknown', won ? 1 : 0)
    }
    for (const [strat, data] of Object.entries(this.store.kv('validation_pairs', {}))) {
      (pairs[strat] ??= []).push(...data)
      for (const [r, [w, n]] of Object.entries(this.store.kv(`validation_regimes:${strat}`, {}))) bump(strat, r, w, n)
    }
    this.cal = Object.fromEntries(Object.entries(pairs).map(([s, p]) => [s, new Calibrator().fit(p)]))
    this.reg = reg; this.built = true
  }
  calibrator(s) { if (!this.built) this.refresh(); return this.cal[s] || new Calibrator() }
  regimePosterior(s, r, priorP = 0.5, priorN = 10) {
    if (!this.built) this.refresh()
    const [w, n] = this.reg[s]?.[r] || [0, 0]
    return [(w + priorP * priorN) / (n + priorN), n]
  }
  regimeTable() {
    if (!this.built) this.refresh()
    return Object.fromEntries(Object.entries(this.reg).map(([s, d]) => [s, Object.fromEntries(Object.entries(d).map(([r, [w, n]]) =>
      [r, { wins: w, n, win_rate: n ? Math.round((w / n) * 1000) / 1000 : null }]))]))
  }
  summary() { if (!this.built) this.refresh(); return Object.fromEntries(Object.entries(this.cal).map(([s, c]) => [s, c.describe()])) }
}

// prior belief on where each specialist works; overridden by evidence as samples accumulate
const REGIME_AFFINITY = {
  trend: { trending_up: 1.0, trending_down: 1.0, ranging: 0.2, quiet: 0.3, volatile: 0.5 },
  price_action: { trending_up: 0.8, trending_down: 0.8, ranging: 0.8, quiet: 0.6, volatile: 0.5 },
  scalping: { trending_up: 0.8, trending_down: 0.8, ranging: 0.4, quiet: 0.2, volatile: 0.7 },
  reversal: { trending_up: 0.3, trending_down: 0.3, ranging: 1.0, quiet: 0.5, volatile: 0.6 },
  breakout: { trending_up: 0.6, trending_down: 0.6, ranging: 0.7, quiet: 1.0, volatile: 0.4 },
  volatility: { trending_up: 0.6, trending_down: 0.6, ranging: 0.6, quiet: 1.0, volatile: 0.7 },
}

const pct = (x) => `${(x * 100).toFixed(1)}%`
const sgn = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`

/** Bot 7: weigh the specialists by calibrated OOS edge and regime record; stand aside on conflict. */
export function decide(signals, regime, htfTrend, memory, payout, minAgree = 2, minEv = 0.02, allowUncalibrated = false) {
  const be = 1 / (1 + payout)
  const reasons = [`regime=${regime}`, `breakeven win rate=${pct(be)}`]
  const no = (why, votes) => ({ trade: false, reasons: [...reasons, why], votes: votes || {} })
  const live = Object.entries(signals).filter(([, s]) => s)
  if (!live.length) return no('no specialist has a setup')
  const scored = live.map(([sid, s]) => {
    const cal = memory.calibrator(sid)
    const pCal = cal.ready ? cal.pWin(s.score) : null
    const [pReg, nReg] = memory.regimePosterior(sid, regime, be)
    const aff = REGIME_AFFINITY[sid]?.[regime] ?? 0.5
    let p = null
    if (pCal !== null) { const wReg = nReg / (nReg + 30); p = (1 - wReg) * pCal + wReg * pReg }
    const edge = p !== null ? p - be : null
    const weight = edge !== null ? Math.max(edge, 0) * Math.sqrt(Math.min(cal.n, 400)) * (0.5 + aff) : 0
    return { strategy: sid, dir: s.direction, score: s.score, p, edge, weight, affinity: aff, samples: cal.n }
  })
  const up = scored.filter((x) => x.dir === 'UP'), dn = scored.filter((x) => x.dir === 'DOWN')
  const wUp = up.reduce((a, x) => a + x.weight, 0), wDn = dn.reduce((a, x) => a + x.weight, 0)
  const votes = { up: up.map((x) => x.strategy), down: dn.map((x) => x.strategy), weight_up: Math.round(wUp * 1e4) / 1e4,
    weight_down: Math.round(wDn * 1e4) / 1e4, detail: scored }
  if (up.length && dn.length) {
    const su = up.some((x) => (x.edge || 0) > 0), sd = dn.some((x) => (x.edge || 0) > 0)
    if (su === sd) return no('conflicting specialist signals - standing aside', votes)
  }
  const side = wUp > wDn || (wUp === wDn && up.length > dn.length) ? up : dn
  const direction = side[0].dir
  if (htfTrend && (htfTrend > 0) !== (direction === 'UP')) {
    if (side.length < 3) return no('signal against higher-timeframe trend', votes)
    reasons.push('against HTF trend but 3+ specialists agree')
  }
  const best = side.reduce((b, x) => {
    const kb = [b.p ?? -1, b.score], kx = [x.p ?? -1, x.score]
    return kx[0] > kb[0] || (kx[0] === kb[0] && kx[1] > kb[1]) ? x : b
  })
  const calibrated = best.p !== null
  if (!calibrated && !allowUncalibrated) return no(`no out-of-sample validation yet for ${best.strategy} - run a walk-forward first`, votes)
  const agree = side.length, ev = calibrated ? expectedValue(best.p, payout) : null
  if (agree < minAgree && (ev === null || ev < minEv * 2)) return no(`only ${agree} specialist(s) agree and edge is not exceptional`, votes)
  if (ev !== null && ev < minEv) return no(`calibrated EV ${sgn(ev)} below minimum ${sgn(minEv)}`, votes)
  if (best.affinity < 0.3 && agree < 3) return no(`${best.strategy} historically weak in ${regime}`, votes)
  const conf = Math.max(0, Math.min(100, 0.55 * best.score + 8 * (agree - 1) + (ev ? 250 * ev : 0)))
  reasons.push(`${agree} specialist(s) agree on ${direction}: ${side.map((x) => x.strategy).join(', ')}`,
    calibrated ? `lead strategy ${best.strategy} (score ${best.score.toFixed(0)}, p_win ${pct(best.p)})` : `lead strategy ${best.strategy} (uncalibrated)`)
  if (ev !== null) reasons.push(`expected value ${sgn(ev)} per unit stake`)
  return { trade: true, direction, strategy: best.strategy, confidence: Math.round(conf * 10) / 10, p_win: best.p, ev, reasons, votes }
}
