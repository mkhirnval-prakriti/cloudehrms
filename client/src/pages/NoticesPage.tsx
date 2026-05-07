import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

// ── Types ──────────────────────────────────────────────────────────────────

type NoticeType = 'announcement' | 'discussion' | 'alert' | 'query'

type Notice = {
  id: number
  title: string
  body: string
  notice_type: NoticeType
  created_at: string
  author_name: string
  read_by_me: number
  reply_count: number
  allow_replies: number
  admin_replies_only: number
  target_branch_id: number | null
  target_branch_name: string | null
  target_role: string | null
  visible_from: string | null
  visible_until: string | null
  active?: number
}

type Reply = {
  id: number
  user_id: number
  user_name: string
  user_role: string
  body: string
  created_at: string
  is_admin_reply: number
}

type Branch = { id: number; name: string }

type NoticeStats = {
  readCount: number
  replyCount: number
  unansweredQueries: number
  targetCount: number
  unreadCount: number
  reads: { user_id: number; full_name: string; role?: string; read_at: string; branch_name?: string | null }[]
  unreads: { user_id: number; full_name: string; role?: string; branch_name?: string | null }[]
}

type CreateForm = {
  title: string
  body: string
  notice_type: NoticeType
  target_branch_id: string
  target_role: string
  allow_replies: boolean
  admin_replies_only: boolean
  visible_from: string
  visible_until: string
}

const emptyForm = (): CreateForm => ({
  title: '',
  body: '',
  notice_type: 'announcement',
  target_branch_id: '',
  target_role: '',
  allow_replies: true,
  admin_replies_only: false,
  visible_from: '',
  visible_until: '',
})

// ── Helpers ────────────────────────────────────────────────────────────────

