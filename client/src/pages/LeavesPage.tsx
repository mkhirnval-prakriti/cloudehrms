import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

type LeaveRow = {
  id: number
  user_id: number
  start_date: string
  end_date: string
  reason: string
  final_status: string
  manager_review: string | null
  admin_review: string | null
  manager_comment: string | null
  admin_comment: string | null
  full_name?: string
  role?: string
}

type LeaveMessage = {
  id: number
  leave_id: number
  author_id: number
  author_name: string
  author_role: string
  body: string
  created_at: string
}

// ── Roles that are NEVER allowed to apply leave ──
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN']

function statusPill(status: string) {
  const s = status.toUpperCase()
  if (s === 'APPROVED') return { label: '✅ Approved', cls: 'bg-emerald-100 text-emerald-700' }
  if (s === 'REJECTED') return { label: '❌ Rejected', cls: 'bg-red-100 text-red-700' }
  return { label: '⏳ Pending', cls: 'bg-amber-100 text-amber-800' }
}

function roleBadge(role?: string) {
  if (!role) return ''
  const map: Record<string, string> = {
    SUPER_ADMIN: 'Super Admin',
    ADMIN: 'Admin',
    LOCATION_MANAGER: 'Branch Mgr',
    ATTENDANCE_MANAGER: 'Attendance Mgr',
    USER: 'Staff',
  }
  return map[role] || role
}

