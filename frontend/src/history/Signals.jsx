import { useEffect, useState } from 'react'
import { api, fmt } from '../api'
import { useLive } from '../App'
import { Action, Badge, Card, useApi } from '../components'

export default function Signals() {
  const { subscribe, status } = useLive()
  const [filter, setFilter] = useState('pending')
  const [sigs, reload] = useApi(`/signals?limit=300${filter ? `&status=${filter}` : ''}`, [filter], 10000)
  useEffect(() => subscribe((m) => { if (['signal', 'signal_update', 'approval_needed'].includes(m.type)) reload() }), [subscribe, reload])
  const mode = status?.mode
  return (
    <>
      <div className="row between"><h1>Signals & Approvals</h1>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>{[['pending', 'Awaiting approval'], ['', 'All'], ['executed', 'Executed'], ['rejected', 'Rejected'], ['expired', 'Expired']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      {(mode === 'manual' || mode === 'semi') && <div className="alert info">{mode === 'manual' ? 'Manual mode: every trade needs your approval.' : 'Semi-auto: bots with auto-execute enabled trade on their own; the rest wait here.'} Approval is still checked against all risk limits, and setups older than one candle expire.</div>}
      <Card>
        <div className="scroll" style={{ maxHeight: 700 }}><table><thead><tr><th>Time</th><th>Bot</th><th>Market</th><th>Side</th><th>Contract</th><th className="num">Conf.</th><th className="num">p(win)</th><th className="num">EV/stake</th><th>Regime</th><th>Why</th><th>Status</th><th /></tr></thead>
          <tbody>{(sigs || []).map((s) => (
            <tr key={s.id}><td className="mini">{fmt.ago(s.ts)}</td><td>{s.bot_id}</td><td>{s.symbol}</td><td><Badge v={s.direction} cls={s.direction === 'UP' ? 'up' : 'down'} /></td>
              <td className="mini">{s.contract_type}</td><td className="num">{fmt.num(s.confidence, 0)}</td><td className="num">{fmt.pct(s.calibrated_p)}</td><td className="num">{fmt.num(s.features?.ev, 3)}</td>
              <td className="mini">{s.regime}</td>
              <td className="mini" style={{ maxWidth: 360 }}>{(s.reasons || []).join(' · ')}{s.decision && <div className={s.status === 'rejected' ? 'down' : ''}>→ {s.decision}</div>}</td>
              <td><Badge v={s.status} /></td>
              <td>{s.status === 'pending' && <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Action className="btn sm good" onClick={() => api(`/signals/${s.id}/approve`, { method: 'POST' })} onDone={reload}>Approve</Action>
                <Action className="btn sm bad" onClick={() => api(`/signals/${s.id}/reject`, { method: 'POST' })} onDone={reload}>Reject</Action></div>}</td></tr>))}</tbody></table>
          {sigs && !sigs.length && <div className="empty">Nothing here</div>}</div>
      </Card>
    </>
  )
}
