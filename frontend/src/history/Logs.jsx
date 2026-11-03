import { useState } from 'react'
import { fmt } from '../api'
import { Badge, Card, useApi } from '../components'

const CATS = ['', 'execution', 'reconcile', 'risk', 'bots', 'config', 'optimizer', 'connection', 'security', 'mode']

export default function Logs() {
  const [cat, setCat] = useState('')
  const [logs] = useApi(`/logs?limit=500${cat ? `&category=${cat}` : ''}`, [cat], 10000)
  return (
    <>
      <h1>Activity Log</h1>
      <Card title="Audit log" right={<select value={cat} onChange={(e) => setCat(e.target.value)}>{CATS.map((c) => <option key={c} value={c}>{c || 'all categories'}</option>)}</select>}>
          <div className="scroll" style={{ maxHeight: 700 }}><table><thead><tr><th>Time</th><th>Level</th><th>Category</th><th>Message</th></tr></thead>
            <tbody>{(logs || []).map((l) => <tr key={l.id} title={l.data ? JSON.stringify(l.data, null, 2) : ''}><td className="mini">{fmt.time(l.ts)}</td>
              <td><Badge v={l.level} cls={l.level === 'WARN' ? 'pending' : l.level === 'ERROR' ? 'down' : ''} /></td><td className="mini">{l.category}</td><td>{l.message}</td></tr>)}</tbody></table></div>
        </Card>
    </>
  )
}
