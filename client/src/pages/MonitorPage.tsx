import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'

type Alert = {
  id: number
  type: string
  severity: 'critical' | 'warning' | 'info' | string
  message: string
  user_name?: string
  actor_name?: string
  created_at: string
  read_by_admin: number
  meta?: string
}

type LogRow = {
  id: number
  action: string
  entity_type: string
  entity_id: string
  created_at: string
  actor_name?: string
  actor_role?: string
  actor_branch?: number
}

type LiveRow = {
  user_id: number
  full_name: string
  login_id?: string
  branch_id?: number
  work_date: string
  punch_in_at?: string
  punch_out_at?: string
  source?: string
  status?: string
}

const BRANCHES: Record<number, string> = { 1: 'HO', 2: 'Amritsar', 3: 'Jaipur', 5: 'Meerut' }
const POLL_INTERVAL = 30000

function sevBadge(sev: string) {
  switch (sev) {
    case 'critical': return 'bg-red-100 text-red-700 border-red-200'
    case 'warning': return 'bg-amber-100 text-amber-700 border-amber-200'
    default: return 'bg-green-50 text-green-700 border-green-200'
  }
}

function sevDot(sev: string) {
  switch (sev) {
    case 'critical': return 'bg-red-500'
    case 'warning': return 'bg-amber-400'
    default: return 'bg-green-500'
  }
}

function actionColor(action: string) {
  if (action.includes('delete') || action.includes('reject') || action.includes('fail')) return 'text-red-600'
  if (action.includes('create') || action.includes('approve') || action.includes('restore')) return 'text-green-700'
  if (action.includes('login')) return 'text-blue-600'
  if (action.includes('settings') || action.includes('update')) return 'text-amber-700'
  if (action.includes('punch') || action.includes('attendance')) return 'text-purple-700'
  return 'text-[#1f5e3b]'
}

