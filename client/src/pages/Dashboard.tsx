import { useState, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { useModuleVisibility } from '../lib/useModuleVisibility'
import { fmtIstTime as fmtTime, fmtIstDateShort as fmtDateShort, fmtIstDateTime as fmtDateTime } from '../lib/date'

type AlertRow = {
  id: number
  type: string
  severity: string
  message: string
  created_at: string
  user_name?: string
}

type MyLeaveRow = {
  id: number
  start_date: string
  end_date: string
  reason: string
  status: string
  leave_type?: string
  created_at: string
}

type Overview = {
  scope?: 'self' | 'branch' | 'all'
  today: {
    date: string
    totalStaff: number
    present: number
    late: number
    absent: number
    onLeave?: number
    halfDay?: number
    punchInCount?: number
    punchOutCount?: number
    totalHoursWorkedToday?: number
    punchInAt?: string | null
    punchOutAt?: string | null
  }
  myMonthly?: {
    present: number
    late: number
    absent: number
    leave: number
    monthStart: string
  }
  myLeaves?: MyLeaveRow[]
  stats: {
    workforce: number
    monthlyBudgetINR: number
    workHours: number
    offices: number
    totalHoursWorkedMonth?: number
  }
  alerts?: {
    highLeaveUsers: { name: string; userId: number; approvedLeaves: number }[]
    frequentLateUsers: { name: string; userId: number; lateDays: number }[]
  }
  hrAlerts?: AlertRow[]
  highlights: {
    topPerformers: { name: string; branch: string; score: number }[]
    lateDefaulters: { name: string; status: string; workDate: string }[]
    violations: { type: string; count: number }[]
    weeklyLateFlags: { name: string; userId: number; lateDays: number }[]
  }
  insights: {
    leaveRequestsPending: number
    biometricRequests: number
    documentCompliancePct: number
  }
  staffByBranch: { name: string; staffCount: number }[]
  liveStatus?: { currentlyIn: number; missingOut: number }
  payrollPreview?: {
    grossCtcMonthlyINR: number
    attendanceDeductionsINR: number
    netFromPayrollINR?: number
    period?: string
    note: string
  }
}

function normalizeOverview(v: unknown): Overview {
  const base: Overview = {
    scope: 'self',
    today: {
      date: '',
      totalStaff: 1,
      present: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
    },
    stats: { workforce: 1, monthlyBudgetINR: 0, workHours: 0, offices: 0 },
    highlights: { topPerformers: [], lateDefaulters: [], violations: [], weeklyLateFlags: [] },
    insights: { leaveRequestsPending: 0, biometricRequests: 0, documentCompliancePct: 100 },
    staffByBranch: [],
  }
  if (!v || typeof v !== 'object') return base
  return { ...base, ...(v as object) } as Overview
}

type DrillPerson = {
  id: number
  full_name: string
  email?: string
  login_id?: string
  branch_name?: string
  status?: string
  punch_in_at?: string | null
  punch_out_at?: string | null
}

type LeaveRow = {
  id: number
  user_id: number
  full_name?: string
  start_date: string
  end_date: string
  reason: string
  status: string
  leave_type?: string
  created_at: string
}

type AuditRow = {
  id: number
  actor_id: number
  actor_name?: string
  action: string
  entity_type: string
  entity_id?: number
  created_at: string
}

type LivePerson = {
  id: number
  user_id: number
  full_name: string
  login_id?: string
  punch_in_at?: string
}

const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)

const POLL_MS = 25000

function actionLabel(action: string) {
  const map: Record<string, string> = {
    employee_create: '➕ Created employee',
    employee_update: '✏️ Updated employee',
    employee_delete: '🗑️ Deleted employee',
    login: '🔑 Logged in',
    attendance_punch: '📍 Punch',
    leave_apply: '📝 Leave applied',
    leave_approve: '✅ Leave approved',
    leave_reject: '❌ Leave rejected',
    staff_restore: '♻️ Restored employee',
    role_change: '🔄 Role changed',
    password_reset: '🔒 Password reset',
  }
  return map[action] || action
}

function leaveStatusBadge(status: string) {
  const s = (status || '').toUpperCase()
  if (s === 'APPROVED') return <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-800">Approved</span>
  if (s === 'REJECTED') return <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800">Rejected</span>
  if (s === 'MANAGER_APPROVED') return <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-800">Mgr Approved</span>
  return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Pending</span>
}

type BioStatusMini = { hasFace: boolean; webauthnCount: number }

