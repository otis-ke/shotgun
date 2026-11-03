// Checks the browser engine against the Python engine on identical data.
// Generate the reference first:  python -m tests.parity.dump_python frontend/tests/py_reference.json
// Then run:                       node --test frontend/tests/
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { analyze, regimeSeries } from '../src/engine/analysis.js'
import { Calibrator } from '../src/engine/ai.js'
import { btConfig, run, walkForward } from '../src/engine/backtest.js'
import { computeAll } from '../src/engine/indicators.js'
import { frameFromCandles } from '../src/engine/series.js'
import { STRATEGIES } from '../src/engine/strategies.js'

const ref = JSON.parse(readFileSync(new URL('./py_reference.json', import.meta.url)))

function close(a, b, path, tol = 1e-6) {
  if (a === null || b === null || a === undefined || b === undefined || Number.isNaN(a)) {
    const an = a === null || a === undefined || Number.isNaN(a), bn = b === null || b === undefined
    assert.equal(an, bn, `${path}: ${a} vs ${b}`)
    return
  }
  if (typeof b === 'number') assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${path}: js ${a} vs py ${b}`)
  else if (typeof b === 'object') for (const k of Object.keys(b)) close(a[k], b[k], `${path}.${k}`, tol)
  else assert.equal(a, b, `${path}`)
}

for (const d of ref.datasets) {
  const df = frameFromCandles(d.candles)
  const f = computeAll(df)

  test(`indicators match (seed ${d.seed})`, () => {
    for (const [k, vals] of Object.entries(d.indicators)) vals.forEach((v, i) => close(f[k][i], v, `${k}[${i}]`))
  })

  test(`regime series matches (seed ${d.seed})`, () => {
    const r = regimeSeries(f)
    const diff = r.filter((x, i) => x !== d.regime_series[i]).length
    assert.equal(diff, 0, `${diff} regime labels differ`)
  })

  for (const [sid, exp] of Object.entries(d.strategies)) {
    test(`${sid} signals + backtest match (seed ${d.seed})`, () => {
      const s = STRATEGIES[sid], g = s.generate(df, f, s.params())
      const bad = g.dir.map((x, i) => [x, i]).filter(([x, i]) => x !== exp.dir[i]).map(([, i]) => i)
      assert.equal(bad.length, 0, `${sid}: ${bad.length} bars differ, first at ${bad[0]}`)
      exp.score.forEach((v, i) => close(g.score[i], v, `${sid}.score[${i}]`))
      for (const [c, vals] of Object.entries(exp.comps)) {
        const k = c.slice(2), mism = vals.filter((v, i) => v !== g.comps[k][i]).length
        assert.equal(mism, 0, `${sid}.${k}: ${mism} bars differ`)
      }
      // trade lists are identical; summed money can land on an exact half-cent tie that each
      // language's float summation order rounds differently -> allow one cent on totals only
      const st = run(df, s, null, btConfig({ duration_bars: 3 }), f).stats
      for (const k of ['net_profit', 'return_pct']) { assert.ok(Math.abs(st[k] - exp.bt_stats[k]) <= 0.0101, `${sid}.${k}`); delete st[k]; delete exp.bt_stats[k] }
      close(st, exp.bt_stats, `${sid}.bt`)
    })
  }

  test(`analysis snapshot matches (seed ${d.seed})`, () => close(analyze('R_100', 60, df, f), d.analyze, 'analyze', 1e-5))

  test(`walk-forward (no optimisation) matches (seed ${d.seed})`, () => {
    const wf = walkForward(df, STRATEGIES.breakout, btConfig({ duration_bars: 3 }), null, 3, 0.6, false)
    close({ oos_stats: wf.oos_stats, passed_validation: wf.passed_validation, positive_folds: wf.positive_folds }, d.walk_forward_noopt, 'wf')
  })
}

test('calibration matches isotonic + shrinkage', () => {
  const cal = new Calibrator().fit(ref.calibration.pairs)
  for (const [s, p] of Object.entries(ref.calibration.p_win)) close(cal.pWin(+s), p, `p_win(${s})`, 1e-4)
  close(cal.describe(), ref.calibration.describe, 'describe', 1e-4)
})
