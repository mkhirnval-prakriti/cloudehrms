import { useCallback, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { PageSkeleton } from '../components/PageSkeleton'

type DocStatus = 'pending' | 'approved' | 'rejected'

type DocRow = {
  id: number
  user_id: number
  doc_type: string
  file_name: string
  file_path: string
  verified: number
  doc_status?: DocStatus
  verifier_notes?: string | null
  verified_at?: string | null
  created_at?: string | null
  user_name?: string
  user_email?: string
}

type FileEntry = {
  file: File
  id: string
  error?: string
}

type UploadState = Record<string, 'idle' | 'uploading' | 'done' | 'error'>

const MAX_MB = 5
const MAX_BYTES = MAX_MB * 1024 * 1024
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp'
const ACCEPT_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']

const DOC_TYPES: { value: string; label: string }[] = [
  { value: 'profile_photo',  label: 'Profile Photo' },
  { value: 'aadhaar_front',  label: 'Aadhaar Card — Front' },
  { value: 'aadhaar_back',   label: 'Aadhaar Card — Back' },
  { value: 'pan',            label: 'PAN Card' },
  { value: 'bank_passbook',  label: 'Bank Passbook / Cancelled Cheque' },
  { value: 'other',          label: 'Other' },
]

function docTypeLabel(t: string): string {
  const found = DOC_TYPES.find((d) => d.value === t)
  if (found) return found.label
  if (t === 'aadhaar') return 'Aadhaar Card'
  if (t === 'bank') return 'Bank Passbook'
  if (t === 'contract') return 'Contract'
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const docsKey = ['documents', 'list'] as const

function makeId() { return Math.random().toString(36).slice(2) }
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
function formatDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })
}
function isPdf(name: string) { return /\.pdf$/i.test(name) }
function isImage(name: string) { return /\.(jpe?g|png|webp|gif)$/i.test(name) }
function validateFile(f: File): string | undefined {
  if (!ACCEPT_MIME.includes(f.type) && !f.name.match(/\.(pdf|jpg|jpeg|png|webp)$/i)) {
    return 'Invalid file format. Only PDF, JPG, PNG accepted.'
  }
  if (f.size > MAX_BYTES) return `File too large (${formatSize(f.size)}). Max ${MAX_MB}MB per file.`
}

type TrashRow = DocRow & { deleted_at?: string | null; deleted_by_name?: string | null }

type StaffGroup = {
  user_id: number
  user_name: string
  total: number
  approved: number
  pending: number
  rejected: number
  docs: DocRow[]
  status: 'verified' | 'pending' | 'rejected' | 'empty'
}

function statusOf(d: DocRow): DocStatus {
  return d.doc_status || (Number(d.verified) === 1 ? 'approved' : 'pending')
}

function groupByStaff(docs: DocRow[]): StaffGroup[] {
  const map = new Map<number, StaffGroup>()
  for (const d of docs) {
    const uid = d.user_id
    if (!map.has(uid)) {
      map.set(uid, { user_id: uid, user_name: d.user_name || `User #${uid}`, total: 0, approved: 0, pending: 0, rejected: 0, docs: [], status: 'empty' })
    }
    const g = map.get(uid)!
    g.docs.push(d)
    g.total++
    const st = statusOf(d)
    if (st === 'approved') g.approved++
    else if (st === 'rejected') g.rejected++
    else g.pending++
  }
  for (const g of map.values()) {
    if (g.total === 0) g.status = 'empty'
    else if (g.rejected > 0) g.status = 'rejected'
    else if (g.pending > 0) g.status = 'pending'
    else g.status = 'verified'
  }
  return Array.from(map.values()).sort((a, b) => {
    // pending first, then rejected, then verified
    const order = { pending: 0, rejected: 1, verified: 2, empty: 3 }
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
    return a.user_name.localeCompare(b.user_name)
  })
}

