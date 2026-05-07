import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import * as faceapi from 'face-api.js'
import { captureVideoFrameToJpegBlob, getFaceCameraConstraints } from '../lib/faceCapture'
import { descriptorToJson, ensureFaceModelsLoaded } from '../lib/faceApiLiveness'
import {
  fetchWebAuthnAttendanceStatus,
  type WebAuthnAttendanceStatus,
} from '../lib/webauthnAttendance'

// ── Role helpers ──────────────────────────────────────────────────────────────
const CAN_MANAGE = ['SUPER_ADMIN', 'ADMIN', 'LOCATION_MANAGER', 'ATTENDANCE_MANAGER']
const CAN_REGISTER = ['SUPER_ADMIN', 'ADMIN']

// ── Settings ──────────────────────────────────────────────────────────────────
type KioskSettings = {
  allowFace: boolean
  allowFingerprint: boolean
  allowGps: boolean
  allowPin: boolean
  allowManual: boolean
  allowFaceReg: boolean
  allowManualOverride: boolean
  voiceFeedback: boolean
  errorAlerts: boolean
}
const DEFAULT_SETTINGS: KioskSettings = {
  allowFace: true, allowFingerprint: false, allowGps: true, allowPin: true,
  allowManual: false, allowFaceReg: true, allowManualOverride: true,
  voiceFeedback: true, errorAlerts: true,
}
function loadSettings(): KioskSettings {
  try { const r = localStorage.getItem('kiosk-settings'); if (r) return { ...DEFAULT_SETTINGS, ...JSON.parse(r) } } catch { /* ignore */ }
  return DEFAULT_SETTINGS
}
function saveSettings(s: KioskSettings) {
  try { localStorage.setItem('kiosk-settings', JSON.stringify(s)) } catch { /* ignore */ }
}

// ── Voice ─────────────────────────────────────────────────────────────────────
function speak(text: string, enabled: boolean) {
  if (!enabled || !window.speechSynthesis) return
  try { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'hi-IN'; u.rate = 0.9; window.speechSynthesis.speak(u) } catch { /* ignore */ }
}

// ── View type ─────────────────────────────────────────────────────────────────
type View = 'home' | 'face' | 'search' | 'pin' | 'manual' | 'register' | 'biometric' | 'qr'

// ── Employee search result ────────────────────────────────────────────────────
type EmpResult = {
  id: number
  full_name: string
  login_id: string
  branch_id: number | null
  punch_in_at: string | null
  punch_out_at: string | null
  att_status: string | null
}

