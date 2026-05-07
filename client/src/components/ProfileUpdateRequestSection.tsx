import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

const EDITABLE_FIELDS = [
  { key: 'full_name', label: 'पूरा नाम', placeholder: 'जैसे: Ramesh Kumar' },
  { key: 'mobile', label: 'मोबाइल नंबर', placeholder: '10 अंक' },
  { key: 'dob', label: 'जन्म तिथि', placeholder: 'YYYY-MM-DD' },
  { key: 'address', label: 'पता', placeholder: 'पूरा पता' },
  { key: 'department', label: 'विभाग', placeholder: 'जैसे: Delivery' },
]

type MyRequest = {
  id: number
  requested_changes: Record<string, string>
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  notes: string | null
  reject_reason: string | null
  created_at: string
  resolved_at: string | null
}

export function ProfileUpdateRequestSection() {
  const [open, setOpen] = useState(false)
  const [myReqs, setMyReqs] = useState<MyRequest[]>([])
  const [fields, setFields] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const latestPending = myReqs.find((r) => r.status === 'pending') ?? null
  const latestRejected = myReqs.find((r) => r.status === 'rejected') ?? null

  const load = useCallback(async () => {
    try {
      const d = await api<{ requests: MyRequest[] }>('/profile/update-requests/mine')
      setMyReqs(d.requests || [])
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function toggleField(key: string, val: string) {
    setFields((prev) => {
      const next = { ...prev }
      if (val.trim()) next[key] = val.trim(); else delete next[key]
      return next
    })
  }

  async function submit() {
    if (Object.keys(fields).length === 0) {
      setMsg('कोई field नहीं भरा।')
      return
    }
    setBusy(true); setMsg(null)
    try {
      await api('/profile/update-request', {
        method: 'POST',
        body: JSON.stringify({ changes: fields, notes: notes.trim() || undefined }),
      })
      setMsg('✅ Request भेज दी गई। Admin की approval के बाद changes apply होंगे।')
      setFields({}); setNotes(''); setOpen(false)
      await load()
    } catch (e) {
      setMsg((e as Error).message || 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  async function cancel(id: number) {
    setBusy(true)
    try {
      await api(`/profile/update-requests/${id}/cancel`, { method: 'POST', body: '{}' })
      await load()
    } catch (e) {
      setMsg((e as Error).message || 'Cancel failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      {/* Pending notice */}
      {latestPending && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 flex items-center justify-between gap-2">
          <span>⏳ Profile update request pending — Admin approval का wait करें।</span>
          <button type="button" disabled={busy}
            onClick={() => void cancel(latestPending.id)}
            className="shrink-0 rounded px-2 py-0.5 text-[10px] font-bold text-amber-800 border border-amber-300 hover:bg-amber-100">
            रद्द करें
          </button>
        </div>
      )}

      {/* Rejected notice */}
      {!latestPending && latestRejected && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800">
          ❌ पिछली request reject हुई।
          {latestRejected.reject_reason && (
            <span className="ml-1 font-semibold">कारण: {latestRejected.reject_reason}</span>
          )}
        </div>
      )}

      {/* Submit button */}
      {!latestPending && (
        <button type="button"
          onClick={() => { setOpen((p) => !p); setMsg(null) }}
          className="mt-2 w-full rounded-xl border border-[#1f5e3b]/20 py-2 text-xs font-semibold text-[#1f5e3b]/70 hover:bg-[#1f5e3b]/5 active:scale-95 transition-transform">
          👤 Profile Update Request करें
        </button>
      )}

      {msg && (
        <p className={`mt-2 text-xs text-center ${msg.startsWith('✅') ? 'text-emerald-700' : 'text-red-600'}`}>{msg}</p>
      )}

      {/* Expandable form */}
      {open && !latestPending && (
        <div className="mt-3 rounded-xl border border-[#1f5e3b]/12 bg-[#f7fbf8] p-4 space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#1f5e3b]/50">
            जो fields बदलनी हों वही भरें — बाकी खाली छोड़ें
          </p>
          {EDITABLE_FIELDS.map(({ key, label, placeholder }) => (
            <label key={key} className="block">
              <span className="text-[11px] font-semibold text-[#1f5e3b]">{label}</span>
              <input
                value={fields[key] ?? ''}
                onChange={(e) => toggleField(key, e.target.value)}
                placeholder={placeholder}
                className="mt-1 w-full rounded-lg border border-[#1f5e3b]/15 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/25"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-[11px] font-semibold text-[#1f5e3b]">Note (optional)</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="बदलाव का कारण"
              className="mt-1 w-full rounded-lg border border-[#1f5e3b]/15 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/25"
            />
          </label>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void submit()}
              className="flex-1 rounded-xl bg-[#1f5e3b] py-2.5 text-sm font-bold text-white shadow disabled:opacity-50 active:scale-95 transition-transform">
              {busy ? 'भेज रहे हैं...' : '📤 Request भेजें'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setMsg(null) }}
              className="rounded-xl border border-[#1f5e3b]/20 px-4 py-2.5 text-sm font-semibold text-[#1f5e3b]/60 hover:bg-[#1f5e3b]/5">
              रद्द
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
