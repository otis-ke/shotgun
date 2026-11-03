import { useEffect, useState } from 'react'
import { api, fmt, GRANULARITIES } from '../api'
import { useLive } from '../App'
import { Action, Badge, Card, Stat, pnlCls, useApi } from '../components'

export default function Bots() {
  const { subscribe } = useLive()
  const [bots, reload, err] = useApi('/bots', [], 15000)
  const [open, setOpen] = useState(null)
  useEffect(() => subscribe((m) => { if (['bot', 'signal', 'trade_closed', 'ai_decision'].includes(m.type)) reload() }), [subscribe, reload])
  if (err) return <div className="alert err">{err}</div>
  if (!bots) return <div className="muted">Loading…</div>
  return (
    <>
      <div className="row between"><h1>Bot Management Center</h1>
        <div className="row">
          <Action onClick={async () => { for (const b of bots) if (!b.running) await api(`/bots/${b.id}/start`, { method: 'POST' }) }} onDone={reload}>Start all</Action>
          <Action className="btn bad" onClick={async () => { for (const b of bots) if (b.running) await api(`/bots/${b.id}/stop`, { method: 'POST' }) }} onDone={reload}>Stop all</Action>
        </div></div>
      <div className="alert info">Each bot is independent: own strategy, markets, timeframe, contract, version history and statistics. Strategy changes only go live after a walk-forward validation passes and you deploy the new version.</div>
      <div className="bots">{bots.map((b) => <BotCard key={b.id} b={b} reload={reload} onOpen={() => setOpen(b.id)} />)}</div>
      {open && <BotModal id={open} onClose={() => { setOpen(null); reload() }} />}
    </>
  )
}

function BotCard({ b, reload, onOpen }) {
  const s = b.stats || {}
  const ls = b.last_signal
  return (
    <div className="card bot">
      <div className="row between">
        <h3>{b.name}</h3>
        <span className="row" style={{ gap: 4 }}>
          {b.validated ? <Badge v="validated" cls="up" /> : <Badge v="unvalidated" cls="pending" />}
          <Badge v={b.running ? 'running' : 'stopped'} cls={b.running ? 'running' : ''} />
        </span>
      </div>
      <div className="desc">{b.description}</div>
      <div className="mini mono">{b.symbols.join(', ')} · {fmt.gran(b.granularity)} · {b.contract.family} {b.contract.duration}{b.contract.duration_unit} · v{b.version}</div>
      <div className="stats">
        <Stat label="trades" value={s.trades} />
        <Stat label="win rate" value={fmt.pct(s.win_rate, 0)} />
        <Stat label="net" value={fmt.num(s.net_profit)} cls={pnlCls(s.net_profit)} />
        <Stat label="PF" value={fmt.num(s.profit_factor)} />
      </div>
      {ls && (
        <div className="mini">
          <b>Last decision</b> {fmt.ago(ls.ts)} — {ls.action === 'no_trade' ? 'stood aside' : <>{ls.direction} {ls.symbol} conf {fmt.num(ls.confidence, 0)} → <Badge v={ls.status} /></>}
          <ul className="reasons">{(ls.reasons || []).slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}{ls.decision && <li>→ {ls.decision}</li>}</ul>
        </div>
      )}
      {b.errors > 0 && <div className="mini down">{b.errors} evaluation error(s) — see Logs</div>}
      <div className="row" style={{ marginTop: 10 }}>
        {b.running
          ? <Action className="btn bad" onClick={() => api(`/bots/${b.id}/stop`, { method: 'POST' })} onDone={reload}>Stop</Action>
          : <Action className="btn good" onClick={() => api(`/bots/${b.id}/start`, { method: 'POST' })} onDone={reload}>Start</Action>}
        <button className="btn" onClick={onOpen}>Configure & validate</button>
      </div>
    </div>
  )
}

function BotModal({ id, onClose }) {
  const [b, reload] = useApi(`/bots/${id}`)
  const [tab, setTab] = useState('settings')
  if (!b) return null
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h1>{b.name} <span className="muted mono">v{b.version}</span></h1><button className="btn" onClick={onClose}>Close</button></div>
        <div className="tabs">{['settings', 'validate', 'versions', 'health'].map((t) =>
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>)}</div>
        {tab === 'settings' && <SettingsTab b={b} reload={reload} />}
        {tab === 'validate' && <ValidateTab b={b} reload={reload} />}
        {tab === 'versions' && <VersionsTab b={b} reload={reload} />}
        {tab === 'health' && <HealthTab b={b} />}
      </div>
    </div>
  )
}

