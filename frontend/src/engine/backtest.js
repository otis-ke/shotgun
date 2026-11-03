// Event-driven backtester + walk-forward validation (port of backend/backtesting/engine).
// Signal on CLOSED bar i, entry at bar i+1 OPEN; Rise/Fall ties lose; multiplier SL fills before TP.
import { regimeSeries } from './analysis.js'
import { computeAll } from './indicators.js'
import { isNum } from './series.js'

export const BT_DEFAULTS = {
  family: 'rise_fall', duration_bars: 5, payout_ratio: 0.9, barrier_atr_mult: 1.0, multiplier: 50, sl_pct: 50,
  tp_pct: 50, min_score: 0, cooldown_bars: 0, initial_balance: 1000, risk_pct: 1.0, fixed_stake: null, commission_pct: 0,
}

export const btConfig = (d = {}) => {
  const c = { ...BT_DEFAULTS }
  for (const k in d) if (k in BT_DEFAULTS) c[k] = d[k]
  return c
}

const r4 = (x) => Number(x.toFixed(4))
const r2 = (x) => Number(x.toFixed(2))

function settle(cfg, d, o, h, l, c, j, end, atrV, stake) {
  const entry = o[j]
  const win = (won, ex) => [ex, won ? stake * cfg.payout_ratio : -stake, won]
  if (cfg.family === 'rise_fall') { const ex = c[end]; return win(d > 0 ? ex > entry : ex < entry, ex) }
  if (cfg.family === 'higher_lower') {
    const bar = entry - d * cfg.barrier_atr_mult * atrV, ex = c[end]
    return win(d > 0 ? ex > bar : ex < bar, ex)
  }
  if (cfg.family === 'touch' || cfg.family === 'no_touch') {
    const bar = entry + d * cfg.barrier_atr_mult * atrV
    let touched = false
    for (let k = j; k <= end; k++) if (d > 0 ? h[k] >= bar : l[k] <= bar) { touched = true; break }
    return win(cfg.family === 'touch' ? touched : !touched, c[end])
  }
  if (cfg.family === 'multiplier') {
    const notional = stake * cfg.multiplier, sl = (-stake * cfg.sl_pct) / 100, tp = (stake * cfg.tp_pct) / 100
    const fee = (notional * cfg.commission_pct) / 100
    for (let k = j; k <= end; k++) {
      const worst = d > 0 ? l[k] : h[k], best = d > 0 ? h[k] : l[k]
      if (d * (worst / entry - 1) * notional - fee <= Math.max(sl, -stake)) return [worst, Math.max(sl, -stake), false]
      if (d * (best / entry - 1) * notional - fee >= tp) return [best, tp, true]
    }
    const pnl = Math.max(d * (c[end] / entry - 1) * notional - fee, -stake)
    return [c[end], pnl, pnl > 0]
  }
  throw new Error(`unknown contract family ${cfg.family}`)
}

export function run(df, strategy, params, cfg, f = null, start = 0, end = null, signals = null) {
  cfg = cfg || btConfig()
  f = f || computeAll(df)
  const g = signals || strategy.generate(df, f, strategy.params(params))
  const { open: o, high: h, low: l, close: c, t: epochs } = df
  const n = end == null ? c.length : Math.min(end, c.length)
  let bal = cfg.initial_balance
  const trades = [], equity = [[epochs[Math.max(start, 0)], bal]]
  let i = Math.max(start, strategy.minBars), freeAt = i
  while (i < n - cfg.duration_bars - 1) {
    if (i >= freeAt && g.dir[i] !== 0 && g.score[i] >= cfg.min_score && isNum(f.atr[i])) {
      const j = i + 1, e = i + cfg.duration_bars
      const stake = cfg.fixed_stake || Math.max(0.35, r2((bal * cfg.risk_pct) / 100))
      if (stake > bal || bal <= 0) break
      const [ex, pnl, won] = settle(cfg, g.dir[i], o, h, l, c, j, e, f.atr[i], stake)
      bal += pnl
      trades.push({ i, epoch: epochs[i], direction: g.dir[i], score: g.score[i], entry: o[j], exit: ex, stake,
        profit: r4(pnl), won, balance: r4(bal) })
      equity.push([epochs[e], r4(bal)])
      freeAt = e + 1 + cfg.cooldown_bars
      i = e
    }
    i++
  }
  return { trades, equity, stats: stats(trades, cfg.initial_balance) }
}

export const toResult = (r, maxTrades = 500) => ({ stats: r.stats, trades: r.trades.slice(-maxTrades), equity: r.equity.slice(-2000) })