export function DocumentsPage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [docType, setDocType] = useState('profile_photo')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [uploadState, setUploadState] = useState<UploadState>({})
  const [dragOver, setDragOver] = useState(false)
  const [batchDone, setBatchDone] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<DocRow | null>(null)

  // Admin view state
  const [staffSearch, setStaffSearch] = useState('')
  const [staffFilter, setStaffFilter] = useState<'all' | 'verified' | 'pending' | 'rejected'>('all')
  const [selectedStaffId, setSelectedStaffId] = useState<number | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [showTrash, setShowTrash] = useState(false)

  // Staff (own) view state
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | DocStatus>('all')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadFormRef = useRef<HTMLFormElement>(null)

  const canVerify = canPerm(user, 'documents:verify')
  const canAll = canPerm(user, 'documents:read_all')

  const listQ = useQuery({
    queryKey: docsKey,
    queryFn: async () => {
      const d = await api<{ documents: DocRow[] }>('/documents')
      return d.documents || []
    },
    retry: 2,
    staleTime: 30_000,
  })

  const trashQ = useQuery({
    queryKey: ['documents', 'trash'],
    queryFn: async () => {
      const d = await api<{ documents: TrashRow[] }>('/documents/trash')
      return d.documents || []
    },
    enabled: canVerify && showTrash,
    staleTime: 15_000,
  })

  const deleteMut = useMutation({
    mutationFn: async (id: number) => { await api(`/documents/${id}`, { method: 'DELETE' }) },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: docsKey })
      qc.invalidateQueries({ queryKey: ['documents', 'trash'] })
    },
  })

  const restoreMut = useMutation({
    mutationFn: async (id: number) => { await api(`/documents/${id}/restore`, { method: 'POST', body: '{}' }) },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: docsKey })
      qc.invalidateQueries({ queryKey: ['documents', 'trash'] })
    },
  })

  const purgeMut = useMutation({
    mutationFn: async (id: number) => { await api(`/documents/${id}/permanent`, { method: 'DELETE' }) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents', 'trash'] }),
  })

  const verifyMut = useMutation({
    mutationFn: async ({ id, status, notes }: { id: number; status: DocStatus; notes?: string }) => {
      await api(`/documents/${id}/verify`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          verifier_notes:
            status === 'approved' ? (notes || 'Approved') :
            status === 'rejected' ? (notes || '') :
            (notes || 'Re-upload requested'),
        }),
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: docsKey }),
  })

  function addFiles(incoming: File[]) {
    const entries: FileEntry[] = incoming.map((f) => ({ file: f, id: makeId(), error: validateFile(f) }))
    setFiles((prev) => {
      const existingNames = new Set(prev.map((e) => e.file.name + e.file.size))
      return [...prev, ...entries.filter((e) => !existingNames.has(e.file.name + e.file.size))]
    })
    setBatchDone(false)
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((e) => e.id !== id))
    setUploadState((prev) => { const s = { ...prev }; delete s[id]; return s })
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    addFiles(Array.from(e.dataTransfer.files))
  }, [])
  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true) }, [])
  const onDragLeave = useCallback(() => setDragOver(false), [])

  async function uploadAll(e: React.FormEvent) {
    e.preventDefault()
    const valid = files.filter((f) => !f.error)
    if (!valid.length) return
    setBatchDone(false)
    const newState: UploadState = {}
    valid.forEach((f) => { newState[f.id] = 'uploading' })
    setUploadState((prev) => ({ ...prev, ...newState }))

    await Promise.all(valid.map(async (entry) => {
      try {
        const fd = new FormData()
        fd.append('file', entry.file)
        fd.append('doc_type', docType)
        await api('/documents', { method: 'POST', body: fd })
        setUploadState((prev) => ({ ...prev, [entry.id]: 'done' }))
      } catch {
        setUploadState((prev) => ({ ...prev, [entry.id]: 'error' }))
      }
    }))

    await qc.invalidateQueries({ queryKey: docsKey })
    setBatchDone(true)
    setFiles((prev) => prev.filter((f) => uploadState[f.id] === 'error'))
  }

  function startReupload(d: DocRow) {
    setDocType(d.doc_type)
    uploadFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setTimeout(() => fileInputRef.current?.click(), 350)
  }

  function adminDelete(d: DocRow) {
    if (!window.confirm(`Move "${docTypeLabel(d.doc_type)}" to Trash?\n\nIt will not be visible to staff but can be restored from the Trash within 30 days.`)) return
    deleteMut.mutate(d.id)
  }
  function ownerDelete(d: DocRow) {
    if (!window.confirm(`Delete "${docTypeLabel(d.doc_type)}"?\n\nThe file will be moved to Trash. Admin can restore it if needed.`)) return
    deleteMut.mutate(d.id)
  }

  function adminReject(d: DocRow) {
    const reason = window.prompt(
      `Why is this ${docTypeLabel(d.doc_type)} being rejected?\n(Reason is required and will be shown to the staff member)`,
      ''
    )
    if (reason == null) return
    const trimmed = reason.trim()
    if (!trimmed) { alert('Rejection reason is required.'); return }
    verifyMut.mutate({ id: d.id, status: 'rejected', notes: trimmed })
  }

  const allValid = files.filter((f) => !f.error)
  const anyUploading = Object.values(uploadState).some((s) => s === 'uploading')
  const allDocs = listQ.data ?? []

  // ── Hooks MUST be called unconditionally (Rules of Hooks) ────────────────
  // Compute both admin and staff views' memos at the top, regardless of branch.
  const groups = useMemo(() => groupByStaff(allDocs), [allDocs])
  const filteredGroups = useMemo(() => {
    const q = staffSearch.trim().toLowerCase()
    return groups.filter((g) => {
      if (staffFilter === 'verified' && g.status !== 'verified') return false
      if (staffFilter === 'pending'  && g.status !== 'pending')  return false
      if (staffFilter === 'rejected' && g.status !== 'rejected') return false
      if (!q) return true
      return g.user_name.toLowerCase().includes(q) || String(g.user_id).includes(q)
    })
  }, [groups, staffSearch, staffFilter])
  const groupCounts = useMemo(() => ({
    all: groups.length,
    verified: groups.filter((g) => g.status === 'verified').length,
    pending:  groups.filter((g) => g.status === 'pending').length,
    rejected: groups.filter((g) => g.status === 'rejected').length,
  }), [groups])
  const ownDocs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allDocs.filter((d) => {
      if (statusFilter !== 'all' && statusOf(d) !== statusFilter) return false
      if (!q) return true
      return `${d.doc_type} ${d.file_name}`.toLowerCase().includes(q)
    })
  }, [allDocs, search, statusFilter])
  const ownCounts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 }
    for (const d of allDocs) c[statusOf(d)]++
    return c
  }, [allDocs])

  // ── ADMIN: Staff-grouped view ─────────────────────────────────────────────
  if (canVerify) {
    const counts = groupCounts
    const selectedGroup = selectedStaffId != null ? groups.find((g) => g.user_id === selectedStaffId) : null

    return (
      <div className="mx-auto max-w-[1100px] space-y-6 pb-8">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-[#1f5e3b]">📋 Document Verification</h1>
              <p className="text-sm text-[#1f5e3b]/65">Review, approve, and reject employee KYC documents — grouped by staff.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowTrash(true)}
              className="rounded-lg border border-[#1f5e3b]/20 bg-white px-3 py-2 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5"
              title="View deleted documents"
            >
              🗑 Trash / Restore
            </button>
          </div>
          {/* Diagnostic counters — verifies grouping math (totals must equal sum of per-staff counts) */}
          {!listQ.isLoading && !listQ.error && (
            <p className="mt-2 text-[11px] text-[#1f5e3b]/55">
              📊 Diagnostic: <strong>{allDocs.length}</strong> total docs across <strong>{groups.length}</strong> staff
              {' '}({groupCounts.verified} fully verified · {groupCounts.pending} pending · {groupCounts.rejected} has rejected)
              {' · '}showing <strong>{filteredGroups.length}</strong> after filter
            </p>
          )}
        </div>

        {listQ.error && (
          <div className="rounded-xl border border-red-200 bg-red-50/80 p-4 text-sm text-red-800">
            <p className="font-medium">Failed to load documents</p>
            <p className="mt-1">{(listQ.error as Error).message}</p>
            <button type="button" onClick={() => listQ.refetch()} className="mt-3 rounded-lg bg-[#1f5e3b] px-4 py-2 text-xs font-semibold text-white">Retry</button>
          </div>
        )}
        {listQ.isLoading && <PageSkeleton rows={6} />}

        {!listQ.isLoading && !listQ.error && (
          <>
            {/* Search + Filter */}
            <div className="ph-card rounded-2xl p-4">
              <div className="flex flex-wrap gap-3">
                <input
                  type="search"
                  value={staffSearch}
                  onChange={(e) => setStaffSearch(e.target.value)}
                  placeholder="🔍 Search staff by name or ID…"
                  className="min-w-[240px] flex-1 rounded-xl border border-[#1f5e3b]/15 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20"
                />
                <button type="button" onClick={() => listQ.refetch()} className="rounded-lg border border-[#1f5e3b]/20 px-3 py-2 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5">🔄 Refresh</button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {([
                  { v: 'all',      label: `All Staff (${counts.all})`,         cls: 'border-[#1f5e3b]/20 text-[#1f5e3b]' },
                  { v: 'pending',  label: `⏳ Pending (${counts.pending})`,    cls: 'border-amber-300 text-amber-800' },
                  { v: 'rejected', label: `❌ Has Rejected (${counts.rejected})`, cls: 'border-red-300 text-red-700' },
                  { v: 'verified', label: `✅ All Verified (${counts.verified})`, cls: 'border-emerald-300 text-emerald-800' },
                ] as const).map((f) => (
                  <button
                    key={f.v}
                    type="button"
                    onClick={() => setStaffFilter(f.v)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                      staffFilter === f.v ? 'bg-[#1f5e3b] text-white border-[#1f5e3b]' : `bg-white ${f.cls} hover:bg-gray-50`
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Staff Cards Grid */}
            {filteredGroups.length === 0 ? (
              <div className="ph-card rounded-2xl p-10 text-center text-sm text-[#1f5e3b]/55">
                {staffSearch || staffFilter !== 'all'
                  ? 'No staff match the current filter.'
                  : 'No documents have been submitted yet.'}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredGroups.map((g) => {
                  const badge =
                    g.status === 'verified' ? 'bg-emerald-100 text-emerald-700' :
                    g.status === 'rejected' ? 'bg-red-100 text-red-700' :
                                              'bg-amber-100 text-amber-700'
                  const badgeLabel =
                    g.status === 'verified' ? '✅ All Verified' :
                    g.status === 'rejected' ? `❌ ${g.rejected} Rejected` :
                                              `⏳ ${g.pending} Pending`
                  return (
                    <button
                      key={g.user_id}
                      type="button"
                      onClick={() => { setSelectedStaffId(g.user_id); setZoomLevel(1) }}
                      className="ph-card group flex items-start gap-3 rounded-2xl p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
                    >
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#1f5e3b]/10 text-lg font-bold text-[#1f5e3b]">
                        {g.user_name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[#14261a]">{g.user_name}</p>
                        <p className="text-[11px] text-[#1f5e3b]/55">ID #{g.user_id}</p>
                        <span className={`mt-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${badge}`}>{badgeLabel}</span>
                        <p className="mt-1.5 text-[11px] text-[#1f5e3b]/65">
                          📄 {g.total} document{g.total === 1 ? '' : 's'}
                          {g.approved > 0 && <span className="text-emerald-700"> · {g.approved} ✓</span>}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* Staff Documents Modal */}
        {selectedGroup && (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-2 sm:p-4" onClick={(e) => e.target === e.currentTarget && setSelectedStaffId(null)}>
            <div className="my-4 w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
              {/* Header */}
              <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-[#1f5e3b]/10 bg-white px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1f5e3b]/10 text-base font-bold text-[#1f5e3b]">
                    {selectedGroup.user_name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <p className="font-semibold text-[#14261a]">{selectedGroup.user_name}</p>
                    <p className="text-[11px] text-[#1f5e3b]/55">
                      ID #{selectedGroup.user_id} · {selectedGroup.total} document{selectedGroup.total === 1 ? '' : 's'} · {selectedGroup.approved} ✓ {selectedGroup.pending} ⏳ {selectedGroup.rejected} ❌
                    </p>
                  </div>
                </div>
                <button type="button" onClick={() => setSelectedStaffId(null)} className="rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#14261a]">Close ✕</button>
              </div>

              {/* Status banner */}
              {selectedGroup.status === 'verified' && (
                <div className="border-b border-emerald-100 bg-emerald-50 px-5 py-3 text-xs font-semibold text-emerald-800">
                  ✅ All documents verified for this staff member.
                </div>
              )}
              {selectedGroup.status === 'pending' && (
                <div className="border-b border-amber-100 bg-amber-50 px-5 py-3 text-xs font-semibold text-amber-800">
                  ⚠ {selectedGroup.pending} document{selectedGroup.pending === 1 ? ' is' : 's are'} pending your review.
                </div>
              )}
              {selectedGroup.status === 'rejected' && (
                <div className="border-b border-red-100 bg-red-50 px-5 py-3 text-xs font-semibold text-red-800">
                  ❌ {selectedGroup.rejected} document{selectedGroup.rejected === 1 ? ' was' : 's were'} rejected. Staff has been asked to re-upload.
                </div>
              )}

              {/* Document list */}
              <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
                {selectedGroup.docs.map((d) => {
                  const st = statusOf(d)
                  const sBadge =
                    st === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                    st === 'rejected' ? 'bg-red-100 text-red-700' :
                                        'bg-amber-100 text-amber-700'
                  const sLabel =
                    st === 'approved' ? '✅ Verified' :
                    st === 'rejected' ? '❌ Rejected' : '⏳ Pending'

                  return (
                    <div key={d.id} className="flex flex-wrap gap-3 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-3">
                      <button
                        type="button"
                        onClick={() => setPreviewDoc(d)}
                        className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#1f5e3b]/15 bg-white hover:border-[#1f5e3b]/40"
                      >
                        {isImage(d.file_name) ? (
                          <img src={d.file_path} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : isPdf(d.file_name) ? (
                          <span className="text-2xl">📕</span>
                        ) : (
                          <span className="text-2xl">📄</span>
                        )}
                      </button>

                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-semibold text-[#14261a]">{docTypeLabel(d.doc_type)}</p>
                        <p className="truncate text-xs text-[#1f5e3b]/60">{d.file_name}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold ${sBadge}`}>{sLabel}</span>
                          <span className="text-[11px] text-[#14261a]/55">Updated: {formatDate(d.verified_at || d.created_at)}</span>
                        </div>
                        {st === 'rejected' && d.verifier_notes && (
                          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                            <strong>Reason:</strong> {d.verifier_notes}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <button type="button" onClick={() => setPreviewDoc(d)} className="rounded-lg border border-[#1f5e3b]/20 px-2.5 py-1 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5">👁 View</button>
                          <a href={d.file_path} download={d.file_name} className="rounded-lg border border-[#1f5e3b]/20 px-2.5 py-1 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5">⬇ Download</a>
                          {st !== 'approved' && (
                            <button type="button" onClick={() => verifyMut.mutate({ id: d.id, status: 'approved' })} disabled={verifyMut.isPending} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">✅ Verify</button>
                          )}
                          {st !== 'rejected' && (
                            <button type="button" onClick={() => adminReject(d)} disabled={verifyMut.isPending} className="rounded-lg border border-red-300 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">❌ Reject</button>
                          )}
                          {st !== 'pending' && (
                            <button type="button" onClick={() => verifyMut.mutate({ id: d.id, status: 'pending', notes: 'Re-upload requested' })} disabled={verifyMut.isPending} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50">🔄 Re-upload</button>
                          )}
                          <button
                            type="button"
                            onClick={() => adminDelete(d)}
                            disabled={deleteMut.isPending}
                            className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                            title="Move to Trash"
                          >
                            🗑 Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {selectedGroup.docs.length === 0 && (
                  <p className="py-6 text-center text-sm text-[#1f5e3b]/50">No documents uploaded yet.</p>
                )}
                {verifyMut.error && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{(verifyMut.error as Error).message}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Preview Modal */}
        {previewDoc && <PreviewModal doc={previewDoc} zoom={zoomLevel} setZoom={setZoomLevel} onClose={() => setPreviewDoc(null)} />}

        {/* Trash Modal */}
        {showTrash && (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-2 sm:p-4" onClick={(e) => e.target === e.currentTarget && setShowTrash(false)}>
            <div className="my-4 w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
              <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-[#1f5e3b]/10 bg-white px-5 py-4">
                <div>
                  <p className="font-semibold text-[#14261a]">🗑 Document Trash</p>
                  <p className="text-[11px] text-[#1f5e3b]/55">Deleted documents — restore them or permanently remove (Super Admin only).</p>
                </div>
                <button type="button" onClick={() => setShowTrash(false)} className="rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#14261a]">Close ✕</button>
              </div>
              <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
                {trashQ.isLoading && <PageSkeleton rows={4} />}
                {trashQ.error && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{(trashQ.error as Error).message}</p>
                )}
                {!trashQ.isLoading && (trashQ.data ?? []).length === 0 && (
                  <p className="py-8 text-center text-sm text-[#1f5e3b]/55">Trash is empty. Deleted documents appear here.</p>
                )}
                {(trashQ.data ?? []).map((d) => (
                  <div key={d.id} className="flex flex-wrap gap-3 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-3">
                    <button
                      type="button"
                      onClick={() => setPreviewDoc(d)}
                      className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#1f5e3b]/15 bg-white hover:border-[#1f5e3b]/40"
                    >
                      {isImage(d.file_name) ? (
                        <img src={d.file_path} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : isPdf(d.file_name) ? <span className="text-2xl">📕</span> : <span className="text-2xl">📄</span>}
                    </button>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-semibold text-[#14261a]">{docTypeLabel(d.doc_type)}</p>
                      <p className="truncate text-xs text-[#1f5e3b]/60">{d.file_name}</p>
                      <p className="text-[11px] text-[#1f5e3b]/75">👤 {d.user_name || `User #${d.user_id}`}</p>
                      <p className="text-[11px] text-red-700">
                        Deleted {formatDate(d.deleted_at)}
                        {d.deleted_by_name ? ` by ${d.deleted_by_name}` : ''}
                      </p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => restoreMut.mutate(d.id)}
                          disabled={restoreMut.isPending}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          ♻ Restore
                        </button>
                        {user?.role === 'SUPER_ADMIN' && (
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(`Permanently delete "${docTypeLabel(d.doc_type)}"?\n\nThis cannot be undone — the file will be removed from disk.`)) {
                                purgeMut.mutate(d.id)
                              }
                            }}
                            disabled={purgeMut.isPending}
                            className="rounded-lg border border-red-300 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            🗑 Delete Forever
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {(restoreMut.error || purgeMut.error) && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                    {((restoreMut.error || purgeMut.error) as Error).message}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── STAFF: Own documents view ─────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-[900px] space-y-6 pb-8">
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">📁 My KYC Documents</h1>
        <p className="text-sm text-[#1f5e3b]/65">Upload your KYC documents and track their verification status.</p>
      </div>

      <form ref={uploadFormRef} onSubmit={uploadAll} className="ph-card space-y-5 rounded-2xl p-6">
        <div>
          <h2 className="text-lg font-semibold text-[#1f5e3b]">📤 Upload Document</h2>
          <p className="text-xs text-[#1f5e3b]/60">
            Profile Photo, Aadhaar (Front & Back separately), PAN, Bank Passbook.
            Max <strong>{MAX_MB} MB</strong> per file. Accepted: PDF, JPG, PNG.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-[#14261a]">Document Type</label>
          <select value={docType} onChange={(e) => setDocType(e.target.value)} className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm">
            {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
            dragOver ? 'border-[#1f5e3b] bg-[#e8f5e9]' : 'border-[#1f5e3b]/30 bg-[#f7fbf8] hover:border-[#1f5e3b]/60 hover:bg-[#eef7f1]'
          }`}
        >
          <span className="text-3xl">📂</span>
          <p className="text-sm font-semibold text-[#1f5e3b]">Drag & drop files here</p>
          <p className="text-xs text-[#1f5e3b]/50">or click to browse</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(Array.from(e.target.files))
              e.target.value = ''
            }}
          />
        </div>

        {files.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/60">Selected files ({files.length})</p>
            {files.map((entry) => {
              const state = uploadState[entry.id] ?? 'idle'
              const icon = state === 'done' ? '✅' : state === 'error' ? '❌' : state === 'uploading' ? '⏳' : entry.error ? '⚠️' : '📄'
              return (
                <div
                  key={entry.id}
                  className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
                    entry.error ? 'border-red-200 bg-red-50' :
                    state === 'done' ? 'border-emerald-200 bg-emerald-50' :
                    state === 'error' ? 'border-red-200 bg-red-50' :
                    'border-[#1f5e3b]/10 bg-white'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-medium text-[#14261a]">
                      <span>{icon}</span>
                      <span className="truncate">{entry.file.name}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-[#14261a]/50">{formatSize(entry.file.size)}</p>
                    {entry.error && <p className="mt-1 text-xs text-red-700">{entry.error}</p>}
                    {state === 'done' && <p className="mt-1 text-xs font-medium text-emerald-700">Uploaded</p>}
                    {state === 'error' && !entry.error && <p className="mt-1 text-xs text-red-700">Upload failed — try again</p>}
                  </div>
                  {state === 'idle' && (
                    <button type="button" onClick={(ev) => { ev.stopPropagation(); removeFile(entry.id) }} className="shrink-0 text-[#1f5e3b]/40 hover:text-red-500" title="Remove">✕</button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {batchDone && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">✅ Submitted for verification. HR will review your documents shortly.</p>}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={anyUploading || allValid.length === 0} className="rounded-xl bg-[#1f5e3b] px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {anyUploading ? `Uploading… (${allValid.length})` : `Submit for Verification (${allValid.length})`}
          </button>
          {files.length > 0 && !anyUploading && (
            <button type="button" onClick={() => { setFiles([]); setUploadState({}); setBatchDone(false) }} className="text-xs text-[#1f5e3b]/50 underline hover:text-red-500">Clear all</button>
          )}
        </div>
      </form>

      {/* Own document list */}
      <div className="ph-card rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-[#1f5e3b]">My Uploaded Documents</h2>
          <button type="button" onClick={() => listQ.refetch()} className="text-sm text-[#1f5e3b] underline">Refresh</button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {([
            { v: 'all',      label: `All (${allDocs.length})`,             cls: 'border-[#1f5e3b]/20 text-[#1f5e3b]' },
            { v: 'pending',  label: `⏳ Pending (${ownCounts.pending})`,    cls: 'border-amber-300 text-amber-800' },
            { v: 'approved', label: `✅ Verified (${ownCounts.approved})`,  cls: 'border-emerald-300 text-emerald-800' },
            { v: 'rejected', label: `❌ Rejected (${ownCounts.rejected})`,  cls: 'border-red-300 text-red-700' },
          ] as const).map((f) => (
            <button key={f.v} type="button" onClick={() => setStatusFilter(f.v)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                statusFilter === f.v ? 'bg-[#1f5e3b] text-white border-[#1f5e3b]' : `bg-white ${f.cls} hover:bg-gray-50`
              }`}>
              {f.label}
            </button>
          ))}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search type / file name…" className="ml-auto rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-xs" />
        </div>

        {listQ.error && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50/80 p-4 text-sm text-red-800">
            <p className="font-medium">Failed to load documents</p>
            <p className="mt-1">{(listQ.error as Error).message}</p>
            <button type="button" onClick={() => listQ.refetch()} className="mt-3 rounded-lg bg-[#1f5e3b] px-4 py-2 text-xs font-semibold text-white">Retry</button>
          </div>
        )}
        {listQ.isLoading && <PageSkeleton rows={5} />}

        {!listQ.isLoading && !listQ.error && (
          <div className="mt-4 space-y-3">
            {ownDocs.map((d) => {
              const st = statusOf(d)
              const badge = st === 'approved' ? 'bg-emerald-100 text-emerald-700' : st === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
              const badgeLabel = st === 'approved' ? '✅ Verified' : st === 'rejected' ? '❌ Rejected' : '⏳ Pending'
              return (
                <div key={d.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[#1f5e3b]/10 bg-white/90 p-4 text-sm">
                  <button type="button" onClick={() => setPreviewDoc(d)} className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#1f5e3b]/15 bg-[#f7fbf8] hover:border-[#1f5e3b]/40">
                    {isImage(d.file_name) ? <img src={d.file_path} alt="" className="h-full w-full object-cover" loading="lazy" /> : isPdf(d.file_name) ? <span className="text-xl">📕</span> : <span className="text-xl">📄</span>}
                  </button>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-semibold text-[#14261a]">{docTypeLabel(d.doc_type)}</p>
                    <p className="truncate text-xs text-[#1f5e3b]/60">{d.file_name}</p>
                    {canAll && d.user_name && <p className="text-xs text-[#1f5e3b]/75">👤 {d.user_name} · ID #{d.user_id}</p>}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold ${badge}`}>{badgeLabel}</span>
                      <span className="text-[11px] text-[#14261a]/55">Updated: {formatDate(d.verified_at || d.created_at)}</span>
                    </div>
                    {st === 'rejected' && d.verifier_notes && (
                      <div className="mt-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                        <strong>Reason:</strong> {d.verifier_notes}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3 pt-1">
                      <button type="button" onClick={() => setPreviewDoc(d)} className="text-xs font-semibold text-[#2e7d32] underline">👁 View</button>
                      <a href={d.file_path} download={d.file_name} className="text-xs font-semibold text-[#1f5e3b] underline">⬇ Download</a>
                      {st === 'rejected' && (
                        <button type="button" onClick={() => startReupload(d)} className="rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600">🔄 Re-upload</button>
                      )}
                      {st === 'pending' && (
                        <button type="button" onClick={() => ownerDelete(d)} disabled={deleteMut.isPending} className="text-xs font-semibold text-red-600 underline disabled:opacity-50">🗑 Delete</button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {ownDocs.length === 0 && (
              <p className="py-6 text-center text-sm text-[#1f5e3b]/50">
                {search.trim() || statusFilter !== 'all' ? 'No documents match your filter.' : 'No documents yet — upload above.'}
              </p>
            )}
          </div>
        )}
      </div>

      {previewDoc && <PreviewModal doc={previewDoc} zoom={zoomLevel} setZoom={setZoomLevel} onClose={() => setPreviewDoc(null)} />}
    </div>
  )
}

// ── Preview Modal with zoom ─────────────────────────────────────────────────
function PreviewModal({ doc, zoom, setZoom, onClose }: { doc: DocRow; zoom: number; setZoom: (n: number) => void; onClose: () => void }) {
  const imgMode = isImage(doc.file_name)
  const pdfMode = isPdf(doc.file_name)
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <div className="relative flex h-full max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-[#1f5e3b]/10 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-[#14261a]">{docTypeLabel(doc.doc_type)}</p>
            <p className="truncate text-xs text-[#1f5e3b]/60">{doc.file_name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {imgMode && (
              <>
                <button type="button" onClick={() => setZoom(Math.max(0.5, zoom - 0.25))} className="rounded-lg border border-[#1f5e3b]/20 px-2 py-1.5 text-xs hover:bg-[#1f5e3b]/5">🔍−</button>
                <span className="text-xs font-semibold text-[#1f5e3b]/70">{Math.round(zoom * 100)}%</span>
                <button type="button" onClick={() => setZoom(Math.min(3, zoom + 0.25))} className="rounded-lg border border-[#1f5e3b]/20 px-2 py-1.5 text-xs hover:bg-[#1f5e3b]/5">🔍+</button>
                <button type="button" onClick={() => setZoom(1)} className="rounded-lg border border-[#1f5e3b]/20 px-2 py-1.5 text-xs hover:bg-[#1f5e3b]/5">↺</button>
              </>
            )}
            <a href={doc.file_path} download={doc.file_name} className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5">⬇ Download</a>
            <button type="button" onClick={onClose} className="rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#14261a]">Close ✕</button>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-auto bg-[#f5faf6] p-2">
          {imgMode ? (
            <img src={doc.file_path} alt={doc.file_name} className="max-w-none object-contain transition-transform" style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }} />
          ) : pdfMode ? (
            <iframe src={doc.file_path} title={doc.file_name} className="h-full w-full border-0" />
          ) : (
            <div className="text-center text-sm text-[#1f5e3b]/70">
              <p className="mb-2">Preview not available for this file type.</p>
              <a href={doc.file_path} download={doc.file_name} className="rounded-lg bg-[#1f5e3b] px-4 py-2 text-xs font-semibold text-white">Download to view</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