export function LeavesPage() {
  const { user } = useAuth()
  const [leaves, setLeaves] = useState<LeaveRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [applyErr, setApplyErr] = useState<string | null>(null)
  const [applyOk, setApplyOk] = useState(false)

  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')

  const [openThreadId, setOpenThreadId] = useState<number | null>(null)
  const [threads, setThreads] = useState<Record<number, LeaveMessage[]>>({})
  const [threadDraft, setThreadDraft] = useState<Record<number, string>>({})
  const [threadErr, setThreadErr] = useState<string | null>(null)

  // Per-row decide state
  const [decideComments, setDecideComments] = useState<Record<number, string>>({})
  const [decideErr, setDecideErr] = useState<string | null>(null)
  const [decideLoading, setDecideLoading] = useState<number | null>(null)

  const canApprove = canPerm(user, 'leave:approve_manager')
  const canReadAll = canPerm(user, 'leave:read_all')
  // Apply form: staff, branch manager, attendance manager — NOT admin/super admin
  const canApplyLeave = canPerm(user, 'leave:apply') && !ADMIN_ROLES.includes(user?.role ?? '')

  const threadBottomRef = useRef<Record<number, HTMLDivElement | null>>({})

  async function load() {
    setErr(null)
    setLoading(true)
    try {
      const d = await api<{ leaves: LeaveRow[] }>('/leave')
      setLeaves(d.leaves || [])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function apply(e: React.FormEvent) {
    e.preventDefault()
    setApplyErr(null)
    setApplyOk(false)
    try {
      await api('/leave/apply', {
        method: 'POST',
        body: JSON.stringify({ start_date: start, end_date: end, reason }),
      })
      setReason('')
      setStart('')
      setEnd('')
      setApplyOk(true)
      await load()
    } catch (e) {
      setApplyErr((e as Error).message)
    }
  }

  async function loadThread(leaveId: number) {
    try {
      const data = await api<{ messages: LeaveMessage[] }>(`/leave/${leaveId}/thread`)
      setThreads((prev) => ({ ...prev, [leaveId]: data.messages || [] }))
      setTimeout(() => {
        threadBottomRef.current[leaveId]?.scrollIntoView({ behavior: 'smooth' })
      }, 50)
    } catch { /* ignore */ }
  }

  async function sendThreadMessage(leaveId: number) {
    const body = String(threadDraft[leaveId] || '').trim()
    if (!body) return
    setThreadErr(null)
    try {
      await api(`/leave/${leaveId}/thread`, { method: 'POST', body: JSON.stringify({ body }) })
      setThreadDraft((prev) => ({ ...prev, [leaveId]: '' }))
      await loadThread(leaveId)
    } catch (e) {
      setThreadErr((e as Error).message)
    }
  }

  async function decide(leaveId: number, action: 'approve' | 'reject') {
    setDecideErr(null)
    setDecideLoading(leaveId)
    try {
      await api(`/leave/${leaveId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ action, comment: decideComments[leaveId] || '' }),
      })
      await load()
    } catch (e) {
      setDecideErr((e as Error).message)
    } finally {
      setDecideLoading(null)
    }
  }

  // Determine if the current user can decide on a specific leave
  function canDecideLeave(L: LeaveRow): boolean {
    if (!canApprove) return false
    if (String(L.final_status).toUpperCase() !== 'PENDING') return false
    if (Number(user?.id) === L.user_id) return false // no self-approval
    // Branch Manager cannot decide on another Branch Manager's leave
    if (user?.role === 'LOCATION_MANAGER' && L.role === 'LOCATION_MANAGER') return false
    return true
  }

  const filteredLeaves = leaves.filter((L) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${L.full_name || ''} ${L.user_id} ${L.reason}`.toLowerCase().includes(q)
  })

  const myPendingCount = leaves.filter((L) => L.user_id === user?.id && L.final_status === 'PENDING').length
  const pendingForApproval = canReadAll
    ? leaves.filter((L) => L.final_status === 'PENDING' && canDecideLeave(L)).length
    : 0

  return (
    <div className="mx-auto max-w-[1000px] space-y-6 pb-8">
      {/* ── Page header ── */}
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">
          {canApprove ? '📋 Leave Management' : '🏖️ My Leave Requests'}
        </h1>
        <p className="text-sm text-[#1f5e3b]/70">
          {canApprove
            ? `Review and approve employee leave requests.${pendingForApproval > 0 ? ` (${pendingForApproval} pending your action)` : ''}`
            : 'छुट्टी के लिए आवेदन करें और status track करें।'}
        </p>
      </div>

      {/* ── Apply form: Staff / Branch Mgr / Attendance Mgr only ── */}
      {canApplyLeave && (
        <form onSubmit={apply} className="ph-card space-y-4 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-[#1f5e3b]">🗓️ छुट्टी के लिए आवेदन</h2>
          {myPendingCount > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              ⚠️ आपकी {myPendingCount} रिक्वेस्ट अभी pending है — नई तारीखों पर ही apply करें।
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">शुरुआत की तारीख *</span>
              <input
                required
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                min={new Date().toISOString().slice(0, 10)}
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">समाप्ति की तारीख *</span>
              <input
                required
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                min={start || new Date().toISOString().slice(0, 10)}
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block font-medium">कारण *</span>
              <textarea
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="छुट्टी का कारण लिखें…"
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
              />
            </label>
          </div>
          {applyErr && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              ❌ {applyErr}
            </div>
          )}
          {applyOk && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              ✅ आपकी leave request सफलतापूर्वक जमा हो गई। Manager जल्द ही review करेगा।
            </div>
          )}
          <button
            type="submit"
            className="rounded-xl bg-[#1f5e3b] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Request भेजें
          </button>
        </form>
      )}

      {/* ── Leave request list ── */}
      <div className="ph-card rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-[#1f5e3b]">
            {canReadAll ? 'All Requests' : 'मेरी Requests'}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {canReadAll && (
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name / emp id / reason"
                className="rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-xs"
              />
            )}
            <button type="button" onClick={load} className="text-sm font-medium text-[#1f5e3b] underline">
              Refresh
            </button>
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="rounded-lg border border-[#1f5e3b]/20 px-2 py-1 text-xs font-semibold text-[#1f5e3b]"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {err && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">❌ {err}</p>}
        {decideErr && (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            ❌ {decideErr}
          </p>
        )}

        {loading ? (
          <div className="mt-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-[#1f5e3b]/5" />
            ))}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {filteredLeaves.map((L) => {
              const pill = statusPill(L.final_status)
              const isSelf = Number(user?.id) === L.user_id
              const canDecide = canDecideLeave(L)
              const isOpen = openThreadId === L.id
              const msgs = threads[L.id] || []

              return (
                <div
                  key={L.id}
                  className={`rounded-2xl border p-4 text-sm transition ${
                    L.final_status === 'APPROVED'
                      ? 'border-emerald-200 bg-emerald-50/40'
                      : L.final_status === 'REJECTED'
                      ? 'border-red-200 bg-red-50/30'
                      : 'border-[#1f5e3b]/10 bg-white/80'
                  }`}
                >
                  {/* ── Header row ── */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-[#14261a]">
                          {L.full_name || `User #${L.user_id}`}
                          {isSelf && <span className="ml-1 text-xs text-[#1f5e3b]/60">(आप)</span>}
                        </p>
                        {canReadAll && L.role && (
                          <span className="rounded-full bg-[#1f5e3b]/10 px-2 py-0.5 text-[10px] font-semibold text-[#1f5e3b]">
                            {roleBadge(L.role)}
                          </span>
                        )}
                        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${pill.cls}`}>
                          {pill.label}
                        </span>
                      </div>
                      <p className="text-xs text-[#1f5e3b]/70">
                        📅 {L.start_date} → {L.end_date}
                      </p>
                      <p className="text-[#14261a]/80">{L.reason}</p>
                      {(L.manager_comment || L.admin_comment) && (
                        <p className="text-xs text-[#1f5e3b]/65">
                          {L.manager_comment && `Manager: "${L.manager_comment}"`}
                          {L.admin_comment && ` · Admin: "${L.admin_comment}"`}
                        </p>
                      )}
                    </div>

                    {/* ── Action buttons ── */}
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          if (isOpen) { setOpenThreadId(null); return }
                          setOpenThreadId(L.id)
                          await loadThread(L.id)
                        }}
                        className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5"
                      >
                        {isOpen ? '▲ Hide chat' : `💬 Chat${msgs.length ? ` (${msgs.length})` : ''}`}
                      </button>

                      {canDecide && (
                        <div className="space-y-2">
                          <input
                            value={decideComments[L.id] || ''}
                            onChange={(e) =>
                              setDecideComments((prev) => ({ ...prev, [L.id]: e.target.value }))
                            }
                            placeholder="टिप्पणी (वैकल्पिक)"
                            className="w-44 rounded-lg border border-[#1f5e3b]/20 px-2 py-1 text-xs"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={decideLoading === L.id}
                              onClick={() => decide(L.id, 'approve')}
                              className="rounded-lg bg-[#2e7d32] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                            >
                              {decideLoading === L.id ? '…' : '✅ Approve'}
                            </button>
                            <button
                              type="button"
                              disabled={decideLoading === L.id}
                              onClick={() => decide(L.id, 'reject')}
                              className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50"
                            >
                              {decideLoading === L.id ? '…' : '❌ Reject'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Self-approval notice */}
                      {canApprove && isSelf && L.final_status === 'PENDING' && (
                        <p className="max-w-[160px] text-right text-[10px] text-amber-700">
                          आप अपनी रिक्वेस्ट approve नहीं कर सकते
                        </p>
                      )}

                      {/* Branch Mgr cannot approve Branch Mgr notice */}
                      {canApprove &&
                        !isSelf &&
                        user?.role === 'LOCATION_MANAGER' &&
                        L.role === 'LOCATION_MANAGER' &&
                        L.final_status === 'PENDING' && (
                          <p className="max-w-[160px] text-right text-[10px] text-amber-700">
                            Admin/Super Admin ही approve करेंगे
                          </p>
                        )}
                    </div>
                  </div>

                  {/* ── Chat thread ── */}
                  {isOpen && (
                    <div className="mt-4 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/70">
                        💬 Conversation
                      </p>
                      <div className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
                        {msgs.length === 0 && (
                          <p className="text-xs text-[#1f5e3b]/50">
                            कोई message नहीं — नीचे से शुरू करें।
                          </p>
                        )}
                        {msgs.map((m) => {
                          const mine = Number(m.author_id) === Number(user?.id)
                          return (
                            <div
                              key={m.id}
                              className={`max-w-[85%] rounded-xl px-3 py-2 text-xs ${
                                mine
                                  ? 'ml-auto bg-[#1f5e3b] text-white'
                                  : 'bg-white text-[#14261a] ring-1 ring-[#1f5e3b]/10'
                              }`}
                            >
                              <p className="font-semibold opacity-80">
                                {m.author_name} · {roleBadge(m.author_role)}
                              </p>
                              <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
                              <p className="mt-0.5 text-[10px] opacity-60">
                                {new Date(m.created_at).toLocaleString('hi-IN', {
                                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                                })}
                              </p>
                            </div>
                          )
                        })}
                        <div ref={(el) => { threadBottomRef.current[L.id] = el }} />
                      </div>
                      {threadErr && (
                        <p className="mt-2 text-xs text-red-600">{threadErr}</p>
                      )}
                      {L.final_status === 'PENDING' ? (
                        <div className="mt-3 flex gap-2">
                          <input
                            value={threadDraft[L.id] || ''}
                            onChange={(e) =>
                              setThreadDraft((prev) => ({ ...prev, [L.id]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                sendThreadMessage(L.id)
                              }
                            }}
                            placeholder="Message लिखें… (Enter से भेजें)"
                            className="flex-1 rounded-lg border border-[#1f5e3b]/20 px-3 py-2 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => sendThreadMessage(L.id)}
                            className="rounded-lg bg-[#1f5e3b] px-3 py-2 text-xs font-semibold text-white"
                          >
                            Send
                          </button>
                        </div>
                      ) : (
                        <p className="mt-3 text-xs text-[#1f5e3b]/55">
                          Thread closed — final decision already taken.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {filteredLeaves.length === 0 && (
              <p className="py-8 text-center text-sm text-[#1f5e3b]/50">
                {search.trim()
                  ? 'कोई result नहीं मिला।'
                  : canReadAll
                  ? 'कोई leave request नहीं।'
                  : 'आपने अभी तक कोई leave request नहीं डाली।'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
