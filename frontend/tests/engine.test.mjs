// End-to-end test of the in-browser engine against the mock Deriv server (tests/mock_deriv.py):
// sign-in, status, market data, analysis, backtest, validation, execution + settlement, gates.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PY = process.env.PYTHON || `${ROOT}.venv/Scripts/python.exe`
const PORT = 8790 + Math.floor(Math.random() * 100)
let mock, api, CONFIG, testing

before(async () => {
  mock = spawn(PY, ['-m', 'tests.mock_deriv', '--port', String(PORT), '--candle-seconds', '0.3'], { cwd: ROOT })
  await new Promise((resolve, reject) => {
    mock.stdout.on('data', (d) => String(d).includes('mock Deriv on') && resolve())
    mock.on('exit', (c) => reject(new Error(`mock exited ${c}`)))
    setTimeout(() => reject(new Error('mock did not start')), 15000)
  })
  const m = await import('../src/engine/local-api.js')
  ;({ localApi: api, CONFIG, __testing: testing } = m)
  CONFIG.wsUrl = `ws://127.0.0.1:${PORT}`
})

after(async () => { try { await api('/auth/logout', { method: 'POST' }) } catch { /* ignore */ } mock?.kill() })

const call = (path, method = 'GET', body) => api(path, { method, body })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('unauthenticated calls are rejected', async () => {
  await assert.rejects(call('/status'), (e) => e.status === 401)
  assert.equal((await call('/site')).static, true)
})

test('pasted Deriv redirect address or API tokens are understood', async () => {
  const { parseCredentials } = await import('../src/credentials.js')
  assert.deepEqual(parseCredentials('https://deriv.example/redirect?acct1=CR1&token1=a1-abcdefgh&cur1=usd&acct2=VRTC2&token2=a1-zyxwvuts&cur2=usd'),
    [{ loginid: 'CR1', token: 'a1-abcdefgh', currency: 'usd' }, { loginid: 'VRTC2', token: 'a1-zyxwvuts', currency: 'usd' }])
  assert.deepEqual(parseCredentials('acct1=CR1&token1=a1-abcdefgh'), [{ loginid: 'CR1', token: 'a1-abcdefgh', currency: null }])
  assert.deepEqual(parseCredentials(' AbCdEfGh12345 ,\n ZyXwVuTs98765 '), [{ token: 'AbCdEfGh12345' }, { token: 'ZyXwVuTs98765' }])
  assert.deepEqual(parseCredentials('hi'), [])
})

test('OAuth needs the owner app id; it can be saved or registered in the browser', async () => {
  assert.equal((await call('/site')).oauth_ready, false)            // shared test app 1089 never returns here
  await assert.rejects(call('/site/app-id', 'PUT', { app_id: 'abc' }), (e) => e.status === 400)
  const s = await call('/site/app-id', 'PUT', { app_id: '12345' })
  assert.deepEqual(s, { app_id: '12345', oauth_ready: true })
  assert.match((await call('/site')).oauth_url, /app_id=12345/)
  await assert.rejects(call('/site/register-app', 'POST', { token: 'admin-otis', redirect_uri: 'http://evil.example/' }), (e) => e.status === 400)
  await assert.rejects(call('/site/register-app', 'POST', { token: 'bad', redirect_uri: 'https://otis-ke.github.io/shotgun/' }), (e) => e.status === 400)
  const r = await call('/site/register-app', 'POST', { token: 'admin-otis', redirect_uri: 'https://otis-ke.github.io/shotgun/' })
  assert.equal(r.app_id, '4242')
  assert.equal((await call('/site')).app_id, '4242')
  assert.equal((await call('/site/app-id', 'PUT', { app_id: null })).oauth_ready, false)
})

test('API-token sign-in (no redirect needed) gives full account access', async () => {
  const r = await call('/auth/deriv', 'POST', { accounts: [{ token: 'demo-tokenuser' }] })
  assert.equal(r.user.accounts.length, 1)
  const s = await call('/status')
  assert.equal(s.health.authorized, true)
  assert.ok(s.balance > 0)
  assert.deepEqual(s.trading_permission, [true, 'demo account'])
  await call('/auth/logout', 'POST')
})

test('Deriv OAuth sign-in verifies tokens and defaults to demo', async () => {
  await assert.rejects(call('/auth/deriv', 'POST', { accounts: [{ token: 'bad' }] }), (e) => e.status === 401)
  const r = await call('/auth/deriv', 'POST', { accounts: [{ token: 'real-otis' }, { token: 'demo-otis' }] })
  assert.equal(r.user.accounts.length, 2)
  assert.ok(r.user.accounts.find((a) => a.loginid === r.user.active_loginid).is_virtual)
  const s = await call('/status')
  assert.equal(s.health.authorized, true)
  assert.equal(s.health.is_virtual, true)
  assert.ok(s.balance > 0)
  assert.deepEqual(s.trading_permission, [true, 'demo account'])
})