// ── Pin status result ─────────────────────────────────────────────────────────
type PinStatus = {
  id: number
  full_name: string
  login_id: string
  punch_in_at: string | null
  punch_out_at: string | null
  att_status: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function empPunchState(e: Pick<EmpResult, 'punch_in_at' | 'punch_out_at'>): 'none' | 'in' | 'done' {
  if (!e.punch_in_at) return 'none'
  if (!e.punch_out_at) return 'in'
  return 'done'
}
function punchLabel(state: 'none' | 'in' | 'done') {
  if (state === 'none') return { text: 'IN', icon: '✅', color: 'from-emerald-500 to-emerald-700', type: 'in' as const }
  if (state === 'in') return { text: 'OUT', icon: '🚪', color: 'from-amber-500 to-orange-600', type: 'out' as const }
  return null
}

function fmt12(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// ── Clock hook ────────────────────────────────────────────────────────────────
function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

// ─────────────────────────────────────────────────────────────────────────────
export function KioskPage() {
  const { user } = useAuth()
  const role = (user?.role ?? '').toUpperCase()
  const canManage = CAN_MANAGE.includes(role)
  const canRegister = CAN_REGISTER.includes(role)

  const [settings, setSettings] = useState<KioskSettings>(loadSettings)
  const [view, setView] = useState<View>('home')
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [msg, setMsg] = useState<string | null>(null)
  const [msgKind, setMsgKind] = useState<'ok' | 'err' | 'info'>('info')
  const [busy, setBusy] = useState(false)

  const now = useClock()

  // ── Refs for face scan ──
  const waRef = useRef<WebAuthnAttendanceStatus | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [camOn, setCamOn] = useState(false)
  const [faceDetected, setFaceDetected] = useState(false)
  const [autoFaceEnabled, setAutoFaceEnabled] = useState(true)
  const [lastMatchName, setLastMatchName] = useState('')
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [capturedDescriptorJson, setCapturedDescriptorJson] = useState<string | null>(null)

  // ── Search view state ──
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<EmpResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedEmp, setSelectedEmp] = useState<EmpResult | null>(null)

  // ── PIN view state ──
  const [pinLoginId, setPinLoginId] = useState('')
  const [pinValue, setPinValue] = useState('')
  const [pinStatus, setPinStatus] = useState<PinStatus | null>(null)
  const [pinVerified, setPinVerified] = useState(false)

  // ── Register / Biometric state ──
  const [registerLoginId, setRegisterLoginId] = useState('')

  // ── Manual override state ──
  const [manualEmpId, setManualEmpId] = useState('')
  const [manualDate, setManualDate] = useState(new Date().toISOString().slice(0, 10))

  // ── QR display state ──
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrCountdown, setQrCountdown] = useState(15)
  const [qrLoading, setQrLoading] = useState(false)
  const qrExpiresAtRef = useRef<number>(0)

  // ── Message helper ──
  function showMsg(text: string, kind: 'ok' | 'err' | 'info' = 'info', voice?: string) {
    setMsg(text); setMsgKind(kind)
    if (voice) speak(voice, settings.voiceFeedback)
    if (kind !== 'info') setTimeout(() => setMsg(null), 7000)
  }

  function clearMsg() { setMsg(null) }

  function updateSetting<K extends keyof KioskSettings>(key: K, val: KioskSettings[K]) {
    setSettings(prev => { const next = { ...prev, [key]: val }; saveSettings(next); return next })
  }

  // ── Reset view-local state on navigate ──
  function goHome() {
    stopFaceCamera()
    setView('home'); clearMsg()
    setSearchQ(''); setSearchResults([]); setSelectedEmp(null)
    setPinLoginId(''); setPinValue(''); setPinStatus(null); setPinVerified(false)
    setRegisterLoginId('')
    setManualEmpId('')
  }

  function goView(v: View) {
    clearMsg()
    setSearchQ(''); setSearchResults([]); setSelectedEmp(null)
    setPinLoginId(''); setPinValue(''); setPinStatus(null); setPinVerified(false)
    setRegisterLoginId(''); setCapturedBlob(null); setCapturedDescriptorJson(null)
    setView(v)
    if (v !== 'face' && v !== 'register' && v !== 'biometric') stopFaceCamera()
  }

  // ── QR token fetch ──
  const qrFetchingRef = useRef(false)
  const fetchQrToken = useCallback(async () => {
    if (qrFetchingRef.current) return
    qrFetchingRef.current = true
    setQrLoading(true)
    try {
      const r = await api<{ token: string; expires_at: number }>('/kiosk/qr/token')
      qrExpiresAtRef.current = r.expires_at
      setQrCountdown(Math.max(0, Math.round((r.expires_at - Date.now()) / 1000)))
      const dataUrl = await QRCode.toDataURL(r.token, { width: 280, margin: 2, color: { dark: '#0a2014', light: '#ffffff' } })
      setQrDataUrl(dataUrl)
    } catch (e) {
      showMsg((e as Error).message || 'QR generate नहीं हो सका।', 'err')
    } finally {
      setQrLoading(false)
      qrFetchingRef.current = false
    }
  }, [])

  // QR countdown ticker + auto-refresh
  useEffect(() => {
    if (view !== 'qr') return
    void fetchQrToken()
    const tick = setInterval(() => {
      const remaining = Math.max(0, Math.round((qrExpiresAtRef.current - Date.now()) / 1000))
      setQrCountdown(remaining)
      if (remaining <= 0) void fetchQrToken()
    }, 1000)
    return () => clearInterval(tick)
  }, [view, fetchQrToken])

  // ── WebAuthn ──
  const refreshWa = useCallback(async () => {
    try { const s = await fetchWebAuthnAttendanceStatus(); waRef.current = s; return s }
    catch { const off: WebAuthnAttendanceStatus = { mode: 'off', credCount: 0, punchRequiresWebAuthn: false, rpId: '' }; waRef.current = off; return off }
  }, [])
  useEffect(() => { void refreshWa() }, [refreshWa])

  // ── Face camera ──
  async function startFaceCamera() {
    clearMsg()
    try {
      await ensureFaceModelsLoaded()
      const stream = await navigator.mediaDevices.getUserMedia(getFaceCameraConstraints())
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play() }
      setCamOn(true)
    } catch (e) { showMsg((e as Error).message || 'Camera शुरू नहीं हो सका।', 'err', 'Camera शुरू नहीं हो सका') }
  }

  function stopFaceCamera() {
    const v = videoRef.current
    if (v?.srcObject) { ;(v.srcObject as MediaStream).getTracks().forEach(t => t.stop()); v.srcObject = null }
    setCamOn(false); setFaceDetected(false)
  }

  // ── Auto face scan loop ──
  useEffect(() => {
    if (!camOn || !autoFaceEnabled || !settings.allowFace) return
    if (view !== 'face') return
    let active = true
    const timer = window.setInterval(async () => {
      if (!active || busy) return
      if (Date.now() < cooldownUntil) return
      const v = videoRef.current; const c = canvasRef.current
      if (!v || !c || !v.videoWidth) return
      try {
        const det = await faceapi
          .detectSingleFace(v, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 }))
          .withFaceLandmarks().withFaceDescriptor()
        setFaceDetected(!!det)
        if (!det) return
        const blob = await captureVideoFrameToJpegBlob(v, c)
        if (!blob) return
        const descriptorJson = descriptorToJson(det.descriptor)
        setCapturedBlob(blob); setCapturedDescriptorJson(descriptorJson)
        const fdMatch = new FormData()
        fdMatch.append('photo', blob, 'face.jpg'); fdMatch.append('faceDescriptor', descriptorJson)
        const m = await api<{ matched_user_id: number; full_name: string; login_id: string }>('/kiosk/face/match', { method: 'POST', body: fdMatch })
        const fdPunch = new FormData()
        fdPunch.append('photo', blob, 'face.jpg'); fdPunch.append('faceDescriptor', descriptorJson)
        fdPunch.append('matched_user_id', String(m.matched_user_id))
        await api('/attendance/face-punch', { method: 'POST', body: fdPunch })
        setLastMatchName(m.full_name)
        showMsg(`✅ ${m.full_name} — अटेंडेंस सफलतापूर्वक लग गई`, 'ok', 'अटेंडेंस सफलतापूर्वक लग गई')
        setCooldownUntil(Date.now() + 8000)
      } catch (e) {
        const text = (e as Error).message || ''
        if (text.toLowerCase().includes('not registered')) {
          if (settings.errorAlerts) showMsg('चेहरा नहीं पहचाना गया — Search या PIN का उपयोग करें', 'err', 'चेहरा नहीं पहचाना गया')
          setCooldownUntil(Date.now() + 2500)
        } else if (text.toLowerCase().includes('already punched out')) {
          showMsg('आज की अटेंडेंस पहले ही हो चुकी है', 'info', 'अटेंडेंस पहले हो चुकी है')
          setCooldownUntil(Date.now() + 5000)
        } else if (!text.toLowerCase().includes('network')) {
          if (settings.errorAlerts) showMsg(text, 'err')
        }
      }
    }, 1800)
    return () => { active = false; window.clearInterval(timer) }
  }, [autoFaceEnabled, camOn, busy, cooldownUntil, settings.allowFace, settings.errorAlerts, view])

  // ── Search employees ──
  useEffect(() => {
    if (view !== 'search') return
    if (searchQ.trim().length < 1) { setSearchResults([]); return }
    const t = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const r = await api<{ employees: EmpResult[] }>(`/kiosk/search?q=${encodeURIComponent(searchQ)}`)
        setSearchResults(r.employees)
      } catch { /* ignore */ }
      finally { setSearchLoading(false) }
    }, 350)
    return () => clearTimeout(t)
  }, [searchQ, view])

  // ── Search punch ──
  async function searchPunch(emp: EmpResult, type: 'in' | 'out') {
    setBusy(true); clearMsg()
    try {
      await api('/kiosk/search/punch', { method: 'POST', body: JSON.stringify({ employee_id: emp.id, type }) })
      const label = type === 'in' ? 'अटेंडेंस लग गई' : 'आप बाहर हो गए'
      showMsg(`✅ ${emp.full_name} — ${label}`, 'ok', label)
      setSelectedEmp(null); setSearchQ(''); setSearchResults([])
    } catch (e) { showMsg((e as Error).message, 'err', 'कुछ गड़बड़ हुई')
    } finally { setBusy(false) }
  }

  // ── PIN verify ──
  async function pinVerify() {
    if (!pinLoginId.trim() || !pinValue.trim()) { showMsg('Employee ID और PIN दोनों डालें।', 'err'); return }
    setBusy(true); clearMsg()
    try {
      const r = await api<PinStatus>(`/kiosk/pin/status?login_id=${encodeURIComponent(pinLoginId)}&pin=${encodeURIComponent(pinValue)}`)
      setPinStatus(r); setPinVerified(true)
    } catch (e) { showMsg((e as Error).message || 'Invalid PIN', 'err', 'PIN गलत है')
    } finally { setBusy(false) }
  }

  // ── PIN punch (smart — only correct type) ──
  async function pinPunchSmart(type: 'in' | 'out') {
    if (!pinStatus) return
    setBusy(true); clearMsg()
    try {
      await api('/kiosk/pin/punch', { method: 'POST', body: JSON.stringify({ login_id: pinLoginId, pin: pinValue, type }) })
      const label = type === 'in' ? 'अटेंडेंस लग गई' : 'आप बाहर हो गए'
      showMsg(`✅ ${pinStatus.full_name} — ${label}`, 'ok', label)
      void refreshWa()
      setPinLoginId(''); setPinValue(''); setPinStatus(null); setPinVerified(false)
    } catch (e) { showMsg((e as Error).message, 'err', 'कुछ गड़बड़ हुई')
    } finally { setBusy(false) }
  }

  // ── Manual override ──
  async function manualOverride(status: 'present' | 'absent' | 'leave') {
    setBusy(true); clearMsg()
    try {
      await api('/attendance/manual', {
        method: 'POST',
        body: JSON.stringify({ userId: Number(manualEmpId), workDate: manualDate, status, notes: 'Kiosk manager override' }),
      })
      showMsg(`✅ ${status} marked for #${manualEmpId}`, 'ok')
      setManualEmpId('')
    } catch (e) { showMsg((e as Error).message, 'err')
    } finally { setBusy(false) }
  }

  // ── Face register ──
  async function registerFaceFromCapture() {
    if (!registerLoginId.trim() || !capturedBlob || !capturedDescriptorJson) {
      showMsg('Employee ID डालें और चेहरा capture करें।', 'err'); return
    }
    setBusy(true); clearMsg()
    try {
      const fd = new FormData()
      fd.append('photo', capturedBlob, 'face.jpg')
      fd.append('faceDescriptor', capturedDescriptorJson)
      fd.append('login_id', registerLoginId.trim())
      await api('/kiosk/face/register', { method: 'POST', body: fd })
      showMsg('✅ चेहरा सफलतापूर्वक Register हो गया।', 'ok', 'चेहरा रजिस्टर हो गया')
      setRegisterLoginId(''); setCapturedBlob(null); setCapturedDescriptorJson(null)
    } catch (e) { showMsg((e as Error).message, 'err')
    } finally { setBusy(false) }
  }

  // ── Styles ──
  const msgBg = msgKind === 'ok' ? 'bg-emerald-500/95' : msgKind === 'err' ? 'bg-red-500/95' : 'bg-white/20'
  const dateStr = now.toLocaleDateString('hi-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })

  // ─────────────────────────────────────────────────────────────────────────
  // ── Method Cards Data ──────────────────────────────────────────────────
  const methodCards = [
    canManage && {
      id: 'qr', icon: '📱', label: 'QR Kiosk', sub: 'Mobile scan के लिए QR',
      color: 'from-cyan-600 to-cyan-800', border: 'border-cyan-500/30',
      show: true,
    },
    settings.allowFace && {
      id: 'face', icon: '📷', label: 'Face Scan', sub: 'चेहरे से अटेंडेंस',
      color: 'from-emerald-600 to-emerald-800', border: 'border-emerald-500/30',
      show: true,
    },
    {
      id: 'search', icon: '🔍', label: 'Search & Mark', sub: 'नाम/ID से ढूंढें',
      color: 'from-blue-600 to-blue-800', border: 'border-blue-500/30',
      show: true,
    },
    settings.allowPin && {
      id: 'pin', icon: '🔢', label: 'PIN Entry', sub: 'ID + PIN से अटेंडेंस',
      color: 'from-indigo-600 to-indigo-800', border: 'border-indigo-500/30',
      show: true,
    },
    canManage && settings.allowManualOverride && {
      id: 'manual', icon: '📝', label: 'Manual Mark', sub: 'Manager: मैनुअल एंट्री',
      color: 'from-amber-600 to-orange-700', border: 'border-amber-500/30',
      show: true,
    },
    canRegister && settings.allowFaceReg && {
      id: 'register', icon: '🪪', label: 'First Registration', sub: 'नया चेहरा / PIN Register',
      color: 'from-purple-600 to-purple-800', border: 'border-purple-500/30',
      show: true,
    },
    canManage && {
      id: 'biometric', icon: '🔄', label: 'Biometric Update', sub: 'चेहरा / PIN अपडेट करें',
      color: 'from-rose-600 to-rose-800', border: 'border-rose-500/30',
      show: true,
    },
  ].filter(Boolean) as { id: View; icon: string; label: string; sub: string; color: string; border: string; show: boolean }[]

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="relative flex min-h-screen flex-col bg-gradient-to-br from-[#071a0f] via-[#0f3020] to-[#1a4d30] text-white select-none">

      {/* ── HEADER ── */}
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 px-5 py-3 bg-black/30 backdrop-blur-sm border-b border-white/10">
        <div className="flex items-center gap-3">
          {view !== 'home' && (
            <button
              type="button"
              onClick={goHome}
              className="rounded-xl border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 active:scale-95 transition-transform"
            >
              ← वापस
            </button>
          )}
          <div>
            <p className="text-base font-bold tracking-wide">🌿 Prakriti Herbs — अटेंडेंस कियोस्क</p>
            <p className="text-xs text-white/50">{dateStr}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-xl font-mono font-bold text-emerald-300">{timeStr}</p>
          </div>
          {canManage && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-xl border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
            >
              ⚙️ Settings
            </button>
          )}
        </div>
      </div>

      {/* ── TIME (mobile) ── */}
      <div className="px-5 pt-4 text-center sm:hidden">
        <p className="text-3xl font-mono font-bold text-emerald-300">{timeStr}</p>
      </div>

      {/* ── STATUS MESSAGE ── */}
      {msg && (
        <div className={`mx-5 mt-3 rounded-2xl px-5 py-4 text-center text-lg font-bold shadow-lg ${msgBg} text-white`}>
          {msg}
          <button type="button" onClick={clearMsg} className="ml-3 text-sm font-normal opacity-70">✕</button>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          HOME — METHOD CARDS
      ════════════════════════════════════════════════════════ */}
      {view === 'home' && (
        <div className="flex-1 p-5">
          <p className="mb-4 text-center text-sm font-semibold uppercase tracking-widest text-white/40">
            अटेंडेंस का तरीका चुनें
          </p>
          <div className="grid grid-cols-2 gap-4 max-w-2xl mx-auto">
            {methodCards.map(card => (
              <button
                key={card.id}
                type="button"
                onClick={() => goView(card.id)}
                className={`group relative flex flex-col items-center justify-center gap-3 rounded-3xl border ${card.border} bg-gradient-to-br ${card.color} p-6 shadow-xl hover:scale-[1.03] active:scale-95 transition-transform min-h-[130px]`}
              >
                <span className="text-4xl">{card.icon}</span>
                <div className="text-center">
                  <p className="text-base font-bold leading-tight">{card.label}</p>
                  <p className="text-xs text-white/70 mt-0.5">{card.sub}</p>
                </div>
              </button>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-white/30">
            सभी अटेंडेंस रिकॉर्ड Audit Log में सुरक्षित रहती हैं
          </p>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          QR KIOSK VIEW — display QR for mobile scan
      ════════════════════════════════════════════════════════ */}
      {view === 'qr' && canManage && (
        <div className="flex-1 flex flex-col items-center justify-center gap-5 p-5">
          <div className="text-center">
            <p className="text-2xl font-bold mb-1">📱 QR Kiosk</p>
            <p className="text-sm text-white/50">Employee अपने phone से scan करें → अटेंडेंस दर्ज होगी</p>
          </div>

          {/* QR Code */}
          <div className="relative flex flex-col items-center justify-center rounded-3xl bg-white p-4 shadow-2xl shadow-cyan-500/20 border-4 border-cyan-400/60" style={{ minWidth: 300, minHeight: 300 }}>
            {qrLoading || !qrDataUrl ? (
              <div className="flex h-64 w-64 items-center justify-center">
                <div className="text-4xl animate-pulse text-[#0a2014]">⏳</div>
              </div>
            ) : (
              <img src={qrDataUrl} alt="QR Code" className="h-64 w-64" />
            )}

            {/* Countdown ring overlay */}
            <div className={`absolute -bottom-4 flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-bold shadow ${qrCountdown > 5 ? 'border-emerald-400 bg-emerald-600 text-white' : 'border-red-400 bg-red-600 text-white animate-pulse'}`}>
              {qrCountdown}
            </div>
          </div>

          {/* Timer bar */}
          <div className="w-full max-w-xs">
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${qrCountdown > 5 ? 'bg-emerald-400' : 'bg-red-400'}`}
                style={{ width: `${(qrCountdown / 15) * 100}%` }}
              />
            </div>
            <p className="mt-1 text-center text-xs text-white/40">
              {qrCountdown > 0 ? `${qrCountdown}s में expire होगा — auto refresh होगा` : 'Refreshing...'}
            </p>
          </div>

          {/* Manual refresh */}
          <button
            type="button"
            disabled={qrLoading}
            onClick={() => void fetchQrToken()}
            className="rounded-2xl border border-cyan-500/30 bg-cyan-600/20 px-6 py-3 text-sm font-semibold text-cyan-300 hover:bg-cyan-600/30 disabled:opacity-40 active:scale-95 transition-transform"
          >
            🔄 नया QR बनाएं
          </button>

          {/* Instructions */}
          <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-white/5 p-4 space-y-1.5">
            <p className="text-xs font-bold text-white/60 mb-2">Employee को बताएं:</p>
            {[
              '① Sidebar में "QR Attendance" खोलें',
              '② Camera खोलें',
              '③ इस QR को scan करें',
              '④ अटेंडेंस तुरंत दर्ज होगी',
            ].map(s => <p key={s} className="text-xs text-white/40">{s}</p>)}
          </div>

          <div className="text-center text-xs text-white/20">
            QR हर 15 सेकंड में बदलता है — reuse नहीं हो सकता
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          FACE SCAN VIEW
      ════════════════════════════════════════════════════════ */}
      {view === 'face' && (
        <div className="flex-1 flex flex-col items-center gap-4 p-5">
          <div className="w-full max-w-sm text-center">
            <p className="text-2xl font-bold mb-1">
              {camOn ? (faceDetected ? '😊 चेहरा पहचाना जा रहा है...' : '👀 कैमरे के सामने खड़े हों') : '📷 चेहरे से अटेंडेंस'}
            </p>
            <p className="text-sm text-white/50">
              {camOn ? '2–3 सेकंड रुकें — अटेंडेंस अपने आप लग जाएगी' : 'Camera खोलें और चेहरा दिखाएं'}
            </p>
          </div>

          <div className="relative w-full max-w-sm">
            <video
              ref={videoRef}
              playsInline muted
              className={`w-full rounded-3xl border-4 object-cover shadow-2xl transition-all ${faceDetected ? 'border-emerald-400 shadow-emerald-500/50' : 'border-white/10'} ${camOn ? 'h-64' : 'h-0 overflow-hidden'}`}
            />
            {camOn && (
              <div className={`absolute bottom-3 left-3 rounded-full px-3 py-1 text-xs font-bold ${faceDetected ? 'bg-emerald-500 text-white' : 'bg-black/50 text-white/70'}`}>
                {faceDetected ? '● चेहरा मिला' : '○ ढूंढ रहे हैं...'}
              </div>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />

          <div className="flex flex-wrap justify-center gap-3 w-full max-w-sm">
            {!camOn ? (
              <button
                type="button"
                onClick={() => void startFaceCamera()}
                className="w-full rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 px-8 py-6 text-xl font-bold shadow-xl hover:from-emerald-400 active:scale-95 transition-transform"
              >
                📷 Camera खोलें
              </button>
            ) : (
              <div className="flex w-full gap-3">
                <button type="button" onClick={stopFaceCamera} className="flex-1 rounded-2xl border border-white/25 bg-white/10 py-4 text-base font-semibold">✕ बंद करें</button>
                <button
                  type="button"
                  onClick={() => setAutoFaceEnabled(v => !v)}
                  className={`flex-1 rounded-2xl py-4 text-base font-semibold transition ${autoFaceEnabled ? 'bg-emerald-600' : 'border border-white/25 bg-white/10'}`}
                >
                  {autoFaceEnabled ? '✅ Auto ON' : '⏸ Auto OFF'}
                </button>
              </div>
            )}
          </div>
          {lastMatchName && <p className="text-sm text-emerald-300">✅ पिछली बार: {lastMatchName}</p>}

          {!settings.allowFace && (
            <div className="rounded-2xl border border-red-500/30 bg-red-900/20 px-5 py-3 text-sm text-red-300">
              Face Scan इस कियोस्क पर बंद है। Settings से चालू करें।
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          SEARCH & MARK VIEW
      ════════════════════════════════════════════════════════ */}
      {view === 'search' && (
        <div className="flex-1 p-5 max-w-lg mx-auto w-full">
          <p className="text-xl font-bold mb-1 text-center">🔍 Search & Mark</p>
          <p className="text-sm text-white/50 mb-4 text-center">नाम या Employee ID से ढूंढें</p>

          {/* Search input */}
          <input
            autoFocus
            value={searchQ}
            onChange={e => { setSearchQ(e.target.value); setSelectedEmp(null) }}
            placeholder="नाम टाइप करें या Employee ID (जैसे PH-AMR-001)"
            className="w-full rounded-2xl bg-white/10 px-5 py-4 text-base placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-blue-500/50 mb-3"
          />

          {/* Selected employee — smart punch */}
          {selectedEmp && (() => {
            const state = empPunchState(selectedEmp)
            const action = punchLabel(state)
            return (
              <div className="rounded-2xl border border-white/15 bg-white/8 p-5 mb-4">
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-12 w-12 rounded-full bg-blue-600 flex items-center justify-center text-xl font-bold">
                    {selectedEmp.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-bold text-lg">{selectedEmp.full_name}</p>
                    <p className="text-sm text-white/50">{selectedEmp.login_id}</p>
                  </div>
                  <button type="button" onClick={() => setSelectedEmp(null)} className="ml-auto text-white/40 hover:text-white">✕</button>
                </div>

                {/* Status info */}
                <div className="flex gap-3 mb-4">
                  <div className="flex-1 rounded-xl bg-white/5 p-3 text-center">
                    <p className="text-xs text-white/40 mb-0.5">IN Time</p>
                    <p className="font-mono font-bold text-sm">{fmt12(selectedEmp.punch_in_at)}</p>
                  </div>
                  <div className="flex-1 rounded-xl bg-white/5 p-3 text-center">
                    <p className="text-xs text-white/40 mb-0.5">OUT Time</p>
                    <p className="font-mono font-bold text-sm">{fmt12(selectedEmp.punch_out_at)}</p>
                  </div>
                </div>

                {state === 'done' ? (
                  <div className="rounded-xl bg-emerald-900/40 border border-emerald-500/30 py-4 text-center">
                    <p className="text-emerald-300 font-bold">✅ आज की अटेंडेंस पूरी हो चुकी है</p>
                    <p className="text-xs text-white/40 mt-1">IN: {fmt12(selectedEmp.punch_in_at)} → OUT: {fmt12(selectedEmp.punch_out_at)}</p>
                  </div>
                ) : action ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void searchPunch(selectedEmp, action.type)}
                    className={`w-full rounded-2xl bg-gradient-to-br ${action.color} py-5 text-2xl font-bold shadow-xl disabled:opacity-50 active:scale-95 transition-transform`}
                  >
                    {action.icon} {action.text} — {selectedEmp.full_name.split(' ')[0]}
                    <span className="block text-sm font-normal opacity-80 mt-0.5">
                      {action.type === 'in' ? 'अटेंडेंस लगाने के लिए tap करें' : 'बाहर जाने के लिए tap करें'}
                    </span>
                  </button>
                ) : null}
              </div>
            )
          })()}

          {/* Search results */}
          {!selectedEmp && searchQ.trim().length >= 1 && (
            <div className="space-y-2">
              {searchLoading && (
                <div className="text-center py-4 text-white/40 text-sm">ढूंढ रहे हैं...</div>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <div className="text-center py-4 text-white/40 text-sm">कोई कर्मचारी नहीं मिला</div>
              )}
              {searchResults.map(emp => {
                const state = empPunchState(emp)
                const statusColor = state === 'none' ? 'text-white/40' : state === 'in' ? 'text-emerald-400' : 'text-amber-400'
                const statusLabel = state === 'none' ? '○ नहीं लगी' : state === 'in' ? '● IN हैं' : '✓ आज पूरी'
                return (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => setSelectedEmp(emp)}
                    className="w-full flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10 active:scale-95 transition-transform text-left"
                  >
                    <div className="h-10 w-10 rounded-full bg-blue-700/60 flex items-center justify-center text-lg font-bold flex-shrink-0">
                      {emp.full_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{emp.full_name}</p>
                      <p className="text-xs text-white/40">{emp.login_id}</p>
                    </div>
                    <span className={`text-xs font-bold ${statusColor}`}>{statusLabel}</span>
                  </button>
                )
              })}
            </div>
          )}

          {searchQ.trim().length === 0 && (
            <div className="text-center py-8 text-white/30 text-sm">
              <p className="text-4xl mb-3">🔍</p>
              <p>नाम या Employee ID टाइप करें</p>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          PIN VIEW — Smart 2-step
      ════════════════════════════════════════════════════════ */}
      {view === 'pin' && (
        <div className="flex-1 p-5 max-w-sm mx-auto w-full">
          <p className="text-xl font-bold mb-1 text-center">🔢 PIN से अटेंडेंस</p>
          <p className="text-sm text-white/50 mb-5 text-center">Employee ID + PIN डालें</p>

          {!pinVerified ? (
            <div className="space-y-3">
              <input
                autoFocus
                value={pinLoginId}
                onChange={e => setPinLoginId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void pinVerify()}
                placeholder="Employee ID (जैसे PH-AMR-001)"
                className="w-full rounded-2xl bg-white/10 px-5 py-4 text-base placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              />
              <input
                value={pinValue}
                onChange={e => setPinValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void pinVerify()}
                type="password"
                placeholder="PIN (4–8 अंक)"
                className="w-full rounded-2xl bg-white/10 px-5 py-4 text-base placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void pinVerify()}
                className="w-full rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 py-5 text-xl font-bold shadow-xl disabled:opacity-50 active:scale-95 transition-transform"
              >
                {busy ? '...' : '🔓 Verify करें'}
              </button>
            </div>
          ) : pinStatus && (() => {
            const state = empPunchState(pinStatus)
            const action = punchLabel(state)
            return (
              <div className="space-y-4">
                {/* Employee card */}
                <div className="rounded-2xl border border-white/15 bg-white/8 p-5 text-center">
                  <div className="h-16 w-16 rounded-full bg-indigo-600 flex items-center justify-center text-2xl font-bold mx-auto mb-3">
                    {pinStatus.full_name.charAt(0).toUpperCase()}
                  </div>
                  <p className="text-xl font-bold">{pinStatus.full_name}</p>
                  <p className="text-sm text-white/50">{pinStatus.login_id}</p>
                </div>

                {/* Status info */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-white/5 p-3 text-center">
                    <p className="text-xs text-white/40 mb-0.5">IN Time</p>
                    <p className="font-mono font-bold">{fmt12(pinStatus.punch_in_at)}</p>
                  </div>
                  <div className="rounded-xl bg-white/5 p-3 text-center">
                    <p className="text-xs text-white/40 mb-0.5">OUT Time</p>
                    <p className="font-mono font-bold">{fmt12(pinStatus.punch_out_at)}</p>
                  </div>
                </div>

                {/* Smart action */}
                {state === 'done' ? (
                  <div className="rounded-xl bg-emerald-900/40 border border-emerald-500/30 py-4 text-center">
                    <p className="text-emerald-300 font-bold">✅ आज की अटेंडेंस पूरी हो चुकी है</p>
                  </div>
                ) : action ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void pinPunchSmart(action.type)}
                    className={`w-full rounded-2xl bg-gradient-to-br ${action.color} py-6 text-2xl font-bold shadow-xl disabled:opacity-50 active:scale-95 transition-transform`}
                  >
                    {action.icon} {action.text}
                    <span className="block text-sm font-normal opacity-80 mt-0.5">
                      {action.type === 'in' ? 'अटेंडेंस लगाने के लिए tap करें' : 'बाहर जाने के लिए tap करें'}
                    </span>
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => { setPinStatus(null); setPinVerified(false); setPinLoginId(''); setPinValue(''); clearMsg() }}
                  className="w-full rounded-2xl border border-white/20 bg-white/5 py-3 text-sm font-semibold"
                >
                  ← दूसरा Employee
                </button>
              </div>
            )
          })()}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          MANUAL MARK VIEW (admin/manager)
      ════════════════════════════════════════════════════════ */}
      {view === 'manual' && canManage && (
        <div className="flex-1 p-5 max-w-sm mx-auto w-full">
          <p className="text-xl font-bold mb-1 text-center">📝 Manual Mark</p>
          <p className="text-sm text-white/50 mb-5 text-center">Manager: किसी भी Employee की अटेंडेंस लगाएं</p>

          <div className="space-y-3">
            <input
              autoFocus
              value={manualEmpId}
              onChange={e => setManualEmpId(e.target.value)}
              placeholder="Employee ID (Number)"
              className="w-full rounded-2xl bg-white/10 px-5 py-4 text-base placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />
            <input
              type="date"
              value={manualDate}
              onChange={e => setManualDate(e.target.value)}
              className="w-full rounded-2xl bg-white/10 px-5 py-4 text-base focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />

            <p className="text-center text-xs text-white/40 pt-1">Status चुनें</p>
            <div className="grid grid-cols-3 gap-3">
              <button type="button" disabled={busy || !manualEmpId} onClick={() => void manualOverride('present')}
                className="rounded-2xl bg-emerald-600 py-5 font-bold disabled:opacity-40 active:scale-95 transition-transform">
                ✅<span className="block text-xs font-normal mt-0.5">Present</span>
              </button>
              <button type="button" disabled={busy || !manualEmpId} onClick={() => void manualOverride('leave')}
                className="rounded-2xl bg-amber-600 py-5 font-bold disabled:opacity-40 active:scale-95 transition-transform">
                📋<span className="block text-xs font-normal mt-0.5">Leave</span>
              </button>
              <button type="button" disabled={busy || !manualEmpId} onClick={() => void manualOverride('absent')}
                className="rounded-2xl bg-red-600 py-5 font-bold disabled:opacity-40 active:scale-95 transition-transform">
                ❌<span className="block text-xs font-normal mt-0.5">Absent</span>
              </button>
            </div>

            <p className="text-center text-xs text-white/30 pt-2">
              ⚠️ यह एंट्री Audit Log में दर्ज होगी
            </p>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          REGISTRATION VIEW (Admin / Super Admin)
      ════════════════════════════════════════════════════════ */}
      {(view === 'register' || view === 'biometric') && canRegister && (
        <div className="flex-1 flex flex-col items-center gap-4 p-5 max-w-sm mx-auto w-full">
          <div className="text-center">
            <p className="text-xl font-bold mb-1">
              {view === 'register' ? '🪪 First Registration' : '🔄 Biometric Update'}
            </p>
            <p className="text-sm text-white/50">
              {view === 'register' ? 'नए Employee का चेहरा Register करें' : 'Employee का चेहरा Update करें'}
            </p>
          </div>

          {/* Camera */}
          <div className="relative w-full">
            <video
              ref={videoRef}
              playsInline muted
              className={`w-full rounded-3xl border-4 object-cover shadow-2xl transition-all ${faceDetected ? 'border-purple-400 shadow-purple-500/40' : 'border-white/10'} ${camOn ? 'h-56' : 'h-0 overflow-hidden'}`}
            />
            {camOn && (
              <div className={`absolute bottom-3 left-3 rounded-full px-3 py-1 text-xs font-bold ${faceDetected ? 'bg-purple-500 text-white' : 'bg-black/50 text-white/60'}`}>
                {faceDetected ? '✓ चेहरा मिला — Capture तैयार' : '○ चेहरा ढूंढ रहे हैं...'}
              </div>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />

          {!camOn ? (
            <button type="button" onClick={() => void startFaceCamera()}
              className="w-full rounded-2xl border border-white/20 bg-white/10 py-4 text-base font-bold hover:bg-white/20">
              📷 Camera खोलें
            </button>
          ) : (
            <button type="button" onClick={stopFaceCamera}
              className="w-full rounded-2xl border border-white/20 bg-white/10 py-3 text-sm font-semibold">
              ✕ Camera बंद करें
            </button>
          )}

          <input
            autoFocus={!camOn}
            value={registerLoginId}
            onChange={e => setRegisterLoginId(e.target.value)}
            placeholder="Employee Login ID (जैसे PH-AMR-001)"
            className="w-full rounded-2xl bg-white/10 px-5 py-4 text-base placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
          />

          {capturedBlob && (
            <p className="text-xs text-emerald-400 text-center">✓ चेहरा Capture हो गया — ID डालकर Register करें</p>
          )}

          <button
            type="button"
            disabled={busy || !capturedBlob || !registerLoginId.trim()}
            onClick={() => void registerFaceFromCapture()}
            className="w-full rounded-2xl bg-gradient-to-br from-purple-500 to-purple-700 py-5 text-xl font-bold shadow-xl disabled:opacity-40 active:scale-95 transition-transform"
          >
            {busy ? '...' : view === 'register' ? '✅ Register करें' : '🔄 Update करें'}
          </button>

          <p className="text-xs text-white/30 text-center">
            Camera चालू होने पर face auto-capture होता है
          </p>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          SETTINGS PANEL (admin-only overlay)
      ════════════════════════════════════════════════════════ */}
      {settingsOpen && canManage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
          <div className="w-full max-w-md rounded-3xl bg-[#0f3020] border border-white/10 p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-bold">⚙️ Kiosk Settings</h2>
              <button type="button" onClick={() => setSettingsOpen(false)} className="rounded-xl border border-white/20 px-3 py-1 text-sm">✕ Close</button>
            </div>

            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-white/40">Attendance Methods</p>
            <div className="mb-5 grid grid-cols-2 gap-2">
              {([
                { key: 'allowFace' as const, label: '📷 Face Scan' },
                { key: 'allowFingerprint' as const, label: '👆 Fingerprint' },
                { key: 'allowGps' as const, label: '📍 GPS' },
                { key: 'allowPin' as const, label: '🔢 PIN / ID' },
                { key: 'allowManual' as const, label: '✍️ Manual Entry' },
              ]).map(({ key, label }) => {
                const val = settings[key]
                return (
                  <button key={key} type="button" onClick={() => updateSetting(key, !val)}
                    className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-sm font-semibold transition ${val ? 'border-emerald-400/50 bg-emerald-600/40 text-emerald-200' : 'border-white/10 bg-white/5 text-white/40'}`}>
                    <span>{label}</span><span className="text-xs">{val ? 'ON' : 'OFF'}</span>
                  </button>
                )
              })}
            </div>

            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-white/40">Extra Controls</p>
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'allowFaceReg' as const, label: '🪪 Face Registration' },
                { key: 'allowManualOverride' as const, label: '📝 Manual Override' },
                { key: 'voiceFeedback' as const, label: '🔊 Voice Feedback' },
                { key: 'errorAlerts' as const, label: '🔔 Error Alerts' },
              ]).map(({ key, label }) => {
                const val = settings[key]
                return (
                  <button key={key} type="button" onClick={() => updateSetting(key, !val)}
                    className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-sm font-semibold transition ${val ? 'border-emerald-400/50 bg-emerald-600/40 text-emerald-200' : 'border-white/10 bg-white/5 text-white/40'}`}>
                    <span>{label}</span><span className="text-xs">{val ? 'ON' : 'OFF'}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
