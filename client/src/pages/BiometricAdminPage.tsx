import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

type PendingRow = {
  id: number
  user_id: number
  requester_id: number
  kind: string
  notes: string | null
  created_at: string
  user_name: string
  user_email: string
  branch_id: number | null
  requester_name: string
}

type ProfilePendingRow = {
  id: number
  user_id: number
  requested_changes: Record<string, string>
  notes: string | null
  created_at: string
  user_name: string
  user_email: string
}

type FaceEnrollmentRow = {
  user_id: number
  full_name: string
  email: string | null
  login_id: string | null
  branch_id: number | null
  role: string | null
  descriptor_count: number | null
  has_embedding: boolean
  enrolled_at: string | null
}

type FaceEnrollmentSummary = {
  total: number
  basic: number
  standard: number
  enhanced: number
  legacy: number
}

function poseTier(count: number | null): {
  label: string
  badgeClass: string
  ringClass: string
  rank: number
} {
  if (count == null) {
    return { label: 'Legacy (no pose data)', badgeClass: 'bg-gray-200 text-gray-800', ringClass: 'ring-gray-300', rank: 0 }
  }
  if (count >= 4) {
    return { label: `${count} poses (enhanced)`, badgeClass: 'bg-blue-600 text-white', ringClass: 'ring-blue-300', rank: 4 }
  }
  if (count === 3) {
    return { label: '3 poses', badgeClass: 'bg-emerald-600 text-white', ringClass: 'ring-emerald-300', rank: 3 }
  }
  return {
    label: `${count} pose${count === 1 ? '' : 's'} (basic)`,
    badgeClass: 'bg-amber-500 text-white',
    ringClass: 'ring-amber-300',
    rank: count,
  }
}

const FIELD_LABELS: Record<string, string> = {
  full_name: 'Full Name',
  mobile: 'Mobile',
  dob: 'Date of Birth',
  address: 'Address',
  department: 'Department',
}