function SettingsTab({ b, reload }) {
  const [f, setF] = useState({
    symbols: b.symbols.join(', '), min_confidence: b.min_confidence, auto_execute: !!b.auto_execute,
    max_stake: b.max_stake ?? '', payout_assumption: b.payout_assumption,
  })
  const [msg, setMsg] = useState(null)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const save = async () => {
    const body = {
      symbols: f.symbols.split(',').map((s) => s.trim()).filter(Boolean), min_confidence: +f.min_confidence,
      auto_execute: f.auto_execute, max_stake: f.max_stake === '' ? null : +f.max_stake, payout_assumption: +f.payout_assumption,
    }
    await api(`/bots/${b.id}`, { method: 'PATCH', body }); setMsg('Saved as a new version.'); reload()
  }
  return (
    <>
      <div className="form">
        <label className="f">Markets (comma separated)<input value={f.symbols} onChange={set('symbols')} /></label>
        <label className="f">Min confidence (0-100)<input type="number" value={f.min_confidence} onChange={set('min_confidence')} /></label>
        <label className="f">Max stake per trade<input type="number" step="0.01" placeholder="global limit" value={f.max_stake} onChange={set('max_stake')} /></label>
        <label className="f">Payout ratio assumed<input type="number" step="0.01" value={f.payout_assumption} onChange={set('payout_assumption')} /></label>
        <label className="f row" style={{ flexDirection: 'row', gap: 6 }}><input type="checkbox" checked={f.auto_execute} onChange={set('auto_execute')} />Auto-execute in semi-auto mode</label>
      </div>
      <div className="mini">Payout ratio = net profit per unit stake on a win. Orders whose live Deriv payout is more than 5% below this are refused, because the edge estimate would no longer hold.</div>
      <div className="row"><Action className="btn primary" onClick={save}>Save settings</Action>{msg && <span className="up mini">{msg}</span>}</div>
      <Card title="Strategy parameters (change via validation)"><pre>{JSON.stringify(b.params, null, 2)}</pre></Card>
      <Card title="Contract"><pre>{JSON.stringify(b.contract, null, 2)}</pre></Card>
    </>
  )
}