export function stats(trades, initial = 1000) {
  if (!trades.length) {
    return { trades: 0, win_rate: null, profit_factor: null, net_profit: 0, max_drawdown_pct: 0, expectancy: null,
      avg_return_pct: null, max_consecutive_losses: 0, sharpe: null }
  }
  const pnl = trades.map((t) => t.profit), stakes = trades.map((t) => t.stake)
  const wins = pnl.map((p) => p > 0)
  let gp = 0, gl = 0, eq = initial, peak = initial, dd = 0, streak = 0, mx = 0
  pnl.forEach((p, k) => {
    if (wins[k]) gp += p; else gl -= p
    eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak)
    streak = wins[k] ? 0 : streak + 1; mx = Math.max(mx, streak)
  })
  const n = pnl.length, sum = pnl.reduce((a, b) => a + b, 0)
  const r = pnl.map((p, k) => p / stakes[k]), rm = r.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - rm) ** 2, 0) / n)
  const nw = wins.filter(Boolean).length
  const rd = (x, d) => Number(x.toFixed(d))   // rounds the exact binary value, like Python's round()
  return {
    trades: n, wins: nw, losses: n - nw, win_rate: rd(nw / n, 4), profit_factor: gl > 0 ? rd(gp / gl, 3) : null,
    net_profit: rd(sum, 2), return_pct: rd((sum / initial) * 100, 2), max_drawdown_pct: rd(dd * 100, 2),
    expectancy: rd(sum / n, 4), expectancy_per_stake: rd(rm, 4), avg_return_pct: rd(rm * 100, 3),
    max_consecutive_losses: mx, sharpe: sd > 0 ? rd((rm / sd) * Math.sqrt(n), 3) : null,
  }
}

export const breakevenWinRate = (payout) => 1 / (1 + payout)

// ---------------- optimisation & walk-forward ----------------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function grid(space, maxCombos, seed = 7) {
  let combos = [{}]
  for (const k of Object.keys(space)) combos = combos.flatMap((c) => space[k].map((v) => ({ ...c, [k]: v })))
  if (combos.length > maxCombos) {
    const rnd = mulberry32(seed)
    for (let i = combos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [combos[i], combos[j]] = [combos[j], combos[i]] }
    combos = combos.slice(0, maxCombos)
  }
  return combos
}

// expectancy per unit stake penalised by drawdown -> prefers robust over lucky configs
const objective = (s, minTrades) => (s.trades < minTrades ? -1e9 : s.expectancy_per_stake - 0.002 * s.max_drawdown_pct)

export function optimise(df, strategy, cfg, baseParams, start = 0, end = null, f = null, maxCombos = 40, minTrades = 20) {
  f = f || computeAll(df)
  let bestP = strategy.params(baseParams), bestS = null, bestO = -1e18
  const combos = Object.keys(strategy.param_space || {}).length ? grid(strategy.param_space, maxCombos) : [{}]
  for (const combo of combos) {
    const p = { ...strategy.params(baseParams), ...combo }
    const r = run(df, strategy, p, cfg, f, start, end)
    const o = objective(r.stats, minTrades)
    if (o > bestO) { bestP = p; bestS = r.stats; bestO = o }
  }
  return [bestP, bestS || {}]
}

/** Anchored walk-forward: optimise on [0, train_end), test on the next unseen window, roll on. */
export function walkForward(df, strategy, cfg, baseParams, folds = 4, trainFrac = 0.6, optimiseParams = true, maxCombos = 30, onProgress) {
  const f = computeAll(df), n = df.close.length
  const firstTrain = Math.floor(n * trainFrac), step = Math.max(1, Math.floor((n - firstTrain) / folds))
  const oosTrades = [], windows = [], paramsUsed = []
  for (let k = 0; k < folds; k++) {
    const trEnd = firstTrain + k * step, teEnd = k === folds - 1 ? n : trEnd + step
    let p, isStats
    if (optimiseParams && Object.keys(strategy.param_space || {}).length) [p, isStats] = optimise(df, strategy, cfg, baseParams, 0, trEnd, f, maxCombos)
    else { p = strategy.params(baseParams); isStats = run(df, strategy, p, cfg, f, 0, trEnd).stats }
    const oos = run(df, strategy, p, cfg, f, trEnd, teEnd)
    oosTrades.push(...oos.trades); paramsUsed.push(p)
    windows.push({ fold: k + 1, train_bars: trEnd, test_from: df.t[trEnd], test_to: df.t[teEnd - 1], params: p,
      in_sample: isStats, out_of_sample: oos.stats })
    onProgress?.((k + 1) / folds)
  }
  const oosStats = stats(oosTrades, cfg.initial_balance)
  const stable = windows.filter((w) => (w.out_of_sample.expectancy ?? -1) > 0).length
  const passed = oosStats.trades >= 30 && (oosStats.expectancy || 0) > 0 && stable >= Math.ceil(folds / 2) && oosStats.max_drawdown_pct <= 25
  return {
    strategy: strategy.id, config: cfg, windows, oos_stats: oosStats,
    recommended_params: paramsUsed.at(-1) || strategy.params(baseParams), positive_folds: stable, folds,
    breakeven_win_rate: cfg.family !== 'multiplier' ? breakevenWinRate(cfg.payout_ratio) : null, passed_validation: passed,
    calibration_pairs: oosTrades.map((t) => [t.score, t.won]), oos_index: oosTrades.map((t) => [t.i, t.won]),
    _f: f,
  }
}

/** Regime-conditional OOS outcomes (wins, n) for the Smart AI. */
export function regimeCounts(f, oosIndex) {
  const reg = regimeSeries(f), counts = {}
  for (const [i, won] of oosIndex) { const r = (counts[reg[i]] ??= [0, 0]); r[0] += won ? 1 : 0; r[1] += 1 }
  return counts
}
