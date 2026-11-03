// Global risk manager (port of backend/risk_management). Every order from every bot passes `check`.
// Stake is a fixed fraction of balance and never depends on past outcomes -> martingale is impossible.
export const DEFAULT_RISK = {
  risk_pct_per_trade: 1.0, fixed_stake: null, min_stake: 0.35, max_stake: 50.0, max_daily_loss_pct: 3.0,
  max_drawdown_pct: 10.0, max_consecutive_losses: 3, cooldown_minutes: 60, max_open_trades: 3, max_open_per_symbol: 1,
  max_trades_per_hour: 10, max_exposure_pct: 3.0, daily_profit_target_pct: 5.0, min_balance: 10.0,
}

const now = () => Date.now() / 1000
export const utcDayStart = (ts = now()) => { const d = new Date(ts * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 }
const CLOSED = ['won', 'lost', 'sold']

export class RiskManager {
  constructor(store) { this.store = store; this.reserved = new Map() }

  config() { return { ...DEFAULT_RISK, ...(this.store.kv('risk_config', {}) || {}) } }

  updateConfig(changes) {
    const bad = Object.keys(changes).filter((k) => !(k in DEFAULT_RISK))
    if (bad.length) throw new Error(`unknown risk settings ${bad.join(', ')}`)
    for (const k of ['risk_pct_per_trade', 'max_daily_loss_pct', 'max_drawdown_pct', 'max_exposure_pct']) {
      if (changes[k] != null && !(changes[k] > 0 && changes[k] <= 100)) throw new Error(`${k} must be between 0 and 100`)
    }
    if (changes.risk_pct_per_trade && changes.risk_pct_per_trade > 5) throw new Error('risk per trade above 5% is not allowed')
    const cfg = { ...this.config(), ...changes }
    this.store.setKv('risk_config', cfg)
    this.store.audit('risk', 'risk configuration updated', { changes })
    return cfg
  }

  recordBalance(balance, loginid) {
    const key = `peak:${loginid || 'default'}`, peak = this.store.kv(key)
    if (peak == null || balance > peak) this.store.setKv(key, balance)
    const dkey = `day_start:${loginid || 'default'}:${utcDayStart()}`
    if (this.store.kv(dkey) == null) this.store.setKv(dkey, balance)
  }

  resetPeak(balance, loginid) {
    this.store.setKv(`peak:${loginid || 'default'}`, balance)
    this.store.audit('risk', 'drawdown peak reset by user', { balance })
  }

  suspension() {
    const s = this.store.kv('suspension')
    if (s?.until && s.until < now()) { this.store.setKv('suspension', null); this.store.audit('risk', 'trading suspension expired'); return null }
    return s
  }

  suspend(reason, minutes = null) {
    const cur = this.suspension()
    if (cur?.reason === reason) return
    const until = minutes ? now() + minutes * 60 : null
    this.store.setKv('suspension', { reason, since: now(), until })
    this.store.audit('risk', `TRADING SUSPENDED: ${reason}`, { until }, 'WARN')
  }

  resume() { this.store.setKv('suspension', null); this.store.audit('risk', 'trading suspension cleared by user') }

  state(balance, loginid) {
    const cfg = this.config(), day0 = utcDayStart(), trades = this.store.all('trades')
    const closed = trades.filter((t) => CLOSED.includes(t.status)).sort((a, b) => (b.sell_time || 0) - (a.sell_time || 0))
    const dayPnl = Math.round(closed.filter((t) => t.sell_time >= day0).reduce((s, t) => s + (t.profit || 0), 0) * 100) / 100
    let consec = 0
    for (const t of closed.slice(0, Math.max(20, cfg.max_consecutive_losses + 1))) { if (t.status === 'won') break; consec++ }
    const openAll = [...trades.filter((t) => t.status === 'open'), ...this.reserved.values()]
    const exposure = Math.round(openAll.reduce((s, t) => s + (t.stake || 0), 0) * 100) / 100
    const nHour = this.store.all('orders').filter((o) => o.ts >= now() - 3600 && ['SENT', 'BOUGHT', 'UNKNOWN'].includes(o.status)).length
    const dayStart = this.store.kv(`day_start:${loginid || 'default'}:${day0}`) || balance
    const peak = this.store.kv(`peak:${loginid || 'default'}`) || balance
    const dd = peak && balance != null ? ((peak - balance) / peak) * 100 : 0
    const r3 = (x) => Math.round(x * 1000) / 1000
    return {
      balance, day_start_balance: dayStart, daily_pnl: dayPnl, daily_pnl_pct: dayStart ? r3((dayPnl / dayStart) * 100) : 0,
      peak_balance: peak, drawdown_pct: r3(dd), consecutive_losses: consec, open_trades: openAll.length, exposure,
      exposure_pct: balance ? r3((exposure / balance) * 100) : null, trades_last_hour: nHour, suspension: this.suspension(), limits: cfg,
    }
  }

  size(balance, botMax) {
    const cfg = this.config()
    const stake = Math.min(cfg.fixed_stake || (balance * cfg.risk_pct_per_trade) / 100, cfg.max_stake, botMax || Infinity)
    return Math.round(stake * 100) / 100
  }

  check({ balance, symbol, loginid, botMaxStake }) {
    const cfg = this.config()
    if (balance == null) return { approved: false, stake: 0, reasons: ['account balance unknown'] }
    const st = this.state(balance, loginid), r = []
    if (st.suspension) r.push(`trading suspended: ${st.suspension.reason}`)
    if (balance < cfg.min_balance) r.push(`balance ${balance} below protection floor ${cfg.min_balance}`)
    if (st.daily_pnl_pct <= -cfg.max_daily_loss_pct) {
      this.suspend(`max daily loss ${cfg.max_daily_loss_pct}% reached`, (utcDayStart() + 86400 - now()) / 60)
      r.push('max daily loss reached')
    }
    if (st.drawdown_pct >= cfg.max_drawdown_pct) { this.suspend(`max drawdown ${cfg.max_drawdown_pct}% reached - manual review required`); r.push('max drawdown reached') }
    if (st.consecutive_losses >= cfg.max_consecutive_losses) {
      this.suspend(`${st.consecutive_losses} consecutive losses - cooldown`, cfg.cooldown_minutes)
      r.push('consecutive loss limit')
    }
    const tgt = cfg.daily_profit_target_pct
    if (tgt && st.daily_pnl_pct >= tgt) r.push(`daily profit target ${tgt}% reached - done for today`)
    if (st.open_trades >= cfg.max_open_trades) r.push('max simultaneous trades reached')
    const nSym = this.store.all('trades').filter((t) => t.status === 'open' && t.symbol === symbol).length +
      [...this.reserved.values()].filter((x) => x.symbol === symbol).length
    if (nSym >= cfg.max_open_per_symbol) r.push(`already have an open position on ${symbol}`)
    if (st.trades_last_hour >= cfg.max_trades_per_hour) r.push('max trades per hour reached')
    const stake = this.size(balance, botMaxStake)
    if (stake < cfg.min_stake) r.push(`computed stake ${stake} below Deriv minimum ${cfg.min_stake}`)
    if (balance && ((st.exposure + stake) / balance) * 100 > cfg.max_exposure_pct) r.push(`exposure would exceed ${cfg.max_exposure_pct}% of balance`)
    if (stake > balance) r.push('stake exceeds balance')
    return { approved: !r.length, stake: r.length ? 0 : stake, reasons: r.length ? r : ['all risk checks passed'], state: st }
  }

  reserve(coid, symbol, stake, botId) { this.reserved.set(coid, { symbol, stake, bot_id: botId }) }
  release(coid) { this.reserved.delete(coid) }
}
