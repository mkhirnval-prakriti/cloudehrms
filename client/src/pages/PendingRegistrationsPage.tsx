import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

type Registration = {
  id: number
  full_name: string
  mobile: string
  email: string
  address?: string
  created_at: string
  account_status: 'PENDING' | 'REJECTED'
  rejection_reason?: string
  registered_via?: string
}

type Branch = { id: number; name: string }

export function PendingRegistrationsPage() {
  const { user } = useAuth()
  const canApprove = canPerm(user, 'users:create') || canPerm(user, 'users:update')
  const canView = canPerm(user, 'users:read')

  const [rows, setRows] = useState<Registration[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [processing, setProcessing] = useState<Record<number, boolean>>({})

  const [selectedBranch, setSelectedBranch] = useState<Record<number, string>>({})
  const [selectedRole, setSelectedRole] = useState<Record<number, string>>({})
  const [rejectReason, setRejectReason] = useState<Record<number, string>>({})
  const [showRejectForm, setShowRejectForm] = useState<Record<number, boolean>>({})
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  async function load() {
    if (!canView) return
    setLoading(true)
    setErr('')
    try {
      const d = await api<{ registrations: Registration[]; count: number }>('/admin/pending-registrations')
      setRows(d.registrations || [])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
    try {
      const b = await api<{ branches: Branch[] }>('/branches')
      setBranches(b.branches || [])
    } catch {
      // branches list is optional — approval still works with default branch
    }
  }

  // Re-run when canView changes (handles auth loading race condition)
  useEffect(() => {
    void load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView])

  async function approve(reg: Registration) {
    setProcessing((p) => ({ ...p, [reg.id]: true }))
    setMsg(null)
    try {
      const data = await api<{ user: { login_id: string; full_name: string } }>(
        `/admin/pending-registrations/${reg.id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            branch_id: selectedBranch[reg.id] ? Number(selectedBranch[reg.id]) : undefined,
            role: selectedRole[reg.id] || 'USER',
          }),
        }
      )
      setMsg({
        type: 'ok',
        text: `${data.user.full_name} approved! Employee ID: ${data.user.login_id}`,
      })
      await load()
    } catch (e) {
      setMsg({ type: 'err', text: (e as Error).message })
    } finally {
      setProcessing((p) => ({ ...p, [reg.id]: false }))
    }
  }

  async function reject(id: number) {
    setProcessing((p) => ({ ...p, [id]: true }))
    setMsg(null)
    try {
      await api(`/admin/pending-registrations/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason[id] || undefined }),
      })
      setMsg({ type: 'ok', text: 'Registration rejected.' })
      setShowRejectForm((p) => ({ ...p, [id]: false }))
      await load()
    } catch (e) {
      setMsg({ type: 'err', text: (e as Error).message })
    } finally {
      setProcessing((p) => ({ ...p, [id]: false }))
    }
  }

  if (!canView) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center text-sm text-[#1f5e3b]">
        You do not have permission to view pending registrations.
      </div>
    )
  }

  const pending = rows.filter((r) => r.account_status === 'PENDING')
  const rejected = rows.filter((r) => r.account_status === 'REJECTED')

  return (
    <div className="mx-auto max-w-[860px] space-y-6 pb-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1f5e3b]">Pending Registrations</h1>
          <p className="mt-0.5 text-sm text-[#1f5e3b]/60">
            Review and approve self-registered accounts
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pending.length > 0 && (
            <span className="rounded-full bg-orange-100 px-3 py-1 text-sm font-bold text-orange-700">
              {pending.length} pending
            </span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-xl border border-[#1f5e3b]/20 bg-white px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] shadow-sm transition hover:bg-[#1f5e3b]/5 disabled:opacity-50"
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {msg && (
        <div
          className={`rounded-xl px-4 py-3 text-sm font-medium ${
            msg.type === 'ok' ? 'bg-[#e8f5e9] text-[#2e7d32]' : 'bg-red-50 text-red-700'
          }`}
        >
          {msg.text}
        </div>
      )}
      {err && <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>}

      {loading ? (
        <div className="ph-card rounded-2xl p-8 text-center text-sm text-[#1f5e3b]/60">Loading…</div>
      ) : pending.length === 0 ? (
        <div className="ph-card rounded-2xl p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#e8f5e9]">
            <svg className="h-6 w-6 text-[#2e7d32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm font-medium text-[#1f5e3b]">No pending registrations</p>
          <p className="mt-1 text-xs text-[#1f5e3b]/55">All registration requests have been processed.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((reg) => (
            <div key={reg.id} className="ph-card rounded-2xl p-6 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-bold text-[#14261a]">{reg.full_name}</h2>
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                      Pending
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-[#1f5e3b]/70">
                    <span>
                      <span className="font-medium">Mobile:</span> {reg.mobile}
                    </span>
                    {reg.email && !reg.email.endsWith('@prakritiherbs.internal') && (
                      <span>
                        <span className="font-medium">Email:</span> {reg.email}
                      </span>
                    )}
                    {reg.address && (
                      <span>
                        <span className="font-medium">Address:</span> {reg.address}
                      </span>
                    )}
                    <span>
                      <span className="font-medium">Applied:</span>{' '}
                      {new Date(reg.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              {canApprove && (
                <div className="rounded-xl bg-[#f5faf6] p-4 space-y-3">
                  <p className="text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">
                    Approval settings
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[#14261a]">Branch</label>
                      <select
                        value={selectedBranch[reg.id] || ''}
                        onChange={(e) =>
                          setSelectedBranch((p) => ({ ...p, [reg.id]: e.target.value }))
                        }
                        className="w-full rounded-lg border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20"
                      >
                        <option value="">Auto-assign (Head Office)</option>
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[#14261a]">Role</label>
                      <select
                        value={selectedRole[reg.id] || 'USER'}
                        onChange={(e) =>
                          setSelectedRole((p) => ({ ...p, [reg.id]: e.target.value }))
                        }
                        className="w-full rounded-lg border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20"
                      >
                        <option value="USER">Staff (USER)</option>
                        <option value="ATTENDANCE_MANAGER">Attendance Manager</option>
                        <option value="LOCATION_MANAGER">Branch Manager</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={processing[reg.id]}
                      onClick={() => void approve(reg)}
                      className="rounded-lg bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#17472d] disabled:opacity-60"
                    >
                      {processing[reg.id] ? 'Processing…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      disabled={processing[reg.id]}
                      onClick={() =>
                        setShowRejectForm((p) => ({ ...p, [reg.id]: !p[reg.id] }))
                      }
                      className="rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60"
                    >
                      Reject
                    </button>
                  </div>
                  {showRejectForm[reg.id] && (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={rejectReason[reg.id] || ''}
                        onChange={(e) =>
                          setRejectReason((p) => ({ ...p, [reg.id]: e.target.value }))
                        }
                        placeholder="Rejection reason (optional)"
                        className="flex-1 rounded-lg border border-red-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-200"
                      />
                      <button
                        type="button"
                        disabled={processing[reg.id]}
                        onClick={() => void reject(reg.id)}
                        className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-60"
                      >
                        Confirm
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center gap-2 text-sm font-medium text-[#1f5e3b]/60 hover:text-[#1f5e3b]">
              <svg className="h-4 w-4 transition group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Show {rejected.length} rejected registration{rejected.length !== 1 ? 's' : ''}
            </div>
          </summary>
          <div className="mt-3 space-y-3">
            {rejected.map((reg) => (
              <div key={reg.id} className="rounded-xl border border-red-100 bg-red-50/50 p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-[#14261a]">{reg.full_name}</span>
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">Rejected</span>
                </div>
                <p className="mt-1 text-xs text-[#1f5e3b]/60">
                  Mobile: {reg.mobile}
                  {reg.rejection_reason && ` · Reason: ${reg.rejection_reason}`}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