function fmtTime(ts: string) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDateTime(ts: string) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function MonitorPage() {
  const { user } = useAuth()
  const isSuperAdmin = user?.role === 'SUPER_ADMIN'

  const [alerts, setAlerts] = useState<Alert[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [live, setLive] = useState<LiveRow[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [unread, setUnread] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [lastPoll, setLastPoll] = useState<Date | null>(null)
  const [tab, setTab] = useState<'feed' | 'alerts' | 'logs'>('feed')
  const [filterAction, setFilterAction] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadAlerts = useCallback(async () => {
    try {
      const r = await api<{ alerts: Alert[] }>('/hr/alerts?limit=100')
      setAlerts(r.alerts || [])
      setUnread((r.alerts || []).filter((a) => !a.read_by_admin).length)
    } catch { /* silent */ }
  }, [])

  const loadLive = useCallback(async () => {
    try {
      const r = await api<{ currently_in: LiveRow[] }>('/attendance/live-status')
      setLive(r.currently_in || [])
    } catch { /* silent */ }
  }, [])

  const loadLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '300' })
      if (filterAction) params.set('action', filterAction)
      if (filterFrom) params.set('from', filterFrom)
      if (filterTo) params.set('to', filterTo)
      const r = await api<{ logs: LogRow[]; actions: string[] }>(`/audit/logs?${params}`)
      setLogs(r.logs || [])
      setActions(r.actions || [])
    } catch { /* silent */ }
  }, [filterAction, filterFrom, filterTo])

  const poll = useCallback(async () => {
    setErr(null)
    try {
      await Promise.all([loadAlerts(), loadLive(), loadLogs()])
      setLastPoll(new Date())
    } catch (e) { setErr((e as Error).message) }
  }, [loadAlerts, loadLive, loadLogs])

  useEffect(() => {
    if (!isSuperAdmin) return
    void poll()
    timerRef.current = setInterval(() => void poll(), POLL_INTERVAL)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isSuperAdmin, poll])

  async function markRead(id: number) {
    try {
      await api(`/hr/alerts/${id}/read`, { method: 'PATCH' })
      setAlerts((p) => p.map((a) => a.id === id ? { ...a, read_by_admin: 1 } : a))
      setUnread((p) => Math.max(0, p - 1))
    } catch { /* silent */ }
  }

  async function markAllRead() {
    const unreadAlerts = alerts.filter((a) => !a.read_by_admin)
    await Promise.all(unreadAlerts.map((a) => markRead(a.id)))
  }

  if (!isSuperAdmin) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center">
        <p className="text-4xl mb-3">🔒</p>
        <p className="font-semibold text-[#1f5e3b]">Live Monitor is restricted to Super Admin only.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-5 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1f5e3b]">📊 Live Monitor</h1>
          <p className="text-sm text-[#1f5e3b]/60">
            Real-time system activity · Auto-refreshes every 30s
            {lastPoll && <span className="ml-2 text-[#1f5e3b]/40">Last: {fmtTime(lastPoll.toISOString())}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {unread > 0 && (
            <span className="rounded-full bg-red-500 px-2.5 py-0.5 text-xs font-bold text-white animate-pulse">
              {unread} unread
            </span>
          )}
          <button
            onClick={() => void poll()}
            className="rounded-xl border border-[#1f5e3b]/20 px-4 py-1.5 text-sm font-medium text-[#1f5e3b] hover:bg-[#1f5e3b]/5"
          >
            ↻ Refresh Now
          </button>
        </div>
      </div>

      {err && <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{err}</div>}

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="ph-card rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-[#1f5e3b]">{live.length}</p>
          <p className="text-xs text-[#1f5e3b]/60 mt-1">Currently In Office</p>
        </div>
        <div className="ph-card rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-[#1f5e3b]">{alerts.length}</p>
          <p className="text-xs text-[#1f5e3b]/60 mt-1">Total Alerts</p>
        </div>
        <div className="ph-card rounded-2xl p-4 text-center">
          <p className={`text-2xl font-bold ${unread > 0 ? 'text-red-600' : 'text-[#1f5e3b]'}`}>{unread}</p>
          <p className="text-xs text-[#1f5e3b]/60 mt-1">Unread Alerts</p>
        </div>
        <div className="ph-card rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-[#1f5e3b]">{logs.length}</p>
          <p className="text-xs text-[#1f5e3b]/60 mt-1">Audit Entries</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#1f5e3b]/15">
        {([
          ['feed', '📡 Live Feed'],
          ['alerts', `🔔 Alerts${unread > 0 ? ` (${unread})` : ''}`],
          ['logs', '📋 Audit Log'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-5 py-2 text-sm font-semibold transition-colors ${tab === k ? 'border-b-2 border-[#1f5e3b] text-[#1f5e3b]' : 'text-[#1f5e3b]/50 hover:text-[#1f5e3b]'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* LIVE FEED TAB */}
      {tab === 'feed' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-[#1f5e3b]">Today's Attendance Activity</h2>
          {live.length === 0 && (
            <div className="ph-card rounded-2xl p-8 text-center text-sm text-[#1f5e3b]/40">
              No attendance recorded today yet.
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {live.map((r, i) => (
              <div key={i} className="ph-card rounded-xl p-3 border-l-4 border-green-400">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold bg-green-100 text-green-700">
                    {r.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#1f5e3b] truncate">{r.full_name}</p>
                    <p className="text-xs text-[#1f5e3b]/60">{r.login_id}</p>
                  </div>
                  <div className="rounded-full px-2 py-0.5 text-xs font-bold bg-green-100 text-green-700">IN</div>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-[#1f5e3b]/60">
                  <span>{r.source || 'manual'}</span>
                  <span>{r.punch_in_at ? fmtDateTime(r.punch_in_at) : r.work_date}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ALERTS TAB */}
      {tab === 'alerts' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#1f5e3b]">System Alerts</h2>
            {unread > 0 && (
              <button onClick={() => void markAllRead()}
                className="text-xs text-[#1f5e3b]/60 hover:text-[#1f5e3b] underline">
                Mark all as read
              </button>
            )}
          </div>

          {alerts.length === 0 && (
            <div className="ph-card rounded-2xl p-8 text-center text-sm text-[#1f5e3b]/40">
              ✅ No alerts at this time.
            </div>
          )}

          <div className="space-y-2">
            {alerts.map((a) => (
              <div key={a.id} className={`ph-card rounded-xl p-4 border ${sevBadge(a.severity)} ${!a.read_by_admin ? 'ring-1 ring-inset ring-current' : 'opacity-75'}`}>
                <div className="flex items-start gap-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sevDot(a.severity)}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold uppercase">{a.severity}</span>
                      <span className="text-xs opacity-70">· {a.type}</span>
                      {a.user_name && <span className="text-xs opacity-70">· {a.user_name}</span>}
                    </div>
                    <p className="text-sm mt-1">{a.message}</p>
                    <p className="text-xs opacity-60 mt-1">{fmtDateTime(a.created_at)}</p>
                  </div>
                  {!a.read_by_admin && (
                    <button
                      onClick={() => void markRead(a.id)}
                      className="shrink-0 text-xs underline opacity-70 hover:opacity-100"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AUDIT LOG TAB */}
      {tab === 'logs' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="ph-card rounded-2xl p-4">
            <h2 className="mb-3 text-sm font-semibold text-[#1f5e3b]">🔍 Filter</h2>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs">
                <span className="mb-1 block font-semibold text-[#1f5e3b]/70">Action</span>
                <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}
                  className="rounded-lg border border-[#1f5e3b]/15 px-2 py-1.5 text-sm min-w-[160px]">
                  <option value="">All actions</option>
                  {actions.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-semibold text-[#1f5e3b]/70">From</span>
                <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)}
                  className="rounded-lg border border-[#1f5e3b]/15 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-semibold text-[#1f5e3b]/70">To</span>
                <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)}
                  className="rounded-lg border border-[#1f5e3b]/15 px-2 py-1.5 text-sm" />
              </label>
              <button onClick={() => { setFilterAction(''); setFilterFrom(''); setFilterTo('') }}
                className="self-end rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs text-[#1f5e3b] hover:bg-[#1f5e3b]/5">
                Clear
              </button>
              <button onClick={() => void loadLogs()}
                className="self-end rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#174d30]">
                Apply
              </button>
            </div>
          </div>

          <div className="ph-card max-h-[70vh] overflow-auto rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-[#1f5e3b]/60">{logs.length} entries</p>
              <button onClick={() => void loadLogs()} className="text-xs text-[#1f5e3b]/60 hover:text-[#1f5e3b]">↻ Refresh</button>
            </div>
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-[#1f5e3b]/10 text-[#1f5e3b]/70">
                  <th className="py-2 pr-3 font-semibold">Time</th>
                  <th className="py-2 pr-3 font-semibold">Actor</th>
                  <th className="py-2 pr-3 font-semibold">Role</th>
                  <th className="py-2 pr-3 font-semibold">Branch</th>
                  <th className="py-2 pr-3 font-semibold">Action</th>
                  <th className="py-2 font-semibold">Entity</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-[#1f5e3b]/5 hover:bg-[#1f5e3b]/3">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-[#1f5e3b]/60">{fmtDateTime(l.created_at)}</td>
                    <td className="py-1.5 pr-3 font-medium text-[#1f5e3b]">{l.actor_name || '—'}</td>
                    <td className="py-1.5 pr-3 text-[#1f5e3b]/60">{l.actor_role || ''}</td>
                    <td className="py-1.5 pr-3 text-[#1f5e3b]/60">{l.actor_branch ? (BRANCHES[l.actor_branch] || `B${l.actor_branch}`) : ''}</td>
                    <td className={`py-1.5 pr-3 font-medium ${actionColor(l.action)}`}>{l.action}</td>
                    <td className="py-1.5 text-[#1f5e3b]/60">{l.entity_type} #{l.entity_id}</td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-[#1f5e3b]/40">No audit logs found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