const TYPE_META: Record<NoticeType, { label: string; emoji: string; bg: string; text: string; border: string }> = {
  announcement: { label: 'Announcement', emoji: '📢', bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
  discussion: { label: 'Discussion', emoji: '💬', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  alert: { label: 'Alert', emoji: '🚨', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  query: { label: 'Query', emoji: '❓', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
}

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  ATTENDANCE_MANAGER: 'HR / Attendance',
  LOCATION_MANAGER: 'Branch Manager',
  USER: 'Staff',
}

function TypeBadge({ type }: { type: NoticeType }) {
  const m = TYPE_META[type] || TYPE_META.announcement
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${m.bg} ${m.text} ${m.border}`}>
      {m.emoji} {m.label}
    </span>
  )
}

function TargetBadge({ branchName, role }: { branchName?: string | null; role?: string | null }) {
  if (!branchName && !role) return <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">🌐 Everyone</span>
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
      📍 {branchName || ''}{branchName && role ? ' · ' : ''}{role ? (ROLE_LABELS[role] || role) : ''}
    </span>
  )
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fullTime(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Convert "YYYY-MM-DD HH:MM:SS" (server) → "YYYY-MM-DDTHH:MM" (datetime-local input)
function toLocalInputValue(iso: string | null): string {
  if (!iso) return ''
  const s = iso.replace(' ', 'T')
  return s.length >= 16 ? s.slice(0, 16) : s
}

function isExpired(n: { visible_until: string | null }): boolean {
  if (!n.visible_until) return false
  const t = new Date(n.visible_until.replace(' ', 'T')).getTime()
  return !Number.isNaN(t) && t < Date.now()
}

// ── Main Page ──────────────────────────────────────────────────────────────

export function NoticesPage() {
  const { user } = useAuth()
  const canWrite = canPerm(user, 'notices:write')
  // Edit / Delete / Archive controls are restricted to Admin & Super Admin
  // per spec, even though notices:write may also include other roles.
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN'

  // view: 'list' | 'thread' | 'create' | 'edit'
  const [view, setView] = useState<'list' | 'thread' | 'create' | 'edit'>('list')
  const [notices, setNotices] = useState<Notice[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [err, setErr] = useState<string | null>(null)

  // Filters (admin-only)
  const [filterBranch, setFilterBranch] = useState('')
  const [filterType, setFilterType] = useState('')

  // Tab: 'active' (default) | 'archive' (admin-only history view)
  const [scope, setScope] = useState<'active' | 'archive'>('active')

  // ID of notice being edited (when view === 'edit')
  const [editingId, setEditingId] = useState<number | null>(null)

  // Thread view
  const [openNotice, setOpenNotice] = useState<Notice | null>(null)
  const [replies, setReplies] = useState<Reply[]>([])
  const [replyText, setReplyText] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [replyErr, setReplyErr] = useState<string | null>(null)
  const [stats, setStats] = useState<NoticeStats | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [statsTab, setStatsTab] = useState<'seen' | 'unseen'>('seen')
  const [nudging, setNudging] = useState(false)
  const replyInputRef = useRef<HTMLInputElement>(null)

  // Create form
  const [form, setForm] = useState<CreateForm>(emptyForm())
  const [submitting, setSubmitting] = useState(false)

  // Load notices
  const loadNotices = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (canWrite && filterBranch) params.set('branch_id', filterBranch)
      if (canWrite && filterType) params.set('notice_type', filterType)
      if (canWrite && scope === 'archive') params.set('scope', 'archive')
      const q = params.toString() ? `?${params}` : ''
      const d = await api<{ notices: Notice[] }>(`/notices${q}`)
      setNotices(d.notices || [])
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [canWrite, filterBranch, filterType, scope])

  useEffect(() => { void loadNotices() }, [loadNotices])

  // Load branches for create form / filter
  useEffect(() => {
    if (!canWrite) return
    api<{ branches: Branch[] }>('/branches').then((d) => setBranches(d.branches || [])).catch(() => {})
  }, [canWrite])

  // Light polling on open thread — refresh replies every 15s
  useEffect(() => {
    if (view !== 'thread' || !openNotice) return
    const id = openNotice.id
    const t = window.setInterval(async () => {
      try {
        const d = await api<{ replies: Reply[] }>(`/notices/${id}/replies`)
        setReplies((prev) => {
          const incoming = d.replies || []
          // Only update if changed (length OR latest id) to avoid re-renders
          if (incoming.length === prev.length && (incoming[incoming.length - 1]?.id ?? 0) === (prev[prev.length - 1]?.id ?? 0)) {
            return prev
          }
          return incoming
        })
      } catch { /* silent */ }
    }, 15000)
    return () => window.clearInterval(t)
  }, [view, openNotice])

  // Open thread
  async function openThread(n: Notice) {
    setOpenNotice(n)
    setReplies([])
    setReplyText('')
    setReplyErr(null)
    setStats(null)
    setStatsOpen(false)
    setView('thread')
    // mark read
    if (!n.read_by_me) {
      api(`/notices/${n.id}/read`, { method: 'POST' }).catch(() => {})
      setNotices((prev) => prev.map((x) => x.id === n.id ? { ...x, read_by_me: 1 } : x))
    }
    // load replies
    try {
      const d = await api<{ replies: Reply[] }>(`/notices/${n.id}/replies`)
      setReplies(d.replies || [])
    } catch { /* silent */ }
  }

  function backToList() {
    setView('list')
    setOpenNotice(null)
    setReplyErr(null)
  }

  async function sendReply() {
    if (!openNotice || !replyText.trim()) return
    setReplySending(true)
    setReplyErr(null)
    try {
      const d = await api<{ reply: Reply }>(`/notices/${openNotice.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: replyText.trim() }),
      })
      setReplies((prev) => [...prev, d.reply])
      setReplyText('')
      // Update reply count in list
      setNotices((prev) => prev.map((x) => x.id === openNotice.id ? { ...x, reply_count: x.reply_count + 1 } : x))
      replyInputRef.current?.focus()
    } catch (e) {
      setReplyErr((e as Error).message)
    } finally {
      setReplySending(false)
    }
  }

  async function deleteReply(rid: number) {
    if (!openNotice) return
    if (!confirm('Delete this reply?')) return
    try {
      await api(`/notices/${openNotice.id}/replies/${rid}`, { method: 'DELETE' })
      setReplies((prev) => prev.filter((r) => r.id !== rid))
      setNotices((prev) => prev.map((x) => x.id === openNotice.id ? { ...x, reply_count: Math.max(0, x.reply_count - 1) } : x))
    } catch (e) {
      setReplyErr((e as Error).message)
    }
  }

  async function toggleStats() {
    if (!openNotice) return
    const next = !statsOpen
    setStatsOpen(next)
    if (next && !stats) {
      try {
        const d = await api<NoticeStats>(`/notices/${openNotice.id}/stats`)
        setStats(d)
      } catch {
        setStats({ readCount: 0, replyCount: 0, unansweredQueries: 0, targetCount: 0, unreadCount: 0, reads: [], unreads: [] })
      }
    }
  }

  async function nudgeUnread() {
    if (!openNotice || !stats || stats.unreadCount === 0 || nudging) return
    if (!confirm(`Send a reminder push notification to ${stats.unreadCount} unread recipient(s)?`)) return
    setNudging(true)
    try {
      const d = await api<{ sent: number; message?: string }>(`/notices/${openNotice.id}/nudge`, { method: 'POST' })
      alert(d.message || `✓ Reminder sent to ${d.sent} people.`)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setNudging(false)
    }
  }

  async function deleteNotice(id: number) {
    if (!confirm('Delete this notice?\n\nIt will be removed from staff dashboards immediately.\nAdmins can still find it in the Archive tab.')) return
    try {
      await api(`/notices/${id}`, { method: 'DELETE' })
      await loadNotices()
      if (openNotice?.id === id) backToList()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  function startEdit(n: Notice) {
    setEditingId(n.id)
    setForm({
      title: n.title,
      body: n.body,
      notice_type: n.notice_type,
      target_branch_id: n.target_branch_id != null ? String(n.target_branch_id) : '',
      target_role: n.target_role || '',
      allow_replies: !!n.allow_replies,
      admin_replies_only: !!n.admin_replies_only,
      visible_from: toLocalInputValue(n.visible_from),
      visible_until: toLocalInputValue(n.visible_until),
    })
    setErr(null)
    setView('edit')
  }

  async function restoreNotice(id: number) {
    if (!confirm('Restore this notice? It will become visible to staff again.')) return
    try {
      await api(`/notices/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: true }),
      })
      await loadNotices()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || !form.body.trim()) return
    setSubmitting(true)
    setErr(null)
    try {
      const payload = {
        title: form.title.trim(),
        body: form.body.trim(),
        notice_type: form.notice_type,
        target_branch_id: form.target_branch_id ? Number(form.target_branch_id) : null,
        target_role: form.target_role || null,
        allow_replies: form.allow_replies,
        admin_replies_only: form.admin_replies_only,
        visible_from: form.visible_from || null,
        visible_until: form.visible_until || null,
      }
      if (view === 'edit' && editingId != null) {
        await api(`/notices/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
      } else {
        await api('/notices', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      }
      setForm(emptyForm())
      setEditingId(null)
      setView('list')
      await loadNotices()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Thread View ────────────────────────────────────────────────────────

  if (view === 'thread' && openNotice) {
    const n = openNotice
    const typeMeta = TYPE_META[n.notice_type] || TYPE_META.announcement
    const replyDisabledMsg = !n.allow_replies
      ? 'Replies are disabled for this notice.'
      : n.admin_replies_only && !canWrite
      ? 'Only admins can reply to this notice.'
      : null

    return (
      <div className="mx-auto max-w-[760px] space-y-4 pb-10">
        {/* Thread header */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={backToList}
            className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-sm font-medium text-[#1f5e3b] hover:bg-[#1f5e3b]/5 transition flex items-center gap-1.5"
          >
            ← Back
          </button>
          <div className="flex flex-wrap gap-1.5">
            <TypeBadge type={n.notice_type} />
            <TargetBadge branchName={n.target_branch_name} role={n.target_role} />
          </div>
          {isAdmin && (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => startEdit(n)}
                className="rounded-lg p-1.5 text-[#1f5e3b]/70 hover:bg-[#1f5e3b]/10 hover:text-[#1f5e3b] transition"
                title="Edit notice"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => void deleteNotice(n.id)}
                className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition"
                title="Delete notice"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Notice body */}
        <div className={`ph-card rounded-2xl p-6 border-l-4 ${typeMeta.border}`}>
          <h1 className="text-xl font-bold text-[#1f5e3b]">{n.title}</h1>
          <p className="mt-1 text-xs text-[#1f5e3b]/55">
            {typeMeta.emoji} {n.author_name} · {fullTime(n.created_at)}
          </p>
          <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-[#14261a]">{n.body}</p>

          {/* Reply controls info */}
          <div className="mt-4 flex flex-wrap gap-2">
            {!n.allow_replies && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">🚫 Replies off</span>
            )}
            {n.allow_replies && n.admin_replies_only && (
              <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] text-amber-700">🔒 Admin replies only</span>
            )}
            {canWrite && (
              <button
                type="button"
                onClick={() => void toggleStats()}
                className="ml-auto rounded-lg border border-[#1f5e3b]/20 px-3 py-1 text-[11px] font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5 transition"
              >
                {statsOpen ? 'Hide stats' : '👁 View stats'}
              </button>
            )}
          </div>

          {/* Stats panel */}
          {statsOpen && (
            <div className="mt-3 rounded-xl bg-[#f5faf6] p-4 space-y-3">
              {!stats ? (
                <p className="text-xs text-[#1f5e3b]/60 animate-pulse">Loading…</p>
              ) : (
                <>
                  {/* Top-line counters */}
                  <div className="flex flex-wrap gap-3 text-xs font-semibold text-[#1f5e3b]">
                    <span>👁 Seen {stats.readCount} / {stats.targetCount}</span>
                    <span>💬 {stats.replyCount} replies</span>
                    {stats.unansweredQueries > 0 && (
                      <span className="text-orange-600">⚠️ {stats.unansweredQueries} unanswered</span>
                    )}
                    {stats.unreadCount > 0 && isAdmin && (
                      <button
                        type="button"
                        onClick={() => void nudgeUnread()}
                        disabled={nudging}
                        className="ml-auto rounded-lg bg-[#1f5e3b] px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#14261a] disabled:opacity-60 transition"
                        title="Send a reminder push to all unread recipients"
                      >
                        {nudging ? 'Sending…' : `🔔 Nudge ${stats.unreadCount}`}
                      </button>
                    )}
                  </div>

                  {/* Seen / Unseen tabs */}
                  <div className="inline-flex rounded-lg border border-[#1f5e3b]/15 bg-white p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setStatsTab('seen')}
                      className={`rounded-md px-3 py-1 font-semibold transition ${statsTab === 'seen' ? 'bg-[#1f5e3b] text-white' : 'text-[#1f5e3b]/70 hover:bg-[#1f5e3b]/5'}`}
                    >
                      ✓ Seen ({stats.readCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatsTab('unseen')}
                      className={`rounded-md px-3 py-1 font-semibold transition ${statsTab === 'unseen' ? 'bg-amber-600 text-white' : 'text-amber-700/80 hover:bg-amber-600/10'}`}
                    >
                      ⏳ Unseen ({stats.unreadCount})
                    </button>
                  </div>

                  {/* Seen list */}
                  {statsTab === 'seen' && (
                    stats.reads.length === 0 ? (
                      <p className="text-xs italic text-[#1f5e3b]/50 py-2">Nobody has read this yet.</p>
                    ) : (
                      <div className="max-h-56 overflow-y-auto space-y-1">
                        {stats.reads.map((r) => (
                          <div key={r.user_id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-1.5 text-xs">
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium text-[#14261a]">{r.full_name}</div>
                              {r.branch_name && (
                                <div className="truncate text-[10px] text-[#1f5e3b]/55">📍 {r.branch_name}</div>
                              )}
                            </div>
                            <span className="flex-shrink-0 text-[#1f5e3b]/55">{fullTime(r.read_at)}</span>
                          </div>
                        ))}
                      </div>
                    )
                  )}

                  {/* Unseen list — grouped by branch */}
                  {statsTab === 'unseen' && (
                    stats.unreads.length === 0 ? (
                      <p className="text-xs italic text-[#2e7d32] py-2">🎉 Everyone has seen this notice.</p>
                    ) : (
                      <div className="max-h-56 overflow-y-auto space-y-2">
                        {(() => {
                          const groups: Record<string, NoticeStats['unreads']> = {}
                          for (const u of stats.unreads) {
                            const key = u.branch_name || 'No branch'
                            if (!groups[key]) groups[key] = []
                            groups[key].push(u)
                          }
                          return Object.entries(groups)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([branch, list]) => (
                              <div key={branch} className="rounded-lg bg-white p-2">
                                <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                  <span>📍 {branch}</span>
                                  <span className="text-amber-600">{list.length}</span>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {list.map((u) => (
                                    <span key={u.user_id} className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900 ring-1 ring-amber-200">
                                      {u.full_name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))
                        })()}
                      </div>
                    )
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Replies thread */}
        <div className="space-y-2">
          {replies.length === 0 && (
            <p className="text-center text-sm text-[#1f5e3b]/40 py-4">No replies yet. Be the first to respond.</p>
          )}
          {replies.map((r) => {
            const isAdmin = r.is_admin_reply === 1
            const isOwnReply = r.user_id === user?.id
            return (
              <div
                key={r.id}
                className={`flex gap-3 ${isAdmin ? 'flex-row' : 'flex-row-reverse'}`}
              >
                {/* Avatar */}
                <div className={`flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold ${isAdmin ? 'bg-[#1f5e3b] text-white' : 'bg-gray-200 text-gray-600'}`}>
                  {r.user_name.charAt(0).toUpperCase()}
                </div>
                {/* Bubble */}
                <div className={`max-w-[80%] space-y-0.5 ${isAdmin ? '' : 'items-end flex flex-col'}`}>
                  <div className={`rounded-2xl px-4 py-2.5 text-sm ${isAdmin ? 'bg-[#1f5e3b] text-white rounded-tl-sm' : 'bg-white border border-gray-200 text-[#14261a] rounded-tr-sm shadow-sm'}`}>
                    {r.body}
                  </div>
                  <div className="flex items-center gap-2">
                    <p className={`text-[10px] ${isAdmin ? 'text-[#1f5e3b]/60' : 'text-gray-400'}`}>
                      {isAdmin && <span className="font-semibold">Admin · </span>}
                      {r.user_name} · {timeAgo(r.created_at)}
                    </p>
                    {(canWrite || isOwnReply) && (
                      <button
                        type="button"
                        onClick={() => void deleteReply(r.id)}
                        className="text-[10px] text-red-400 hover:text-red-600 transition"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Reply input */}
        {replyDisabledMsg ? (
          <p className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-center text-sm text-gray-500">
            🔒 {replyDisabledMsg}
          </p>
        ) : (
          <div className="ph-card rounded-2xl p-4">
            {replyErr && <p className="mb-2 text-sm text-red-600">{replyErr}</p>}
            <div className="flex gap-2">
              <input
                ref={replyInputRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply() } }}
                placeholder={canWrite ? 'Reply as admin…' : 'Write your reply…'}
                className="flex-1 rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                disabled={replySending}
              />
              <button
                type="button"
                onClick={() => void sendReply()}
                disabled={replySending || !replyText.trim()}
                className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white hover:bg-[#17472d] transition disabled:opacity-50"
              >
                {replySending ? '…' : 'Send'}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">Press Enter to send</p>
          </div>
        )}
      </div>
    )
  }

  // ── Create / Edit Form ─────────────────────────────────────────────────

  if ((view === 'create' && canWrite) || (view === 'edit' && isAdmin)) {
    const typeMeta = TYPE_META[form.notice_type]
    const isEdit = view === 'edit'
    return (
      <div className="mx-auto max-w-[760px] space-y-4 pb-10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { setForm(emptyForm()); setEditingId(null); setView('list') }}
            className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-sm font-medium text-[#1f5e3b] hover:bg-[#1f5e3b]/5 transition"
          >
            ← Cancel
          </button>
          <h1 className="text-xl font-bold text-[#1f5e3b]">{isEdit ? 'Edit Notice' : 'New Notice'}</h1>
        </div>

        {err && <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{err}</p>}

        <form onSubmit={submitForm} className="ph-card rounded-2xl p-6 space-y-5">
          {/* Type picker */}
          <div>
            <label className="block mb-2 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Notice Type</label>
            <div className="flex flex-wrap gap-2">
              {(['announcement', 'discussion', 'alert', 'query'] as NoticeType[]).map((t) => {
                const m = TYPE_META[t]
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, notice_type: t }))}
                    className={`flex items-center gap-1.5 rounded-xl border-2 px-3 py-1.5 text-sm font-medium transition ${form.notice_type === t ? `${m.bg} ${m.text} ${m.border}` : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
                  >
                    {m.emoji} {m.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Title *</label>
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              required
              placeholder={`${typeMeta.emoji} Notice title`}
              className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
            />
          </div>

          {/* Body */}
          <div>
            <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Message *</label>
            <textarea
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              required
              rows={4}
              placeholder="Write your message here…"
              className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30 resize-none"
            />
          </div>

          {/* Targeting */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Target Branch</label>
              <select
                value={form.target_branch_id}
                onChange={(e) => setForm((f) => ({ ...f, target_branch_id: e.target.value }))}
                className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
              >
                <option value="">🌐 All Branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Target Role</label>
              <select
                value={form.target_role}
                onChange={(e) => setForm((f) => ({ ...f, target_role: e.target.value }))}
                className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
              >
                <option value="">All Roles</option>
                <option value="USER">Staff</option>
                <option value="LOCATION_MANAGER">Branch Manager</option>
                <option value="ATTENDANCE_MANAGER">HR / Attendance</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
          </div>

          {/* Reply controls */}
          <div className="rounded-xl border border-[#1f5e3b]/15 bg-[#f4faf7] p-4 space-y-3">
            <p className="text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Reply Settings</p>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.allow_replies}
                onChange={(e) => setForm((f) => ({ ...f, allow_replies: e.target.checked, admin_replies_only: e.target.checked ? f.admin_replies_only : false }))}
                className="h-4 w-4 accent-[#1f5e3b]"
              />
              <span className="text-sm text-[#14261a]">Allow replies from staff</span>
            </label>
            {form.allow_replies && (
              <label className="flex items-center gap-3 cursor-pointer ml-7">
                <input
                  type="checkbox"
                  checked={form.admin_replies_only}
                  onChange={(e) => setForm((f) => ({ ...f, admin_replies_only: e.target.checked }))}
                  className="h-4 w-4 accent-[#1f5e3b]"
                />
                <span className="text-sm text-[#14261a]">Admin replies only (staff can read but not reply)</span>
              </label>
            )}
          </div>

          {/* Visibility window */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Visible From (optional)</label>
              <input
                type="datetime-local"
                value={form.visible_from}
                onChange={(e) => setForm((f) => ({ ...f, visible_from: e.target.value }))}
                className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Visible Until (optional)</label>
              <input
                type="datetime-local"
                value={form.visible_until}
                onChange={(e) => setForm((f) => ({ ...f, visible_until: e.target.value }))}
                className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-xl bg-[#1f5e3b] px-6 py-2 text-sm font-semibold text-white hover:bg-[#17472d] transition disabled:opacity-50"
            >
              {submitting
                ? (isEdit ? 'Saving…' : 'Publishing…')
                : isEdit
                  ? '💾 Save Changes'
                  : `${typeMeta.emoji} Publish Notice`}
            </button>
            <button
              type="button"
              onClick={() => { setForm(emptyForm()); setEditingId(null); setView('list') }}
              className="rounded-xl border border-[#1f5e3b]/20 px-5 py-2 text-sm font-medium text-[#1f5e3b] hover:bg-[#1f5e3b]/5 transition"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    )
  }

  // ── List View ──────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-[760px] space-y-5 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Notice Board</h1>
        {canWrite && (
          <button
            type="button"
            onClick={() => { setErr(null); setView('create') }}
            className="flex items-center gap-1.5 rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white hover:bg-[#17472d] transition shadow"
          >
            + New Notice
          </button>
        )}
      </div>

      {err && <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{err}</p>}

      {/* Admin tabs: Active vs Archive (Admin / Super Admin only) */}
      {isAdmin && (
        <div className="inline-flex rounded-xl border border-[#1f5e3b]/15 bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setScope('active')}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${scope === 'active' ? 'bg-[#1f5e3b] text-white' : 'text-[#1f5e3b]/70 hover:bg-[#1f5e3b]/5'}`}
          >
            📌 Active
          </button>
          <button
            type="button"
            onClick={() => setScope('archive')}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${scope === 'archive' ? 'bg-[#1f5e3b] text-white' : 'text-[#1f5e3b]/70 hover:bg-[#1f5e3b]/5'}`}
            title="Expired or deleted notices"
          >
            🗂 Archive
          </button>
        </div>
      )}

      {/* Admin filter bar */}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <select
            value={filterBranch}
            onChange={(e) => setFilterBranch(e.target.value)}
            className="rounded-xl border border-[#1f5e3b]/20 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20"
          >
            <option value="">All Branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded-xl border border-[#1f5e3b]/20 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20"
          >
            <option value="">All Types</option>
            <option value="announcement">📢 Announcement</option>
            <option value="discussion">💬 Discussion</option>
            <option value="alert">🚨 Alert</option>
            <option value="query">❓ Query</option>
          </select>
          {(filterBranch || filterType) && (
            <button
              type="button"
              onClick={() => { setFilterBranch(''); setFilterType('') }}
              className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50 transition"
            >
              ✕ Clear
            </button>
          )}
        </div>
      )}

      {/* Notice list */}
      <div className="space-y-3">
        {notices.length === 0 && (
          <div className="text-center py-16">
            <p className="text-4xl mb-2">{scope === 'archive' ? '🗂' : '📋'}</p>
            <p className="text-sm text-[#1f5e3b]/50">
              {scope === 'archive' ? 'No archived notices.' : 'No notices yet.'}
            </p>
          </div>
        )}
        {notices.map((n) => {
          const typeMeta = TYPE_META[n.notice_type] || TYPE_META.announcement
          const isUnread = !n.read_by_me && scope === 'active'
          const expired = isExpired(n)
          const deleted = n.active === 0
          return (
            <div
              key={n.id}
              className={`relative ph-card rounded-2xl border-l-4 ${typeMeta.border} ${isUnread ? 'ring-2 ring-emerald-300/60 bg-emerald-50/30 shadow-sm' : 'opacity-95'} ${deleted ? 'opacity-70' : ''}`}
            >
              <button
                type="button"
                onClick={() => void openThread(n)}
                className="block w-full text-left p-5 hover:bg-[#1f5e3b]/[0.02] rounded-2xl transition"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0 pr-16">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                      <TypeBadge type={n.notice_type} />
                      <TargetBadge branchName={n.target_branch_name} role={n.target_role} />
                      {isUnread && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white animate-pulse">
                          <span className="h-1.5 w-1.5 rounded-full bg-white"></span> NEW
                        </span>
                      )}
                      {deleted && (
                        <span className="inline-flex items-center rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-700">
                          🗑 Deleted
                        </span>
                      )}
                      {!deleted && expired && (
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                          ⌛ Expired
                        </span>
                      )}
                    </div>
                    <h2 className={`text-base font-semibold text-[#1f5e3b] ${isUnread ? 'font-bold' : ''}`}>{n.title}</h2>
                    <p className="mt-0.5 text-xs text-[#1f5e3b]/50">{n.author_name} · {timeAgo(n.created_at)}</p>
                    <p className="mt-2 text-sm text-[#14261a]/70 line-clamp-2">{n.body}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#1f5e3b]/55">
                      {n.reply_count > 0 && (
                        <span className="flex items-center gap-1">
                          💬 {n.reply_count} {n.reply_count === 1 ? 'reply' : 'replies'}
                        </span>
                      )}
                      {!n.allow_replies && <span>🚫 No replies</span>}
                      {n.allow_replies && n.admin_replies_only && <span>🔒 Admin only</span>}
                      {n.visible_until && (
                        <span title={`Visible until ${fullTime(n.visible_until)}`}>
                          📅 {expired ? 'Ended' : 'Until'} {shortDate(n.visible_until)}
                        </span>
                      )}
                    </div>
                  </div>
                  <svg className="h-4 w-4 text-[#1f5e3b]/30 flex-shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </button>

              {/* Admin Edit / Delete / Restore icons (sit above the card click) */}
              {isAdmin && (
                <div className="absolute top-3 right-3 flex items-center gap-1">
                  {!deleted && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); startEdit(n) }}
                      className="rounded-lg p-1.5 text-[#1f5e3b]/70 hover:bg-[#1f5e3b]/10 hover:text-[#1f5e3b] transition"
                      title="Edit notice"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  )}
                  {deleted ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void restoreNotice(n.id) }}
                      className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 transition"
                      title="Restore notice"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void deleteNotice(n.id) }}
                      className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition"
                      title="Delete notice"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
