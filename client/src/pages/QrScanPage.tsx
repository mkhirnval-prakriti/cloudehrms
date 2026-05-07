import { useCallback, useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { api } from '../api'

type TodayStatus = {
  punch_in_at: string | null
  punch_out_at: string | null
  status: string | null
}

type GpsState = 'idle' | 'fetching' | 'ok' | 'err'

function fmt12(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

export function QrScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animRef = useRef<number>(0)
  const scannedRef = useRef(false)

  const [camOn, setCamOn] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgKind, setMsgKind] = useState<'ok' | 'err' | 'info'>('info')
  const [busy, setBusy] = useState(false)

  const [todayStatus, setTodayStatus] = useState<TodayStatus | null>(null)
  // GPS state retained but OPTIONAL — if browser grants quickly we send coords for audit;
  // attendance is allowed even without GPS since the QR token itself proves presence.
  const [gpsState, setGpsState] = useState<GpsState>('idle')
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null)

  // ── Today's status ──────────────────────────────────────────────────────
  const loadTodayStatus = useCallback(async () => {
    try {
      const r = await api<TodayStatus>('/attendance/my-today')
      setTodayStatus(r)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { void loadTodayStatus() }, [loadTodayStatus])

  // Derived punch type
  const punchType: 'in' | 'out' = (!todayStatus?.punch_in_at) ? 'in' : 'out'
  const alreadyDone = !!(todayStatus?.punch_in_at && todayStatus?.punch_out_at)

  // ── GPS capture (purely OPTIONAL — manual tap only) ─────────────────────
  // QR attendance does NOT require GPS. We only fetch coords if the user
  // taps the GPS chip in the header (for optional audit-only logging).
  // The QR token itself proves presence, so no auto-prompt on mount.
  const captureGps = useCallback(() => {
    if (!navigator.geolocation) { setGpsState('err'); return }
    setGpsState('fetching')
    navigator.geolocation.getCurrentPosition(
      pos => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })
        setGpsState('ok')
      },
      () => { setGpsState('err') },
      { timeout: 8000, maximumAge: 30000, enableHighAccuracy: false }
    )
  }, [])

  // ── Camera ──────────────────────────────────────────────────────────────
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showMsg('Camera API इस browser में support नहीं है। Chrome या Safari try करें।', 'err')
      return
    }
    // Pre-stop any existing stream on the element before re-opening,
    // otherwise Chrome/Safari throw a false "NotReadableError" (camera busy).
    try {
      const prev = streamRef.current
      if (prev) { prev.getTracks().forEach(t => t.stop()); streamRef.current = null }
      const vEl = videoRef.current
      if (vEl?.srcObject) {
        try { (vEl.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
        vEl.srcObject = null
      }
    } catch { /* noop */ }

    const constraints: MediaStreamConstraints = {
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    }
    const tryOpen = () => navigator.mediaDevices.getUserMedia(constraints)

    let stream: MediaStream
    try {
      try {
        stream = await tryOpen()
      } catch (innerErr) {
        const innerName = (innerErr as { name?: string }).name || ''
        if (innerName === 'NotReadableError' || innerName === 'AbortError') {
          // Camera was busy — wait briefly and retry once
          await new Promise((r) => setTimeout(r, 400))
          stream = await tryOpen()
        } else {
          throw innerErr
        }
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try { await videoRef.current.play() } catch { /* may auto-play */ }
      }
      setCamOn(true)
      setScanning(true)
      scannedRef.current = false
    } catch (err) {
      const e = err as DOMException
      let hint = ''
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        hint = 'Camera permission deny हो गई — browser settings में allow करें।'
      } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        hint = 'इस device पर कोई camera नहीं मिला।'
      } else if (e.name === 'NotReadableError' || (e.message || '').toLowerCase().includes('could not start video')) {
        hint = 'Camera किसी और app में खुली है — सभी camera apps/tabs बंद करें फिर try करें।'
      } else if (e.name === 'OverconstrainedError') {
        hint = 'Back camera नहीं मिला — किसी और camera से try करें।'
      } else {
        hint = e.message || 'अज्ञात कारण।'
      }
      showMsg(`📷 Camera शुरू नहीं हुआ: ${hint}`, 'err')
    }
  }

  function stopCamera() {
    if (animRef.current) cancelAnimationFrame(animRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCamOn(false); setScanning(false)
  }

  useEffect(() => () => stopCamera(), [])

  // ── QR scan loop ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!camOn || !scanning) return
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    let active = true
    const scan = () => {
      if (!active || scannedRef.current) return
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' })
          if (code?.data) {
            scannedRef.current = true
            setScanning(false)
            void handleScan(code.data)
            return
          }
        }
      }
      animRef.current = requestAnimationFrame(scan)
    }
    animRef.current = requestAnimationFrame(scan)
    return () => { active = false; cancelAnimationFrame(animRef.current) }
  }, [camOn, scanning])

  // ── Handle scanned token ────────────────────────────────────────────────
  async function handleScan(rawData: string) {
    setBusy(true)
    setMsg(null)

    try {
      // QR payload may be just the token string, or a JSON object
      let token = rawData.trim()
      try {
        const parsed = JSON.parse(rawData)
        if (parsed?.token) token = parsed.token
      } catch { /* raw string token */ }

      // GPS coords are sent ONLY if available — server treats them as audit-only for QR.
      const payload: Record<string, unknown> = { token, type: punchType }
      if (gpsCoords) {
        payload.lat = gpsCoords.lat
        payload.lng = gpsCoords.lng
        payload.accuracy = gpsCoords.accuracy
      }
      await api('/kiosk/qr/scan', { method: 'POST', body: JSON.stringify(payload) })

      const label = punchType === 'in' ? 'अटेंडेंस लग गई ✅' : 'आप बाहर हो गए 🚪'
      showMsg(`${label}`, 'ok', true)
      stopCamera()
      void loadTodayStatus()
    } catch (e) {
      showMsg((e as Error).message || 'Scan failed', 'err')
      // Allow retry — reset scanned flag after a delay
      setTimeout(() => { scannedRef.current = false; if (camOn) setScanning(true) }, 3000)
    } finally {
      setBusy(false)
    }
  }

  function showMsg(text: string, kind: 'ok' | 'err' | 'info', persist = false) {
    setMsg(text); setMsgKind(kind)
    if (!persist && kind !== 'info') setTimeout(() => setMsg(null), 7000)
  }

  const msgBg = msgKind === 'ok' ? 'bg-emerald-500/95' : msgKind === 'err' ? 'bg-red-500/95' : 'bg-blue-500/95'

  const gpsIcon = gpsState === 'ok' ? '📍' : gpsState === 'fetching' ? '⏳' : gpsState === 'err' ? '❌' : '📍'
  const gpsLabel = gpsState === 'ok'
    ? `GPS OK (±${gpsCoords ? Math.round(gpsCoords.accuracy) : '?'}m)`
    : gpsState === 'fetching' ? 'GPS ढूंढ रहे हैं...'
    : gpsState === 'err' ? 'GPS Error — Tap to retry'
    : 'GPS...'

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#071a0f] via-[#0f3020] to-[#1a4d30] text-white flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-black/30">
        <div>
          <p className="text-lg font-bold">📱 QR Attendance Scan</p>
          <p className="text-xs text-white/50">Kiosk QR scan करें — अटेंडेंस दर्ज होगी</p>
        </div>
        <button
          type="button"
          onClick={captureGps}
          className={`rounded-xl px-3 py-2 text-xs font-semibold border ${gpsState === 'ok' ? 'border-emerald-500/40 bg-emerald-600/20 text-emerald-300' : gpsState === 'err' ? 'border-red-500/40 bg-red-600/20 text-red-300' : 'border-white/20 bg-white/10 text-white/60'}`}
        >
          {gpsIcon} {gpsLabel}
        </button>
      </div>

      {/* Status message */}
      {msg && (
        <div className={`mx-5 mt-3 rounded-2xl px-5 py-4 text-center text-lg font-bold shadow-lg ${msgBg} text-white`}>
          {msg}
        </div>
      )}

      {/* Today's status card */}
      <div className="mx-5 mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
        <p className="text-xs text-white/40 mb-2 font-semibold uppercase tracking-wide">आज की अटेंडेंस</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <p className="text-xs text-white/40">IN</p>
            <p className="font-mono font-bold text-sm">{fmt12(todayStatus?.punch_in_at ?? null)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-white/40">OUT</p>
            <p className="font-mono font-bold text-sm">{fmt12(todayStatus?.punch_out_at ?? null)}</p>
          </div>
          <div className="text-center">
            {alreadyDone ? (
              <span className="text-xs font-bold text-emerald-400">✅ पूरी</span>
            ) : (
              <span className={`text-sm font-bold ${punchType === 'in' ? 'text-emerald-400' : 'text-amber-400'}`}>
                Next: {punchType.toUpperCase()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Camera + scanner */}
      <div className="flex-1 flex flex-col items-center gap-4 p-5">
        {alreadyDone ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
            <p className="text-5xl">✅</p>
            <p className="text-xl font-bold text-emerald-300">आज की अटेंडेंस पूरी हो चुकी है</p>
            <p className="text-sm text-white/50">IN: {fmt12(todayStatus?.punch_in_at ?? null)} → OUT: {fmt12(todayStatus?.punch_out_at ?? null)}</p>
          </div>
        ) : (
          <>
            {/* Scanner window */}
            <div className="relative w-full max-w-sm">
              <video
                ref={videoRef}
                playsInline muted
                className={`w-full rounded-3xl border-4 object-cover shadow-2xl transition-all bg-black/50 ${scanning ? 'border-emerald-400' : 'border-white/10'} ${camOn ? 'h-72' : 'h-0 overflow-hidden'}`}
              />
              {camOn && (
                <>
                  {/* Scanner overlay */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className={`h-48 w-48 rounded-2xl border-2 ${scanning ? 'border-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.4)]' : 'border-white/30'} transition-all`} />
                  </div>
                  <div className="absolute bottom-3 left-0 right-0 text-center">
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${scanning ? 'bg-emerald-500 text-white' : 'bg-black/60 text-white/60'}`}>
                      {scanning ? busy ? '...' : '● QR ढूंढ रहे हैं' : '○ Processing...'}
                    </span>
                  </div>
                </>
              )}
              <canvas ref={canvasRef} className="hidden" />
            </div>

            {/* Action buttons */}
            {!camOn ? (
              <div className="w-full max-w-sm space-y-3">
                <button
                  type="button"
                  onClick={() => void startCamera()}
                  className="w-full rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 py-6 text-2xl font-bold shadow-xl active:scale-95 transition-transform"
                >
                  📷 Camera खोलें — QR Scan करें
                  <span className="block text-sm font-normal opacity-80 mt-0.5">
                    {punchType === 'in' ? 'IN की अटेंडेंस लगाने के लिए' : 'OUT के लिए scan करें'}
                  </span>
                </button>
                <p className="text-center text-xs text-white/40">
                  ℹ️ QR scan के लिए GPS / WiFi / Fingerprint की ज़रूरत नहीं है।
                </p>
              </div>
            ) : (
              <div className="w-full max-w-sm space-y-3">
                <p className="text-center text-sm text-white/60">
                  Office के कियोस्क पर दिख रहे QR को camera से scan करें
                </p>
                <button
                  type="button"
                  onClick={stopCamera}
                  className="w-full rounded-2xl border border-white/20 bg-white/10 py-3 text-sm font-semibold"
                >
                  ✕ बंद करें
                </button>
              </div>
            )}

            {/* Instructions */}
            {!camOn && (
              <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-4 space-y-2">
                <p className="text-xs font-bold text-white/60 mb-2">कैसे करें:</p>
                {[
                  '① Office के kiosk के पास पहुंचें',
                  '② Camera खोलें (GPS की ज़रूरत नहीं)',
                  '③ Kiosk screen पर दिखने वाला QR scan करें',
                  '④ अटेंडेंस तुरंत दर्ज हो जाएगी',
                ].map(s => <p key={s} className="text-xs text-white/50">{s}</p>)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
