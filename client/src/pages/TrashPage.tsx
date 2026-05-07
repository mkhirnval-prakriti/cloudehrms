import { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'

type DeletedUser = {
  id: number
  full_name: string
  login_id?: string | null
  email: string
  mobile?: string | null
  role: string
  branch_id?: number | null
  deleted_at: string
}

type LogRow = {
  id: number
  action: string
  entity_type: string
  entity_id: string
  created_at: string
  actor_name?: string
  actor_role?: string
}

type Retention = { mode: 'days' | 'minutes'; days: number; minutes: number }

const BRANCHES: Record<number, string> = { 1: 'Head Office', 2: 'Amritsar', 3: 'Jaipur', 5: 'Meerut' }

function daysLeft(deletedAt: string, retDays: number): number {
  const del = new Date(deletedAt).getTime()
  if (isNaN(del)) return retDays
  const expiry = del + retDays * 86400000
  const left = Math.ceil((expiry - Date.now()) / 86400000)
  return Math.max(0, left)
}

function roleColor(role: string) {
  switch (role) {
    case 'SUPER_ADMIN': return 'bg-purple-100 text-purple-800'
    case 'ADMIN': return 'bg-blue-100 text-blue-800'
    case 'LOCATION_MANAGER': return 'bg-amber-100 text-amber-800'
    case 'ATTENDANCE_MANAGER': return 'bg-cyan-100 text-cyan-800'
    default: return 'bg-gray-100 text-gray-700'
  }
}

function actionColor(action: string) {
  if (action.includes('delete') || action.includes('reject')) return 'text-red-600'
  if (action.includes('create') || action.includes('approve') || action.includes('restore')) return 'text-green-700'
  if (action.includes('login') || action.includes('logout')) return 'text-blue-600'
  if (action.includes('settings') || action.includes('update') || action.includes('edit')) return 'text-amber-700'
  return 'text-[#1f5e3b]'
}

export function TrashPage() {
  const { user } = useAuth()
  const isSuperAdmin = user?.role === 'SUPER_ADMIN'

  const [users, setUsers] = useState<DeletedUser[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [retention, setRetention] = useState<Retention>({ mode: 'days', days: 30, minutes: 30 })
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<DeletedUser | null>(null)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [tab, setTab] = useState<'trash' | 'audit'>('trash')

  // Audit log filters
  const [filterAction, setFilterAction] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')

  const loadData = useCallback(() => {
    if (!isSuperAdmin) return
    const params = new URLSearchParams({ limit: '500' })
    if (filterAction) params.set('action', filterAction)
    if (filterFrom) params.set('from', filterFrom)
    if (filterTo) params.set('to', filterTo)
    Promise.all([
      api<{ users: DeletedUser[] }>('/trash/users'),
      api<{ logs: LogRow[]; actions: string[] }>(`/audit/logs?${params}`),
      api<Retention>('/trash/retention'),
    ]).then(([u, l, r]) => {
      setUsers(u.users || [])
      setLogs(l.logs || [])
      setActions(l.actions || [])
      setRetention(r)
    }).catch((e) => setErr((e as Error).message))
  }, [isSuperAdmin, filterAction, filterFrom, filterTo])

  useEffect(() => { loadData() }, [loadData])

  function flash(msg: string) { setOk(msg); setTimeout(() => setOk(null), 4000) }

  async function restoreUser(id: number) {
    setErr(null)
    try {
      await api(`/trash/users/${id}/restore`, { method: 'POST' })
      setUsers((p) => p.filter((u) => u.id !== id))
      flash('Employee restored successfully.')
    } catch (e) { setErr((e as Error).message) }
  }

  function openConfirmDelete(u: DeletedUser) {
    setConfirmDelete(u)
    setDeleteErr(null)
  }

  async function permanentDelete(u: DeletedUser) {
    setDeleteErr(null)
    setDeleting(true)
    try {
      await api(`/trash/users/${u.id}`, { method: 'DELETE' })
      // Remove from UI immediately
      setUsers((p) => p.filter((x) => x.id !== u.id))
      setConfirmDelete(null)
      setDeleting(false)
      flash(`"${u.full_name}" permanently deleted.`)
      // Also reload from server to ensure fresh state
      loadData()
    } catch (e) {
      setDeleting(false)
      // Show error INSIDE the modal so user can see it
      setDeleteErr((e as Error).message || 'Delete failed. Please try again.')
    }
  }

  async function saveRetention() {
    setErr(null)
    try {
      const r = await api<Retention>('/trash/retention', { method: 'PATCH', body: JSON.stringify(retention) })
      setRetention(r)
      flash('Retention settings saved.')
    } catch (e) { setErr((e as Error).message) }
  }

  const filteredUsers = users.filter((u) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${u.full_name} ${u.login_id || ''} ${u.email || ''} ${u.mobile || ''}`.toLowerCase().includes(q)
  })

  if (!isSuperAdmin) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center text-sm text-[#1f5e3b]">
        🔒 Trash & Audit is restricted to Super Admin.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-5 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1f5e3b]">🗑️ Trash & Audit</h1>
          <p className="text-sm text-[#1f5e3b]/60">Restore or permanently remove deleted staff · View system audit trail</p>
        </div>
      </div>

      {err && <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{err}</div>}
      {ok && <div className="rounded-xl bg-green-50 px-4 py-2 text-sm text-green-700">✅ {ok}</div>}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#1f5e3b]/15">
        {([['trash', '🗑️ Deleted Staff'], ['audit', '📋 Audit Log']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-5 py-2 text-sm font-semibold transition-colors ${tab === k ? 'border-b-2 border-[#1f5e3b] text-[#1f5e3b]' : 'text-[#1f5e3b]/50 hover:text-[#1f5e3b]'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* TRASH TAB */}
      {tab === 'trash' && (
        <div className="space-y-4">
          {/* Retention settings */}
          <div className="ph-card rounded-2xl p-4">
            <h2 className="mb-3 text-sm font-semibold text-[#1f5e3b]">⏱️ Auto-Delete Retention</h2>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs">
                <span className="mb-1 block font-semibold text-[#1f5e3b]/70">Mode</span>
                <select
                  value={retention.mode}
                  onChange={(e) => setRetention((p) => ({ ...p, mode: e.target.value as 'days' | 'minutes' }))}
                  className="rounded-lg border border-[#1f5e3b]/15 px-2 py-1.5 text-sm"
                >
                  <option value="days">Days</option>
                  <option value="minutes">Minutes (testing)</option>
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-semibold text-[#1f5e3b]/70">Days</span>
                <input
                  type="number" min={1} value={retention.days}
                  onChange={(e) => setRetention((p) => ({ ...p, days: Number(e.target.value) || 30 }))}
                  className="w-20 rounded-lg border border-[#1f5e3b]/15 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-semibold text-[#1f5e3b]/70">Minutes</span>
                <input
                  type="number" min={1} value={retention.minutes}
                  onChange={(e) => setRetention((p) => ({ ...p, minutes: Number(e.target.value) || 30 }))}
                  className="w-20 rounded-lg border border-[#1f5e3b]/15 px-2 py-1.5 text-sm"
                />
              </label>
              <button onClick={() => void saveRetention()}
                className="rounded-lg bg-[#1f5e3b] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#174d30]">
                Save
              </button>
            </div>
          </div>

          {/* Search + refresh row */}
          <div className="flex items-center gap-2">
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name / ID / email / mobile…"
              className="flex-1 rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-sm text-[#1f5e3b]/60 hover:text-[#1f5e3b]">✕ Clear</button>
            )}
            <button onClick={loadData} className="rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm text-[#1f5e3b]/60 hover:text-[#1f5e3b]" title="Refresh">↻</button>
          </div>

          {filteredUsers.length === 0 && (
            <div className="ph-card rounded-2xl p-8 text-center text-sm text-[#1f5e3b]/50">
              {search.trim() ? 'No deleted staff match your search.' : '✅ Trash is empty — no deleted staff.'}
            </div>
          )}

          {/* Employee cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredUsers.map((u) => {
              const left = daysLeft(u.deleted_at, retention.days)
              const urgent = left <= 3
              const branchName = u.branch_id ? (BRANCHES[u.branch_id] || `Branch ${u.branch_id}`) : 'No Branch'
              return (
                <div key={u.id} className={`ph-card rounded-2xl p-4 space-y-3 border-l-4 ${urgent ? 'border-red-400' : 'border-[#1f5e3b]/20'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-[#1f5e3b]">{u.full_name}</p>
                      <p className="text-xs text-[#1f5e3b]/60">{u.login_id || `#${u.id}`} · {branchName}</p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${roleColor(u.role)}`}>
                      {u.role.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="text-xs text-[#1f5e3b]/70 space-y-0.5">
                    <p>{u.email}</p>
                    {u.mobile && <p>{u.mobile}</p>}
                    <p className="text-[#1f5e3b]/50">Deleted: {new Date(u.deleted_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })}</p>
                  </div>
                  <div className={`text-xs font-semibold ${urgent ? 'text-red-600' : 'text-[#1f5e3b]/60'}`}>
                    {urgent ? `⚠️ Auto-deletes in ${left} day${left !== 1 ? 's' : ''}` : `🕐 ${left} days left`}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void restoreUser(u.id)}
                      className="flex-1 rounded-lg border border-[#1f5e3b]/30 py-1.5 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5"
                    >
                      ♻️ Restore
                    </button>
                    <button
                      onClick={() => openConfirmDelete(u)}
                      className="flex-1 rounded-lg border border-red-300 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      🗑️ Delete Forever
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* AUDIT LOG TAB */}
      {tab === 'audit' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="ph-card rounded-2xl p-4">
            <h2 className="mb-3 text-sm font-semibold text-[#1f5e3b]">🔍 Filter Audit Log</h2>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs">
                <span className="mb-1 block font-semibold text-[#1f5e3b]/70">Action Type</span>
                <select
                  value={filterAction}
                  onChange={(e) => setFilterAction(e.target.value)}
                  className="rounded-lg border border-[#1f5e3b]/15 px-2 py-1.5 text-sm min-w-[160px]"
                >
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
                Clear Filters
              </button>
            </div>
          </div>

          <div className="ph-card max-h-[70vh] overflow-auto rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-[#1f5e3b]/60">{logs.length} entries</p>
              <button onClick={loadData} className="text-xs text-[#1f5e3b]/60 hover:text-[#1f5e3b]">↻ Refresh</button>
            </div>
            <table className="w-full min-w-[600px] text-left text-xs">
              <thead>
                <tr className="border-b border-[#1f5e3b]/10 text-[#1f5e3b]/70">
                  <th className="py-2 pr-3 font-semibold">Time</th>
                  <th className="py-2 pr-3 font-semibold">Actor</th>
                  <th className="py-2 pr-3 font-semibold">Role</th>
                  <th className="py-2 pr-3 font-semibold">Action</th>
                  <th className="py-2 font-semibold">Entity</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-[#1f5e3b]/5 hover:bg-[#1f5e3b]/3">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-[#1f5e3b]/60">{new Date(l.created_at).toLocaleString('en-IN')}</td>
                    <td className="py-1.5 pr-3 font-medium text-[#1f5e3b]">{l.actor_name || '—'}</td>
                    <td className="py-1.5 pr-3 text-[#1f5e3b]/60">{(l as { actor_role?: string }).actor_role || ''}</td>
                    <td className={`py-1.5 pr-3 font-medium ${actionColor(l.action)}`}>{l.action}</td>
                    <td className="py-1.5 text-[#1f5e3b]/60">{l.entity_type} #{l.entity_id}</td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-[#1f5e3b]/40">No audit logs found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Permanent Delete Confirm Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-red-600">⚠️ Permanent Delete</h3>
            <p className="text-sm text-gray-700">
              This will <strong>permanently and irreversibly</strong> delete{' '}
              <strong>"{confirmDelete.full_name}"</strong> ({confirmDelete.login_id || `#${confirmDelete.id}`}) and all their data including attendance, payroll, documents, and leave records.
            </p>
            <p className="text-xs text-red-500 font-medium">This action cannot be undone.</p>

            {/* Error shown INSIDE modal so it's always visible */}
            {deleteErr && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                ❌ {deleteErr}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setConfirmDelete(null); setDeleteErr(null) }}
                disabled={deleting}
                className="flex-1 rounded-xl border border-gray-200 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void permanentDelete(confirmDelete)}
                disabled={deleting}
                className="flex-1 rounded-xl bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {deleting ? (
                  <>
                    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Deleting…
                  </>
                ) : (
                  'Delete Forever'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
