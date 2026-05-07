import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getToken } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { currentPeriod } from '../lib/date'

type Entry = {
  id: number
  user_id: number
  period: string
  gross_inr: number
  deductions_inr: number
  net_inr: number
  notes: string | null
  full_name?: string
  email?: string
}

type UserMini = { id: number; full_name: string; email: string }

type PayrollOverview = {
  period: string
  totals: { gross_inr: number; deductions_inr: number; net_inr: number; count: number }
  entries: Entry[]
}

type PayrollPolicy = {
  monthly_leave_limit: number
  half_day_unit: number
  min_working_hours: number
  auto_half_day_enabled: boolean
  half_day_counts_in_leave: boolean
  weekoff_counts_in_leave: boolean
  per_day_divisor: number
  bonus_enabled: boolean
  late_minutes_threshold: number
  late_deduction_enabled: boolean
  late_free_minutes: number
  late_block_minutes: number
  late_block_days: number
}

type LateDate = { date: string; punch_in: string; late_minutes: number }

type BreakdownAgg = {
  present_days: number
  half_days: number
  absent_days: number
  weekoff_days: number
  leave_days_approved: number
  combined_leave_units: number
  low_hours_days: number
  late_days: number
  special_holiday_count: number
  total_days_in_month: number
  effective_min_hours: number
}

type BreakdownRow = {
  user_id: number
  full_name: string
  email: string
  monthly_salary: number
  days_in_month: number
  per_day_salary: number
  half_day_rate: number
  half_day_count: number
  half_day_deduction_inr: number
  combined_leave_units: number
  leave_limit: number
  excess_leaves: number
  excess_leave_deduction_inr: number
  unused_leaves: number
  unused_leave_bonus_inr: number
  late_days: number
  total_late_minutes: number
  late_free_minutes: number
  late_block_minutes: number
  late_block_days: number
  late_penalty_blocks: number
  late_penalty_days: number
  late_remaining_safe_minutes: number
  late_until_next_block_minutes: number
  late_dates: LateDate[]
  late_deduction_inr: number
  total_deduction_inr: number
  final_salary_inr: number
  manual_override: boolean
  breakdown: BreakdownAgg
}

type Holiday = { id: number; holiday_date: string; name: string }

const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0)