test('market data, analysis and bots', async () => {
  assert.ok((await call('/markets/symbols')).length > 0)
  const c = await call('/markets/candles?symbol=R_100&granularity=60&count=300')
  assert.equal(c.length, 300)
  const a = await call('/markets/analysis?symbol=R_100&granularity=60')
  assert.ok(a.regime.name && Object.keys(a.signals).length === 6 && a.indicators.rsi !== undefined)
  const bots = await call('/bots')
  assert.equal(bots.length, 7)
  assert.equal((await call('/strategies')).length, 6)
  const d = await call('/dashboard')
  assert.ok(d.risk.limits && d.stats)
})

test('backtest runs on Deriv history', async () => {
  const r = await call('/backtest', 'POST', { strategies: ['trend', 'breakout'], symbol: 'R_50', granularity: 60, days: 1,
    contract: { family: 'rise_fall', duration_bars: 3, payout_ratio: 0.9 } })
  assert.ok(r.bars >= 1000)
  assert.ok(r.results.trend.stats && r.results.breakout.stats)
  const wf = await call('/backtest', 'POST', { strategies: ['scalping'], symbol: 'R_50', granularity: 60, days: 1, walk_forward: true, folds: 2 })
  assert.ok('passed_validation' in wf.results.scalping)
})

test('walk-forward validation stores a version and feeds calibration', async () => {
  const v = await call('/bots/breakout/validate', 'POST', { days: 1, folds: 2, optimise: false, symbol: 'R_25', overrides: { granularity: 60 } })
  assert.ok(['proposed', 'rejected'].includes(v.status))
  const b = await call('/bots/breakout')
  assert.ok(b.versions.some((x) => x.version === v.version))
  if (v.status === 'rejected') await assert.rejects(call(`/bots/breakout/deploy/${v.version}`, 'POST'), (e) => e.status === 400)
  const cal = await call('/analytics/calibration')
  if (v.oos_stats.trades) assert.ok(cal.calibration.breakout.samples > 0)
})

test('execution: order recorded before buy, settles, no duplicates', async () => {
  const r = await testing.runtime()
  const req = { bot_id: 'trend', symbol: 'R_100', direction: 'UP', contract: { family: 'rise_fall', duration: 1, duration_unit: 'm' },
    confidence: 80, signal_id: 999001, payout_assumption: 0.9 }
  const res = await r.exe.execute(req)
  assert.equal(res.status, 'BOUGHT', res.message)
  assert.equal((await r.exe.execute(req)).status, 'DUPLICATE')
  const order = r.store.where('orders', (o) => o.coid === res.coid)[0]
  assert.equal(order.status, 'BOUGHT')
  for (let i = 0; i < 40 && r.store.where('trades', (t) => t.contract_id === res.contract_id)[0].status === 'open'; i++) await sleep(150)
  const t = r.store.where('trades', (x) => x.contract_id === res.contract_id)[0]
  assert.ok(['won', 'lost'].includes(t.status))
  const perf = await call('/analytics/performance')
  assert.equal(perf.equity_curve.length, 1)
  assert.equal((await call('/trades')).length, 1)
})

test('emergency stop blocks trading and bots', async () => {
  await call('/emergency-stop', 'POST')
  await assert.rejects(call('/bots/trend/start', 'POST'), (e) => e.status === 409)
  const r = await testing.runtime()
  assert.equal((await r.exe.execute({ bot_id: 'trend', symbol: 'R_75', direction: 'UP', contract: {}, signal_id: 999002 })).status, 'BLOCKED')
  await call('/emergency-stop', 'DELETE')
  const b = await call('/bots/trend/start', 'POST')
  assert.equal(b.running, true)
  await call('/bots/trend/stop', 'POST')
})

test('risk settings are validated', async () => {
  await assert.rejects(call('/risk', 'PUT', { risk_pct_per_trade: 20 }), (e) => e.status === 400)
  assert.equal((await call('/risk', 'PUT', { max_open_trades: 2 })).max_open_trades, 2)
})

test('real account needs explicit authorization', async () => {
  const s = await call('/status')
  const real = s.user.accounts.find((a) => !a.is_virtual)
  await call('/account/switch', 'POST', { loginid: real.loginid })
  const s2 = await call('/status')
  assert.equal(s2.health.is_virtual, false)
  assert.equal(s2.trading_permission[0], false)
  await assert.rejects(call('/mode', 'PUT', { mode: 'full' }), (e) => e.status === 400)
  await assert.rejects(call('/deriv/authorize-real', 'POST', { loginid: real.loginid, confirmation: 'yes' }), (e) => e.status === 400)
  await call('/deriv/authorize-real', 'POST', { loginid: real.loginid, confirmation: 'I ACCEPT REAL MONEY RISK' })
  assert.equal((await call('/status')).trading_permission[0], true)
  await call('/deriv/authorize-real', 'DELETE')
})

test('sign out clears the session', async () => {
  await call('/auth/logout', 'POST')
  await assert.rejects(call('/status'), (e) => e.status === 401)
})
