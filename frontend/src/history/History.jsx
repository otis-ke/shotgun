import { useState } from 'react'
import { api, fmt } from '../api'
import { Badge, Card, pnlCls, useApi } from '../components'

export default function History() {
  const [tab, setTab] = useState('trades')
  const [status, setStatus] = useState('')
  const [bot, setBot] = useState('')
  const q = new URLSearchParams({ limit: 1000, ...(status && { status }), ...(bot && { bot_id: bot }) })
  const [trades] = useApi(tab === 'trades' ? `/trades?${q}` : null, [], 20000)
  const [orders] = useApi(tab === 'orders' ? '/orders?limit=300' : null, [], 20000)
  const [tx, , txErr] = useApi(tab === 'account' ? '/account/transactions?limit=100' : null)
  const exportCsv = () => {
    const cols = ['contract_id', 'bot_id', 'symbol', 'contract_type', 'direction', 'stake', 'payout', 'profit', 'status', 'buy_time', 'sell_time', 'confidence', 'regime', 'is_virtual']
    const csv = [cols.join(',')].concat((trades || []).map((t) => cols.map((c) => JSON.stringify(t[c] ?? '')).join(','))).join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'trades.csv'; a.click()
  }
  return (
    <>
      <h1>History</h1>
      <div className="tabs">{[['trades', 'Trades'], ['orders', 'Execution orders'], ['account', 'Deriv account activity']].map(([k, l]) =>
        <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'trades' && (
        <Card right={<div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">all statuses</option>{['open', 'won', 'lost'].map((s) => <option key={s}>{s}</option>)}</select>
          <select value={bot} onChange={(e) => setBot(e.target.value)}><option value="">all bots</option>{['trend', 'price_action', 'scalping', 'reversal', 'breakout', 'volatility', 'smart_ai', 'external'].map((s) => <option key={s}>{s}</option>)}</select>
          <button className="btn" onClick={exportCsv} disabled={!trades?.length}>Export CSV</button></div>}>
          <div className="scroll" style={{ maxHeight: 640 }}><table><thead><tr><th>Opened</th><th>Contract</th><th>Bot</th><th>Market</th><th>Type</th><th>Side</th><th className="num">Stake</th><th className="num">Payout</th><th className="num">P/L</th><th>Status</th><th className="num">Conf.</th><th>Regime</th><th>Acct</th></tr></thead>
            <tbody>{(trades || []).map((t) => (
              <tr key={t.contract_id}><td className="mini">{fmt.time(t.buy_time)}</td><td className="mono">{t.contract_id}</td><td>{t.bot_id}</td><td>{t.symbol}</td><td className="mini">{t.contract_type}</td>
                <td>{t.direction && <Badge v={t.direction} cls={t.direction === 'UP' ? 'up' : 'down'} />}</td>
                <td className="num">{fmt.num(t.stake)}</td><td className="num">{fmt.num(t.payout)}</td><td className={`num ${pnlCls(t.profit)}`}>{fmt.num(t.profit)}</td>
                <td><Badge v={t.status} /></td><td className="num">{fmt.num(t.confidence, 0)}</td><td className="mini">{t.regime}</td><td className="mini">{t.is_virtual ? 'demo' : 'REAL'}</td></tr>))}</tbody></table>
            {trades && !trades.length && <div className="empty">No trades recorded</div>}</div>
        </Card>)}
      {tab === 'orders' && (
        <Card><div className="mini" style={{ marginBottom: 8 }}>Every purchase attempt is written here before it is sent. UNKNOWN orders (connection lost mid-purchase) are reconciled against Deriv's records and never re-sent.</div>
          <div className="scroll" style={{ maxHeight: 640 }}><table><thead><tr><th>Time</th><th>Order id</th><th>Bot</th><th>Market</th><th>Type</th><th className="num">Stake</th><th>Status</th><th>Contract</th><th>Error</th></tr></thead>
            <tbody>{(orders || []).map((o) => <tr key={o.coid}><td className="mini">{fmt.time(o.ts)}</td><td className="mono mini">{o.coid.slice(0, 12)}</td><td>{o.bot_id}</td><td>{o.symbol}</td><td className="mini">{o.contract_type}</td>
              <td className="num">{fmt.num(o.stake)}</td><td><Badge v={o.status} /></td><td className="mono">{o.contract_id || '—'}</td><td className="mini down">{o.error}</td></tr>)}</tbody></table></div></Card>)}
      {tab === 'account' && (
        <Card>{txErr ? <div className="alert err">{txErr}</div> : !tx ? 'Loading…' :
          <div className="scroll" style={{ maxHeight: 640 }}><table><thead><tr><th>Time</th><th>Action</th><th>Description</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
            <tbody>{tx.statement.map((t) => <tr key={t.transaction_id}><td className="mini">{fmt.time(t.transaction_time)}</td><td>{t.action_type}</td><td className="mini">{t.longcode}</td>
              <td className={`num ${pnlCls(t.amount)}`}>{fmt.num(t.amount)}</td><td className="num">{fmt.num(t.balance_after)}</td></tr>)}</tbody></table>
            {!tx.statement.length && <div className="empty">No account transactions</div>}</div>}</Card>)}
    </>
  )
}