export function PayrollPage() {
  const { user } = useAuth()
  const [period, setPeriod] = useState(currentPeriod)
  const [overview, setOverview] = useState<PayrollOverview | null>(null)
  const [users, setUsers] = useState<UserMini[]>([])
  const [policy, setPolicy] = useState<PayrollPolicy | null>(null)
  const [breakdown, setBreakdown] = useState<BreakdownRow[] | null>(null)
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [autoRunning, setAutoRunning] = useState(false)
  const [autoMsg, setAutoMsg] = useState<string | null>(null)
  const [savingPolicy, setSavingPolicy] = useState(false)

  const canRead = canPerm(user, 'payroll:read') || canPerm(user, 'payroll:read_self')
  const canWrite = canPerm(user, 'payroll:write')
  const isSelfOnly = !canPerm(user, 'payroll:read') && canPerm(user, 'payroll:read_self')

  // Manual override form
  const [uid, setUid] = useState<number | ''>('')
  const [overrideNet, setOverrideNet] = useState('')
  const [overrideNotes, setOverrideNotes] = useState('')

  // Per-employee setup form (admin only)
  const [editUid, setEditUid] = useState<number | ''>('')
  const [editSalary, setEditSalary] = useState('')
  const [editMinHours, setEditMinHours] = useState('')

  // Holiday form
  const [holDate, setHolDate] = useState('')
  const [holName, setHolName] = useState('')

  // search filter for admin breakdown table
  const [search, setSearch] = useState('')
  const filteredBreakdown = useMemo(() => {
    if (!breakdown) return []
    const q = search.trim().toLowerCase()
    if (!q) return breakdown
    return breakdown.filter((r) =>
      r.full_name.toLowerCase().includes(q) ||
      (r.email || '').toLowerCase().includes(q) ||
      String(r.user_id).includes(q)
    )
  }, [breakdown, search])

  function downloadReport(fmt: 'xlsx' | 'pdf', userId?: number) {
    const qs = new URLSearchParams({ period })
    if (userId) qs.set('user_id', String(userId))
    const tok = getToken() || ''
    fetch(`/api/payroll/export-v2.${fmt}?${qs.toString()}`, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    })
      .then((r) => { if (!r.ok) throw new Error(`Download failed (${r.status})`); return r.blob() })
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = userId ? `payroll-${userId}-${period}.${fmt}` : `payroll-${period}.${fmt}`
        document.body.appendChild(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
      .catch((e) => alert(String(e.message || e)))
  }

  const load = useCallback(async () => {
    if (!canRead) return
    setErr(null)
    setLoading(true)
    try {
      const year = period.slice(0, 4)
      const calls: Promise<unknown>[] = [
        api<PayrollOverview>('/payroll/overview?period=' + encodeURIComponent(period)),
        api<{ breakdown: BreakdownRow[] }>('/payroll/breakdown?period=' + encodeURIComponent(period)),
        api<{ policy: PayrollPolicy }>('/payroll/policy'),
        api<{ holidays: Holiday[] }>('/payroll/holidays?year=' + year),
      ]
      if (canWrite) calls.push(api<{ users: UserMini[] }>('/users'))
      const results = await Promise.all(calls)
      setOverview(results[0] as PayrollOverview)
      setBreakdown((results[1] as { breakdown: BreakdownRow[] }).breakdown || [])
      setPolicy((results[2] as { policy: PayrollPolicy }).policy)
      setHolidays((results[3] as { holidays: Holiday[] }).holidays || [])
      if (canWrite) setUsers(((results[4] as { users: UserMini[] }).users) || [])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [canRead, canWrite, period])

  useEffect(() => { void load() }, [load])

  // When admin picks an employee in setup form, prefill from breakdown
  useEffect(() => {
    if (editUid === '' || !breakdown) return
    const row = breakdown.find((b) => b.user_id === editUid)
    if (row) {
      setEditSalary(String(row.monthly_salary))
      setEditMinHours(String(row.breakdown.effective_min_hours))
    }
  }, [editUid, breakdown])

  async function runAutoDeductV2() {
    if (!window.confirm(`Apply V2 leave + half-day rules to all employees for ${period}? (Manual entries preserved.)`)) return
    setAutoRunning(true)
    setAutoMsg(null)
    try {
      const d = await api<{ updated_count: number; period: string }>(
        '/payroll/auto-deduct-v2',
        { method: 'POST', body: JSON.stringify({ period }) }
      )
      setAutoMsg(`✅ Applied to ${d.updated_count} employees for ${d.period}`)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setAutoRunning(false)
    }
  }

  async function saveOverride(e: React.FormEvent) {
    e.preventDefault()
    if (!canWrite || uid === '') return
    setErr(null)
    try {
      const u = users.find((x) => x.id === uid)
      const br = breakdown?.find((x) => x.user_id === uid)
      const monthly = br?.monthly_salary || 0
      const net = Number(overrideNet) || 0
      const ded = Math.max(0, monthly - net)
      await api('/payroll/entries', {
        method: 'POST',
        body: JSON.stringify({
          user_id: Number(uid), period, gross_inr: monthly, deductions_inr: ded,
          notes: `Manual override: ${overrideNotes || `set by admin for ${u?.full_name || 'user'}`}`,
        }),
      })
      setOverrideNet(''); setOverrideNotes(''); setUid('')
      await load()
    } catch (e) { setErr((e as Error).message) }
  }

  async function saveUserSetup(e: React.FormEvent) {
    e.preventDefault()
    if (!canWrite || editUid === '') return
    try {
      await api(`/payroll/user/${editUid}`, {
        method: 'PUT',
        body: JSON.stringify({
          base_salary_inr: Number(editSalary) || 0,
          min_working_hours_override: editMinHours === '' ? null : Number(editMinHours),
        }),
      })
      setAutoMsg(`✅ Salary & hours updated for employee #${editUid}`)
      await load()
    } catch (e) { setErr((e as Error).message) }
  }

  async function addHoliday(e: React.FormEvent) {
    e.preventDefault()
    if (!canWrite || !holDate || !holName) return
    try {
      await api('/payroll/holidays', { method: 'POST', body: JSON.stringify({ holiday_date: holDate, name: holName }) })
      setHolDate(''); setHolName('')
      await load()
    } catch (e) { setErr((e as Error).message) }
  }

  async function deleteHoliday(id: number) {
    if (!window.confirm('Delete this special holiday?')) return
    try {
      await api(`/payroll/holidays/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) { setErr((e as Error).message) }
  }

  async function savePolicy(patch: Partial<PayrollPolicy>) {
    if (!canWrite || !policy) return
    setSavingPolicy(true)
    try {
      const r = await api<{ policy: PayrollPolicy }>('/payroll/policy', { method: 'PUT', body: JSON.stringify(patch) })
      setPolicy(r.policy)
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setSavingPolicy(false) }
  }

  if (!canRead) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center">
        <p className="text-[#1f5e3b]">You do not have permission to view payroll.</p>
      </div>
    )
  }

  const myRow = isSelfOnly ? breakdown?.[0] : null

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 pb-8">
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Payroll</h1>
        <p className="text-sm text-[#1f5e3b]/70">
          {isSelfOnly
            ? 'Aapki monthly salary, attendance breakdown aur deductions.'
            : 'Per-employee fixed-monthly salary with auto deductions.'}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-[#1f5e3b]">Period (YYYY-MM)</span>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value.slice(0, 7))}
            className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
        </label>
        <button type="button" onClick={() => void load()} className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white">Reload</button>
        {canWrite && (
          <button type="button" onClick={() => void runAutoDeductV2()} disabled={autoRunning}
            className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-60">
            {autoRunning ? '⏳ Calculating…' : '⚡ Auto-Calculate Salary'}
          </button>
        )}
      </div>
      {autoMsg && <p className="text-sm font-medium text-[#2e7d32]">{autoMsg}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Staff self-view */}
      {isSelfOnly && myRow && (
        <div className="ph-card rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-[#1f5e3b]">{myRow.full_name} — {period}</h2>
              <p className="text-xs text-[#1f5e3b]/60">Fixed monthly salary, deductions reason-wise neeche dekhein.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => downloadReport('xlsx', myRow.user_id)}
                className="rounded-xl bg-[#1f5e3b] text-white px-3 py-1.5 text-xs font-semibold hover:bg-[#174a2e]">⬇ Excel</button>
              <button onClick={() => downloadReport('pdf', myRow.user_id)}
                className="rounded-xl bg-[#0d47a1] text-white px-3 py-1.5 text-xs font-semibold hover:bg-[#0a3a82]">⬇ PDF</button>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            <Stat label="Monthly Salary" value={inr(myRow.monthly_salary)} tone="info" />
            <Stat label="Per Day Rate" value={inr(myRow.per_day_salary)} tone="info" />
            <Stat label="Half Day Rate" value={inr(myRow.half_day_rate)} tone="info" />
            <Stat label="✓ Final Salary" value={inr(myRow.final_salary_inr)} tone="primary" />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            <Stat label="Working Days (Present)" value={String(myRow.breakdown.present_days)} tone="success" />
            <Stat label="Half Days" value={String(myRow.half_day_count)} tone="warn" />
            <Stat label="Absent" value={String(myRow.breakdown.absent_days)} tone="warn" />
            <Stat label="Week-Off" value={String(myRow.breakdown.weekoff_days)} tone="muted" />
            <Stat label="Late Mins (Total)" value={`${myRow.total_late_minutes}m`} tone="warn" />
            <Stat label="Low-Hours Days" value={String(myRow.breakdown.low_hours_days)} tone="warn" />
            <Stat label="Special Holidays" value={String(myRow.breakdown.special_holiday_count)} tone="muted" />
            <Stat label="Min Hours/Day" value={`${myRow.breakdown.effective_min_hours}h`} tone="muted" />
          </div>
          <div className="mt-5 rounded-xl border border-[#1f5e3b]/10 bg-[#f5faf6] p-4">
            <p className="text-sm font-semibold text-[#1f5e3b]">💰 Salary Calculation</p>
            <ul className="mt-2 space-y-1 text-sm">
              <li className="flex justify-between">
                <span>Base Monthly Salary:</span>
                <span className="font-semibold text-[#1f5e3b]">{inr(myRow.monthly_salary)}</span>
              </li>
              {myRow.unused_leave_bonus_inr > 0 && (
                <li className="flex justify-between">
                  <span>➕ Bonus ({myRow.unused_leaves} unused leaves × {inr(myRow.per_day_salary)}):</span>
                  <span className="font-semibold text-green-700">+{inr(myRow.unused_leave_bonus_inr)}</span>
                </li>
              )}
              {myRow.half_day_deduction_inr > 0 && (
                <li className="flex justify-between">
                  <span>➖ Half-day cuts ({myRow.half_day_count} × {inr(myRow.half_day_rate)}):</span>
                  <span className="font-semibold text-orange-600">−{inr(myRow.half_day_deduction_inr)}</span>
                </li>
              )}
              {myRow.excess_leave_deduction_inr > 0 && (
                <li className="flex justify-between">
                  <span>➖ Extra leaves ({myRow.excess_leaves} × {inr(myRow.per_day_salary)}):</span>
                  <span className="font-semibold text-orange-600">−{inr(myRow.excess_leave_deduction_inr)}</span>
                </li>
              )}
              {myRow.late_deduction_inr > 0 && (
                <li className="flex justify-between">
                  <span>➖ Late penalty ({myRow.total_late_minutes} min → {myRow.late_penalty_days} day{myRow.late_penalty_days === 1 ? '' : 's'}):</span>
                  <span className="font-semibold text-orange-600">−{inr(myRow.late_deduction_inr)}</span>
                </li>
              )}
              <li className="flex justify-between border-t border-[#1f5e3b]/10 pt-2">
                <span>Total Leaves Used: {myRow.combined_leave_units} of {myRow.leave_limit} allowed</span>
                <span className="text-[#1f5e3b]/70">{myRow.unused_leaves > 0 ? `${myRow.unused_leaves} unused` : `${myRow.excess_leaves} extra`}</span>
              </li>
              <li className="flex justify-between border-t border-[#1f5e3b]/10 pt-2 text-base">
                <span className="font-bold">✓ Final Salary:</span>
                <span className="font-bold text-[#0d47a1]">{inr(myRow.final_salary_inr)}</span>
              </li>
            </ul>
            <p className="mt-2 text-[10px] text-[#1f5e3b]/60">
              💡 Kam leave lo, zyada salary pao! Har unused leave par {inr(myRow.per_day_salary)} bonus milta hai.
            </p>
          </div>
          {myRow.manual_override && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">⚠ Final salary admin ne manually set ki hai (auto-calc skip).</p>
          )}

          {/* Live Late Tracker (minutes-based) */}
          <LateTracker row={myRow} />
        </div>
      )}

      {/* Policy panel */}
      {policy && !isSelfOnly && (
        <div className="ph-card space-y-3 rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[#1f5e3b]">📋 Leave & Salary Policy</h2>
            {canWrite && <span className="text-[10px] text-[#1f5e3b]/60">Changes save instantly</span>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            <PolicyNum label="Per Day Divisor" hint="Per Day = Monthly ÷ this (default 30)"
              value={policy.per_day_divisor} disabled={!canWrite || savingPolicy} min={1} max={31}
              onSave={(v) => savePolicy({ per_day_divisor: v })} />
            <PolicyNum label="Monthly Leave Limit" hint="Free leaves per month (default 4)"
              value={policy.monthly_leave_limit} disabled={!canWrite || savingPolicy} min={0} max={31}
              onSave={(v) => savePolicy({ monthly_leave_limit: v })} />
            <PolicyNum label="Half-Day Unit" hint="Half day = per-day × this (default 0.5)"
              value={policy.half_day_unit} disabled={!canWrite || savingPolicy} min={0} max={1} step={0.1}
              onSave={(v) => savePolicy({ half_day_unit: v })} />
            <PolicyNum label="Default Min Working Hours/Day" hint="Below this → auto half-day"
              value={policy.min_working_hours} disabled={!canWrite || savingPolicy} min={0} max={24} step={0.5}
              onSave={(v) => savePolicy({ min_working_hours: v })} />
            <PolicyToggle label="Bonus Enabled" hint="Unused leave × per-day = bonus"
              checked={policy.bonus_enabled} disabled={!canWrite || savingPolicy}
              onChange={(v) => savePolicy({ bonus_enabled: v })} />
            <PolicyToggle label="Auto Half-Day on Low Hours" hint="Hours < min → half-day"
              checked={policy.auto_half_day_enabled} disabled={!canWrite || savingPolicy}
              onChange={(v) => savePolicy({ auto_half_day_enabled: v })} />
            <PolicyToggle label="Count Half-Days in Leave Bucket" hint="Off → only half-day cut, no leave count"
              checked={policy.half_day_counts_in_leave} disabled={!canWrite || savingPolicy}
              onChange={(v) => savePolicy({ half_day_counts_in_leave: v })} />
            <PolicyToggle label="Count Week-Offs in Leave Bucket" hint="Sundays count toward limit (default OFF — paid)"
              checked={policy.weekoff_counts_in_leave} disabled={!canWrite || savingPolicy}
              onChange={(v) => savePolicy({ weekoff_counts_in_leave: v })} />
            <PolicyNum label="Per-day Late Grace (mins)" hint="Late only counts beyond shift+grace+this (default 0)"
              value={policy.late_minutes_threshold} disabled={!canWrite || savingPolicy} min={0} max={240}
              onSave={(v) => savePolicy({ late_minutes_threshold: v })} />
            <PolicyNum label="Free Late Minutes / Month" hint="Total monthly safe limit (default 30 min)"
              value={policy.late_free_minutes} disabled={!canWrite || savingPolicy} min={0} max={600}
              onSave={(v) => savePolicy({ late_free_minutes: v })} />
            <PolicyNum label="Block Size (mins)" hint="Every X minutes over limit = 1 block (default 30)"
              value={policy.late_block_minutes} disabled={!canWrite || savingPolicy} min={1} max={600}
              onSave={(v) => savePolicy({ late_block_minutes: v })} />
            <PolicyNum label="Days per Block" hint="Days deducted per block (default 1)"
              value={policy.late_block_days} disabled={!canWrite || savingPolicy} min={0} max={10} step={1}
              onSave={(v) => savePolicy({ late_block_days: v })} />
            <PolicyToggle label="Late Penalty Enabled" hint="Master switch for minutes-based late deduction"
              checked={policy.late_deduction_enabled} disabled={!canWrite || savingPolicy}
              onChange={(v) => savePolicy({ late_deduction_enabled: v })} />
          </div>
        </div>
      )}

      {/* Special holidays — admin manages, all see */}
      {!isSelfOnly && (
        <div className="ph-card space-y-3 rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-[#1f5e3b]">🎉 Special / Festival Holidays</h2>
          <p className="text-xs text-[#1f5e3b]/60">In dates par koi salary deduction nahi hogi (paid).</p>
          {canWrite && (
            <form onSubmit={addHoliday} className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Date</span>
                <input type="date" value={holDate} onChange={(e) => setHolDate(e.target.value)} required
                  className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm flex-1 min-w-[200px]">
                <span className="mb-1 block font-medium">Name</span>
                <input value={holName} onChange={(e) => setHolName(e.target.value)} required placeholder="e.g. Diwali"
                  className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <button type="submit" className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white">Add holiday</button>
            </form>
          )}
          {holidays.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[400px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#1f5e3b]/10 text-xs text-[#1f5e3b]/60">
                    <th className="py-1.5">Date</th><th className="py-1.5">Name</th>
                    {canWrite && <th className="py-1.5">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.id} className="border-b border-[#1f5e3b]/5">
                      <td className="py-1.5">{h.holiday_date}</td>
                      <td className="py-1.5">{h.name}</td>
                      {canWrite && (
                        <td className="py-1.5">
                          <button type="button" onClick={() => void deleteHoliday(h.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-xs text-[#1f5e3b]/50">No holidays added yet.</p>}
        </div>
      )}

      {/* Per-employee setup (admin) */}
      {canWrite && !isSelfOnly && (
        <form onSubmit={saveUserSetup} className="ph-card space-y-4 rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-[#1f5e3b]">⚙ Per-Employee Salary & Min Hours Setup</h2>
          <p className="text-xs text-[#1f5e3b]/70">Har employee ki monthly salary aur min daily hours alag set kar sakte hain. Min hours blank = shift duration use hogi.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm sm:col-span-3">
              <span className="mb-1 block font-medium">Employee</span>
              <select required value={editUid} onChange={(e) => setEditUid(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Monthly Salary (INR)</span>
              <input value={editSalary} onChange={(e) => setEditSalary(e.target.value)} required inputMode="decimal"
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Min Working Hours/Day</span>
              <input type="number" min="0" max="24" step="0.5" value={editMinHours} onChange={(e) => setEditMinHours(e.target.value)}
                placeholder="blank = use shift"
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
            </label>
            <div className="text-xs text-[#1f5e3b]/60 sm:col-span-1 self-end">Shift timings change karne ke liye Timings page use karein.</div>
          </div>
          <button type="submit" className="rounded-xl bg-[#1f5e3b] px-5 py-2.5 text-sm font-semibold text-white">Save employee setup</button>
        </form>
      )}

      {/* Admin breakdown table */}
      {!isSelfOnly && breakdown && breakdown.length > 0 && (
        <div className="ph-card rounded-2xl p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-[#1f5e3b]">Per-Employee Breakdown — {period}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 Search name, email or ID…"
                className="rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-sm w-56" />
              <button onClick={() => downloadReport('xlsx')}
                className="rounded-xl bg-[#1f5e3b] text-white px-3 py-1.5 text-xs font-semibold hover:bg-[#174a2e]">
                ⬇ Excel (All)
              </button>
              <button onClick={() => downloadReport('pdf')}
                className="rounded-xl bg-[#0d47a1] text-white px-3 py-1.5 text-xs font-semibold hover:bg-[#0a3a82]">
                ⬇ PDF (All)
              </button>
            </div>
          </div>
          {search && (
            <p className="mb-2 text-xs text-[#1f5e3b]/60">
              Showing {filteredBreakdown.length} of {breakdown.length} employees
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1200px] text-left text-xs">
              <thead>
                <tr className="border-b border-[#1f5e3b]/10 text-[10px] font-semibold uppercase tracking-wide text-[#1f5e3b]/60">
                  <th className="py-2">Employee</th>
                  <th className="py-2 text-right">Monthly</th>
                  <th className="py-2 text-right">Per/Day</th>
                  <th className="py-2 text-center">Present</th>
                  <th className="py-2 text-center">Half</th>
                  <th className="py-2 text-center">Absent</th>
                  <th className="py-2 text-center">Wk-Off</th>
                  <th className="py-2 text-center">Late (mins/days)</th>
                  <th className="py-2 text-center">Used / Limit</th>
                  <th className="py-2 text-right text-green-700">Bonus</th>
                  <th className="py-2 text-right text-orange-600">Deduction</th>
                  <th className="py-2 text-right text-[#0d47a1]">Final</th>
                  <th className="py-2 text-center">⬇</th>
                </tr>
              </thead>
              <tbody>
                {filteredBreakdown.map((r) => (
                  <tr key={r.user_id} className="border-b border-[#1f5e3b]/5 hover:bg-[#f5faf6]">
                    <td className="py-1.5 font-medium">
                      {r.full_name}
                      {r.manual_override && <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] text-amber-800">MANUAL</span>}
                      <div className="text-[10px] text-[#1f5e3b]/50">{r.email}</div>
                    </td>
                    <td className="py-1.5 text-right">{inr(r.monthly_salary)}</td>
                    <td className="py-1.5 text-right text-[#1f5e3b]/70">{inr(r.per_day_salary)}</td>
                    <td className="py-1.5 text-center text-[#2e7d32]">{r.breakdown.present_days}</td>
                    <td className="py-1.5 text-center">{r.half_day_count}</td>
                    <td className="py-1.5 text-center text-orange-600">{r.breakdown.absent_days}</td>
                    <td className="py-1.5 text-center">{r.breakdown.weekoff_days}</td>
                    <td className="py-1.5 text-center">
                      <span className="font-semibold">{r.total_late_minutes}m</span>
                      {r.late_penalty_days > 0 && <span className="ml-1 text-orange-600">(−{r.late_penalty_days}d)</span>}
                    </td>
                    <td className="py-1.5 text-center">
                      <span className={r.combined_leave_units > r.leave_limit ? 'text-red-600 font-semibold' : 'text-[#1f5e3b]'}>
                        {r.combined_leave_units} / {r.leave_limit}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-semibold text-green-700">{r.unused_leave_bonus_inr > 0 ? `+${inr(r.unused_leave_bonus_inr)}` : '—'}</td>
                    <td className="py-1.5 text-right font-semibold text-orange-600">{r.total_deduction_inr > 0 ? `−${inr(r.total_deduction_inr)}` : '—'}</td>
                    <td className="py-1.5 text-right font-semibold text-[#0d47a1]">{inr(r.final_salary_inr)}</td>
                    <td className="py-1.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button title="Download Excel" onClick={() => downloadReport('xlsx', r.user_id)}
                          className="rounded bg-[#1f5e3b]/10 hover:bg-[#1f5e3b]/20 px-1.5 py-0.5 text-[10px] text-[#1f5e3b]">XLS</button>
                        <button title="Download PDF" onClick={() => downloadReport('pdf', r.user_id)}
                          className="rounded bg-[#0d47a1]/10 hover:bg-[#0d47a1]/20 px-1.5 py-0.5 text-[10px] text-[#0d47a1]">PDF</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredBreakdown.length === 0 && (
                  <tr><td colSpan={13} className="py-6 text-center text-[#1f5e3b]/50">No matching employees.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Manual override */}
      {canWrite && !isSelfOnly && (
        <form onSubmit={saveOverride} className="ph-card space-y-4 rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-[#1f5e3b]">✏ Manual Salary Override</h2>
          <p className="text-xs text-[#1f5e3b]/70">Auto-calc bypass karke final salary set karein. Bonus, advance recovery, ya special cases ke liye.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block font-medium">Employee</span>
              <select required value={uid} onChange={(e) => setUid(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Final Salary (INR)</span>
              <input value={overrideNet} onChange={(e) => setOverrideNet(e.target.value)} required inputMode="decimal"
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
            </label>
            <label className="text-sm sm:col-span-3">
              <span className="mb-1 block font-medium">Reason / Notes</span>
              <input value={overrideNotes} onChange={(e) => setOverrideNotes(e.target.value)} placeholder="e.g. Bonus added / advance deducted"
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
            </label>
          </div>
          <button type="submit" className="rounded-xl bg-[#1f5e3b] px-5 py-2.5 text-sm font-semibold text-white">Save override</button>
        </form>
      )}

      {/* Saved totals */}
      {!isSelfOnly && (
        <div className="ph-card rounded-2xl p-5">
          <h2 className="mb-3 text-lg font-semibold text-[#1f5e3b]">Saved payroll entries — {period}</h2>
          {loading ? <p className="text-sm">Loading…</p> : overview ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl bg-[#e8f5e9] p-4">
                <p className="text-xs font-medium text-[#1f5e3b]/80">Gross</p>
                <p className="text-xl font-bold text-[#1f5e3b]">{inr(overview.totals.gross_inr)}</p>
              </div>
              <div className="rounded-xl bg-[#fff3e0] p-4">
                <p className="text-xs font-medium text-[#8d6e63]">Deductions</p>
                <p className="text-xl font-bold text-[#5d4037]">{inr(overview.totals.deductions_inr)}</p>
              </div>
              <div className="rounded-xl bg-[#e3f2fd] p-4">
                <p className="text-xs font-medium text-[#1565c0]">Net</p>
                <p className="text-xl font-bold text-[#0d47a1]">{inr(overview.totals.net_inr)}</p>
              </div>
            </div>
          ) : null}
          {overview && overview.entries.length === 0 && (
            <p className="mt-4 text-sm text-[#1f5e3b]/60">No saved entries yet — run "Auto-Calculate Salary".</p>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'info' | 'primary' | 'success' | 'warn' | 'muted' }) {
  const cls = tone === 'primary' ? 'bg-[#e3f2fd] text-[#0d47a1]'
    : tone === 'success' ? 'bg-[#e8f5e9] text-[#1f5e3b]'
    : tone === 'warn' ? 'bg-[#fff3e0] text-[#8d6e63]'
    : tone === 'muted' ? 'bg-gray-100 text-gray-700'
    : 'bg-[#f5faf6] text-[#1f5e3b]'
  return (
    <div className={`rounded-xl p-3 ${cls}`}>
      <p className="text-[10px] font-medium opacity-80">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  )
}

function PolicyNum({ label, hint, value, disabled, min, max, step, onSave }:
  { label: string; hint: string; value: number; disabled: boolean; min?: number; max?: number; step?: number; onSave: (v: number) => void }) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => { setLocal(String(value)) }, [value])
  return (
    <div className="rounded-lg bg-[#f5faf6] p-3 text-xs">
      <p className="font-semibold text-[#1f5e3b]">{label}</p>
      <input type="number" min={min} max={max} step={step ?? 1} disabled={disabled}
        value={local} onChange={(e) => setLocal(e.target.value)}
        onBlur={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v) && v !== value) onSave(v) }}
        className="mt-1 w-24 rounded border border-[#1f5e3b]/20 px-2 py-1 text-sm" />
      <p className="mt-1 text-[10px] text-[#1f5e3b]/60">{hint}</p>
    </div>
  )
}

function LateTracker({ row }: { row: BreakdownRow }) {
  const total = row.total_late_minutes || 0
  const free = row.late_free_minutes || 30
  const block = row.late_block_minutes || 30
  const overFree = Math.max(0, total - free)
  const safePct = Math.min(100, (Math.min(total, free) / Math.max(1, free)) * 100)
  const blocksFilled = row.late_penalty_blocks || 0
  const inSafeZone = total <= free
  const dates = row.late_dates || []
  return (
    <div className="mt-5 rounded-xl border border-orange-200 bg-orange-50/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-orange-700">⏰ Late Tracker (is mahine)</p>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${inSafeZone ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
          {inSafeZone ? 'Safe Zone' : `${blocksFilled} block cut`}
        </span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-white p-2 text-center">
          <p className="text-[10px] text-gray-500">Total Late</p>
          <p className="text-lg font-bold text-orange-700">{total} min</p>
        </div>
        <div className="rounded-lg bg-white p-2 text-center">
          <p className="text-[10px] text-gray-500">Safe Limit Bachi</p>
          <p className="text-lg font-bold text-green-700">{row.late_remaining_safe_minutes} / {free} min</p>
        </div>
        <div className="rounded-lg bg-white p-2 text-center">
          <p className="text-[10px] text-gray-500">Salary Cut</p>
          <p className="text-lg font-bold text-red-600">−{row.late_penalty_days} day{row.late_penalty_days === 1 ? '' : 's'}</p>
        </div>
      </div>
      <div className="mt-3">
        <div className="mb-1 flex justify-between text-[10px] text-gray-600">
          <span>0 min</span>
          <span className="font-semibold">Safe limit: {free} min</span>
          <span>{free + block * 3}+ min</span>
        </div>
        <div className="relative h-3 w-full overflow-hidden rounded-full bg-gray-200">
          <div className="absolute left-0 top-0 h-full bg-green-500 transition-all" style={{ width: `${safePct * 0.5}%` }} />
          {overFree > 0 && (
            <div className="absolute top-0 h-full bg-orange-500 transition-all" style={{ left: '50%', width: `${Math.min(50, (overFree / (block * 3)) * 50)}%` }} />
          )}
          <div className="absolute top-0 h-full w-px bg-gray-700" style={{ left: '50%' }} />
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-700">
        {inSafeZone ? (
          <>Aap <b>{total} min</b> late ho chuke hain. Abhi <b>{row.late_remaining_safe_minutes} min</b> safe limit bachi hai. Iske baad har <b>{block} min</b> par <b>{row.late_block_days} din</b> ki salary kategi.</>
        ) : (
          <>Aap <b>{total} min</b> late ho chuke hain — <b>{row.late_penalty_days} din</b> ki salary kat chuki hai. Aur <b>{row.late_until_next_block_minutes} min</b> late hue to <b>{row.late_block_days} din aur</b> kategi.</>
        )}
      </p>
      {dates.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-orange-700">📋 Late history dekho ({dates.length} din)</summary>
          <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-white p-2 text-xs">
            {dates.map((d, i) => (
              <li key={i} className="flex items-center justify-between border-b border-gray-100 py-1 last:border-0">
                <span className="font-medium">{d.date}</span>
                <span className="text-gray-500">{new Date(d.punch_in).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span>
                <span className="font-bold text-orange-600">+{d.late_minutes}m</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function PolicyToggle({ label, hint, checked, disabled, onChange }:
  { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-lg bg-[#f5faf6] p-3 text-xs">
      <input type="checkbox" disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <p className="font-semibold text-[#1f5e3b]">{label}</p>
        <p className="text-[10px] text-[#1f5e3b]/60">{hint}</p>
      </div>
    </label>
  )
}