function StaffDashboard({ data, userName, isFetching, onRefetch }: {
  data: Overview
  userName: string
  isFetching: boolean
  onRefetch: () => void
}) {
  const t = data.today
  const m = data.myMonthly
  const leaves = data.myLeaves || []

  const { data: bioStatus } = useQuery({
    queryKey: ['bio', 'status', 'staff-dash'],
    queryFn: () => api<BioStatusMini>('/biometric/status'),
    staleTime: 60000,
  })
  const hasFace = bioStatus?.hasFace ?? false
  const hasFp = (bioStatus?.webauthnCount ?? 0) > 0
  const neitherRegistered = bioStatus != null && !hasFace && !hasFp

  const todayEmoji = t.present > 0 ? '✅' : t.late > 0 ? '⏰' : t.onLeave ? '📅' : '❌'
  const todayText = t.present > 0 ? 'आज Present हैं' : t.late > 0 ? 'आज Late Mark हैं' : t.onLeave ? 'आज Leave पर हैं' : 'आज Absent हैं'

  const monthLabel = m?.monthStart
    ? new Date(m.monthStart + 'T00:00:00').toLocaleString('en-IN', { month: 'long', year: 'numeric' })
    : ''

  const quickActions = [
    { icon: '📍', label: 'Attendance', to: '/attendance' },
    { icon: '📋', label: 'My Leave', to: '/leave' },
    { icon: '📢', label: 'Notice Board', to: '/notices' },
    { icon: '💰', label: 'My Payslip', to: '/payroll' },
  ]

  const notClockedIn = t.present === 0 && t.late === 0 && !t.onLeave
  const clockedInNoOut = (t.present > 0 || t.late > 0) && !t.punchOutAt
  const allDone = (t.present > 0 || t.late > 0) && !!t.punchOutAt

  // 30-min Clock Out lockout countdown
  const LOCK_MS = 30 * 60 * 1000
  const canClockOut = !t.punchInAt
    || (Date.now() - new Date(t.punchInAt).getTime()) >= LOCK_MS
  const [dashSecsLeft, setDashSecsLeft] = useState<number>(0)
  useEffect(() => {
    if (!t.punchInAt || canClockOut) { setDashSecsLeft(0); return }
    const unlockAt = new Date(t.punchInAt).getTime() + LOCK_MS
    const tick = () => setDashSecsLeft(Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000)))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [t.punchInAt, canClockOut]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-[900px] space-y-7 pb-8">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1f5e3b] sm:text-3xl">
            नमस्ते, {userName} 👋
          </h1>
          <p className="text-sm text-[#1f5e3b]/60">{t.date}</p>
        </div>
        <button
          type="button"
          onClick={onRefetch}
          disabled={isFetching}
          className="rounded-xl border border-[#1f5e3b]/20 bg-white px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] shadow-sm transition hover:bg-[#1f5e3b]/5 disabled:opacity-50"
        >
          {isFetching ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* Today's status card — with prominent CTA */}
      <div className={`ph-card rounded-2xl overflow-hidden border-l-4 ${t.present > 0 || t.late > 0 ? 'border-green-500' : t.onLeave ? 'border-blue-400' : 'border-red-400'}`}>
        <div className="p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1f5e3b]/8 text-3xl">
              {todayEmoji}
            </div>
            <div className="flex-1">
              <p className="font-bold text-[#1f5e3b] text-lg">{todayText}</p>
              <p className="text-xs text-[#1f5e3b]/55 mt-0.5">{t.date}</p>
            </div>
          </div>
          {(t.punchInAt || t.punchOutAt) && (
            <div className="mt-3 flex gap-6 text-sm text-[#14261a]/80">
              {t.punchInAt && <span>🟢 Check In: <strong>{fmtTime(t.punchInAt)}</strong></span>}
              {t.punchOutAt && <span>🔴 Check Out: <strong>{fmtTime(t.punchOutAt)}</strong></span>}
            </div>
          )}
        </div>
        {/* CTA Button based on status */}
        {notClockedIn && (
          <NavLink to="/attendance"
            className="flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-500 to-emerald-600 px-5 py-3.5 text-sm font-bold text-white hover:from-emerald-600 hover:to-emerald-700 transition-all">
            🟢 Clock In — अटेंडेंस दर्ज करें →
          </NavLink>
        )}
        {clockedInNoOut && canClockOut && (
          <NavLink to="/attendance"
            className="flex items-center justify-center gap-2 bg-gradient-to-r from-red-500 to-red-600 px-5 py-3.5 text-sm font-bold text-white hover:from-red-600 hover:to-red-700 transition-all">
            🔴 Clock Out — जाते समय Clock Out करें →
          </NavLink>
        )}
        {clockedInNoOut && !canClockOut && (
          <div className="flex flex-col items-center justify-center gap-0.5 bg-blue-50 px-5 py-3 text-center">
            <span className="text-xs font-semibold text-blue-700">⏱️ Clock Out के लिए प्रतीक्षा करें</span>
            {dashSecsLeft > 0 && (
              <span className="text-sm font-extrabold text-blue-800 tabular-nums">
                {String(Math.floor(dashSecsLeft / 60)).padStart(2, '0')}:{String(dashSecsLeft % 60).padStart(2, '0')} बाकी
              </span>
            )}
          </div>
        )}
        {allDone && (
          <div className="flex items-center justify-center gap-2 bg-emerald-50 px-5 py-3 text-sm font-semibold text-emerald-700">
            ✅ आज की Attendance पूरी हो गई
          </div>
        )}
      </div>

      {/* Monthly Working Hours */}
      <WorkHoursCard />

      {/* Monthly Summary */}
      {m && (
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">
            My Attendance — {monthLabel}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="ph-card rounded-2xl p-5 text-center border-t-4 border-green-400">
              <div className="text-3xl font-bold text-green-700">{m.present}</div>
              <div className="mt-1 text-xs font-semibold text-[#1f5e3b]/70">Present Days</div>
            </div>
            <div className="ph-card rounded-2xl p-5 text-center border-t-4 border-amber-400">
              <div className="text-3xl font-bold text-amber-700">{m.late}</div>
              <div className="mt-1 text-xs font-semibold text-[#1f5e3b]/70">Late Days</div>
            </div>
            <div className="ph-card rounded-2xl p-5 text-center border-t-4 border-red-400">
              <div className="text-3xl font-bold text-red-700">{m.absent}</div>
              <div className="mt-1 text-xs font-semibold text-[#1f5e3b]/70">Absent Days</div>
            </div>
            <div className="ph-card rounded-2xl p-5 text-center border-t-4 border-blue-400">
              <div className="text-3xl font-bold text-blue-700">{m.leave}</div>
              <div className="mt-1 text-xs font-semibold text-[#1f5e3b]/70">Leave Days</div>
            </div>
          </div>
        </section>
      )}

      {/* Profile & Biometrics */}
      <section>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Profile &amp; Biometrics</h2>

        {/* First-time registration alert — shown only when neither is enrolled */}
        {neitherRegistered && (
          <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-bold text-amber-900">⚠️ Biometric Registration आवश्यक है</p>
            <p className="mt-1 text-xs text-amber-800">
              अटेंडेंस के लिए Face या Fingerprint में से कोई एक register करना अनिवार्य है।
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <NavLink
                to="/identity"
                className="rounded-xl bg-[#1f5e3b] px-3 py-2 text-center text-xs font-bold text-white transition active:scale-95"
              >
                📷 Face Register
              </NavLink>
              <NavLink
                to="/identity"
                className="rounded-xl border border-[#1f5e3b] px-3 py-2 text-center text-xs font-bold text-[#1f5e3b] transition active:scale-95"
              >
                👆 Fingerprint Register
              </NavLink>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Profile Update */}
          <NavLink
            to="/identity"
            className="ph-card flex items-center gap-3 rounded-2xl p-4 transition hover:bg-[#1f5e3b]/5 active:scale-95"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#1f5e3b]/10 text-xl">👤</div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#1f5e3b]">Profile Update</p>
              <p className="text-xs text-[#1f5e3b]/55">अपनी जानकारी अपडेट करें</p>
            </div>
          </NavLink>

          {/* Face Update */}
          <NavLink
            to="/identity"
            className="ph-card flex items-center gap-3 rounded-2xl p-4 transition hover:bg-[#1f5e3b]/5 active:scale-95"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#1f5e3b]/10 text-xl">📷</div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#1f5e3b]">Face Update</p>
              <p className="text-xs text-[#1f5e3b]/55">
                {hasFace ? '✅ Enrolled' : '❌ Not registered'}
              </p>
            </div>
          </NavLink>

          {/* Fingerprint Update */}
          <NavLink
            to="/identity"
            className="ph-card flex items-center gap-3 rounded-2xl p-4 transition hover:bg-[#1f5e3b]/5 active:scale-95"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#1f5e3b]/10 text-xl">👆</div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#1f5e3b]">Fingerprint Update</p>
              <p className="text-xs text-[#1f5e3b]/55">
                {hasFp ? '✅ Enrolled' : '❌ Not registered'}
              </p>
            </div>
          </NavLink>
        </div>
      </section>

      {/* Quick Actions */}
      <section>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Quick Actions</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {quickActions.map((a) => (
            <NavLink
              key={a.to}
              to={a.to}
              className="ph-card flex flex-col items-center gap-2 rounded-2xl p-5 text-center transition hover:bg-[#1f5e3b]/5"
            >
              <span className="text-3xl">{a.icon}</span>
              <span className="text-xs font-semibold text-[#1f5e3b]">{a.label}</span>
            </NavLink>
          ))}
        </div>
      </section>

      {/* My Leave Requests */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">My Leave Requests</h2>
          <NavLink to="/leave" className="text-xs font-semibold text-[#1f5e3b] hover:underline underline-offset-2">
            Apply / View All →
          </NavLink>
        </div>
        <div className="ph-card rounded-2xl p-5">
          {leaves.length === 0 ? (
            <p className="text-sm text-[#1f5e3b]/50">No leave requests yet. Click "Apply / View All" to apply.</p>
          ) : (
            <ul className="divide-y divide-[#1f5e3b]/8">
              {leaves.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[#14261a]">
                      {fmtDateShort(l.start_date)} → {fmtDateShort(l.end_date)}
                      {l.leave_type && <span className="ml-2 text-xs text-[#1f5e3b]/50">({l.leave_type})</span>}
                    </p>
                    <p className="text-xs text-[#1f5e3b]/60 line-clamp-1">{l.reason}</p>
                  </div>
                  {leaveStatusBadge(l.status)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Notice Board shortcut */}
      <div className="ph-card rounded-2xl p-5 flex items-center justify-between border border-[#1f5e3b]/15">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📢</span>
          <div>
            <p className="font-semibold text-[#1f5e3b] text-sm">Notice Board</p>
            <p className="text-xs text-[#1f5e3b]/55">Company notices and announcements</p>
          </div>
        </div>
        <NavLink to="/notices" className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-xs font-semibold text-white hover:bg-[#174d30] transition">
          View Notices
        </NavLink>
      </div>
    </div>
  )
}

export function Dashboard() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const isSuperAdmin = user?.role === 'SUPER_ADMIN'
  const isAdminUi = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN'
  const canLeaveAll = canPerm(user, 'leave:read_all')
  const { canSee } = useModuleVisibility()

  const {
    data,
    error: queryError,
    isPending,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: async () => {
      const d = await api<Overview>('/dashboard/overview')
      return normalizeOverview(d)
    },
    refetchInterval: POLL_MS,
    retry: 1,
  })

  const { data: accountAudit } = useQuery({
    queryKey: ['admin', 'account-audit'],
    queryFn: () => api<{ stats: { total: number; active_rows: number; login_ready: number; pending: number; rejected: number; trashed: number; super_admins: number; admins: number; staff: number }, recent: { id: number; full_name: string; login_id?: string | null; role: string; active: number; account_status?: string | null; deleted_at?: string | null; created_at: string }[] }>('/admin/account-audit'),
    enabled: isSuperAdmin,
    staleTime: 30000,
  })

  const { data: leavesData, refetch: refetchLeaves } = useQuery({
    queryKey: ['dashboard', 'leaves-pending'],
    queryFn: () => api<{ leaves: LeaveRow[] }>('/leave'),
    enabled: canLeaveAll,
    refetchInterval: POLL_MS,
  })

  const { data: auditData } = useQuery({
    queryKey: ['dashboard', 'audit-recent'],
    queryFn: () => api<{ logs: AuditRow[] }>('/audit/logs?limit=15'),
    enabled: isSuperAdmin,
    refetchInterval: 60000,
  })

  const { data: liveData } = useQuery({
    queryKey: ['dashboard', 'live-status'],
    queryFn: () => api<{ currently_in: LivePerson[]; date: string }>('/attendance/live-status'),
    enabled: canLeaveAll || isSuperAdmin,
    refetchInterval: POLL_MS,
  })

  const err = queryError ? (queryError as Error).message : null
  const [drill, setDrill] = useState<{ title: string; status: string } | null>(null)
  const [drillRows, setDrillRows] = useState<DrillPerson[]>([])
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState<string | null>(null)
  const [liveExpanded, setLiveExpanded] = useState(false)
  const [leaveAction, setLeaveAction] = useState<Record<number, string>>({})

  async function openDrill(title: string, status: string) {
    setDrill({ title, status })
    setDrillLoading(true)
    setDrillRows([])
    setDrillError(null)
    try {
      const d = await api<{ people: DrillPerson[] }>('/dashboard/today-list?status=' + encodeURIComponent(status))
      setDrillRows(d.people || [])
    } catch (e) {
      setDrillError((e as Error).message || 'Failed to load list. Please try again.')
      setDrillRows([])
    } finally {
      setDrillLoading(false)
    }
  }

  async function approveLeave(id: number) {
    setLeaveAction((prev) => ({ ...prev, [id]: 'loading' }))
    try {
      await api(`/leave/${id}/admin-approve`, { method: 'POST', body: JSON.stringify({ comment: null }) })
      setLeaveAction((prev) => ({ ...prev, [id]: 'approved' }))
      await refetchLeaves()
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] })
    } catch (e) {
      setLeaveAction((prev) => ({ ...prev, [id]: 'error' }))
      alert('Failed: ' + (e as Error).message)
    }
  }

  async function rejectLeave(id: number) {
    setLeaveAction((prev) => ({ ...prev, [id]: 'loading' }))
    try {
      await api(`/leave/${id}/admin-reject`, { method: 'POST', body: JSON.stringify({ comment: 'Rejected from Dashboard' }) })
      setLeaveAction((prev) => ({ ...prev, [id]: 'rejected' }))
      await refetchLeaves()
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] })
    } catch (e) {
      setLeaveAction((prev) => ({ ...prev, [id]: 'error' }))
      alert('Failed: ' + (e as Error).message)
    }
  }

  if (err) {
    return (
      <div className="ph-card rounded-2xl p-6 text-red-700">
        <p className="font-semibold">Dashboard failed to load</p>
        <p className="mt-1 text-sm">{err}</p>
        <button type="button" onClick={() => refetch()} className="mt-4 rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white">Retry</button>
      </div>
    )
  }
  if (isPending || !data) {
    return (
      <div className="flex h-[50vh] flex-col items-center justify-center gap-3">
        <div className="relative h-14 w-14">
          <div className="ph-loader-orbit absolute inset-0 rounded-full border-2 border-dashed border-[#1f5e3b]/20 border-t-[#66bb6a]" />
          <div className="absolute inset-0 m-auto h-8 w-8 rounded-full bg-[#1f5e3b]/5" />
        </div>
        <p className="text-xs text-[#1f5e3b]/60">Loading dashboard…</p>
      </div>
    )
  }

  const isSelf = data.scope === 'self' || (!!user && user.role === 'USER')

  // ── STAFF / USER ROLE — completely isolated personal dashboard ──────────────
  if (isSelf) {
    return (
      <StaffDashboard
        data={data}
        userName={user?.full_name?.split(' ')[0] ?? 'Staff'}
        isFetching={isFetching}
        onRefetch={() => { void refetch() }}
      />
    )
  }

  // ── ADMIN / MANAGER DASHBOARD ────────────────────────────────────────────────
  const t = data.today
  const ha = data.hrAlerts || []
  const pol = data.alerts
  const pendingLeaves = (leavesData?.leaves || []).filter((l) => l.status === 'pending' || l.status === 'manager_approved')
  const recentAudit = auditData?.logs || []
  const liveNow = liveData?.currently_in || []
  const liveCount = liveNow.length
  const missingOut = data.liveStatus?.missingOut ?? 0

  return (
    <div className="mx-auto max-w-[1600px] space-y-8 pb-8">
      {/* Header — high-tech command bar for ADMIN / SUPER_ADMIN, classic for other roles */}
      {isAdminUi ? (
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#071309] via-[#122518] to-[#071309] p-6 shadow-2xl">
          {/* Decorative ambient orbs */}
          <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[#66bb6a]/6 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-12 -right-12 h-56 w-56 rounded-full bg-[#2e7d32]/8 blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            {/* Title block */}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-400/55">Prakriti Herbs · HRMS</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-400">
                  <span className="relative flex h-1.5 w-1.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                  Live
                </span>
              </div>
              <h1 className="mt-1.5 font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
                {isSuperAdmin ? 'Super Admin' : 'Admin'} Dashboard
              </h1>
              <p className="mt-1 text-sm text-white/35">{t.date} · auto-refresh every {POLL_MS / 1000}s</p>
            </div>
            {/* Right side — rate pill + refresh */}
            <div className="flex shrink-0 items-center gap-3">
              {canSee('dashboard.today_attendance') && t.totalStaff > 0 && (
                <div className="rounded-xl border border-white/10 bg-white/6 px-5 py-3 text-center backdrop-blur-sm">
                  <div className="text-3xl font-bold tabular-nums leading-none text-white">
                    {Math.round(((t.present + t.late) / t.totalStaff) * 100)}%
                  </div>
                  <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-emerald-400/70">Attendance</div>
                </div>
              )}
              <button
                type="button"
                onClick={() => { void refetch(); void refetchLeaves() }}
                disabled={isFetching}
                className="rounded-xl border border-white/15 bg-white/8 px-3 py-2 text-xs font-semibold text-white/75 transition hover:bg-white/15 disabled:opacity-50"
              >
                {isFetching ? '↻ Refreshing…' : '↻ Refresh'}
              </button>
            </div>
          </div>
          {/* Mini KPI strip inside header */}
          {canSee('dashboard.today_attendance') && (
            <div className="relative mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
              {([
                { label: 'Total Staff', value: t.totalStaff,        color: 'text-white/90',    bg: 'bg-white/8 border-white/10' },
                { label: 'Present',     value: t.present,           color: 'text-emerald-300', bg: 'bg-emerald-500/12 border-emerald-500/18' },
                { label: 'Late',        value: t.late,              color: 'text-amber-300',   bg: 'bg-amber-500/12 border-amber-500/18' },
                { label: 'Absent',      value: t.absent,            color: 'text-red-300',     bg: 'bg-red-500/12 border-red-500/18' },
                { label: 'On Leave',    value: t.onLeave || 0,      color: 'text-sky-300',     bg: 'bg-sky-500/12 border-sky-500/18' },
              ] as { label: string; value: number; color: string; bg: string }[]).map(({ label, value, color, bg }) => (
                <div key={label} className={`rounded-xl border ${bg} px-4 py-3 backdrop-blur-sm`}>
                  <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/35">{label}</div>
                  <div className={`mt-1 text-2xl font-bold tabular-nums leading-none ${color}`}>{value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-[#1f5e3b] sm:text-3xl">Dashboard</h1>
            <p className="text-sm text-[#1f5e3b]/65">{t.date} · auto-refresh every {POLL_MS / 1000}s</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void refetch(); void refetchLeaves() }}
              disabled={isFetching}
              className="rounded-xl border border-[#1f5e3b]/20 bg-white px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] shadow-sm transition hover:bg-[#1f5e3b]/5 disabled:opacity-50"
            >
              {isFetching ? 'Refreshing…' : '↻ Refresh now'}
            </button>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#66bb6a]/35 bg-white px-3 py-1 text-xs font-semibold text-[#1f5e3b] shadow-sm">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#66bb6a] opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#2e7d32]" />
              </span>
              Live
            </span>
          </div>
        </div>
      )}

      {/* Smart alerts */}
      {canSee('dashboard.smart_alerts') && (ha.length > 0 || (pol && (pol.frequentLateUsers?.length || pol.highLeaveUsers?.length))) && (
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Smart Alerts</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {ha.length > 0 && (
              <div className="ph-card rounded-2xl border border-amber-200/80 bg-amber-50/50 p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-amber-900/90">Security &amp; Attendance</div>
                <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto text-xs text-[#14261a]">
                  {ha.slice(0, 8).map((a) => (
                    <li key={a.id}>
                      <span className="font-semibold text-amber-900">[{a.type}]</span> {a.message}
                      <span className="text-[#1f5e3b]/50"> · {a.created_at}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {pol && (pol.frequentLateUsers?.length || pol.highLeaveUsers?.length) ? (
              <div className="ph-card rounded-2xl border border-red-100 bg-red-50/40 p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-red-900/90">Policy Warnings</div>
                {pol.frequentLateUsers?.length > 0 && (
                  <p className="mt-2 text-xs text-[#14261a]">Frequent late (14d): {pol.frequentLateUsers.map((x) => x.name).join(', ')}</p>
                )}
                {pol.highLeaveUsers?.length > 0 && (
                  <p className="mt-2 text-xs text-[#14261a]">High leave count (YTD &gt;4): {pol.highLeaveUsers.map((x) => `${x.name} (${x.approvedLeaves})`).join(', ')}</p>
                )}
              </div>
            ) : null}
          </div>
        </section>
      )}

      {/* Today's Attendance */}
      {canSee('dashboard.today_attendance') && (
        <section>
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Today's Attendance</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Total Staff" value={t.totalStaff} variant="brand" onClick={() => openDrill('All Staff Today', 'all')} />
            <StatCard label="Present" value={t.present} variant="present" onClick={() => openDrill('Present (incl. half-day)', 'present')} />
            <StatCard label="Late" value={t.late} variant="late" onClick={() => openDrill('Late Today', 'late')} />
            <StatCard label="Absent" value={t.absent} variant="absent" onClick={() => openDrill('Absent Today', 'absent')} />
            <StatCard label="On Leave" value={t.onLeave || 0} variant="leave" onClick={() => openDrill('On Leave Today', 'leave')} />
          </div>
          {(t.halfDay != null || t.punchInCount != null) && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat title="Half-day" value={String(t.halfDay ?? 0)} sub="today" onClick={() => openDrill('Half-day', 'half')} />
              <MiniStat title="Punch in" value={String(t.punchInCount ?? 0)} sub="records" />
              <MiniStat title="Punch out" value={String(t.punchOutCount ?? 0)} sub="records" />
              <MiniStat title="Hours today" value={t.totalHoursWorkedToday != null ? `${t.totalHoursWorkedToday}h` : '—'} sub="total org" />
            </div>
          )}
        </section>
      )}

      {/* Live + Pending Leaves row */}
      {(canSee('dashboard.live_status') || canSee('dashboard.pending_leaves')) && (
        <div className="grid gap-6 lg:grid-cols-2">
          {canSee('dashboard.live_status') && (
            <Panel title={`Currently In Office (${liveCount})`}>
              <div className="flex items-center justify-between">
                <p className="text-xs text-[#1f5e3b]/60">{liveCount} checked in · {missingOut} missing punch-out</p>
                <button type="button" className="text-xs font-semibold text-[#1f5e3b] underline-offset-2 hover:underline" onClick={() => setLiveExpanded((v) => !v)}>
                  {liveExpanded ? 'Hide' : 'Show list'}
                </button>
              </div>
              {liveExpanded && (
                <ul className="mt-3 max-h-48 space-y-1.5 overflow-y-auto text-sm">
                  {liveNow.length === 0 ? (
                    <li className="text-[#1f5e3b]/50">No one currently checked in.</li>
                  ) : (
                    liveNow.map((p) => (
                      <li key={p.user_id || p.id} className="flex justify-between border-b border-[#1f5e3b]/8 pb-1.5">
                        <span className="font-medium text-[#14261a]">{p.full_name}</span>
                        <span className="text-xs text-[#1f5e3b]/60">{p.login_id || '—'} · In: {fmtTime(p.punch_in_at)}</span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </Panel>
          )}

          {canLeaveAll && canSee('dashboard.pending_leaves') && (
            <Panel title={`Pending Leave Requests (${pendingLeaves.length})`}>
              {pendingLeaves.length === 0 ? (
                <p className="text-sm text-[#1f5e3b]/50">No pending leave requests.</p>
              ) : (
                <ul className="max-h-52 space-y-2 overflow-y-auto text-sm">
                  {pendingLeaves.slice(0, 8).map((l) => {
                    const state = leaveAction[l.id]
                    return (
                      <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1f5e3b]/8 pb-2">
                        <div>
                          <span className="font-medium text-[#14261a]">{l.full_name || `#${l.user_id}`}</span>
                          <span className="ml-2 text-xs text-[#1f5e3b]/60">{fmtDateShort(l.start_date)} → {fmtDateShort(l.end_date)}</span>
                          <p className="text-xs text-[#1f5e3b]/70 line-clamp-1">{l.reason}</p>
                          {l.status === 'manager_approved' && <span className="text-[10px] font-semibold uppercase text-amber-700">Manager approved — awaiting final</span>}
                        </div>
                        {state === 'approved' ? (
                          <span className="text-xs font-semibold text-green-700">✓ Approved</span>
                        ) : state === 'rejected' ? (
                          <span className="text-xs font-semibold text-red-700">✗ Rejected</span>
                        ) : (
                          <div className="flex gap-1.5">
                            <button type="button" disabled={state === 'loading'} onClick={() => approveLeave(l.id)} className="rounded-lg bg-green-700 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-green-800 disabled:opacity-50">
                              {state === 'loading' ? '…' : 'Approve'}
                            </button>
                            <button type="button" disabled={state === 'loading'} onClick={() => rejectLeave(l.id)} className="rounded-lg bg-red-700 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-red-800 disabled:opacity-50">
                              Reject
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                  {pendingLeaves.length > 8 && <li className="pt-1 text-xs text-[#1f5e3b]/60">+{pendingLeaves.length - 8} more — see Leaves page</li>}
                </ul>
              )}
            </Panel>
          )}
        </div>
      )}

      {/* Workforce Overview */}
      {canSee('dashboard.company_stats') && (
        <section>
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Workforce Overview</h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MiniStat title="Workforce" value={String(data.stats.workforce)} sub="total employees" />
            <MiniStat title="Monthly Budget" value={inr(data.stats.monthlyBudgetINR)} sub="planned CTC" />
            <MiniStat title="Work Hours" value={`${data.stats.workHours}h`} sub="avg / month" />
            <MiniStat title="Offices" value={String(data.stats.offices)} sub="branches" />
          </div>
          {data.stats.totalHoursWorkedMonth != null && (
            <p className="mt-3 text-xs text-[#1f5e3b]/70">Month-to-date working hours (org): <strong>{data.stats.totalHoursWorkedMonth}h</strong></p>
          )}
        </section>
      )}

      {/* Employee Highlights + Actionable Insights */}
      {canSee('dashboard.employee_highlights') && (
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Employee Highlights</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Panel title="Top Performers">
                <ul className="space-y-2.5">
                  {data.highlights.topPerformers.slice(0, 5).map((p, i) => (
                    <li key={i} className="flex justify-between gap-2 text-sm">
                      <span className="font-medium text-[#14261a]">{p.name}</span>
                      <span className="shrink-0 text-[#2e7d32]">{p.score}% · {p.branch}</span>
                    </li>
                  ))}
                  {data.highlights.topPerformers.length === 0 && <li className="text-sm text-[#1f5e3b]/50">No data yet</li>}
                </ul>
              </Panel>
              <Panel title="Late / Defaulters Today">
                <ul className="space-y-2.5">
                  {data.highlights.lateDefaulters.map((r, i) => (
                    <li key={i} className="flex justify-between gap-2 text-sm">
                      <span className="text-[#14261a]">{r.name}</span>
                      <span className="text-amber-700">{r.status}</span>
                    </li>
                  ))}
                  {data.highlights.lateDefaulters.length === 0 && <li className="text-sm text-[#1f5e3b]/50">No late entries today</li>}
                </ul>
              </Panel>
            </div>
            <Panel title="Violation Reports">
              <ul className="space-y-2">
                {data.highlights.violations.map((v, i) => (
                  <li key={i} className="flex justify-between text-sm">
                    <span>{v.type}</span>
                    <span className="font-semibold text-red-700">{v.count}</span>
                  </li>
                ))}
              </ul>
              {data.highlights.weeklyLateFlags.length > 0 && (
                <p className="mt-4 border-t border-[#1f5e3b]/10 pt-3 text-xs text-amber-900/90">
                  Weekly late 3+ days: {data.highlights.weeklyLateFlags.map((f) => f.name).join(', ')}
                </p>
              )}
            </Panel>
          </div>
          <div>
            <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Actionable Insights</h2>
            <div className="space-y-3">
              <InsightCard title="Leave Requests" value={data.insights.leaveRequestsPending} hint="pending approval" />
              <InsightCard title="Biometric Requests" value={data.insights.biometricRequests} hint="in queue" />
              <div className="ph-card rounded-2xl p-5">
                <div className="text-xs font-semibold text-[#1f5e3b]/75">Document Compliance</div>
                <div className="mt-1 text-3xl font-bold text-[#1f5e3b]">{data.insights.documentCompliancePct}%</div>
                <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-emerald-100/80">
                  <div className="h-full rounded-full bg-gradient-to-r from-[#1f5e3b] via-[#66bb6a] to-[#a5d6a7] transition-all duration-500" style={{ width: `${data.insights.documentCompliancePct}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Staff by Branch */}
      {canSee('dashboard.staff_by_branch') && data.staffByBranch.length > 0 && (
        <section>
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Staff by Branch</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.staffByBranch.map((b) => (
              <div key={b.name} className="ph-card rounded-2xl p-6">
                <div className="text-lg font-bold text-[#1f5e3b]">{b.name}</div>
                <div className="mt-2 text-4xl font-semibold tabular-nums text-[#2e7d32]">{b.staffCount}</div>
                <div className="text-xs font-medium text-[#1f5e3b]/55">staff members</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Payroll Preview */}
      {canSee('dashboard.payroll') && data.payrollPreview && (
        <section>
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Payroll Preview</h2>
          <div className="ph-card rounded-2xl p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-xs font-medium text-[#1f5e3b]/65">Gross CTC (monthly)</div>
                <div className="mt-1 text-2xl font-bold text-[#14261a]">{inr(data.payrollPreview.grossCtcMonthlyINR)}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-[#1f5e3b]/65">Attendance deductions (estimate)</div>
                <div className="mt-1 text-2xl font-bold text-amber-800">− {inr(data.payrollPreview.attendanceDeductionsINR)}</div>
              </div>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-[#1f5e3b]/60">{data.payrollPreview.note}</p>
          </div>
        </section>
      )}

      {isSuperAdmin && accountAudit && (
        <section>
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Account Audit</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="ph-card rounded-2xl p-5"><div className="text-xs font-medium text-[#1f5e3b]/65">Total Users</div><div className="mt-1 text-3xl font-bold text-[#1f5e3b]">{accountAudit.stats.total}</div></div>
            <div className="ph-card rounded-2xl p-5"><div className="text-xs font-medium text-[#1f5e3b]/65">Login Ready</div><div className="mt-1 text-3xl font-bold text-[#1f5e3b]">{accountAudit.stats.login_ready}</div></div>
            <div className="ph-card rounded-2xl p-5"><div className="text-xs font-medium text-[#1f5e3b]/65">Pending / Rejected</div><div className="mt-1 text-3xl font-bold text-amber-700">{accountAudit.stats.pending} / {accountAudit.stats.rejected}</div></div>
            <div className="ph-card rounded-2xl p-5"><div className="text-xs font-medium text-[#1f5e3b]/65">Trash</div><div className="mt-1 text-3xl font-bold text-red-700">{accountAudit.stats.trashed}</div></div>
          </div>
          <div className="ph-card mt-4 rounded-2xl p-5">
            <div className="mb-3 text-sm font-semibold text-[#1f5e3b]">Recent Accounts</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-[#1f5e3b]/55">
                  <tr>
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Login ID</th>
                    <th className="py-2 pr-4">Role</th>
                    <th className="py-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {accountAudit.recent.map((u) => (
                    <tr key={u.id} className="border-t border-[#1f5e3b]/8">
                      <td className="py-2 pr-4">{u.full_name}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{u.login_id || `#${u.id}`}</td>
                      <td className="py-2 pr-4">{u.role}</td>
                      <td className="py-2 pr-4">{u.deleted_at ? 'Trashed' : u.account_status || (u.active ? 'ACTIVE' : 'INACTIVE')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Recent Activity — Super Admin only */}
      {isSuperAdmin && recentAudit.length > 0 && (
        <section>
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">Recent System Activity (Super Admin)</h2>
          <div className="ph-card rounded-2xl p-5">
            <ul className="divide-y divide-[#1f5e3b]/8">
              {recentAudit.map((log) => (
                <li key={log.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
                  <div>
                    <span className="font-medium text-[#14261a]">{actionLabel(log.action)}</span>
                    {log.actor_name && <span className="ml-2 text-xs text-[#1f5e3b]/60">by {log.actor_name}</span>}
                    <span className="ml-2 text-xs text-[#1f5e3b]/40">[{log.entity_type}#{log.entity_id}]</span>
                  </div>
                  <span className="shrink-0 text-xs text-[#1f5e3b]/55">{fmtDateTime(log.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Drill-down modal */}
      {drill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal
          onClick={(e) => { if (e.target === e.currentTarget) { setDrill(null); setDrillError(null) } }}
        >
          <div className="ph-card max-h-[85vh] w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl">
            {/* Header */}
            <div className="border-b border-[#1f5e3b]/10 px-5 py-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-[#1f5e3b]">{drill.title}</h3>
                <p className="text-xs text-[#1f5e3b]/60">
                  {data.today.date}
                  {!drillLoading && !drillError && (
                    <span className="ml-2 font-semibold text-[#1f5e3b]">· {drillRows.length} employee{drillRows.length !== 1 ? 's' : ''}</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setDrill(null); setDrillError(null) }}
                className="rounded-lg p-1 text-[#1f5e3b]/40 hover:bg-[#1f5e3b]/10 hover:text-[#1f5e3b] transition-colors"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="max-h-[60vh] overflow-y-auto px-5 py-3">
              {drillLoading ? (
                <div className="flex items-center gap-2 py-6 justify-center text-sm text-[#1f5e3b]/70">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#1f5e3b]/20 border-t-[#1f5e3b]" />
                  Loading…
                </div>
              ) : drillError ? (
                <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 my-2">
                  ❌ {drillError}
                  <button
                    type="button"
                    onClick={() => void openDrill(drill.title, drill.status)}
                    className="ml-3 underline text-red-600 hover:text-red-800"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <ul className="space-y-2 text-sm">
                  {drillRows.map((p) => (
                    <li key={p.id} className="border-b border-[#1f5e3b]/8 pb-2 last:border-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-[#14261a]">{p.full_name}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          p.status === 'present' ? 'bg-green-100 text-green-800'
                          : p.status === 'late' ? 'bg-amber-100 text-amber-800'
                          : (p.status === 'half' || p.status === 'half_day') ? 'bg-blue-100 text-blue-800'
                          : p.status === 'leave' ? 'bg-purple-100 text-purple-700'
                          : p.status === 'absent' ? 'bg-red-100 text-red-800'
                          : 'bg-orange-100 text-orange-700'
                        }`}>{p.status || 'absent'}</span>
                      </div>
                      <div className="text-xs text-[#1f5e3b]/70">{p.login_id || p.email || '—'} · {p.branch_name || '—'}</div>
                      {(p.punch_in_at || p.punch_out_at) && (
                        <div className="mt-0.5 text-xs text-[#14261a]/80">
                          {p.punch_in_at && <span>In: {fmtDateTime(p.punch_in_at)}</span>}
                          {p.punch_out_at && <span className="ml-3">Out: {fmtDateTime(p.punch_out_at)}</span>}
                        </div>
                      )}
                    </li>
                  ))}
                  {drillRows.length === 0 && (
                    <li className="py-8 text-center text-sm">
                      <div className="text-3xl mb-2">📭</div>
                      <p className="text-[#1f5e3b] font-semibold">
                        No {drill.status === 'all' ? 'staff' : drill.status === 'present' ? 'present' : drill.status === 'leave' ? 'on-leave' : drill.status} records yet today.
                      </p>
                      <p className="text-xs text-[#1f5e3b]/60 mt-1">
                        {drill.status === 'present' || drill.status === 'late' || drill.status === 'half'
                          ? 'No employees have punched in with this status yet.'
                          : drill.status === 'leave'
                          ? 'No approved leaves cover today.'
                          : drill.status === 'absent'
                          ? 'Everyone has either punched in or has approved leave.'
                          : 'Records will appear here as they are entered.'}
                      </p>
                    </li>
                  )}
                </ul>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-[#1f5e3b]/10 px-5 py-3 flex justify-end">
              <button
                type="button"
                className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white hover:bg-[#174d30]"
                onClick={() => { setDrill(null); setDrillError(null) }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function WorkHoursCard() {
  type WH = {
    period: string
    shift_hours_per_day: number
    working_days: number
    leave_days: number
    required_days: number
    required_hours: number
    actual_hours: number
    shortfall_hours: number
    on_track_pct: number
  }
  const { data } = useQuery<WH | null>({
    queryKey: ['/work-hours/monthly'],
    queryFn: async () => {
      try { return await api<WH>('/work-hours/monthly') } catch { return null }
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  if (!data) return null
  const pct = Math.max(0, Math.min(100, data.on_track_pct))
  const onTrack = data.shortfall_hours <= 0.5
  const barColor = onTrack ? 'bg-green-500' : pct >= 80 ? 'bg-amber-500' : 'bg-red-500'
  const periodLabel = (() => {
    try {
      const [y, mo] = data.period.split('-').map(Number)
      return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric' })
    } catch { return data.period }
  })()
  return (
    <section>
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[#1f5e3b]/55">
        Working Hours — {periodLabel}
      </h2>
      <div className="ph-card rounded-2xl border border-[#1f5e3b]/10 bg-white p-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-3xl font-bold text-[#1f5e3b] tabular-nums">
              {data.actual_hours.toFixed(1)}
              <span className="text-base font-medium text-[#1f5e3b]/50"> / {data.required_hours.toFixed(1)} hrs</span>
            </div>
            <div className="mt-1 text-xs text-[#1f5e3b]/60">
              {data.required_days} working days × {data.shift_hours_per_day} hrs/day
              {data.leave_days > 0 ? ` (${data.leave_days} leave excluded)` : ''}
            </div>
          </div>
          <div className={`rounded-full px-3 py-1 text-xs font-bold ${onTrack ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
            {onTrack ? '✅ On Track' : `⚠ ${data.shortfall_hours.toFixed(1)} hrs कम`}
          </div>
        </div>
        <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-[#f0f0f0]">
          <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-[#1f5e3b]/60">
          <span>{pct}% complete</span>
          <span>Target {data.required_hours.toFixed(1)} hrs</span>
        </div>
      </div>
    </section>
  )
}

function StatCard({ label, value, variant, onClick }: {
  label: string; value: number; variant: 'brand' | 'present' | 'late' | 'absent' | 'leave'; onClick?: () => void
}) {
  const grad =
    variant === 'brand' ? 'from-[#1F5E3B] via-[#2f7a4a] to-[#1F5E3B]'
    : variant === 'present' ? 'from-[#4CAF50] to-[#81C784]'
    : variant === 'late' ? 'from-[#C9A227] to-[#d5b85b]'
    : variant === 'leave' ? 'from-[#1976d2] to-[#42a5f5]'
    : 'from-[#c62828] to-[#e53935]'
  return (
    <div className="ph-stat-tall">
      <button
        type="button"
        disabled={!onClick}
        onClick={onClick}
        className={`relative w-full overflow-hidden rounded-2xl bg-gradient-to-br px-5 py-6 text-left text-white shadow-lg transition ${grad} ${onClick ? 'cursor-pointer hover:brightness-[1.03]' : ''}`}
      >
        <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-white/10 blur-2xl" />
        <div className="relative text-[11px] font-semibold uppercase tracking-[0.12em] text-white/90">{label}</div>
        <div className="ph-kpi-value relative mt-2 tabular-nums tracking-tight">{value}</div>
        {onClick && <div className="relative mt-1 text-[10px] font-medium text-white/80">Tap for list</div>}
      </button>
    </div>
  )
}

function MiniStat({ title, value, sub, onClick }: { title: string; value: string; sub: string; onClick?: () => void }) {
  const C = onClick ? 'button' : 'div'
  return (
    <C
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`ph-card rounded-2xl p-5 text-left ${onClick ? 'w-full cursor-pointer transition hover:bg-[#1f5e3b]/5' : ''}`}
    >
      <div className="text-xs font-semibold text-[#1f5e3b]/65">{title}</div>
      <div className="mt-2 text-xl font-bold text-[#14261a] sm:text-2xl">{value}</div>
      <div className="mt-1 text-[11px] font-medium text-[#8d6e63]">{sub}</div>
    </C>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ph-card rounded-2xl p-5">
      <div className="mb-3 text-sm font-bold text-[#1f5e3b]">{title}</div>
      {children}
    </div>
  )
}

function InsightCard({ title, value, hint }: { title: string; value: number; hint: string }) {
  return (
    <div className="ph-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-5">
      <div>
        <div className="text-xs font-semibold text-[#1f5e3b]/65">{title}</div>
        <div className="text-2xl font-bold text-[#1f5e3b]">{value}</div>
        <div className="text-[11px] text-[#8d6e63]">{hint}</div>
      </div>
      <span className="rounded-lg bg-[#e8f5e9] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-[#1f5e3b]">Review</span>
    </div>
  )
}