export function BiometricAdminPage() {
  const { user } = useAuth()
  const allowed = canPerm(user, 'biometric:admin')
  const [pending, setPending] = useState<PendingRow[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rejectId, setRejectId] = useState<number | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const [profilePending, setProfilePending] = useState<ProfilePendingRow[]>([])
  const [profileRejectId, setProfileRejectId] = useState<number | null>(null)
  const [profileRejectReason, setProfileRejectReason] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileMsg, setProfileMsg] = useState<string | null>(null)

  const [targetUserId, setTargetUserId] = useState('')
  const [adminFaceFile, setAdminFaceFile] = useState<File | null>(null)

  // ─── Face enrollment overview (basic vs enhanced) ─────────────────────────
  const [faceList, setFaceList] = useState<FaceEnrollmentRow[]>([])
  const [faceSummary, setFaceSummary] = useState<FaceEnrollmentSummary | null>(null)
  const [faceFilter, setFaceFilter] = useState<'all' | 'needs_upgrade'>('all')
  const [faceSort, setFaceSort] = useState<'pose_asc' | 'pose_desc' | 'name'>('pose_asc')
  const [faceLoading, setFaceLoading] = useState(false)
  const [faceErr, setFaceErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!allowed) return
    setMsg(null)
    try {
      const d = await api<{ requests: PendingRow[] }>('/biometric/requests/pending')
      setPending(d.requests || [])
    } catch (e) {
      setMsg((e as Error).message || 'Failed to load')
    }
  }, [allowed])

  const loadProfileReqs = useCallback(async () => {
    if (!allowed) return
    try {
      const d = await api<{ requests: ProfilePendingRow[] }>('/profile/update-requests/pending')
      setProfilePending(d.requests || [])
    } catch { /* silent */ }
  }, [allowed])

  const loadFaceEnrollments = useCallback(async () => {
    if (!allowed) return
    setFaceLoading(true)
    setFaceErr(null)
    try {
      const d = await api<{ users: FaceEnrollmentRow[]; summary: FaceEnrollmentSummary }>(
        '/biometric/admin/face-enrollments',
      )
      setFaceList(d.users || [])
      setFaceSummary(d.summary || null)
    } catch (e) {
      setFaceErr((e as Error).message || 'Failed to load face enrollments')
    } finally {
      setFaceLoading(false)
    }
  }, [allowed])

  useEffect(() => {
    void load()
    void loadProfileReqs()
    void loadFaceEnrollments()
  }, [load, loadProfileReqs, loadFaceEnrollments])

  // Sort + filter the face list for display.
  const visibleFaceList = (() => {
    const filtered =
      faceFilter === 'needs_upgrade'
        ? faceList.filter((r) => r.descriptor_count == null || r.descriptor_count < 4)
        : faceList
    const sorted = [...filtered]
    if (faceSort === 'name') {
      sorted.sort((a, b) => a.full_name.localeCompare(b.full_name))
    } else {
      const dir = faceSort === 'pose_asc' ? 1 : -1
      sorted.sort((a, b) => {
        const ar = poseTier(a.descriptor_count).rank
        const br = poseTier(b.descriptor_count).rank
        if (ar !== br) return (ar - br) * dir
        return a.full_name.localeCompare(b.full_name)
      })
    }
    return sorted
  })()

  async function approve(id: number) {
    setBusy(true)
    setMsg(null)
    try {
      await api(`/biometric/requests/${id}/approve`, { method: 'POST', body: '{}' })
      setMsg('Approved.')
      await load()
    } catch (e) {
      setMsg((e as Error).message || 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  async function reject(id: number) {
    setBusy(true)
    setMsg(null)
    try {
      await api(`/biometric/requests/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
      })
      setMsg('Rejected.')
      setRejectId(null)
      setRejectReason('')
      await load()
    } catch (e) {
      setMsg((e as Error).message || 'Reject failed')
    } finally {
      setBusy(false)
    }
  }

  async function approveProfile(id: number) {
    setProfileBusy(true); setProfileMsg(null)
    try {
      await api(`/profile/update-requests/${id}/approve`, { method: 'POST', body: '{}' })
      setProfileMsg('Profile update approved and applied.')
      await loadProfileReqs()
    } catch (e) {
      setProfileMsg((e as Error).message || 'Approve failed')
    } finally {
      setProfileBusy(false)
    }
  }

  async function rejectProfile(id: number) {
    setProfileBusy(true); setProfileMsg(null)
    try {
      await api(`/profile/update-requests/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: profileRejectReason.trim() || undefined }),
      })
      setProfileMsg('Profile update rejected.')
      setProfileRejectId(null)
      setProfileRejectReason('')
      await loadProfileReqs()
    } catch (e) {
      setProfileMsg((e as Error).message || 'Reject failed')
    } finally {
      setProfileBusy(false)
    }
  }

  async function adminEnrollFace() {
    const id = Number(targetUserId)
    if (!Number.isFinite(id) || id <= 0) {
      setMsg('Enter a valid user ID.')
      return
    }
    if (!adminFaceFile || adminFaceFile.size < 8192) {
      setMsg('Choose a clear photo (min ~8KB).')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const fd = new FormData()
      fd.append('photo', adminFaceFile, 'face.jpg')
      await api(`/users/${id}/face-enrollment`, { method: 'POST', body: fd })
      setMsg(`Face enrolled for user ${id}.`)
      setAdminFaceFile(null)
    } catch (e) {
      setMsg((e as Error).message || 'Enrollment failed')
    } finally {
      setBusy(false)
    }
  }

  async function resetFace() {
    const id = Number(targetUserId)
    if (!Number.isFinite(id) || id <= 0) {
      setMsg('Enter a valid user ID.')
      return
    }
    if (!window.confirm(`Clear face profile for user ${id}?`)) return
    setBusy(true)
    setMsg(null)
    try {
      await api(`/biometric/admin/users/${id}/reset-face`, { method: 'POST', body: '{}' })
      setMsg('Face profile cleared.')
    } catch (e) {
      setMsg((e as Error).message || 'Reset failed')
    } finally {
      setBusy(false)
    }
  }

  async function resetWebauthn() {
    const id = Number(targetUserId)
    if (!Number.isFinite(id) || id <= 0) {
      setMsg('Enter a valid user ID.')
      return
    }
    if (!window.confirm(`Remove ALL passkeys for user ${id}? They must register again on their device.`)) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api<{ ok: boolean; removed: number }>(`/biometric/admin/users/${id}/reset-webauthn`, {
        method: 'POST',
        body: '{}',
      })
      setMsg(`Removed ${r.removed} passkey(s).`)
    } catch (e) {
      setMsg((e as Error).message || 'Reset failed')
    } finally {
      setBusy(false)
    }
  }

  if (!allowed) {
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <p className="text-red-700">You do not have access to biometric administration.</p>
        <Link to="/" className="mt-4 inline-block font-semibold text-[#2e7d32] underline">
          Home
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1000px] space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Biometric requests</h1>
        <p className="mt-1 text-sm text-[#1f5e3b]/75">
          Approve or reject staff requests. Branch managers only see users in their branch.
        </p>
      </div>

      {msg && <p className="rounded-xl bg-white p-3 text-sm shadow ring-1 ring-[#1f5e3b]/10">{msg}</p>}

      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-[#1f5e3b]">Pending</h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-sm text-[#1f5e3b]/60">No pending requests.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {pending.map((r) => (
              <li key={r.id} className="rounded-xl border border-[#1f5e3b]/12 bg-white/80 p-4">
                <p className="text-sm font-semibold text-[#14261a]">
                  {r.user_name} <span className="font-normal text-[#1f5e3b]/70">(user #{r.user_id})</span>
                </p>
                <p className="text-xs text-[#1f5e3b]/70">
                  {r.user_email} · Kind: <span className="font-semibold capitalize">{r.kind}</span> · Requested{' '}
                  {new Date(r.created_at).toLocaleString()} · By {r.requester_name}
                </p>
                {r.notes ? <p className="mt-1 text-xs text-[#14261a]">Note: {r.notes}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => approve(r.id)}
                    className="rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Approve
                  </button>
                  {rejectId === r.id ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <input
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason (optional)"
                        className="rounded border border-[#1f5e3b]/20 px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => reject(r.id)}
                        className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Confirm reject
                      </button>
                      <button type="button" className="text-xs underline" onClick={() => setRejectId(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setRejectId(r.id)}
                      className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-800"
                    >
                      Reject
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={() => load()} className="mt-4 text-sm font-semibold text-[#2e7d32] underline">
          Refresh
        </button>
      </div>

      {/* ── Profile Update Requests ── */}
      <div className="ph-card rounded-2xl p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#1f5e3b]">Profile Update Requests</h2>
            <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Staff requests to change their profile data — approve to apply instantly.</p>
          </div>
          {profilePending.length > 0 && (
            <span className="rounded-full bg-amber-500 px-2.5 py-0.5 text-xs font-bold text-white">{profilePending.length}</span>
          )}
        </div>
        {profileMsg && <p className="mt-3 rounded-xl bg-white p-3 text-sm shadow ring-1 ring-[#1f5e3b]/10">{profileMsg}</p>}
        {profilePending.length === 0 ? (
          <p className="mt-3 text-sm text-[#1f5e3b]/60">No pending profile requests.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {profilePending.map((r) => (
              <li key={r.id} className="rounded-xl border border-[#1f5e3b]/12 bg-white/80 p-4">
                <p className="text-sm font-semibold text-[#14261a]">
                  {r.user_name} <span className="font-normal text-[#1f5e3b]/60">({r.user_email})</span>
                </p>
                <p className="text-xs text-[#1f5e3b]/50">{new Date(r.created_at).toLocaleString()}</p>
                <div className="mt-2 space-y-1 rounded-lg bg-[#f7fbf8] p-3">
                  {Object.entries(r.requested_changes).map(([k, v]) => (
                    <p key={k} className="text-xs">
                      <span className="font-semibold text-[#1f5e3b]">{FIELD_LABELS[k] ?? k}:</span>{' '}
                      <span className="text-[#14261a]">{v}</span>
                    </p>
                  ))}
                </div>
                {r.notes && <p className="mt-1 text-xs text-[#14261a]/70">Note: {r.notes}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={profileBusy} onClick={() => void approveProfile(r.id)}
                    className="rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                    Approve & Apply
                  </button>
                  {profileRejectId === r.id ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <input value={profileRejectReason} onChange={(e) => setProfileRejectReason(e.target.value)}
                        placeholder="Reason (optional)" className="rounded border border-[#1f5e3b]/20 px-2 py-1 text-xs" />
                      <button type="button" disabled={profileBusy} onClick={() => void rejectProfile(r.id)}
                        className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white">
                        Confirm Reject
                      </button>
                      <button type="button" className="text-xs underline" onClick={() => setProfileRejectId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" disabled={profileBusy} onClick={() => setProfileRejectId(r.id)}
                      className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-800">
                      Reject
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={() => void loadProfileReqs()} className="mt-4 text-sm font-semibold text-[#2e7d32] underline">
          Refresh
        </button>
      </div>

      {/* ── Face enrollment overview (basic vs enhanced) ── */}
      <div className="ph-card rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[#1f5e3b]">Face enrollment overview</h2>
            <p className="mt-0.5 text-xs text-[#1f5e3b]/65">
              Staff with only the basic 3 poses may struggle in tough lighting (overhead lights, caps).
              Ask them to re-enroll and add the optional 4th pose for "enhanced" matching.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadFaceEnrollments()}
            disabled={faceLoading}
            className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] disabled:opacity-50"
          >
            {faceLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {faceErr && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">{faceErr}</p>}

        {faceSummary && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg bg-blue-50 p-3 ring-1 ring-blue-200">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-700">Enhanced (4 poses)</p>
              <p className="mt-1 text-xl font-bold text-blue-900">{faceSummary.enhanced}</p>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3 ring-1 ring-emerald-200">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Standard (3 poses)</p>
              <p className="mt-1 text-xl font-bold text-emerald-900">{faceSummary.standard}</p>
            </div>
            <div className="rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Basic (1-2)</p>
              <p className="mt-1 text-xl font-bold text-amber-900">{faceSummary.basic}</p>
            </div>
            <div className="rounded-lg bg-gray-100 p-3 ring-1 ring-gray-300">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-700">Legacy (no data)</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{faceSummary.legacy}</p>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-[#1f5e3b]">
            <input
              type="checkbox"
              checked={faceFilter === 'needs_upgrade'}
              onChange={(e) => setFaceFilter(e.target.checked ? 'needs_upgrade' : 'all')}
            />
            Show only staff who could upgrade to 4 poses
          </label>
          <label className="flex items-center gap-1.5 text-[#1f5e3b]">
            Sort:
            <select
              value={faceSort}
              onChange={(e) => setFaceSort(e.target.value as typeof faceSort)}
              className="rounded border border-[#1f5e3b]/20 px-2 py-1 text-xs"
            >
              <option value="pose_asc">Fewest poses first</option>
              <option value="pose_desc">Most poses first</option>
              <option value="name">Name (A–Z)</option>
            </select>
          </label>
          <span className="ml-auto text-[#1f5e3b]/60">
            Showing {visibleFaceList.length}
            {faceSummary ? ` of ${faceSummary.total}` : ''}
          </span>
        </div>

        {visibleFaceList.length === 0 ? (
          <p className="mt-3 text-sm text-[#1f5e3b]/60">
            {faceLoading ? 'Loading…' : 'No staff to show.'}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[#1f5e3b]/10 rounded-xl bg-white/60 ring-1 ring-[#1f5e3b]/10">
            {visibleFaceList.map((r) => {
              const tier = poseTier(r.descriptor_count)
              return (
                <li key={r.user_id} className="flex flex-wrap items-center gap-3 p-3">
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${tier.badgeClass} ${tier.ringClass}`}
                  >
                    {tier.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[#14261a]">
                      {r.full_name}
                      <span className="ml-1 font-normal text-[#1f5e3b]/60">(user #{r.user_id})</span>
                    </p>
                    <p className="truncate text-[11px] text-[#1f5e3b]/65">
                      {r.email || r.login_id || '—'}
                      {r.role ? ` · ${r.role}` : ''}
                      {r.branch_id != null ? ` · branch #${r.branch_id}` : ''}
                      {r.enrolled_at ? ` · enrolled ${new Date(r.enrolled_at).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTargetUserId(String(r.user_id))}
                    className="shrink-0 rounded-lg border border-[#1f5e3b]/20 px-2 py-1 text-[11px] font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5"
                    title="Load this user ID into the actions panel below"
                  >
                    Manage
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-[#1f5e3b]">Direct admin actions</h2>
        <p className="mt-1 text-xs text-[#1f5e3b]/70">
          Enroll or reset identity data for an employee without going through the request flow. All actions are audit
          logged.
        </p>
        <label className="mt-4 block text-sm">
          <span className="font-medium text-[#1f5e3b]">User ID</span>
          <input
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
            className="mt-1 w-full max-w-xs rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
            placeholder="e.g. 42"
          />
        </label>
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-[#1f5e3b]">Enroll / replace face (photo file)</p>
            <input
              type="file"
              accept="image/*"
              className="mt-1 text-sm"
              onChange={(e) => setAdminFaceFile(e.target.files?.[0] || null)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => adminEnrollFace()}
              className="mt-2 rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Save face for user
            </button>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-[#1f5e3b]/10 pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => resetFace()}
              className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-950"
            >
              Clear face profile
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => resetWebauthn()}
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-900"
            >
              Remove all passkeys
            </button>
          </div>
        </div>
      </div>

      <p className="text-center text-sm">
        <Link to="/identity" className="font-semibold text-[#2e7d32] underline">
          Staff Identity page
        </Link>
      </p>
    </div>
  )
}
