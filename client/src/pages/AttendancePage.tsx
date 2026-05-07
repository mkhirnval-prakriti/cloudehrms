import { useCallback, useEffect, useRef, useState } from 'react'
import { api, apiFetchUrl, getToken } from '../api'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastHost'
import { useRealtimeEvents } from '../realtime'
import { canPerm } from '../lib/permissions'
import { localDateStr } from '../lib/date'
import { Link } from 'react-router-dom'
import { captureVideoFrameToJpegBlob, getFaceCameraConstraints } from '../lib/faceCapture'
import { descriptorToJson, runLivenessAndFaceDescriptor } from '../lib/faceApiLiveness'
import {
  browserSupportsWebAuthn,
  createAttendanceWebAuthnPayload,
  fetchWebAuthnAttendanceStatus,
  registerNewPasskey,
  type WebAuthnAttendanceStatus,
} from '../lib/webauthnAttendance'
import { EmployeesPage } from './EmployeesPage'
import { BiometricAdminPage } from './BiometricAdminPage'
import { QrScanWidget } from '../components/QrScanWidget'
import { ProfileUpdateRequestSection } from '../components/ProfileUpdateRequestSection'

type AttRow = {
  id: number
  user_id: number
  work_date: string
  punch_in_at: string | null
  punch_out_at: string | null
  status: string
  full_name?: string
  punch_in_photo?: string | null
  punch_method_in?: string | null
  punch_method_out?: string | null
  verification_in?: string | null
}
type WarnRow = { type: string; severity: string; message: string }
type Branch = { id: number; name: string }

