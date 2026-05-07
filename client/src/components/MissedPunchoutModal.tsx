import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

type MissedRecord = {
  id: number
  user_id: number
  work_date: string
  punch_in_at: string
  full_name?: string
  login_id?: string
}

type Props = {
  onDismiss: () => void
}

export function MissedPunchoutModal({ onDismiss }: Props) {
  const { user } = useAuth()
  const isAdmin = canPerm(user, 'attendance:read_all')
  const [records, setRecords] = useState<MissedRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Record<number, boolean>>({})
  const [times, setTimes] = useState<Record<number, string>>({})
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [done, setDone] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')

  useEffect(() => {
    api<{ missed: MissedRecord[] }>('/attendance/missed-punchout')
      .then((d) => setRecords(d.missed || []))
      .catch(() => setRecords([]))
      .finally(() => setLoading(false))
  }, [])

  async function fixPunchout(record: MissedRecord) {
    const t = times[record.id]
    if (!t) {
      setError(`Please set a punch-out time for ${record.work_date}`)
      return
    }
    setSaving((prev) => ({ ...prev, [record.id]: true }))
    setError('')
    try {
      const punchOutAt = `${record.work_date}T${t}:00`
      await api(`/attendance/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ punchOutAt, notes: notes[record.id] || 'Backdated punch-out via next-day correction' }),
      })
      setDone((prev) => new Set([...prev, record.id]))
    } catch (e) {
      setError((e as Error).message || 'Failed to save')
    } finally {
      setSaving((prev) => ({ ...prev, [record.id]: false }))
    }
  }

  const remaining = records.filter((r) => !done.has(r.id))

  if (loading) return null
  if (records.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[#1f5e3b]/10 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-[#1f5e3b]">
              {isAdmin ? `Missed Punch-Outs (${records.length})` : 'You have a missed punch-out'}
            </h2>
            <p className="mt-0.5 text-xs text-[#1f5e3b]/60">
              {isAdmin
                ? 'These employees did not punch out. You can fix them here or dismiss.'
                : 'You forgot to punch out on a previous day. Please enter your punch-out time.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-0.5 rounded-lg p-1.5 text-[#1f5e3b]/50 hover:bg-[#1f5e3b]/5 hover:text-[#1f5e3b]"
            aria-label="Dismiss"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}
          {remaining.map((r) => (
            <div key={r.id} className="rounded-xl border border-[#1f5e3b]/10 bg-[#f5faf6] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  {isAdmin && (
                    <p className="font-semibold text-sm text-[#14261a]">
                      {r.full_name}
                      {r.login_id ? <span className="ml-1 text-xs text-[#1f5e3b]/55">({r.login_id})</span> : null}
                    </p>
                  )}
                  <p className="text-xs text-[#1f5e3b]/60">
                    Date: <strong>{r.work_date}</strong> · Punched in: <strong>{r.punch_in_at?.slice(11, 16) || '?'}</strong>
                  </p>
                </div>
                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">Open</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Punch-out time</label>
                  <input
                    type="time"
                    value={times[r.id] || ''}
                    onChange={(e) => setTimes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    className="w-full rounded-lg border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">Note (optional)</label>
                  <input
                    type="text"
                    value={notes[r.id] || ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    placeholder="Reason..."
                    className="w-full rounded-lg border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                  />
                </div>
              </div>
              <button
                type="button"
                disabled={saving[r.id]}
                onClick={() => void fixPunchout(r)}
                className="w-full rounded-lg bg-[#1f5e3b] py-2 text-xs font-semibold text-white transition hover:bg-[#17472d] disabled:opacity-60"
              >
                {saving[r.id] ? 'Saving…' : 'Save punch-out'}
              </button>
            </div>
          ))}
          {remaining.length === 0 && records.length > 0 && (
            <div className="py-4 text-center text-sm text-[#1f5e3b]">
              All corrected! You can close this window.
            </div>
          )}
        </div>

        <div className="border-t border-[#1f5e3b]/10 px-6 py-3 flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg border border-[#1f5e3b]/20 px-4 py-2 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5"
          >
            {remaining.length === 0 ? 'Close' : 'Dismiss for now'}
          </button>
        </div>
      </div>
    </div>
  )
}
