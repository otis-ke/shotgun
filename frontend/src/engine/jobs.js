// CPU-heavy work (backtests, walk-forward validation). Runs in a Web Worker in the browser so it
// never freezes the page or the live Deriv connection; runs inline under Node tests.
import { btConfig, regimeCounts, run, toResult, walkForward } from './backtest.js'
import { computeAll } from './indicators.js'
import { frameFromCandles } from './series.js'
import { STRATEGIES } from './strategies.js'

export function backtestJob({ candles, strategies, params, cfg, walk, folds }) {
  const df = frameFromCandles(candles), c = btConfig(cfg), f = computeAll(df), out = {}
  for (const sid of strategies) {
    const s = STRATEGIES[sid]
    if (walk) {
      const wf = walkForward(df, s, c, params[sid], folds)
      for (const k of ['calibration_pairs', 'oos_index', '_f']) delete wf[k]
      out[sid] = wf
    } else out[sid] = toResult(run(df, s, params[sid], c, f))
  }
  return out
}

export function validateJob({ candles, strategy, params, cfg, folds, optimise }) {
  const df = frameFromCandles(candles)
  const wf = walkForward(df, STRATEGIES[strategy], btConfig(cfg), params, folds, 0.6, optimise)
  wf.regime_counts = regimeCounts(wf._f, wf.oos_index)
  delete wf._f
  return wf
}

export const JOBS = { backtest: backtestJob, validate: validateJob }