export function AttendancePage() {
  const { user } = useAuth()
  const toast = useToast()
  const [from, setFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 14)
    return localDateStr(d)
  })
  const [to, setTo] = useState(() => localDateStr())
  const [records, setRecords] = useState<AttRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [punchMsg, setPunchMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterBranchId, setFilterBranchId] = useState<string>('')
  const [search, setSearch] = useState('')
  const [branches, setBranches] = useState<Branch[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<WarnRow[]>([])
  const [gpsPermState, setGpsPermState] = useState<'unknown' | 'granted' | 'denied' | 'unavailable'>('unknown')

  type LiveRow = { id: number; full_name: string; login_id?: string | null; punch_in_at: string }
  type MonthRow = { id: number; full_name: string; login_id?: string | null; present_days: number; late_days: number; absent_days: number; work_minutes: number }
  type WarnOverview = { lateToday: number; missedPunchOut: number; leaveHeavyUsers: { id: number; full_name: string; approved_count: number }[] }
  type TodayOverview = { totalStaff: number; present: number; late: number; absent: number; onLeave?: number }
  const [liveRows, setLiveRows] = useState<LiveRow[]>([])
  const [monthRows, setMonthRows] = useState<MonthRow[]>([])
  const [warnOverview, setWarnOverview] = useState<WarnOverview | null>(null)
  const [todayOverview, setTodayOverview] = useState<TodayOverview | null>(null)
  const [activeTab, setActiveTab] = useState<'history' | 'live' | 'monthly' | 'overview'>('history')
  const [monthPeriod, setMonthPeriod] = useState(() => new Date().toISOString().slice(0, 7))
  const [dlLoading, setDlLoading] = useState(false)
  const [dlErr, setDlErr] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [camOn, setCamOn] = useState(false)
  const [faceBlob, setFaceBlob] = useState<Blob | null>(null)
  const [faceDescriptorJson, setFaceDescriptorJson] = useState<string | null>(null)
  const [bioHint, setBioHint] = useState<{
    hasFace: boolean
    webauthnCount: number
    faceEmbeddingActive?: boolean
    canRequestFaceUpdate?: boolean
    blockReasonFace?: string
    pendingFace?: { id: number; created_at: string } | null
    approvedFace?: { id: number; approval_expires_at: string } | null
  } | null>(null)
  const [_faceReqBusy, setFaceReqBusy] = useState(false)
  const [_faceReqMsg, setFaceReqMsg] = useState<string | null>(null)
  const [showFaceEnrollModal, setShowFaceEnrollModal] = useState(false)
  const [enrollMsg, setEnrollMsg] = useState<string | null>(null)
  const [enrollBusy, setEnrollBusy] = useState(false)
  const [missedClockoutDismissed, setMissedClockoutDismissed] = useState(false)

  // ── Attendance Edit Modal (admin-only) ──
  const [editRec, setEditRec] = useState<AttRow | null>(null)
  const [editStatus, setEditStatus] = useState('')
  const [editIn, setEditIn] = useState('')
  const [editOut, setEditOut] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editErr, setEditErr] = useState<string | null>(null)

  // ── Absent-today drill modal (Absent staff have no attendance_records row,
  //    so the History tab cannot show them — fetch from /dashboard/today-list)
  type AbsentPerson = { id: number; full_name: string; email?: string | null; login_id?: string | null; branch_name?: string | null; status?: string | null }
  const [absentDrill, setAbsentDrill] = useState<{ open: boolean; loading: boolean; rows: AbsentPerson[]; error: string | null }>({ open: false, loading: false, rows: [], error: null })

  async function openAbsentDrill() {
    setAbsentDrill({ open: true, loading: true, rows: [], error: null })
    try {
      const branchQs = filterBranchId ? `&branch_id=${encodeURIComponent(filterBranchId)}` : ''
      const d = await api<{ people: AbsentPerson[] }>(`/dashboard/today-list?status=absent${branchQs}`)
      setAbsentDrill({ open: true, loading: false, rows: d.people || [], error: null })
    } catch (e) {
      setAbsentDrill({ open: true, loading: false, rows: [], error: (e as Error).message || 'Failed to load' })
    }
  }

  // ── Leave-today drill modal (approved leave_requests covering today)
  type LeavePerson = AbsentPerson & { leave_type?: string | null; leave_from?: string | null; leave_to?: string | null; leave_reason?: string | null }
  const [leaveDrill, setLeaveDrill] = useState<{ open: boolean; loading: boolean; rows: LeavePerson[]; error: string | null }>({ open: false, loading: false, rows: [], error: null })

  async function openLeaveDrill() {
    setLeaveDrill({ open: true, loading: true, rows: [], error: null })
    try {
      const branchQs = filterBranchId ? `&branch_id=${encodeURIComponent(filterBranchId)}` : ''
      const d = await api<{ people: LeavePerson[] }>(`/dashboard/today-list?status=leave${branchQs}`)
      setLeaveDrill({ open: true, loading: false, rows: d.people || [], error: null })
    } catch (e) {
      setLeaveDrill({ open: true, loading: false, rows: [], error: (e as Error).message || 'Failed to load' })
    }
  }

  // ── Attendance Edit helpers ──
  function toLocalDatetimeInput(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${y}-${mo}-${da}T${h}:${mi}`
  }

  function openEdit(r: AttRow) {
    setEditRec(r)
    setEditStatus(r.status)
    setEditIn(toLocalDatetimeInput(r.punch_in_at))
    setEditOut(toLocalDatetimeInput(r.punch_out_at))
    setEditNotes('')
    setEditBusy(false)
    setEditErr(null)
  }

  async function saveEdit() {
    if (!editRec) return
    setEditBusy(true)
    setEditErr(null)
    try {
      const payload: Record<string, string | null> = { status: editStatus }
      if (editIn) payload.punchInAt = new Date(editIn).toISOString()
      else payload.punchInAt = null
      if (editOut) payload.punchOutAt = new Date(editOut).toISOString()
      else payload.punchOutAt = null
      if (editNotes.trim()) payload.notes = editNotes.trim()
      await api(`/attendance/${editRec.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      setRecords((prev) => prev.map((r) => r.id === editRec.id ? {
        ...r,
        status: editStatus,
        punch_in_at: editIn ? new Date(editIn).toISOString() : null,
        punch_out_at: editOut ? new Date(editOut).toISOString() : null,
      } : r))
      setEditRec(null)
    } catch (e) {
      const err = e as { message?: string; reason?: string; solution?: string }
      setEditErr(err.message || 'Save failed')
      toast.pushApiError(e, 'Attendance save nahi hua')
    } finally {
      setEditBusy(false)
    }
  }

  // ── Step-by-step attendance wizard state ──
  type FlowStep = 'idle' | 'gps-checking' | 'gps-failed' | 'wifi-input' | 'biometric' | 'qr-fallback'
  const [flowStep, setFlowStep] = useState<FlowStep>('idle')
  const [flowKind, setFlowKind] = useState<'in' | 'out'>('in')
  const [flowGpsCoords, setFlowGpsCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [geoOutsideInfo, setGeoOutsideInfo] = useState<{ distance_m: number; radius_m: number | null; branchName: string | null } | null>(null)
  const [flowLocationMethod, setFlowLocationMethod] = useState<'gps' | 'wifi' | null>(null)
  const [wifiOptions, setWifiOptions] = useState<{ ssid: string; requires_password: boolean }[]>([])
  const [wifiSsid, setWifiSsid] = useState<string>('')
  const [wifiPassword, setWifiPassword] = useState<string>('')

  // ── Separate camera state for enrollment modal (avoids conflict with punch camera) ──
  const enrollVideoRef = useRef<HTMLVideoElement>(null)
  const enrollCanvasRef = useRef<HTMLCanvasElement>(null)
  const [enrollCamOn, setEnrollCamOn] = useState(false)
  const [enrollPreviewUrl, setEnrollPreviewUrl] = useState<string | null>(null)
  const [enrollFaceBlob, setEnrollFaceBlob] = useState<Blob | null>(null)
  const [enrollDescriptorJson, setEnrollDescriptorJson] = useState<string | null>(null)

  const today = localDateStr()
  const canAll = canPerm(user, 'history:read')
  const canBioAdmin = canPerm(user, 'biometric:admin')
  const [geoWarned, setGeoWarned] = useState(false)
  const [mainSection, setMainSection] = useState<'attendance' | 'employees' | 'biometrics'>('attendance')
  const [clockOutSecsLeft, setClockOutSecsLeft] = useState<number>(0)

  const waStatusRef = useRef<WebAuthnAttendanceStatus | null>(null)
  const [_waStatus, setWaStatus] = useState<WebAuthnAttendanceStatus | null>(null)
  const refreshWaStatus = useCallback(async () => {
    try {
      const s = await fetchWebAuthnAttendanceStatus()
      waStatusRef.current = s
      setWaStatus(s)
      return s
    } catch {
      const fallback: WebAuthnAttendanceStatus = {
        mode: 'off',
        credCount: 0,
        punchRequiresWebAuthn: false,
        rpId: '',
      }
      waStatusRef.current = fallback
      setWaStatus(fallback)
      return fallback
    }
  }, [])

  const refreshIdentityHint = useCallback(async () => {
    try {
      const b = await api<{
        hasFace: boolean; webauthnCount: number; faceEmbeddingActive?: boolean
        canRequestFaceUpdate?: boolean; blockReasonFace?: string
        pending?: { face?: { id: number; created_at: string } | null }
        approvedAwaitingEnrollment?: { face?: { id: number; approval_expires_at: string } | null }
      }>('/biometric/status')
      setBioHint({
        hasFace: !!b.hasFace,
        webauthnCount: Number(b.webauthnCount || 0),
        faceEmbeddingActive: !!b.faceEmbeddingActive,
        canRequestFaceUpdate: !!b.canRequestFaceUpdate,
        blockReasonFace: b.blockReasonFace,
        pendingFace: b.pending?.face ?? null,
        approvedFace: b.approvedAwaitingEnrollment?.face ?? null,
      })
    } catch {
      setBioHint(null)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    void (async () => {
      await refreshWaStatus()
      await refreshIdentityHint()
    })()
  }, [user, refreshWaStatus, refreshIdentityHint])

  // @ts-expect-error - kept for future re-enable, intentionally unused
  async function _attachWebAuthnIfNeeded(bodyOrAppend: Record<string, unknown> | FormData) {
    const s = waStatusRef.current ?? (await refreshWaStatus())
    if (!s.punchRequiresWebAuthn) return
    if (!browserSupportsWebAuthn()) {
      throw new Error('इस browser में Fingerprint (WebAuthn) supported नहीं है — Face से try करें।')
    }
    let payload
    try {
      payload = await createAttendanceWebAuthnPayload()
    } catch (e) {
      const name = (e as {name?: string}).name || ''
      const msg = (e as Error).message || ''
      // Translate WebAuthn errors to user-friendly Hindi
      if (name === 'NotAllowedError' || msg.toLowerCase().includes('not allowed') || msg.toLowerCase().includes('timed out')) {
        throw new Error('🔁 Fingerprint scan रद्द हो गया या time-out हुआ — फिर से try करें, या Face से punch करें।')
      }
      if (name === 'InvalidStateError') {
        throw new Error('यह passkey इस device पर registered नहीं है — दूसरी device use करें या Face से punch करें।')
      }
      if (name === 'SecurityError') {
        throw new Error('🔒 Fingerprint security error — page को HTTPS पर खोलें और retry करें।')
      }
      throw new Error('Fingerprint error: ' + (msg || name || 'Unknown') + ' — Face से try करें।')
    }
    if (bodyOrAppend instanceof FormData) {
      bodyOrAppend.append('webAuthn', JSON.stringify(payload))
    } else {
      bodyOrAppend.webAuthn = payload
    }
  }

  function speak(text: string) {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'hi-IN'
    u.rate = 0.92
    window.speechSynthesis.speak(u)
  }

  function notify(title: string, body: string) {
    if (!('Notification' in window)) return
    const show = () => {
      try {
        new Notification(title, {
          body,
          icon: '/logo.png',
          tag: 'attendance-alert',
          requireInteraction: false,
        })
      } catch {}
    }
    if (Notification.permission === 'granted') {
      show()
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then((p) => { if (p === 'granted') show() }).catch(() => {})
    }
  }

  // Request notification permission proactively (staff/managers only)
  useEffect(() => {
    const isStaff = user?.role === 'USER' || user?.role === 'ATTENDANCE_MANAGER' || user?.role === 'LOCATION_MANAGER'
    if (!isStaff) return
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [user?.role])

  // Release any active camera streams when leaving the page (prevents
  // false "camera in use by another app" on next mount).
  useEffect(() => {
    return () => {
      const v = videoRef.current
      if (v?.srcObject) {
        try { (v.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
        v.srcObject = null
      }
      const ev = enrollVideoRef.current
      if (ev?.srcObject) {
        try { (ev.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
        ev.srcObject = null
      }
    }
  }, [])

  // Check GPS permission state on mount and react to changes
  useEffect(() => {
    if (!navigator.permissions) return
    navigator.permissions.query({ name: 'geolocation' as PermissionName }).then((result) => {
      const map: Record<string, 'granted' | 'denied' | 'unknown'> = {
        granted: 'granted', denied: 'denied', prompt: 'unknown',
      }
      setGpsPermState(map[result.state] ?? 'unknown')
      result.onchange = () => setGpsPermState(map[result.state] ?? 'unknown')
    }).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setErr(null)
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('from', from)
      params.set('to', to)
      if (filterStatus) params.set('status', filterStatus)
      if (filterBranchId) params.set('branchId', filterBranchId)
      const q = `?${params.toString()}`
      let rows: AttRow[] = []
      try {
        const data = await api<{ records: AttRow[] }>('/attendance/history' + q)
        rows = data.records || []
        console.log('[attendance] /attendance/history', { query: q, count: rows.length })
      } catch (historyErr) {
        console.warn('[attendance] history failed, trying /attendance', historyErr)
        const data2 = await api<{ attendance: AttRow[] }>('/attendance' + q)
        rows = (data2.attendance || []).map((r) => ({
          ...r,
          work_date: (r as unknown as { workDate?: string }).workDate || r.work_date,
          user_id: (r as unknown as { userId?: number }).userId || r.user_id,
          full_name: (r as unknown as { userName?: string }).userName || r.full_name,
          punch_in_at: (r as unknown as { checkIn?: string | null }).checkIn || r.punch_in_at,
          punch_out_at: (r as unknown as { checkOut?: string | null }).checkOut || r.punch_out_at,
        }))
        console.log('[attendance] /attendance fallback', { query: q, count: rows.length })
      }
      setRecords(rows)
      const w = await api<{ warnings: WarnRow[] }>('/warnings/me')
      setWarnings(w.warnings || [])
      if (canAll) {
        const b = await api<{ branches: Branch[] }>('/branches')
        setBranches(b.branches || [])
        api<{ currently_in: LiveRow[] }>('/attendance/live-status')
          .then((r) => setLiveRows(r.currently_in || []))
          .catch(() => {})
        api<{ rows: MonthRow[] }>(`/attendance/month-summary?month=${monthPeriod}`)
          .then((r) => setMonthRows(r.rows || []))
          .catch(() => {})
        api<WarnOverview>('/warnings/overview')
          .then((r) => setWarnOverview(r))
          .catch(() => {})
        api<{ today: TodayOverview }>('/dashboard/overview')
          .then((r) => setTodayOverview(r.today))
          .catch(() => {})
      }
      await refreshIdentityHint()
    } catch (e) {
      setErr((e as Error).message)
      setRecords([])
      setWarnings([])
    } finally {
      setLoading(false)
    }
  }, [from, to, filterStatus, filterBranchId, refreshIdentityHint, canAll])

  useEffect(() => {
    load()
  }, [load])

  // Realtime: any punch / admin edit anywhere → refresh history list.
  // Debounced via React's natural rerender; load() is idempotent.
  useRealtimeEvents({
    attendance: (data) => {
      const d = data as { user_id?: number; type?: string }
      // Always refresh own punches; for admins viewing all, refresh on every event.
      if (canAll || d?.user_id === user?.id) {
        load()
      }
    },
  }, [load, canAll, user?.id])

  async function downloadAttendanceExcel() {
    setDlLoading(true)
    setDlErr(null)
    try {
      const params = new URLSearchParams()
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (filterStatus) params.set('status', filterStatus)
      if (filterBranchId) params.set('branchId', filterBranchId)
      const pathname = '/attendance/export.xlsx'
      const url = `${apiFetchUrl(pathname)}?${params.toString()}`
      const token = getToken()
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      const dateTag = `${from || 'all'}_to_${to || 'all'}`
      a.download = `attendance_${dateTag}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(href)
    } catch (e) {
      setDlErr((e as Error).message || 'Download failed')
    } finally {
      setDlLoading(false)
    }
  }

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const todayRows = records.filter((r) => r.work_date === today)
  const myToday = todayRows.find((r) => r.user_id === user?.id)
  const autoPunchType: 'in' | 'out' = !myToday?.punch_in_at ? 'in' : 'out'

  // 30-minute minimum before clock-out is allowed
  const CLOCK_OUT_LOCK_MS = 30 * 60 * 1000
  const canCheckOut = autoPunchType !== 'out'
    || !myToday?.punch_in_at
    || (Date.now() - new Date(myToday.punch_in_at).getTime()) >= CLOCK_OUT_LOCK_MS

  // Live countdown until Clock Out is unlocked
  const punchInAt = myToday?.punch_in_at ?? null
  useEffect(() => {
    if (!punchInAt) { setClockOutSecsLeft(0); return }
    const unlockAt = new Date(punchInAt).getTime() + CLOCK_OUT_LOCK_MS
    const tick = () => {
      const left = Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000))
      setClockOutSecsLeft(left)
    }
    tick()
    if (unlockAt <= Date.now()) return
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [punchInAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Yesterday missed clock-out check
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10) })()
  const missedClockoutYesterday = !missedClockoutDismissed
    && records.some((r) => r.work_date === yesterday && r.user_id === user?.id && r.punch_in_at && !r.punch_out_at)

  // Show punch section for USER and managers (ATTENDANCE_MANAGER, LOCATION_MANAGER)
  const showPunchSection = user?.role === 'USER'
    || user?.role === 'ATTENDANCE_MANAGER'
    || user?.role === 'LOCATION_MANAGER'
  const thisMonthPrefix = today.slice(0, 7)
  const myMonthRows = records.filter((r) => r.work_date.startsWith(thisMonthPrefix) && r.user_id === user?.id)
  const mPresent = myMonthRows.filter((r) => r.status === 'present').length
  const mLate = myMonthRows.filter((r) => r.status === 'late').length
  const mHalfDay = myMonthRows.filter((r) => r.status === 'half_day').length
  const mAbsent = myMonthRows.filter((r) => r.status === 'absent').length

  let filtered = records
  if (filterStatus) {
    filtered = filtered.filter((r) => String(r.status || '').toLowerCase() === filterStatus.toLowerCase())
  }
  if (search.trim()) {
    const q = search.trim().toLowerCase()
    filtered = filtered.filter((r) => `${r.full_name || ''} ${r.user_id}`.toLowerCase().includes(q))
  }



  async function submitFaceEnrollment() {
    if (!enrollFaceBlob || enrollFaceBlob.size < 8192) {
      setEnrollMsg('साफ फोटो लें (min ~8KB) — अच्छी रोशनी में camera खोलें।')
      return
    }
    if (!enrollDescriptorJson) {
      setEnrollMsg('"Live Verify & Capture" पहले दबाएं — एक बार पलकें झपकाएं।')
      return
    }
    setEnrollBusy(true)
    setEnrollMsg(null)
    try {
      const fd = new FormData()
      fd.append('photo', enrollFaceBlob, 'face.jpg')
      fd.append('faceDescriptor', enrollDescriptorJson)
      const token = getToken()
      const res = await fetch(apiFetchUrl(`/users/${user?.id}/face-enrollment`), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
        credentials: 'include',
      })
      const text = await res.text()
      const parsed = text ? JSON.parse(text) : null
      if (!res.ok) throw new Error(parsed?.error || res.statusText)
      setEnrollMsg('✅ Face registration सफल! अब Face से अटेंडेंस लगा सकते हैं।')
      setEnrollFaceBlob(null)
      setEnrollDescriptorJson(null)
      if (enrollPreviewUrl) URL.revokeObjectURL(enrollPreviewUrl)
      setEnrollPreviewUrl(null)
      stopEnrollCamera()
      await refreshIdentityHint()
    } catch (e) {
      setEnrollMsg((e as Error).message || 'Enrollment failed')
    } finally {
      setEnrollBusy(false)
    }
  }

  // @ts-expect-error - kept for future re-enable, intentionally unused
  async function _requestFaceUpdate() {
    setFaceReqBusy(true); setFaceReqMsg(null)
    try {
      await api('/biometric/requests', { method: 'POST', body: JSON.stringify({ kind: 'face', notes: 'Staff requested face update from attendance page' }) })
      setFaceReqMsg('✅ Request भेज दी गई। Admin की approval के बाद आप face update कर सकेंगे।')
      await refreshIdentityHint()
    } catch (e) {
      setFaceReqMsg((e as Error).message || 'Request failed')
    } finally {
      setFaceReqBusy(false)
    }
  }

  // @ts-expect-error - kept for future re-enable, intentionally unused
  async function _startCamera() {
    setErr(null)
    setPunchMsg(null)
    // Always release any existing stream on the element BEFORE re-opening,
    // otherwise Chrome/Safari throw a false "NotReadableError" (camera busy).
    const v = videoRef.current
    if (v?.srcObject) {
      try { (v.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
      v.srcObject = null
    }
    const tryOpen = async () =>
      await navigator.mediaDevices.getUserMedia(getFaceCameraConstraints())
    try {
      let stream: MediaStream
      try {
        stream = await tryOpen()
      } catch (innerErr) {
        const innerName = (innerErr as {name?: string}).name || ''
        if (innerName === 'NotReadableError' || innerName === 'AbortError') {
          // Device may not have released yet — wait briefly and retry once.
          await new Promise((r) => setTimeout(r, 350))
          stream = await tryOpen()
        } else {
          throw innerErr
        }
      }
      if (!videoRef.current) { stream.getTracks().forEach(t => t.stop()); throw new Error('Video element not ready.') }
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      setCamOn(true)
    } catch (e) {
      const name = (e as {name?: string}).name || ''
      const msg = (e as Error).message || ''
      if (name === 'NotAllowedError' || msg.toLowerCase().includes('denied')) {
        setPunchMsg('🚫 Camera permission नहीं दी — Browser Settings → Site → Camera → Allow करें, फिर retry करें।')
      } else if (name === 'NotFoundError') {
        setPunchMsg('📷 Camera नहीं मिला — Camera device connect है? दूसरा browser try करें।')
      } else if (name === 'NotReadableError') {
        setPunchMsg('📷 Camera busy है — Page एक बार refresh करें, या browser में बाकी कोई camera tab बंद करें।')
      } else {
        setPunchMsg('Camera खोलने में समस्या: ' + (msg || name || 'Unknown') + ' — Page refresh करें।')
      }
    }
  }

  /** Opens camera, grabs one scaled frame, closes — fewer taps for attendance. */
  // @ts-expect-error - kept for future re-enable, intentionally unused
  async function _quickFaceCapture() {
    if (bioHint?.faceEmbeddingActive) {
      setPunchMsg('AI face profile is on — use Open camera, then Live verify & capture (blink + small head move).')
      return
    }
    setErr(null)
    setPunchMsg(null)
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c) return
    // Pre-stop any existing stream to avoid false "NotReadableError"
    if (v.srcObject) {
      try { (v.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
      v.srcObject = null
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(getFaceCameraConstraints())
      v.srcObject = stream
      await v.play()
      await new Promise<void>((res) => {
        if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) res()
        else v.onloadeddata = () => res()
      })
      await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
      const blob = await captureVideoFrameToJpegBlob(v, c)
      stream.getTracks().forEach((t) => t.stop())
      v.srcObject = null
      setCamOn(false)
      if (blob && blob.size >= 8192) {
        setFaceDescriptorJson(null)
        setFaceBlob(blob)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(URL.createObjectURL(blob))
        setPunchMsg('Photo captured — tap Check in (face) or Check out (face).')
      } else {
        setPunchMsg('Photo too small — try brighter light or use Open camera, then Capture.')
      }
    } catch {
      setErr('Camera access denied or unavailable.')
    }
  }

  function stopCamera() {
    const v = videoRef.current
    if (v && v.srcObject) {
      ;(v.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
      v.srcObject = null
    }
    setCamOn(false)
    setFaceDescriptorJson(null)
  }

  // ── Enrollment-specific camera functions (dedicated refs, no conflict with punch) ──
  async function startEnrollCamera() {
    setEnrollMsg(null)
    // Pre-stop any existing stream + also ensure punch camera is fully released
    // (only ONE camera stream at a time on the page).
    const ev = enrollVideoRef.current
    if (ev?.srcObject) {
      try { (ev.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
      ev.srcObject = null
    }
    const pv = videoRef.current
    if (pv?.srcObject) {
      try { (pv.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
      pv.srcObject = null
      setCamOn(false)
    }
    const tryOpen = async () =>
      await navigator.mediaDevices.getUserMedia(getFaceCameraConstraints())
    try {
      let stream: MediaStream
      try {
        stream = await tryOpen()
      } catch (innerErr) {
        const innerName = (innerErr as {name?: string}).name || ''
        if (innerName === 'NotReadableError' || innerName === 'AbortError') {
          await new Promise((r) => setTimeout(r, 350))
          stream = await tryOpen()
        } else {
          throw innerErr
        }
      }
      if (!enrollVideoRef.current) { stream.getTracks().forEach(t => t.stop()); throw new Error('Camera element not ready.') }
      enrollVideoRef.current.srcObject = stream
      await enrollVideoRef.current.play()
      setEnrollCamOn(true)
    } catch (e) {
      const msg = (e as Error).message || ''
      const name = (e as {name?: string}).name || ''
      if (name === 'NotAllowedError' || msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('denied')) {
        setEnrollMsg('🚫 Camera permission नहीं मिली। Browser settings में Site → Camera → Allow करें, फिर page refresh करें।')
      } else if (name === 'NotFoundError' || msg.toLowerCase().includes('notfound') || msg.toLowerCase().includes('device')) {
        setEnrollMsg('📷 Camera नहीं मिला। Camera device connect है? दूसरा browser try करें।')
      } else if (name === 'NotReadableError' || msg.toLowerCase().includes('notreadable')) {
        setEnrollMsg('📷 Camera busy है — Page एक बार refresh करें या दूसरे camera tabs बंद करें।')
      } else {
        setEnrollMsg('Camera खोलने में समस्या: ' + (msg || 'Unknown error') + ' — Page refresh करें।')
      }
    }
  }

  function stopEnrollCamera() {
    const v = enrollVideoRef.current
    if (v && v.srcObject) {
      ;(v.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
      v.srcObject = null
    }
    setEnrollCamOn(false)
    setEnrollDescriptorJson(null)
  }

  async function liveVerifyAndCaptureEnroll() {
    const v = enrollVideoRef.current
    const c = enrollCanvasRef.current
    if (!v || !c || !v.videoWidth) {
      setEnrollMsg('Camera नहीं खुला — पहले "Camera खोलें" बटन दबाएं।')
      return
    }
    setEnrollMsg(null)
    setEnrollBusy(true)
    try {
      const desc = await runLivenessAndFaceDescriptor(v)
      setEnrollDescriptorJson(descriptorToJson(desc))
      const blob = await captureVideoFrameToJpegBlob(v, c)
      if (blob && blob.size >= 8192) {
        setEnrollFaceBlob(blob)
        if (enrollPreviewUrl) URL.revokeObjectURL(enrollPreviewUrl)
        setEnrollPreviewUrl(URL.createObjectURL(blob))
        setEnrollMsg('✅ Live check passed — नीचे "Save & Register" दबाएं।')
      } else {
        setEnrollDescriptorJson(null)
        setEnrollMsg('Photo बहुत छोटी — light बढ़ाएं, camera के पास आएं और retry करें।')
      }
    } catch (e) {
      setEnrollDescriptorJson(null)
      setEnrollMsg((e as Error).message || 'Live check failed')
    } finally {
      setEnrollBusy(false)
    }
  }

  /** Simple direct capture for enrollment — no AI liveness, just grabs a frame.
   *  Used as fallback when face-api.js CDN models are slow/unavailable. */
  async function captureEnrollSimple() {
    const v = enrollVideoRef.current
    const c = enrollCanvasRef.current
    if (!v || !c) {
      setEnrollMsg('Camera element नहीं मिला — page refresh करें।')
      return
    }
    if (!v.videoWidth || !v.videoHeight) {
      setEnrollMsg('Camera अभी ready नहीं — थोड़ा रुकें और फिर Try करें।')
      return
    }
    setEnrollBusy(true)
    setEnrollMsg(null)
    try {
      await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
      const blob = await captureVideoFrameToJpegBlob(v, c)
      if (blob && blob.size >= 8192) {
        setEnrollFaceBlob(blob)
        setEnrollDescriptorJson(null)
        if (enrollPreviewUrl) URL.revokeObjectURL(enrollPreviewUrl)
        setEnrollPreviewUrl(URL.createObjectURL(blob))
        setEnrollMsg('📸 Photo captured — "Save & Register" दबाएं (AI verification के बिना)।')
      } else {
        setEnrollMsg('Photo बहुत छोटी या unclear — अच्छी रोशनी में camera के पास आकर Try करें।')
      }
    } catch (e) {
      setEnrollMsg('Capture failed: ' + ((e as Error).message || 'Unknown error'))
    } finally {
      setEnrollBusy(false)
    }
  }

  // ── Wizard Flow Functions ──

  async function startClockFlow(kind: 'in' | 'out') {
    if (busy) return
    setFlowKind(kind)
    setFlowStep('gps-checking')
    setPunchMsg(null)
    setFlowGpsCoords(null)
    setFlowLocationMethod(null)
    setFaceBlob(null)
    setFaceDescriptorJson(null)
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    stopCamera()
    setBusy(true)
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 15000,
          enableHighAccuracy: true,
          maximumAge: 0,
        })
      })
      setGpsPermState('granted')
      const lat = pos.coords.latitude
      const lng = pos.coords.longitude
      setFlowGpsCoords({ lat, lng })
      // ── Pre-flight radius check: surface "X meters outside" BEFORE biometric step
      try {
        const geo = await api<{ within: boolean; distance_m: number; radius_m: number | null; branch: { name: string } | null }>(
          `/attendance/geo-check?lat=${lat}&lng=${lng}`
        )
        if (geo && geo.within === false) {
          setGeoOutsideInfo({ distance_m: geo.distance_m, radius_m: geo.radius_m, branchName: geo.branch?.name || null })
          setFlowStep('gps-failed')
          return
        }
      } catch { /* fall through — server-side check still applies on punch */ }
      setGeoOutsideInfo(null)
      setFlowLocationMethod('gps')
      setFlowStep('biometric')
    } catch (e) {
      const geoErr = e as GeolocationPositionError
      if (geoErr?.code === 1) setGpsPermState('denied')
      else if (geoErr?.code === 2) setGpsPermState('unavailable')
      else setGpsPermState('unknown')
      setGeoOutsideInfo(null)
      setFlowStep('gps-failed')
    } finally {
      setBusy(false)
    }
  }

  function cancelFlow() {
    setFlowStep('idle')
    setFlowGpsCoords(null)
    setFlowLocationMethod(null)
    setPunchMsg(null)
    setFaceBlob(null)
    setFaceDescriptorJson(null)
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    stopCamera()
  }

  async function confirmWifiAndProceed() {
    setPunchMsg(null)
    try {
      const opts = await api<{ enabled: boolean; networks: { ssid: string; requires_password: boolean }[] }>('/attendance/wifi-options')
      const nets = Array.isArray(opts?.networks) ? opts.networks : []
      setWifiOptions(nets)
      if (nets.length === 0) {
        setWifiSsid('')
        setWifiPassword('')
        setFlowLocationMethod('wifi')
        setFlowGpsCoords(null)
        setFlowStep('biometric')
        return
      }
      if (nets.length === 1) {
        setWifiSsid(nets[0].ssid)
      } else if (!wifiSsid) {
        setWifiSsid(nets[0].ssid)
      }
      setWifiPassword('')
      setFlowStep('wifi-input')
    } catch {
      setWifiOptions([])
      setWifiSsid('')
      setWifiPassword('')
      setFlowStep('wifi-input')
    }
  }
  function submitWifiSelection() {
    if (wifiOptions.length > 0 && !wifiSsid.trim()) {
      setPunchMsg('कृपया Office WiFi network चुनें')
      return
    }
    const sel = wifiOptions.find((n) => n.ssid.toLowerCase() === wifiSsid.trim().toLowerCase())
    if (sel?.requires_password && !wifiPassword.trim()) {
      setPunchMsg('इस WiFi के लिए password जरूरी है')
      return
    }
    setPunchMsg(null)
    setFlowLocationMethod('wifi')
    setFlowGpsCoords(null)
    setFlowStep('biometric')
  }

  // @ts-expect-error - kept for future re-enable, intentionally unused
  async function _punchFaceWizard(kind: 'in' | 'out') {
    if (!faceBlob || faceBlob.size < 8192) {
      setPunchMsg('📷 पहले अपना Face Capture करें (min ~8KB)।')
      return
    }
    if (bioHint?.faceEmbeddingActive && !faceDescriptorJson) {
      setPunchMsg('👁️ "Live Verify & Capture" पहले दबाएं — एक बार पलकें झपकाएं।')
      return
    }
    setPunchMsg(null)
    setBusy(true)
    try {
      const path = kind === 'in' ? '/attendance/checkin' : '/attendance/checkout'
      const fd = new FormData()
      fd.append('type', kind)
      fd.append('source', 'device')
      fd.append('attendanceMethod', 'face')
      if (flowLocationMethod === 'gps' && flowGpsCoords) {
        fd.append('lat', String(flowGpsCoords.lat))
        fd.append('lng', String(flowGpsCoords.lng))
      } else if (flowLocationMethod === 'wifi') {
        fd.append('useBranchCenter', 'true')
        if (wifiSsid.trim()) fd.append('wifi_ssid', wifiSsid.trim())
        if (wifiPassword.trim()) fd.append('wifi_password', wifiPassword.trim())
      } else {
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000 })
          )
          fd.append('lat', String(pos.coords.latitude))
          fd.append('lng', String(pos.coords.longitude))
        } catch {}
      }
      fd.append('photo', faceBlob, 'face.jpg')
      if (faceDescriptorJson) fd.append('faceDescriptor', faceDescriptorJson)
      // Face is the biometric proof — do NOT also demand fingerprint/passkey.
      const token = getToken()
      const res = await fetch(apiFetchUrl(path), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
        credentials: 'include',
      })
      const text = await res.text()
      const data = text ? JSON.parse(text) : null
      if (!res.ok) throw new Error(data?.error || res.statusText)
      void refreshWaStatus()
      if (kind === 'in') {
        const msg = 'प्रकृति हर्ब्स में अटेंडेंस लगाने के लिए धन्यवाद, आपकी Clock In सफलतापूर्वक हो गई है।'
        setPunchMsg('✅ Face से Check In हो गया!')
        speak(msg)
        notify('✅ Clock In सफल — Prakriti Herbs', msg)
      } else {
        const msg = 'प्रकृति हर्ब्स में समय देने के लिए धन्यवाद, आपकी Clock Out सफलतापूर्वक हो गई है।'
        setPunchMsg('🚪 Face से Check Out हो गया!')
        speak(msg)
        notify('🚪 Clock Out सफल — Prakriti Herbs', msg)
      }
      setFaceBlob(null)
      setFaceDescriptorJson(null)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
      stopCamera()
      setFlowStep('idle')
      setFlowGpsCoords(null)
      setFlowLocationMethod(null)
      await load()
    } catch (e) {
      setPunchMsg((e as Error).message || 'Face punch failed')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 1-click Face Attendance: open camera → wait for stable frame →
   * auto-capture (with liveness if AI active) → submit punch → done.
   * No intermediate buttons or state. Smooth experience.
   */
  async function oneClickFaceAttendance(kind: 'in' | 'out') {
    if (busy) return
    setPunchMsg('📷 Camera खुल रही है...')
    setBusy(true)
    let localStream: MediaStream | null = null
    try {
      const v = videoRef.current
      const c = canvasRef.current
      if (!v || !c) throw new Error('Camera element ready नहीं — page refresh करें')

      // Pre-stop any existing stream
      if (v.srcObject) {
        try { (v.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
        v.srcObject = null
      }

      // Open camera (with retry)
      const tryOpen = async () => await navigator.mediaDevices.getUserMedia(getFaceCameraConstraints())
      try {
        localStream = await tryOpen()
      } catch (err) {
        const en = (err as {name?: string}).name || ''
        if (en === 'NotReadableError' || en === 'AbortError') {
          await new Promise(r => setTimeout(r, 350))
          localStream = await tryOpen()
        } else {
          throw err
        }
      }
      v.srcObject = localStream
      await v.play()
      setCamOn(true)

      // Wait for video to stabilize (ready + 600ms for auto-exposure)
      setPunchMsg('📷 चेहरा सीधे camera की ओर रखें...')
      await new Promise<void>((res) => {
        if (v.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA && v.videoWidth) res()
        else v.onloadeddata = () => res()
      })
      await new Promise(r => setTimeout(r, 600))

      // Capture descriptor — use liveness if AI profile is active
      let descJson: string | null = null
      if (bioHint?.faceEmbeddingActive) {
        setPunchMsg('👁️ एक बार पलकें झपकाएं...')
        try {
          const desc = await runLivenessAndFaceDescriptor(v)
          descJson = descriptorToJson(desc)
        } catch (e) {
          throw new Error(((e as Error).message || 'Live verify') + ' — सीधे camera देखें और retry करें')
        }
      }

      // Capture photo
      const blob = await captureVideoFrameToJpegBlob(v, c)
      if (!blob || blob.size < 8192) {
        throw new Error('Photo साफ नहीं आई — अच्छी रोशनी में retry करें')
      }

      // Submit punch (skip state, use local vars)
      setPunchMsg('⏳ अटेंडेंस लग रही है...')
      const path = kind === 'in' ? '/attendance/checkin' : '/attendance/checkout'
      const fd = new FormData()
      fd.append('type', kind)
      fd.append('source', 'device')
      fd.append('attendanceMethod', 'face')
      if (flowLocationMethod === 'gps' && flowGpsCoords) {
        fd.append('lat', String(flowGpsCoords.lat))
        fd.append('lng', String(flowGpsCoords.lng))
      } else if (flowLocationMethod === 'wifi') {
        fd.append('useBranchCenter', 'true')
        if (wifiSsid.trim()) fd.append('wifi_ssid', wifiSsid.trim())
        if (wifiPassword.trim()) fd.append('wifi_password', wifiPassword.trim())
      }
      fd.append('photo', blob, 'face.jpg')
      if (descJson) fd.append('faceDescriptor', descJson)
      const token = getToken()
      const res = await fetch(apiFetchUrl(path), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
        credentials: 'include',
      })
      const text = await res.text()
      const data = text ? JSON.parse(text) : null
      if (!res.ok) throw new Error(data?.error || res.statusText)

      void refreshWaStatus()
      if (kind === 'in') {
        const m = 'प्रकृति हर्ब्स में अटेंडेंस लगाने के लिए धन्यवाद, आपकी Clock In सफलतापूर्वक हो गई है।'
        setPunchMsg('✅ Face से Check In हो गया!')
        speak(m)
        notify('✅ Clock In सफल — Prakriti Herbs', m)
      } else {
        const m = 'प्रकृति हर्ब्स में समय देने के लिए धन्यवाद, आपकी Clock Out सफलतापूर्वक हो गई है।'
        setPunchMsg('🚪 Face से Check Out हो गया!')
        speak(m)
        notify('🚪 Clock Out सफल — Prakriti Herbs', m)
      }
      setFlowStep('idle')
      setFlowGpsCoords(null)
      setFlowLocationMethod(null)
      await load()
    } catch (e) {
      const err = e as { message?: string; reason?: string; solution?: string }
      setPunchMsg('❌ ' + (err.message || 'Face attendance failed'))
      toast.pushApiError(e, 'Face attendance fail ho gayi')
    } finally {
      // Always release camera
      if (localStream) {
        try { localStream.getTracks().forEach(t => t.stop()) } catch { /* noop */ }
      }
      const v = videoRef.current
      if (v?.srcObject) {
        try { (v.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
        v.srcObject = null
      }
      setCamOn(false)
      setBusy(false)
    }
  }

  async function punchFingerprintWizard(kind: 'in' | 'out') {
    setPunchMsg(null)
    setBusy(true)
    try {
      // Browser support gate
      if (!browserSupportsWebAuthn()) {
        throw new Error('इस browser में Fingerprint supported नहीं है — Face से try करें।')
      }

      // Auto-register on first use — silent: device biometric prompt is the registration.
      // Subsequent uses skip this and go straight to authentication.
      const cur = waStatusRef.current ?? (await refreshWaStatus())
      if (cur.credCount === 0) {
        setPunchMsg('👆 पहली बार setup — अपना Fingerprint / Face / PIN दिखाएं...')
        try {
          await registerNewPasskey('Attendance Device')
          await refreshWaStatus()
        } catch (e) {
          const name = (e as {name?: string}).name || ''
          const msg = (e as Error).message || ''
          if (name === 'NotAllowedError' || /not allowed|timed out/i.test(msg)) {
            throw new Error('🔁 Setup रद्द हो गया — फिर से try करें, या Face से punch करें।')
          }
          if (name === 'InvalidStateError') {
            throw new Error('यह device पहले से registered है — फिर से try करें।')
          }
          if (name === 'SecurityError') {
            throw new Error('🔒 Page को HTTPS पर खोलें और retry करें।')
          }
          throw new Error('Fingerprint setup failed: ' + (msg || name) + ' — Face से try करें।')
        }
      }

      const path = kind === 'in' ? '/attendance/checkin' : '/attendance/checkout'
      const body: Record<string, unknown> = {
        type: kind,
        source: 'device',
        attendanceMethod: 'fingerprint',
        verificationStatus: 'pending',
      }
      if (flowLocationMethod === 'gps' && flowGpsCoords) {
        body.lat = flowGpsCoords.lat
        body.lng = flowGpsCoords.lng
      } else if (flowLocationMethod === 'wifi') {
        body.useBranchCenter = true
        if (wifiSsid.trim()) body.wifi_ssid = wifiSsid.trim()
        if (wifiPassword.trim()) body.wifi_password = wifiPassword.trim()
      }
      // Always require biometric verification for fingerprint method —
      // never submit a "fake" pending punch without device biometric proof.
      setPunchMsg('👆 अपना Fingerprint / Face / PIN दिखाएं...')
      try {
        const payload = await createAttendanceWebAuthnPayload()
        body.webAuthn = payload
      } catch (e) {
        const name = (e as {name?: string}).name || ''
        const msg = (e as Error).message || ''
        if (name === 'NotAllowedError' || /not allowed|timed out/i.test(msg)) {
          throw new Error('🔁 Fingerprint scan रद्द हो गया या time-out हुआ — फिर से try करें, या Face से punch करें।')
        }
        if (name === 'InvalidStateError') {
          throw new Error('यह device registered नहीं है — फिर से try करें या Face से punch करें।')
        }
        if (name === 'SecurityError') {
          throw new Error('🔒 Page को HTTPS पर खोलें और retry करें।')
        }
        throw new Error('Fingerprint error: ' + (msg || name) + ' — Face से try करें।')
      }
      await api(path, { method: 'POST', body: JSON.stringify(body) })
      void refreshWaStatus()
      if (kind === 'in') {
        const msg = 'प्रकृति हर्ब्स में अटेंडेंस लगाने के लिए धन्यवाद, आपकी Clock In सफलतापूर्वक हो गई है।'
        setPunchMsg('✅ Fingerprint से Check In हो गया!')
        speak(msg)
        notify('✅ Clock In सफल — Prakriti Herbs', msg)
      } else {
        const msg = 'प्रकृति हर्ब्स में समय देने के लिए धन्यवाद, आपकी Clock Out सफलतापूर्वक हो गई है।'
        setPunchMsg('🚪 Fingerprint से Check Out हो गया!')
        speak(msg)
        notify('🚪 Clock Out सफल — Prakriti Herbs', msg)
      }
      setFlowStep('idle')
      setFlowGpsCoords(null)
      setFlowLocationMethod(null)
      await load()
    } catch (e) {
      const name = (e as {name?: string}).name || ''
      const raw = (e as Error).message || 'Fingerprint punch failed'
      // If WebAuthn dialog itself errored at dispatch time (rare), translate it here too.
      if (name === 'NotAllowedError' || /not allowed|timed out/i.test(raw)) {
        setPunchMsg('🔁 Fingerprint scan रद्द हो गया या time-out हुआ — फिर से try करें, या Face से punch करें।')
      } else {
        setPunchMsg(raw)
      }
    } finally {
      setBusy(false)
    }
  }

  // @ts-expect-error - kept for future re-enable, intentionally unused
  async function _liveVerifyAndCapture() {
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c || !v.videoWidth) {
      setPunchMsg('Open the camera first.')
      return
    }
    setPunchMsg(null)
    setBusy(true)
    try {
      const desc = await runLivenessAndFaceDescriptor(v)
      setFaceDescriptorJson(descriptorToJson(desc))
      const blob = await captureVideoFrameToJpegBlob(v, c)
      if (blob && blob.size >= 8192) {
        setFaceBlob(blob)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(URL.createObjectURL(blob))
        setPunchMsg('Live check passed — tap Check in (face) or Check out (face).')
      } else {
        setFaceDescriptorJson(null)
        setPunchMsg('Photo too small after live check — adjust light and retry.')
      }
    } catch (e) {
      setFaceDescriptorJson(null)
      setPunchMsg((e as Error).message || 'Live check failed')
    } finally {
      setBusy(false)
    }
  }

  // @ts-expect-error - kept for future re-enable, intentionally unused
  async function _capturePreview() {
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c || !v.videoWidth) return
    const blob = await captureVideoFrameToJpegBlob(v, c)
    if (blob) {
      if (bioHint?.faceEmbeddingActive) {
        setFaceDescriptorJson(null)
      }
      setFaceBlob(blob)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(URL.createObjectURL(blob))
    }
  }

  // Keep a ref so shift-end and geo-fence callbacks always see the latest myToday
  const myTodayRef = useRef(myToday)
  useEffect(() => { myTodayRef.current = myToday }, [myToday])

  useEffect(() => {
    if (!user?.shift_end) return
    const [hh, mm] = String(user.shift_end).split(':').map((x) => Number(x) || 0)
    const targetMin = hh * 60 + mm
    let firedForDay: string | null = null
    const t = window.setInterval(() => {
      // IST-safe minutes-since-midnight regardless of device TZ
      const nowIst = new Date(Date.now() + 5.5 * 3600000)
      const istMin = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes()
      const dayKey = nowIst.toISOString().slice(0, 10)
      // Fire exactly once per day in a 2-minute window after shift_end
      if (istMin >= targetMin && istMin <= targetMin + 2 && firedForDay !== dayKey) {
        const cur = myTodayRef.current
        if (!cur?.punch_in_at || cur?.punch_out_at) return  // already out or not in
        firedForDay = dayKey
        const msg = 'आपका कार्य समय पूर्ण हो गया है, कृपया Clock Out करें।'
        speak(msg)
        notify('⏰ शिफ्ट समाप्त — Prakriti Herbs', msg)
      }
    }, 30000)
    return () => window.clearInterval(t)
  }, [user?.shift_end]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user?.branch_id || geoWarned || !navigator.geolocation) return
    let stop = false
    let watchId: number | null = null
    api<{ branches: { id: number; lat: number | null; lng: number | null; radius_meters: number }[] }>('/branches')
      .then((d) => {
        if (stop) return
        const b = (d.branches || []).find((x) => Number(x.id) === Number(user.branch_id))
        if (!b || b.lat == null || b.lng == null) return
        watchId = navigator.geolocation.watchPosition((pos) => {
          const r = Number(b.radius_meters || 300)
          const toRad = (n: number) => (n * Math.PI) / 180
          const R = 6371000
          const dLat = toRad(pos.coords.latitude - Number(b.lat))
          const dLng = toRad(pos.coords.longitude - Number(b.lng))
          const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(Number(b.lat))) *
              Math.cos(toRad(pos.coords.latitude)) *
              Math.sin(dLng / 2) ** 2
          const dist = 2 * R * Math.asin(Math.sqrt(a))
          if (dist > r) {
            const cur = myTodayRef.current
            const notYetOut = cur?.punch_in_at && !cur?.punch_out_at
            const msg = notYetOut
              ? 'आप बिना Clock Out किए लोकेशन से बाहर जा रहे हैं, कृपया पहले Clock Out करें, अन्यथा बाद में Clock Out मान्य नहीं होगा।'
              : 'आप ऑफिस के निर्धारित क्षेत्र से बाहर जा रहे हैं।'
            speak(msg)
            notify('📍 लोकेशन अलर्ट — Prakriti Herbs', msg)
            setGeoWarned(true)
          }
        })
      })
      .catch(() => {})
    return () => {
      stop = true
      if (watchId != null) navigator.geolocation.clearWatch(watchId)
    }
  }, [geoWarned, user?.branch_id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 pb-8">
      {/* ── Page header + section switcher ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1f5e3b]">Employee Dashboard</h1>
          <p className="text-sm text-[#1f5e3b]/70">
            {canAll
              ? 'आज की उपस्थिति, देरी और अनुपस्थित — एक जगह पर सब कुछ देखें।'
              : 'अटेंडेंस लगाएं — GPS, Face या Fingerprint से।'}
          </p>
        </div>
        {canAll && (
          <div className="flex shrink-0 gap-1 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-1">
            {([['attendance', '📊 Attendance'], ['employees', '👥 Employees'], ...(canBioAdmin ? [['biometrics', '🔐 Biometrics']] as [string, string][] : [])] as [string, string][]).map(([sec, label]) => (
              <button
                key={sec}
                type="button"
                onClick={() => setMainSection(sec as 'attendance' | 'employees' | 'biometrics')}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${mainSection === sec ? 'bg-[#1f5e3b] text-white shadow-sm' : 'text-[#1f5e3b]/70 hover:text-[#1f5e3b]'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* ── Employees section ── */}
      {mainSection === 'employees' && <EmployeesPage />}

      {/* ── Biometrics section ── */}
      {mainSection === 'biometrics' && <BiometricAdminPage />}

      {/* ── Attendance section ── */}
      {mainSection === 'attendance' && <>

      {/* ── Admin: Today Overview stat cards ── */}
      {canAll && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {([
            { label: 'कुल स्टाफ', sub: 'Total Staff', value: todayOverview?.totalStaff, color: 'from-[#1f5e3b] to-[#2e7d32]', status: '' },
            { label: 'उपस्थित', sub: 'Present Today', value: todayOverview?.present, color: 'from-emerald-500 to-emerald-600', status: 'present' },
            { label: 'देर से आए', sub: 'Late Today', value: todayOverview?.late, color: 'from-amber-400 to-amber-500', status: 'late' },
            { label: 'अनुपस्थित', sub: 'Absent Today', value: todayOverview?.absent, color: 'from-red-400 to-red-600', status: 'absent' },
            { label: 'छुट्टी पर', sub: 'On Leave Today', value: todayOverview?.onLeave ?? 0, color: 'from-sky-500 to-sky-600', status: 'leave' },
            { label: 'अभी ऑफिस में', sub: 'Currently In', value: liveRows.length, color: 'from-blue-500 to-blue-600', status: '__live__' },
          ] as { label: string; sub: string; value: number | undefined; color: string; status: string }[]).map((card) => (
            <button
              key={card.label}
              type="button"
              onClick={() => {
                if (card.status === '__live__') { setActiveTab('live') }
                else if (card.status === 'absent') { void openAbsentDrill() }
                else if (card.status === 'leave') { void openLeaveDrill() }
                else { setActiveTab('history'); setFilterStatus(card.status) }
              }}
              className={`group rounded-2xl bg-gradient-to-br ${card.color} p-4 text-center text-white shadow-md transition hover:shadow-xl hover:scale-[1.02] active:scale-[0.98]`}
            >
              <p className="text-3xl font-bold tabular-nums">{card.value ?? '—'}</p>
              <p className="mt-0.5 text-sm font-semibold">{card.label}</p>
              <p className="mt-0.5 text-[10px] text-white/70">{card.sub}</p>
            </button>
          ))}
        </div>
      )}

      {/* ── Missed clock-out yesterday banner ── */}
      {missedClockoutYesterday && (
        <div className="flex items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div>
            <p className="text-sm font-bold text-amber-900">⚠️ कल आप क्लॉकआउट करना भूल गए थे</p>
            <p className="text-xs text-amber-700 mt-0.5">
              {yesterday} को आपका Clock-Out रिकॉर्ड नहीं मिला। Admin से सुधार के लिए संपर्क करें।
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMissedClockoutDismissed(true)}
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-200"
          >
            ✕ Close
          </button>
        </div>
      )}

      {/* ── Staff & Manager Attendance Wizard ── */}
      {showPunchSection && <div className="space-y-4">

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-amber-900">⚠️ सूचना</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
              {warnings.map((w, idx) => <li key={idx}>{w.message}</li>)}
            </ul>
          </div>
        )}

        {/* Missed clock-out yesterday banner */}
        {missedClockoutYesterday && (
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
            <div>
              <p className="text-sm font-bold text-amber-900">⚠️ कल आप क्लॉकआउट करना भूल गए थे</p>
              <p className="text-xs text-amber-700 mt-0.5">
                {yesterday} को आपका Clock-Out रिकॉर्ड नहीं मिला। Admin से सुधार के लिए संपर्क करें।
              </p>
            </div>
            <button type="button" onClick={() => setMissedClockoutDismissed(true)}
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-200">
              ✕ Close
            </button>
          </div>
        )}

        {/* ══ STEP: IDLE — Today's status + Clock In/Out button ══ */}
        {flowStep === 'idle' && (
          <div className="ph-card overflow-hidden rounded-2xl shadow-lg">
            <div className="bg-gradient-to-br from-[#1f5e3b] to-[#2e7d32] px-6 py-5 text-white">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/20 text-2xl font-bold uppercase">
                  {user?.full_name?.charAt(0) ?? '?'}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold">{user?.full_name ?? '—'}</p>
                  <p className="text-sm text-emerald-100/80">
                    {(user as unknown as { role?: string })?.role?.replace(/_/g, ' ') ?? 'Staff'}
                    {' · '}ID: {(user as unknown as { login_id?: string })?.login_id ?? user?.id}
                  </p>
                </div>
              </div>
            </div>
            <div className="px-5 pb-5 pt-4 space-y-4">
              <div className="grid grid-cols-3 gap-2.5">
                <div className="rounded-xl bg-emerald-50 p-3">
                  <p className="text-[10px] font-semibold text-emerald-600/60">Check In</p>
                  <p className="mt-1 text-base font-bold text-emerald-700">
                    {myToday?.punch_in_at
                      ? new Date(myToday.punch_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : '—'}
                  </p>
                </div>
                <div className="rounded-xl bg-red-50 p-3">
                  <p className="text-[10px] font-semibold text-red-500/60">Check Out</p>
                  <p className="mt-1 text-base font-bold text-red-600">
                    {myToday?.punch_out_at
                      ? new Date(myToday.punch_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : '—'}
                  </p>
                </div>
                <div className="rounded-xl bg-[#f7fbf8] p-3">
                  <p className="text-[10px] font-semibold text-[#1f5e3b]/50">Status</p>
                  <p className="mt-1 text-sm font-bold text-[#1f5e3b]">
                    {myToday
                      ? myToday.status === 'present' ? '✅ Present'
                        : myToday.status === 'late' ? '⏰ Late'
                        : myToday.status === 'half_day' ? '☀️ Half Day'
                        : '❌ Absent'
                      : '— Absent'}
                  </p>
                </div>
              </div>
              <div className="rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] px-4 py-3">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[#1f5e3b]/40">
                  इस महीने — {new Date().toLocaleString('hi-IN', { month: 'long' })}
                </p>
                <div className="grid grid-cols-4 gap-2 text-center">
                  <div><p className="text-xl font-bold text-emerald-600">{mPresent}</p><p className="text-[10px] text-[#1f5e3b]/50">उपस्थित</p></div>
                  <div><p className="text-xl font-bold text-amber-500">{mLate}</p><p className="text-[10px] text-[#1f5e3b]/50">देर से</p></div>
                  <div><p className="text-xl font-bold text-blue-500">{mHalfDay}</p><p className="text-[10px] text-[#1f5e3b]/50">आधा दिन</p></div>
                  <div><p className="text-xl font-bold text-red-500">{mAbsent}</p><p className="text-[10px] text-[#1f5e3b]/50">अनुपस्थित</p></div>
                </div>
              </div>
              {punchMsg && (
                <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
                  punchMsg.startsWith('✅') || punchMsg.startsWith('🚪')
                    ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border border-red-200 bg-red-50 text-red-700'
                }`}>{punchMsg}</div>
              )}
              {autoPunchType === 'in' ? (
                <button type="button" disabled={busy}
                  onClick={() => void startClockFlow('in')}
                  className="w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-600 py-4 text-base font-bold text-white shadow-lg hover:from-emerald-600 hover:to-emerald-700 disabled:opacity-50 active:scale-[0.98] transition-all">
                  {busy ? '⏳ प्रतीक्षा करें...' : '🟢 Clock In — अटेंडेंस दर्ज करें'}
                </button>
              ) : canCheckOut ? (
                <button type="button" disabled={busy}
                  onClick={() => void startClockFlow('out')}
                  className="w-full rounded-2xl bg-gradient-to-r from-red-500 to-red-600 py-4 text-base font-bold text-white shadow-lg hover:from-red-600 hover:to-red-700 disabled:opacity-50 active:scale-[0.98] transition-all">
                  {busy ? '⏳ प्रतीक्षा करें...' : '🔴 Clock Out — जाने का समय दर्ज करें'}
                </button>
              ) : (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-4 text-center space-y-1.5">
                  <p className="text-sm font-bold text-blue-900">⏱️ Clock Out के लिए प्रतीक्षा करें</p>
                  {clockOutSecsLeft > 0 ? (
                    <p className="text-lg font-extrabold text-blue-700 tabular-nums">
                      {String(Math.floor(clockOutSecsLeft / 60)).padStart(2, '0')} मिनट{' '}
                      {String(clockOutSecsLeft % 60).padStart(2, '0')} सेकेंड
                    </p>
                  ) : null}
                  <p className="text-xs text-blue-600">
                    Check In के 30 मिनट बाद ही Clock Out कर सकते हैं।
                    {myToday?.punch_in_at && (
                      <> आपने {new Date(myToday.punch_in_at).toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' })} बजे Check In किया।</>
                    )}
                  </p>
                </div>
              )}
              {/* QR Code — always available, no GPS/WiFi needed */}
              <div className="rounded-2xl border border-purple-200 bg-purple-50/60 p-3">
                <div className="flex items-center gap-3 mb-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-100 text-lg">📷</div>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-[#1f5e3b]">QR Code से अटेंडेंस</p>
                    <p className="text-[11px] text-[#1f5e3b]/60">हमेशा उपलब्ध — GPS या WiFi की जरूरत नहीं</p>
                  </div>
                </div>
                <button type="button" disabled={busy}
                  onClick={() => { setFlowKind(autoPunchType === 'in' ? 'in' : 'out'); setPunchMsg(null); setFlowStep('qr-fallback') }}
                  className="w-full rounded-xl bg-purple-600 py-2.5 text-sm font-bold text-white shadow hover:bg-purple-700 disabled:opacity-50 active:scale-95 transition-transform">
                  📷 Admin का QR Scan करें
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Link to="/leaves"
                  className="flex items-center justify-center gap-2 rounded-xl border border-[#1f5e3b]/20 py-2.5 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5 active:scale-95 transition-transform">
                  📅 छुट्टी आवेदन
                </Link>
                <Link to="/identity"
                  className="flex items-center justify-center gap-2 rounded-xl border border-[#1f5e3b]/20 py-2.5 text-xs font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5 active:scale-95 transition-transform">
                  👤 Profile / Biometric
                </Link>
              </div>
              <ProfileUpdateRequestSection />
            </div>
          </div>
        )}

        {/* ══ STEP: GPS CHECKING ══ */}
        {flowStep === 'gps-checking' && (
          <div className="ph-card rounded-2xl p-8 text-center space-y-3">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
              <span className="text-3xl animate-pulse">📍</span>
            </div>
            <p className="font-bold text-[#1f5e3b]">GPS Location जांच रहे हैं...</p>
            <p className="text-sm text-[#1f5e3b]/60">कृपया Location permission allow करें और थोड़ा इंतजार करें</p>
            <div className="flex justify-center gap-1 pt-1">
              <div className="h-2 w-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="h-2 w-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="h-2 w-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        {/* ══ STEP: GPS FAILED — WiFi / QR fallback ══ */}
        {flowStep === 'gps-failed' && (
          <div className="space-y-3">
            <div className="ph-card rounded-2xl overflow-hidden">
              <div className={`${geoOutsideInfo ? 'bg-red-500' : 'bg-amber-500'} px-5 py-3 flex items-center gap-3`}>
                <span className="text-xl">📍</span>
                <div className="flex-1">
                  <p className="font-bold text-white text-sm">
                    {geoOutsideInfo ? 'आप Office से दूर हैं' : 'GPS Location उपलब्ध नहीं'}
                  </p>
                  <p className={`text-xs ${geoOutsideInfo ? 'text-red-100' : 'text-amber-100'}`}>
                    {flowKind === 'in' ? 'Clock In' : 'Clock Out'} के लिए वैकल्पिक तरीका चुनें
                  </p>
                </div>
                <button type="button" onClick={cancelFlow}
                  className="rounded-xl bg-white/20 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/30">
                  ← वापस
                </button>
              </div>
              <div className="px-5 py-3">
                {geoOutsideInfo ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 space-y-1">
                    <p className="text-sm font-bold text-red-800">
                      📏 आप office location से <span className="tabular-nums">{geoOutsideInfo.distance_m}</span> मीटर बाहर हैं
                    </p>
                    <p className="text-[11px] text-red-700">
                      {geoOutsideInfo.branchName ? `${geoOutsideInfo.branchName} branch` : 'Office'}
                      {geoOutsideInfo.radius_m != null && ` का allowed radius: ${geoOutsideInfo.radius_m === 0 ? 'exact location (strict)' : `${geoOutsideInfo.radius_m} मीटर`}`}
                    </p>
                  </div>
                ) : gpsPermState === 'denied' ? (
                  <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                    🚫 Location permission नहीं दी गई। Browser Settings → Site Settings → Location → Allow करें।
                  </p>
                ) : gpsPermState === 'unavailable' ? (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    📴 GPS बंद है। Phone Settings → Location → On करें, फिर Clock In दबाएं।
                  </p>
                ) : (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    ⏱️ GPS timeout या unavailable। नीचे दिए विकल्प आज़माएं।
                  </p>
                )}
              </div>
            </div>
            <div className="ph-card rounded-2xl p-5">
              <div className="flex items-start gap-3 mb-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-xl">📍</div>
                <div>
                  <p className="font-bold text-[#1f5e3b]">Location के अंदर जाएँ</p>
                  <p className="text-xs text-[#1f5e3b]/60">Office geo-fence के अंदर पहुँचकर दोबारा कोशिश करें</p>
                </div>
              </div>
              <button type="button" disabled={busy} onClick={() => void startClockFlow(flowKind)}
                className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white shadow hover:bg-emerald-700 disabled:opacity-50 active:scale-95 transition-transform">
                🔄 GPS दोबारा जांचें
              </button>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-[#1f5e3b]/10" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#1f5e3b]/40">या</span>
              <div className="h-px flex-1 bg-[#1f5e3b]/10" />
            </div>
            <div className="ph-card rounded-2xl p-5">
              <div className="flex items-start gap-3 mb-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-xl">📶</div>
                <div>
                  <p className="font-bold text-[#1f5e3b]">ऑफिस WiFi से अटेंडेंस</p>
                  <p className="text-xs text-[#1f5e3b]/60">सुनिश्चित करें कि आप ऑफिस के authorized WiFi से connected हैं</p>
                </div>
              </div>
              <button type="button" onClick={() => void confirmWifiAndProceed()}
                className="w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white shadow hover:bg-blue-700 active:scale-95 transition-transform">
                📶 WiFi से {flowKind === 'in' ? 'Check In' : 'Check Out'} करें →
              </button>
            </div>
          </div>
        )}

        {/* ══ STEP: WiFi SSID Selection ══ */}
        {flowStep === 'wifi-input' && (
          <div className="space-y-3">
            <div className="ph-card rounded-2xl overflow-hidden">
              <div className="bg-blue-600 px-5 py-3 flex items-center gap-3">
                <span className="text-xl">📶</span>
                <div className="flex-1">
                  <p className="font-bold text-white text-sm">ऑफिस WiFi की पुष्टि करें</p>
                  <p className="text-xs text-blue-100">अपने ऑफिस का WiFi network चुनें</p>
                </div>
                <button type="button" onClick={() => setFlowStep('gps-failed')}
                  className="rounded-xl bg-white/20 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/30">
                  ← वापस
                </button>
              </div>
              <div className="px-5 py-4 space-y-3">
                {wifiOptions.length > 0 ? (
                  <div>
                    <label className="text-xs font-bold text-[#1f5e3b]/70 mb-1 block">Office WiFi Network</label>
                    <select value={wifiSsid} onChange={(e) => { setWifiSsid(e.target.value); setWifiPassword('') }}
                      className="w-full rounded-xl border border-[#1f5e3b]/20 bg-white px-3 py-2.5 text-sm font-medium text-[#1f5e3b]">
                      {wifiOptions.map((n) => (
                        <option key={n.ssid} value={n.ssid}>{n.ssid}{n.requires_password ? ' 🔒' : ''}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="text-xs font-bold text-[#1f5e3b]/70 mb-1 block">WiFi Network का नाम (SSID)</label>
                    <input type="text" value={wifiSsid} onChange={(e) => setWifiSsid(e.target.value)}
                      placeholder="जैसे: PrakritiHerbs-Office"
                      className="w-full rounded-xl border border-[#1f5e3b]/20 bg-white px-3 py-2.5 text-sm font-medium text-[#1f5e3b] placeholder:text-[#1f5e3b]/30" />
                    <p className="text-[11px] text-[#1f5e3b]/50 mt-1">Phone Settings → WiFi में जो name दिख रहा है वही type करें</p>
                  </div>
                )}
                {(() => {
                  const sel = wifiOptions.find((n) => n.ssid.toLowerCase() === wifiSsid.trim().toLowerCase())
                  if (sel?.requires_password) {
                    return (
                      <div>
                        <label className="text-xs font-bold text-[#1f5e3b]/70 mb-1 block">WiFi Password</label>
                        <input type="password" value={wifiPassword} onChange={(e) => setWifiPassword(e.target.value)}
                          placeholder="Office WiFi password"
                          className="w-full rounded-xl border border-[#1f5e3b]/20 bg-white px-3 py-2.5 text-sm font-medium text-[#1f5e3b]" />
                      </div>
                    )
                  }
                  return null
                })()}
                {punchMsg && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 font-medium">{punchMsg}</div>
                )}
                <button type="button" onClick={submitWifiSelection}
                  className="w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white shadow hover:bg-blue-700 active:scale-95">
                  ✅ आगे बढ़ें — Biometric Step
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ STEP: BIOMETRIC — Face or Fingerprint (MANDATORY) ══ */}
        {flowStep === 'biometric' && (
          <div className="space-y-3">
            {/* Location verified banner */}
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-3">
              <span className="text-xl">✅</span>
              <div className="flex-1">
                <p className="text-sm font-bold text-emerald-800">
                  {flowLocationMethod === 'gps' ? '📍 GPS Location Verified' : '📶 WiFi Location Confirmed'}
                </p>
                <p className="text-xs text-emerald-700">
                  Location Step 1 ✓ — अब Step 2: Biometric verification अनिवार्य है
                </p>
              </div>
              <button type="button" onClick={cancelFlow}
                className="shrink-0 rounded-xl border border-emerald-300 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                ✕
              </button>
            </div>

            {/* Mandatory policy notice */}
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 flex items-start gap-2">
              <span className="text-base mt-0.5">🔐</span>
              <p className="text-xs text-amber-800 font-medium">
                <span className="font-bold">अनिवार्य नियम:</span> Attendance के लिए <span className="font-bold">Face</span> या <span className="font-bold">Fingerprint</span> में से एक verify करना जरूरी है। बिना Biometric के attendance दर्ज नहीं होगी।
              </p>
            </div>

            {/* No biometric enrolled — enrollment prompt + QR fallback (NO GPS bypass)
                Only shown when device doesn't support WebAuthn either (otherwise fingerprint
                card below handles first-time silent registration). */}
            {bioHint && !bioHint.hasFace && bioHint.webauthnCount === 0 && !browserSupportsWebAuthn() && (
              <div className="space-y-3">
                {/* Enrollment required card */}
                <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">⚠️</span>
                    <div>
                      <p className="font-bold text-amber-900">Biometric Registration अनिवार्य है</p>
                      <p className="text-xs text-amber-800 mt-1">
                        आपके account में कोई Face या Fingerprint register नहीं है।
                        Attendance के लिए Biometric enrollment जरूरी है — कृपया HR से मिलें या नीचे खुद register करें।
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Link to="/identity"
                      className="rounded-xl bg-amber-600 py-2.5 text-center text-xs font-bold text-white shadow hover:bg-amber-700">
                      🔐 Face Register
                    </Link>
                    <button type="button"
                      onClick={() => { setShowFaceEnrollModal(true); setEnrollMsg(null) }}
                      className="rounded-xl border border-amber-400 bg-white py-2.5 text-xs font-bold text-amber-800 hover:bg-amber-100">
                      📷 अभी Enroll करें
                    </button>
                  </div>
                </div>
                {/* QR fallback — admin-controlled, always allowed */}
                <div className="rounded-2xl border border-purple-200 bg-purple-50 p-4 space-y-2">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">📷</span>
                    <div>
                      <p className="font-bold text-purple-900">QR Code से Attendance (तत्काल विकल्प)</p>
                      <p className="text-xs text-purple-700 mt-0.5">
                        Admin के Kiosk QR code को scan करें — Biometric enrollment के बिना भी काम करेगा।
                      </p>
                    </div>
                  </div>
                  <button type="button" disabled={busy}
                    onClick={() => { setPunchMsg(null); setFlowStep('qr-fallback') }}
                    className="w-full rounded-xl bg-purple-600 py-2.5 text-sm font-bold text-white shadow hover:bg-purple-700 disabled:opacity-50 active:scale-95">
                    📷 Admin का QR Scan करें
                  </button>
                </div>
                <button type="button" onClick={cancelFlow}
                  className="w-full rounded-xl border border-[#1f5e3b]/20 py-2.5 text-sm font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5">
                  ← वापस
                </button>
              </div>
            )}
            {punchMsg && (
              <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
                punchMsg.startsWith('✅') || punchMsg.startsWith('🚪')
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border border-red-200 bg-red-50 text-red-700'
              }`}>{punchMsg}</div>
            )}

            {/* ── CASE 1 & 3: Face enrolled → show Face option ── */}
            {bioHint?.hasFace && (
              <div className="ph-card rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#1f5e3b]/10 text-2xl">📷</div>
                    <div>
                      <p className="font-bold text-[#1f5e3b]">Face Recognition</p>
                      <p className="text-xs text-[#1f5e3b]/50">चेहरे से अटेंडेंस</p>
                    </div>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✅ Enrolled</span>
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-[#1f5e3b]/60">
                    एक click — चेहरा सीधे camera की ओर रखें, अच्छी रोशनी में।
                  </p>
                  <video ref={videoRef} playsInline muted
                    className={`w-full max-h-56 rounded-xl border border-[#1f5e3b]/20 shadow-sm object-cover ${camOn ? 'block' : 'hidden'}`} />
                  <canvas ref={canvasRef} className="hidden" />
                  <button type="button" disabled={busy}
                    onClick={() => void oneClickFaceAttendance(flowKind)}
                    className="w-full rounded-xl bg-[#1f5e3b] py-3.5 text-base font-bold text-white shadow-lg hover:bg-[#2e7d32] disabled:opacity-60 active:scale-95">
                    {busy ? '⏳ कृपया रुकें...'
                      : flowKind === 'in' ? '📷 Face से Clock In' : '📷 Face से Clock Out'}
                  </button>
                  {bioHint?.pendingFace && (
                    <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      ⏳ Face update request pending — Admin approval का wait करें।
                    </p>
                  )}
                  {bioHint?.approvedFace && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 flex items-center justify-between gap-2">
                      <span>✅ Admin ने approve किया — face re-register करें।</span>
                      <Link to="/identity" className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[10px] font-bold text-white shrink-0">Update →</Link>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── CASE 2 & 3: Fingerprint enrolled → show Fingerprint option ──
                Also shown for first-time users (webauthnCount=0) when device supports
                WebAuthn — punchFingerprintWizard auto-registers silently on first tap. */}
            {((bioHint?.webauthnCount ?? 0) > 0 || browserSupportsWebAuthn()) && (
              <div className="ph-card rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#1f5e3b]/10 text-2xl">👆</div>
                    <div>
                      <p className="font-bold text-[#1f5e3b]">Fingerprint / Face Unlock</p>
                      <p className="text-xs text-[#1f5e3b]/50">Phone का अपना biometric</p>
                    </div>
                  </div>
                  {(bioHint?.webauthnCount ?? 0) > 0
                    ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✅ Enrolled</span>
                    : <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">👆 First Use</span>
                  }
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-[#1f5e3b]/60">
                    {(bioHint?.webauthnCount ?? 0) > 0
                      ? 'Phone का Fingerprint, Face या PIN — एक click में अटेंडेंस।'
                      : 'पहली बार: आपका Fingerprint/PIN automatically register होगा — बस नीचे tap करें।'
                    }
                  </p>
                  <button type="button" disabled={busy}
                    onClick={() => void punchFingerprintWizard(flowKind)}
                    className="w-full rounded-xl bg-gradient-to-r from-[#1f5e3b] to-[#2e7d32] py-3.5 text-base font-bold text-white shadow-lg hover:opacity-90 disabled:opacity-60 active:scale-95">
                    {busy ? '⏳ कृपया रुकें...'
                      : flowKind === 'in' ? '👆 Fingerprint से Clock In' : '👆 Fingerprint से Clock Out'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ STEP: QR FALLBACK ══ */}
        {flowStep === 'qr-fallback' && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <button type="button" onClick={cancelFlow}
                className="rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5">
                ← वापस
              </button>
              <div>
                <p className="font-bold text-[#1f5e3b]">📷 QR Code से अटेंडेंस</p>
                <p className="text-xs text-[#1f5e3b]/60">Admin द्वारा नियंत्रित Kiosk QR scan</p>
              </div>
            </div>
            <QrScanWidget
              onSuccess={() => { void load(); cancelFlow() }}
              todayPunchIn={myToday?.punch_in_at ?? null}
              todayPunchOut={myToday?.punch_out_at ?? null}
            />
          </div>
        )}

      </div>}


      <div className="ph-card rounded-2xl p-6">
        {/* ── Tab bar ── */}
        <div className="mb-5 flex flex-wrap gap-1 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-1">
          {([...(canAll ? ['live', 'monthly', 'overview'] : []), 'history'] as ('history' | 'live' | 'monthly' | 'overview')[]).map((tab) => {
            const labels: Record<string, string> = {
              history: canAll ? 'Attendance History' : 'अटेंडेंस रिकॉर्ड',
              live: `Live — अभी ऑफिस में (${liveRows.length})`,
              monthly: 'Monthly Summary',
              overview: `Overview${warnOverview ? ` · ${warnOverview.lateToday} late` : ''}`,
            }
            return (
              <button key={tab} type="button" onClick={() => setActiveTab(tab)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${activeTab === tab ? 'bg-[#1f5e3b] text-white shadow-sm' : 'text-[#1f5e3b]/70 hover:text-[#1f5e3b]'}`}>
                {labels[tab]}
              </button>
            )
          })}
        </div>

        {/* ── Live Status tab ── */}
        {activeTab === 'live' && (
          <div>
            <p className="mb-3 text-xs text-[#1f5e3b]/60">Employees who punched in today but have not yet punched out.</p>
            {liveRows.length === 0 ? (
              <p className="text-sm text-[#1f5e3b]/50">No one is currently checked in.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead><tr className="border-b border-[#1f5e3b]/10 text-xs font-semibold text-[#1f5e3b]/60">
                    <th className="py-2 pr-4">Employee</th>
                    <th className="py-2 pr-4">Employee ID</th>
                    <th className="py-2">Checked In At</th>
                  </tr></thead>
                  <tbody className="divide-y divide-[#1f5e3b]/5">
                    {liveRows.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-4 font-semibold text-[#14261a]">{r.full_name}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-[#546e7a]">{r.login_id || `#${r.id}`}</td>
                        <td className="py-2 text-xs text-[#546e7a]">{new Date(r.punch_in_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <button type="button" onClick={() => api<{ currently_in: LiveRow[] }>('/attendance/live-status').then((r) => setLiveRows(r.currently_in || []))}
              className="mt-3 text-xs font-semibold text-[#1f5e3b] underline">Refresh</button>
          </div>
        )}

        {/* ── Monthly Summary tab ── */}
        {activeTab === 'monthly' && (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-medium text-[#1f5e3b]">
                Month:
                <input type="month" value={monthPeriod} onChange={(e) => {
                  setMonthPeriod(e.target.value)
                  api<{ rows: MonthRow[] }>(`/attendance/month-summary?month=${e.target.value}`)
                    .then((r) => setMonthRows(r.rows || [])).catch(() => {})
                }} className="rounded-xl border border-[#1f5e3b]/15 px-2 py-1 text-sm" />
              </label>
              <p className="text-xs text-[#1f5e3b]/50">{monthRows.length} employees</p>
            </div>
            {monthRows.length === 0 ? (
              <p className="text-sm text-[#1f5e3b]/50">No data for selected month.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead><tr className="border-b border-[#1f5e3b]/10 text-xs font-semibold text-[#1f5e3b]/60">
                    <th className="py-2 pr-4">Employee</th>
                    <th className="py-2 pr-4">ID</th>
                    <th className="py-2 pr-4 text-center">Present</th>
                    <th className="py-2 pr-4 text-center">Late</th>
                    <th className="py-2 pr-4 text-center">Absent</th>
                    <th className="py-2 text-right">Work Hours</th>
                  </tr></thead>
                  <tbody className="divide-y divide-[#1f5e3b]/5">
                    {monthRows.map((r) => (
                      <tr key={r.id} className="hover:bg-[#f7fbf8]">
                        <td className="py-2 pr-4 font-semibold text-[#14261a]">{r.full_name}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-[#546e7a]">{r.login_id || `#${r.id}`}</td>
                        <td className="py-2 pr-4 text-center">
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">{r.present_days}</span>
                        </td>
                        <td className="py-2 pr-4 text-center">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.late_days > 0 ? 'bg-amber-100 text-amber-700' : 'bg-[#f0f0f0] text-[#90a4ae]'}`}>{r.late_days}</span>
                        </td>
                        <td className="py-2 pr-4 text-center">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.absent_days > 0 ? 'bg-red-100 text-red-700' : 'bg-[#f0f0f0] text-[#90a4ae]'}`}>{r.absent_days}</span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-xs font-medium text-[#37474f]">
                          {(r.work_minutes / 60).toFixed(1)}h
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Overview tab (admin) ── */}
        {activeTab === 'overview' && canAll && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-center">
                <p className="text-3xl font-bold text-amber-700">{warnOverview?.lateToday ?? '—'}</p>
                <p className="mt-1 text-xs font-semibold text-amber-900">Late Today</p>
              </div>
              <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-center">
                <p className="text-3xl font-bold text-red-700">{warnOverview?.missedPunchOut ?? '—'}</p>
                <p className="mt-1 text-xs font-semibold text-red-900">Missed Punch-Out</p>
              </div>
              <div className="rounded-xl border border-[#1f5e3b]/15 bg-[#f0f9f2] p-4 text-center">
                <p className="text-3xl font-bold text-[#1f5e3b]">{warnOverview?.leaveHeavyUsers?.length ?? '—'}</p>
                <p className="mt-1 text-xs font-semibold text-[#1f5e3b]/80">High Leave Usage (&ge;2 approved)</p>
              </div>
            </div>
            {warnOverview?.leaveHeavyUsers && warnOverview.leaveHeavyUsers.length > 0 && (
              <div className="rounded-xl border border-[#1f5e3b]/10 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/70">High Leave Users</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-xs font-semibold text-[#78909c]">
                      <th className="pb-1 pr-4 text-left">Employee</th>
                      <th className="pb-1 text-right">Approved Leaves (YTD)</th>
                    </tr></thead>
                    <tbody className="divide-y divide-[#1f5e3b]/5">
                      {warnOverview.leaveHeavyUsers.map((u) => (
                        <tr key={u.id} className="hover:bg-[#f7fbf8]">
                          <td className="py-1.5 pr-4 font-medium text-[#14261a]">{u.full_name}</td>
                          <td className="py-1.5 text-right font-bold text-[#e53935]">{u.approved_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <button type="button" onClick={() => api<WarnOverview>('/warnings/overview').then((r) => setWarnOverview(r)).catch(() => {})}
              className="text-xs font-semibold text-[#1f5e3b] underline">Refresh</button>
          </div>
        )}

        {/* ── History tab ── */}
        {activeTab === 'history' && <>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block font-medium text-[#1f5e3b]">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-[#1f5e3b]">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-[#1f5e3b]">Status</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm">
              <option value="">All</option>
              <option value="present">Present</option>
              <option value="late">Late</option>
              <option value="absent">Absent</option>
            </select>
          </label>
          {canAll && (
            <label className="text-sm">
              <span className="mb-1 block font-medium text-[#1f5e3b]">Branch</span>
              <select value={filterBranchId} onChange={(e) => setFilterBranchId(e.target.value)} className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm">
                <option value="">All</option>
                {branches.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-sm">
            <span className="mb-1 block font-medium text-[#1f5e3b]">Search</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name / employee id"
              className="rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={load}
            className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setFilterStatus('')
              setFilterBranchId('')
              setSearch('')
            }}
            className="rounded-xl border border-[#1f5e3b]/20 bg-white px-4 py-2 text-sm font-semibold text-[#1f5e3b]"
          >
            Clear filters
          </button>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => void downloadAttendanceExcel()}
              disabled={dlLoading}
              className="rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-1.5"
            >
              {dlLoading ? '⏳ Downloading…' : '⬇️ Download Excel'}
            </button>
            {dlErr && <p className="text-xs text-red-600">{dlErr}</p>}
          </div>
        </div>
        {err && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <p className="text-sm text-red-600">{err}</p>
            <button type="button" onClick={load} className="text-sm font-semibold text-[#2e7d32] underline">
              Retry
            </button>
          </div>
        )}
        {loading ? (
          <p className="mt-4 text-sm text-[#1f5e3b]/70">Loading…</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-[#1f5e3b]/10">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="bg-[#f7fbf8] text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/70">
                  <th className="px-4 py-3">Date</th>
                  {canAll && <th className="px-4 py-3">Employee</th>}
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Check In</th>
                  <th className="px-4 py-3">Check Out</th>
                  <th className="px-4 py-3">Hours</th>
                  <th className="px-4 py-3">Photo</th>
                  {canAll && <th className="px-4 py-3">Edit</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f5e3b]/5">
                {filtered.map((r) => {
                  const isLate = String(r.status).toLowerCase() === 'late'
                  const isAbsent = String(r.status).toLowerCase() === 'absent'
                  const hoursWorked = r.punch_in_at && r.punch_out_at
                    ? ((new Date(r.punch_out_at).getTime() - new Date(r.punch_in_at).getTime()) / 36e5)
                    : null
                  return (
                  <tr key={r.id} className={`transition hover:bg-[#f7fbf8] ${isLate ? 'bg-amber-50/60' : isAbsent ? 'bg-red-50/40' : ''}`}>
                    <td className="px-4 py-3 text-xs font-medium text-[#546e7a]">{r.work_date}</td>
                    {canAll && (
                      <td className="px-4 py-3 font-semibold text-[#14261a]">
                        {r.full_name || '—'}
                        {r.punch_method_in && (
                          <span className="ml-2 rounded-full bg-[#e8f5e9] px-1.5 py-0.5 text-[10px] font-bold text-[#2e7d32]">{r.punch_method_in}</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
                        r.status === 'present' ? 'bg-emerald-100 text-emerald-700' :
                        r.status === 'late' ? 'bg-amber-100 text-amber-700' :
                        r.status === 'half_day' ? 'bg-blue-100 text-blue-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {r.status === 'present' ? '✅' : r.status === 'late' ? '⏰' : r.status === 'half_day' ? '☀️' : '❌'}
                        {' '}{String(r.status).replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[#37474f]">
                      {r.punch_in_at ? new Date(r.punch_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : <span className="text-[#90a4ae]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#37474f]">
                      {r.punch_out_at ? new Date(r.punch_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : <span className="text-[#90a4ae]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold tabular-nums text-[#37474f]">
                      {hoursWorked !== null ? (
                        <span className={hoursWorked < 4 ? 'text-amber-600' : 'text-[#37474f]'}>{hoursWorked.toFixed(1)}h</span>
                      ) : <span className="text-[#90a4ae]">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {r.punch_in_photo ? (
                        <button
                          type="button"
                          className="rounded-lg bg-[#e8f5e9] px-2 py-1 text-xs font-semibold text-[#2e7d32] hover:bg-[#c8e6c9] transition"
                          onClick={() => window.open(r.punch_in_photo!, '_blank')}
                        >
                          📷 View
                        </button>
                      ) : (
                        <span className="text-[#90a4ae]">—</span>
                      )}
                    </td>
                    {canAll && (
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openEdit(r)}
                          className="rounded-lg border border-[#1f5e3b]/20 bg-white px-2 py-1 text-xs font-semibold text-[#1f5e3b] hover:bg-[#f0faf4] transition"
                        >
                          ✏️ Edit
                        </button>
                      </td>
                    )}
                  </tr>
                  )
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="mt-4 text-sm text-[#1f5e3b]/60">
                {search.trim() ? 'No attendance records match your search/filter.' : 'No records in selected range.'}
              </p>
            )}
          </div>
        )}
        </>}
      </div>
      </>}

      {/* ── Attendance Edit Modal (admin-only) ── */}
      {editRec && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal
          onClick={(e) => { if (e.target === e.currentTarget) setEditRec(null) }}
        >
          <div className="ph-card w-full max-w-md overflow-hidden rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1f5e3b]/10 px-5 py-4">
              <div>
                <h3 className="font-bold text-[#1f5e3b]">✏️ Edit Attendance Record</h3>
                <p className="text-xs text-[#1f5e3b]/55">Admin override — changes are audit-logged</p>
              </div>
              <button
                type="button"
                onClick={() => setEditRec(null)}
                className="rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-sm font-semibold text-[#1f5e3b]/60 hover:bg-[#f7fbf8]"
              >
                ✕ Close
              </button>
            </div>

            <div className="space-y-4 p-5">
              {/* Employee + Date — read-only */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[#1f5e3b]/50">Employee</p>
                  <p className="mt-1 text-sm font-semibold text-[#14261a]">{editRec.full_name || `#${editRec.user_id}`}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[#1f5e3b]/50">Date</p>
                  <p className="mt-1 text-sm font-semibold text-[#14261a]">{editRec.work_date}</p>
                </div>
              </div>

              {/* Status dropdown */}
              <div>
                <label className="text-xs font-semibold text-[#1f5e3b]">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                >
                  <option value="present">✅ Present</option>
                  <option value="late">⏰ Late</option>
                  <option value="half_day">☀️ Half Day</option>
                  <option value="absent">❌ Absent</option>
                  <option value="leave">🏖️ Leave</option>
                </select>
              </div>

              {/* Check-in time */}
              <div>
                <label className="text-xs font-semibold text-[#1f5e3b]">Check In</label>
                <input
                  type="datetime-local"
                  value={editIn}
                  onChange={(e) => setEditIn(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                />
              </div>

              {/* Check-out time */}
              <div>
                <label className="text-xs font-semibold text-[#1f5e3b]">Check Out</label>
                <input
                  type="datetime-local"
                  value={editOut}
                  onChange={(e) => setEditOut(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs font-semibold text-[#1f5e3b]">Notes (optional)</label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={2}
                  placeholder="Reason for edit…"
                  className="mt-1 w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30 resize-none"
                />
              </div>

              {editErr && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{editErr}</div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={editBusy}
                  className="flex-1 rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white hover:bg-[#174f32] disabled:opacity-50 transition"
                >
                  {editBusy ? 'Saving…' : '💾 Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditRec(null)}
                  className="rounded-xl border border-[#1f5e3b]/20 px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#f7fbf8] transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Face First-Time Enrollment Modal ── */}
      {showFaceEnrollModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal
        >
          <div className="ph-card w-full max-w-md overflow-hidden rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1f5e3b]/10 px-5 py-4">
              <div>
                <h3 className="font-bold text-[#1f5e3b]">📷 Face Registration</h3>
                <p className="text-xs text-[#1f5e3b]/55">पहली बार अपना चेहरा रजिस्टर करें</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowFaceEnrollModal(false)
                  stopEnrollCamera()
                  setEnrollFaceBlob(null)
                  setEnrollDescriptorJson(null)
                  if (enrollPreviewUrl) { URL.revokeObjectURL(enrollPreviewUrl); setEnrollPreviewUrl(null) }
                  setEnrollMsg(null)
                }}
                className="rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-sm font-semibold text-[#1f5e3b]/60"
              >
                ✕ Close
              </button>
            </div>
            <div className="space-y-3 p-5">
              <p className="text-xs text-[#1f5e3b]/70">
                Camera खोलें → <strong>Live Verify &amp; Capture</strong> दबाएं (एक बार पलकें झपकाएं + हल्का सिर हिलाएं) → <strong>Save &amp; Register</strong> करें।
              </p>
              {enrollMsg && (
                <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
                  enrollMsg.startsWith('✅') ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : enrollMsg.startsWith('🚫') || enrollMsg.startsWith('📷') ? 'bg-amber-50 text-amber-800 border border-amber-200'
                    : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {enrollMsg}
                </div>
              )}
              {/* Video ALWAYS in DOM — enrollVideoRef never null when startEnrollCamera() fires */}
              <video
                ref={enrollVideoRef}
                playsInline
                muted
                autoPlay
                className={`w-full max-h-52 rounded-xl border border-[#1f5e3b]/20 object-cover bg-black ${enrollCamOn ? 'block' : 'hidden'}`}
              />
              <canvas ref={enrollCanvasRef} className="hidden" />
              {!enrollCamOn ? (
                <button
                  type="button"
                  disabled={enrollBusy}
                  onClick={() => void startEnrollCamera()}
                  className="w-full rounded-xl bg-[#1f5e3b] py-2.5 text-sm font-bold text-white disabled:opacity-50 hover:bg-[#2e7d32]"
                >
                  📷 Camera खोलें
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={enrollBusy}
                      onClick={() => void liveVerifyAndCaptureEnroll()}
                      className="flex-1 rounded-xl bg-[#2e7d32] py-2.5 text-sm font-bold text-white disabled:opacity-50"
                    >
                      {enrollBusy ? '⏳ Live check हो रहा है... (4 sec)' : '👁️ Live Verify & Capture'}
                    </button>
                    <button
                      type="button"
                      disabled={enrollBusy}
                      onClick={() => void captureEnrollSimple()}
                      className="rounded-xl border border-[#1f5e3b]/20 bg-white px-3 py-2.5 text-xs font-semibold text-[#1f5e3b] hover:bg-[#f7fbf8] disabled:opacity-50"
                      title="AI model के बिना सीधा Capture (Admin बाद में verify करेगा)"
                    >
                      📸 Simple
                    </button>
                    <button
                      type="button"
                      onClick={stopEnrollCamera}
                      className="rounded-xl border border-[#1f5e3b]/20 px-3 py-2.5 text-sm text-[#1f5e3b] hover:bg-[#f7fbf8]"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="text-[10px] text-[#1f5e3b]/50 text-center">
                    Live Verify = AI blink detection · Simple = direct photo capture
                  </p>
                </div>
              )}
              {enrollPreviewUrl && (
                <div className="space-y-2">
                  <img
                    src={enrollPreviewUrl}
                    alt="Captured face"
                    className="w-full max-h-44 rounded-xl border border-[#1f5e3b]/15 object-cover"
                  />
                  <button
                    type="button"
                    disabled={enrollBusy || !enrollFaceBlob}
                    onClick={() => void submitFaceEnrollment()}
                    className="w-full rounded-xl bg-[#1f5e3b] py-3 text-sm font-bold text-white shadow disabled:opacity-50 hover:bg-[#2e7d32]"
                  >
                    {enrollBusy ? '⏳ Saving...' : '✅ Face Save & Register करें'}
                  </button>
                  {!enrollDescriptorJson && (
                    <p className="text-center text-[10px] text-amber-600">
                      💡 "Live Verify" से AI embedding भी save होगी — बेहतर recognition के लिए recommended
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── On Leave Today drill modal ── */}
      {leaveDrill.open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setLeaveDrill((s) => ({ ...s, open: false }))}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-sky-100 bg-sky-50 px-5 py-3">
              <div>
                <p className="text-lg font-bold text-sky-700">📅 छुट्टी पर — On Leave Today</p>
                <p className="text-xs text-sky-600/80">
                  {leaveDrill.loading ? 'Loading…' : `${leaveDrill.rows.length} staff आज leave पर हैं`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLeaveDrill((s) => ({ ...s, open: false }))}
                className="rounded-lg px-3 py-1 text-sm font-semibold text-sky-700 hover:bg-sky-100"
              >
                ✕ Close
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto p-4">
              {leaveDrill.loading && (
                <p className="py-8 text-center text-sm text-[#1f5e3b]/60">Loading leave list…</p>
              )}
              {leaveDrill.error && (
                <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{leaveDrill.error}</p>
              )}
              {!leaveDrill.loading && !leaveDrill.error && leaveDrill.rows.length === 0 && (
                <p className="py-8 text-center text-sm text-[#1f5e3b]/70">कोई भी staff आज leave पर नहीं है।</p>
              )}
              {!leaveDrill.loading && leaveDrill.rows.length > 0 && (
                <ul className="divide-y divide-[#1f5e3b]/10">
                  {leaveDrill.rows.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[#1f3a2a]">{p.full_name}</p>
                        <p className="truncate text-xs text-[#1f5e3b]/60">
                          {p.login_id || p.email || `#${p.id}`}
                          {p.branch_name ? ` · ${p.branch_name}` : ''}
                        </p>
                        {(p.leave_from || p.leave_to) && (
                          <p className="mt-1 truncate text-[11px] text-sky-700/80">
                            {p.leave_from === p.leave_to ? p.leave_from : `${p.leave_from || '—'} → ${p.leave_to || '—'}`}
                            {p.leave_reason ? ` · ${p.leave_reason}` : ''}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 rounded-full bg-sky-100 px-2.5 py-0.5 text-[11px] font-semibold capitalize text-sky-700">
                        {p.leave_type || 'leave'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Absent Today drill modal ── */}
      {absentDrill.open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setAbsentDrill((s) => ({ ...s, open: false }))}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-red-100 bg-red-50 px-5 py-3">
              <div>
                <p className="text-lg font-bold text-red-700">अनुपस्थित — Absent Today</p>
                <p className="text-xs text-red-600/80">
                  {absentDrill.loading ? 'Loading…' : `${absentDrill.rows.length} staff have not punched in today`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAbsentDrill((s) => ({ ...s, open: false }))}
                className="rounded-lg px-3 py-1 text-sm font-semibold text-red-700 hover:bg-red-100"
              >
                ✕ Close
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto p-4">
              {absentDrill.loading && (
                <p className="py-8 text-center text-sm text-[#1f5e3b]/60">Loading absent staff list…</p>
              )}
              {absentDrill.error && (
                <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{absentDrill.error}</p>
              )}
              {!absentDrill.loading && !absentDrill.error && absentDrill.rows.length === 0 && (
                <p className="py-8 text-center text-sm text-emerald-700">🎉 कोई भी staff आज absent नहीं है!</p>
              )}
              {!absentDrill.loading && absentDrill.rows.length > 0 && (
                <ul className="divide-y divide-[#1f5e3b]/10">
                  {absentDrill.rows.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#1f3a2a]">{p.full_name}</p>
                        <p className="truncate text-xs text-[#1f5e3b]/60">
                          {p.login_id || p.email || `#${p.id}`}
                          {p.branch_name ? ` · ${p.branch_name}` : ''}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-semibold text-red-700">
                        Absent
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
