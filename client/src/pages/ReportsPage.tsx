import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api, apiFetchUrl, getToken } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

function localDateInputValue(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type ReportsPayload = {
  generatedAt: string
  exports: Record<string, string>
  meta: string
  note: string
}

/** Backend catalogue uses `/api/...`; browser fetch uses same-origin path without `/api` prefix for apiFetchUrl. */
function stripApiPrefix(full: string): string {
  const u = full.startsWith('/api') ? full.slice(4) : full
  return u.startsWith('/') ? u : `/${u}`
}

async function downloadExport(fullPath: string, filename: string) {
  const token = getToken()
  const rel = stripApiPrefix(fullPath)
  const qIdx = rel.indexOf('?')
  const pathname = qIdx >= 0 ? rel.slice(0, qIdx) : rel
  const query = qIdx >= 0 ? rel.slice(qIdx) : ''
  const url = `${apiFetchUrl(pathname)}${query}`
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

export function ReportsPage() {
  const { user } = useAuth()
  const now = useMemo(() => new Date(), [])
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [reportDay, setReportDay] = useState(() => localDateInputValue(now))

  const canAccess = !!(user && (canPerm(user, 'export:read') || canPerm(user, 'dashboard:read')))
  const canEmployees = !!(user && canPerm(user, 'users:read') && canPerm(user, 'export:read'))
  const canSystem = user?.role === 'SUPER_ADMIN'

  const reportsQ = useQuery({
    queryKey: ['reports', year, month],
    queryFn: () => api<ReportsPayload>(`/reports?year=${year}&month=${month}`),
    enabled: canAccess,
  })

  const data = reportsQ.data

  if (!canAccess) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center text-sm text-[#1f5e3b]">
        Reports are available to roles with export or full dashboard access. Contact HR if you need an export.
      </div>
    )
  }

  /** Keys from `GET /api/reports` — PDF/XLSX handlers live in `server/productRoutes.js`. */
  const attendanceLinks: { key: string; label: string }[] = [
    { key: 'attendanceCsv', label: 'Attendance (CSV)' },
    { key: 'attendanceXlsx', label: 'Attendance (Excel)' },
    { key: 'monthlyCsv', label: 'Monthly attendance (CSV)' },
    { key: 'monthlyPdf', label: 'Monthly summary (PDF)' },
    { key: 'monthlyAttendanceXlsx', label: 'Monthly attendance (Excel)' },
    { key: 'dailyPdf', label: 'Daily summary (PDF)' },
    { key: 'dailyXlsx', label: 'Daily summary (Excel)' },
  ]

  function canDownloadAttendanceExport(key: string) {
    if (!user) return false
    const exportOk = canPerm(user, 'export:read')
    const dashOk = canPerm(user, 'dashboard:read')
    if (key === 'dailyPdf' || key === 'dailyXlsx') return exportOk || dashOk
    return exportOk
  }

  function resolveAttendancePath(key: string, exports: ReportsPayload['exports']) {
    const base = exports[key]
    if (!base) return ''
    if (key === 'dailyPdf' || key === 'dailyXlsx') {
      const sep = base.includes('?') ? '&' : '?'
      return `${base}${sep}date=${encodeURIComponent(reportDay)}`
    }
    return base
  }

  const otherLinks: { key: string; label: string }[] = [
    { key: 'leaveCsv', label: 'Leaves (CSV)' },
    { key: 'documentsXlsx', label: 'Documents (Excel)' },
    { key: 'payrollXlsx', label: 'Payroll (Excel)' },
  ]

  async function handleDownload(path: string, label: string) {
    const safe = label.replace(/\s+/g, '-').toLowerCase()
    const ext = path.includes('.csv') ? 'csv' : path.includes('.xlsx') ? 'xlsx' : path.includes('.pdf') ? 'pdf' : 'export'
    await downloadExport(path, `hrms-${safe}.${ext}`)
  }

  return (
    <div className="mx-auto max-w-[960px] space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Reports & exports</h1>
        <p className="mt-1 text-sm text-[#1f5e3b]/70">
          Download data using the same APIs as integrations. Use a period for monthly files.
        </p>
      </div>

      <div className="ph-card flex flex-wrap items-end gap-4 rounded-2xl p-5">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-[#1f5e3b]">Year</span>
          <input
            type="number"
            className="rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
            value={year}
            min={2020}
            max={2100}
            onChange={(e) => setYear(Number(e.target.value) || year)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-[#1f5e3b]">Month</span>
          <select
            className="rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
          >
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {new Date(2000, i, 1).toLocaleString('default', { month: 'long' })}
              </option>
            ))}
          </select>
        </label>
      </div>

      {reportsQ.isLoading && <p className="text-sm text-[#1f5e3b]/70">Loading report catalogue…</p>}
      {reportsQ.isError && (
        <p className="text-sm text-red-600">{(reportsQ.error as Error)?.message || 'Failed to load reports.'}</p>
      )}

      {data && (
        <>
          <p className="text-xs text-[#1f5e3b]/60">
            Catalogue generated: {new Date(data.generatedAt).toLocaleString()} — {data.note}
          </p>

          <section className="ph-card space-y-4 rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-[#1f5e3b]">Attendance reports</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-[#1f5e3b]">Date for daily PDF / Excel</span>
              <input
                type="date"
                className="rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
                value={reportDay}
                max={localDateInputValue(new Date())}
                onChange={(e) => setReportDay(e.target.value || reportDay)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {attendanceLinks.map(({ key, label }) => {
                const path = resolveAttendancePath(key, data.exports)
                if (!path) return null
                return (
                  <button
                    key={key}
                    type="button"
                    className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-105 disabled:opacity-50"
                    disabled={!canDownloadAttendanceExport(key)}
                    onClick={() => handleDownload(path, label)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            {user && !canPerm(user, 'export:read') && canPerm(user, 'dashboard:read') && (
              <p className="text-xs text-[#1f5e3b]/80">
                Daily summary downloads are available with dashboard access. Raw attendance CSV/Excel and monthly files need export permission.
              </p>
            )}
            {user && !canPerm(user, 'export:read') && !canPerm(user, 'dashboard:read') && (
              <p className="text-xs text-amber-800">You do not have permission to download these files.</p>
            )}
          </section>

          {canEmployees && (
            <section className="ph-card space-y-4 rounded-2xl p-6">
              <h2 className="text-lg font-semibold text-[#1f5e3b]">Employee reports</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-[#1f5e3b]/30 bg-white px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-emerald-50"
                  onClick={() => handleDownload('/employees/export.csv', 'Employees CSV')}
                >
                  Employees (CSV)
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-[#1f5e3b]/30 bg-white px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-emerald-50"
                  onClick={() => handleDownload('/employees/export.xlsx', 'Employees Excel')}
                >
                  Employees (Excel)
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-[#1f5e3b]/30 bg-white px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-emerald-50"
                  onClick={() => handleDownload('/employees/export.pdf', 'Employees PDF')}
                >
                  Employees (PDF)
                </button>
              </div>
            </section>
          )}

          <section className="ph-card space-y-4 rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-[#1f5e3b]">More exports</h2>
            <div className="flex flex-wrap gap-2">
              {otherLinks.map(({ key, label }) => {
                const path = data.exports[key as keyof typeof data.exports]
                if (!path) return null
                if (key === 'leaveCsv' && (!user || (!canPerm(user, 'leave:read_all') && !canPerm(user, 'leave:read_self'))))
                  return null
                const needDocs = key === 'documentsXlsx'
                if (
                  needDocs &&
                  (!user || (!canPerm(user, 'documents:read_all') && !canPerm(user, 'documents:verify')))
                )
                  return null
                const needPayroll = key === 'payrollXlsx'
                if (needPayroll && (!user || !canPerm(user, 'payroll:read'))) return null
                return (
                  <button
                    key={key}
                    type="button"
                    className="rounded-xl bg-[#66bb6a]/20 px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#66bb6a]/30"
                    onClick={() => handleDownload(path, label)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </section>

          {canSystem && (
            <section className="ph-card space-y-4 rounded-2xl border border-amber-200/80 bg-amber-50/40 p-6">
              <h2 className="text-lg font-semibold text-amber-950">Full system export</h2>
              <p className="text-xs text-amber-900/90">Super Admin only — multi-sheet workbook or summary PDF.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-xl bg-amber-800 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-900"
                  onClick={() => handleDownload('/system/export.xlsx', 'System Excel')}
                >
                  System (Excel)
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-amber-800 px-4 py-2 text-sm font-semibold text-amber-950 hover:bg-amber-100"
                  onClick={() => handleDownload('/system/export.pdf', 'System PDF')}
                >
                  System (PDF summary)
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