function ValidateTab({ b, reload }) {
  const [f, setF] = useState({ days: 30, folds: 4, optimise: true, granularity: b.granularity,
    duration: b.contract.duration, duration_unit: b.contract.duration_unit, family: b.contract.family, params: '' })
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  if (b.strategy === 'smart_ai') return <div className="alert info">The Smart AI bot has no parameters of its own: it learns from the out-of-sample results of the six specialists. Validate those bots and it will start trusting them in the regimes where they proved themselves.</div>
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const run = async () => {
    setBusy(true); setErr(null); setRes(null)
    try {
      const overrides = { granularity: +f.granularity, contract: { family: f.family, duration: +f.duration, duration_unit: f.duration_unit } }
      if (f.params.trim()) overrides.params = JSON.parse(f.params)
      setRes(await api(`/bots/${b.id}/validate`, { method: 'POST', body: { days: +f.days, folds: +f.folds, optimise: f.optimise, overrides } }))
      reload()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const o = res?.oos_stats
  return (
    <>
      <div className="alert info">Anchored walk-forward: parameters are optimised on past data only, then scored on the next unseen window. Only out-of-sample trades count. A passing run creates a <b>proposed</b> version — nothing changes until you deploy it.</div>
      <div className="form">
        <label className="f">History (days)<input type="number" value={f.days} onChange={set('days')} /></label>
        <label className="f">Folds<input type="number" min="2" max="8" value={f.folds} onChange={set('folds')} /></label>
        <label className="f">Timeframe<select value={f.granularity} onChange={set('granularity')}>{GRANULARITIES.map((g) => <option key={g} value={g}>{fmt.gran(g)}</option>)}</select></label>
        <label className="f">Contract<select value={f.family} onChange={set('family')}>{['rise_fall', 'higher_lower', 'touch', 'no_touch', 'multiplier'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="f">Duration<input type="number" value={f.duration} onChange={set('duration')} /></label>
        <label className="f">Unit<select value={f.duration_unit} onChange={set('duration_unit')}>{['m', 'h', 's'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="f row" style={{ flexDirection: 'row', gap: 6 }}><input type="checkbox" checked={f.optimise} onChange={set('optimise')} />Optimise parameters</label>
      </div>
      <label className="f">Parameter overrides (JSON, optional)<textarea rows="2" value={f.params} onChange={set('params')} placeholder='{"adx_min": 25}' /></label>
      <div className="row"><button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Downloading history & testing…' : 'Run walk-forward validation'}</button></div>
      {err && <div className="alert err">{err}</div>}
      {res && (
        <>
          <div className={`alert ${res.passed_validation ? 'info' : 'warn'}`}>Version v{res.version}: <b>{res.passed_validation ? 'PASSED' : 'FAILED'}</b> — {res.positive_folds}/{res.folds} profitable OOS folds.
            {res.breakeven_win_rate && <> Breakeven win rate at this payout: {fmt.pct(res.breakeven_win_rate)}.</>}
            {res.passed_validation ? ' Deploy it from the Versions tab.' : ' This version cannot be deployed.'}</div>
          <div className="kpis">
            <div className="kpi"><div className="l">OOS trades</div><div className="v">{o.trades}</div></div>
            <div className="kpi"><div className="l">Win rate</div><div className="v">{fmt.pct(o.win_rate)}</div></div>
            <div className="kpi"><div className="l">Profit factor</div><div className="v">{fmt.num(o.profit_factor)}</div></div>
            <div className="kpi"><div className="l">Expectancy / stake</div><div className={`v ${pnlCls(o.expectancy_per_stake)}`}>{fmt.num(o.expectancy_per_stake, 4)}</div></div>
            <div className="kpi"><div className="l">Max DD</div><div className="v down">{fmt.num(o.max_drawdown_pct)}%</div></div>
            <div className="kpi"><div className="l">Max loss streak</div><div className="v">{o.max_consecutive_losses}</div></div>
          </div>
          <table><thead><tr><th>Fold</th><th>Test window</th><th className="num">IS trades</th><th className="num">IS win</th><th className="num">OOS trades</th><th className="num">OOS win</th><th className="num">OOS exp.</th></tr></thead>
            <tbody>{res.windows.map((w) => <tr key={w.fold}><td>{w.fold}</td><td className="mini">{fmt.time(w.test_from)} → {fmt.time(w.test_to)}</td>
              <td className="num">{w.in_sample.trades}</td><td className="num">{fmt.pct(w.in_sample.win_rate)}</td>
              <td className="num">{w.out_of_sample.trades}</td><td className="num">{fmt.pct(w.out_of_sample.win_rate)}</td>
              <td className={`num ${pnlCls(w.out_of_sample.expectancy)}`}>{fmt.num(w.out_of_sample.expectancy, 3)}</td></tr>)}</tbody></table>
        </>
      )}
    </>
  )
}

function VersionsTab({ b, reload }) {
  return (
    <div className="scroll" style={{ maxHeight: 500 }}><table><thead><tr><th>Ver</th><th>Status</th><th>Created</th><th>Note</th><th className="num">OOS trades</th><th className="num">OOS win</th><th className="num">OOS exp.</th><th /></tr></thead>
      <tbody>{b.versions.map((v) => {
        const o = v.validation?.oos_stats
        const can = v.status === 'proposed' || v.status === 'archived'
        return (
          <tr key={v.id}><td className="mono">v{v.version}</td><td><Badge v={v.status} /></td><td className="mini">{fmt.time(v.created_at)}</td><td className="mini">{v.note}</td>
            <td className="num">{o?.trades ?? '—'}</td><td className="num">{fmt.pct(o?.win_rate)}</td><td className="num">{fmt.num(o?.expectancy_per_stake, 4)}</td>
            <td>{can && <Action className="btn sm" confirm={`${v.status === 'proposed' ? 'Deploy' : 'Restore'} v${v.version}? The bot restarts with this configuration.`}
              onClick={() => api(`/bots/${b.id}/deploy/${v.version}`, { method: 'POST' })} onDone={reload}>{v.status === 'proposed' ? 'Deploy' : 'Restore'}</Action>}</td></tr>)
      })}</tbody></table></div>
  )
}

function HealthTab({ b }) {
  const d = b.degradation
  return (
    <>
      <div className={`alert ${d.degraded ? 'err' : 'info'}`}>{d.degraded
        ? `Degraded: live win rate ${fmt.pct(d.win_rate)} is significantly below the expected ${fmt.pct(d.expected)} (z=${d.z}). The bot is auto-disabled when this happens.`
        : `Since this version was deployed: ${d.trades} settled trades, win rate ${fmt.pct(d.win_rate)} vs expected ${fmt.pct(d.expected)} (breakeven ${fmt.pct(d.breakeven)}). ${d.trades < 30 ? 'At least 30 trades are needed before a degradation test is meaningful.' : ''}`}</div>
      <Card title="Statistics (recorded trades)"><pre>{JSON.stringify(b.stats, null, 2)}</pre></Card>
    </>
  )
}
