import { useCallback, useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { api } from '../api'

type Props = {
  onSuccess?: () => void
  todayPunchIn?: string | null
  todayPunchOut?: string | null
}

type GpsState = 'idle' | 'fetching' | 'ok' | 'err'

const KIOSK_HINT =
  'अगर आप यहाँ से अटेंडेंस नहीं लगा पा रहे हैं, तो कृपया Admin या Attendance Manager के Kiosk Mode पर जाकर QR स्कैन करें और वहाँ से अटेंडेंस लगाएँ।'

export function QrScanWidget({ onSuccess, todayPunchIn, todayPunchOut }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animRef = useRef<number>(0)
  const scannedRef = useRef(false)

  const [open, setOpen] = useState(false)
  const [camOn, setCamOn] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)

  const [msg, setMsg] = useState<string | null>(null)
  const [msgKind, setMsgKind] = useState<'ok' | 'err' | 'warn' | 'info'>('info')
  const [showKioskHint, setShowKioskHint] = useState(false)

  const [gpsState, setGpsState] = useState<GpsState>('idle')
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null)

  // Derived punch type
  const punchType: 'in' | 'out' = !todayPunchIn ? 'in' : 'out'
  const alreadyDone = !!(todayPunchIn && todayPunchOut)

  // ── GPS capture (fires when widget opens) ──────────────────────────────
  const captureGps = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsState('err')
      return
    }
    setGpsState('fetching')
    navigator.geolocation.getCurrentPosition(
      pos => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })
        setGpsState('ok')
      },
      () => { setGpsState('err') },
      { timeout: 15000, maximumAge: 10000, enableHighAccuracy: true }
    )
  }, [])

  useEffect(() => {
    if (open) captureGps()
  }, [open, captureGps])

  // ── Camera ──────────────────────────────────────────────────────────────
  async function startCamera() {
    setMsg(null); setShowKioskHint(false); scannedRef.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      })
      streamRef.current = stream
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play() }
      setCamOn(true); setScanning(true)
    } catch (e) {
      showErr(`Camera नहीं खुला: ${(e as Error).message}`)
    }
  }

  function stopCamera() {
    if (animRef.current) cancelAnimationFrame(animRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCamOn(false); setScanning(false)
  }

  function closeWidget() {
    stopCamera()
    setOpen(false)
    setMsg(null)
    setShowKioskHint(false)
    setGpsState('idle')
    setGpsCoords(null)
  }

  // Cleanup on unmount
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

  // ── Process scanned QR ──────────────────────────────────────────────────
  async function handleScan(rawData: string) {
    setBusy(true); setMsg(null); setShowKioskHint(false)
    stopCamera()

    if (!gpsCoords || gpsState !== 'ok') {
      showErr('GPS location नहीं मिली। कृपया GPS चालू करें और दोबारा try करें।', true)
      setBusy(false)
      return
    }

    try {
      let token = rawData.trim()
      try { const p = JSON.parse(rawData); if (p?.token) token = p.token } catch { /* raw token */ }

      await api('/kiosk/qr/scan', {
        method: 'POST',
        body: JSON.stringify({
          token,
          lat: gpsCoords.lat,
          lng: gpsCoords.lng,
          accuracy: gpsCoords.accuracy,
          type: punchType,
        }),
      })

      const label = punchType === 'in' ? 'अटेंडेंस सफलतापूर्वक लग गई ✅' : 'पंच-आउट सफलतापूर्वक हो गया 🚪'
      setMsg(label); setMsgKind('ok')
      onSuccess?.()
    } catch (e) {
      const errText = (e as Error).message || 'Scan failed'
      showErr(errText, true)
    } finally {
      setBusy(false)
    }
  }

  function showErr(text: string, showHint = false) {
    setMsg(text); setMsgKind('err')
    if (showHint) setShowKioskHint(true)
  }

  function retryCamera() {
    scannedRef.current = false
    setMsg(null); setShowKioskHint(false)
    void startCamera()
  }

  // ── Collapsed state (just the button) ──────────────────────────────────
  if (!open) {
    return (
      <div className="mt-5 rounded-2xl border border-[#1f5e3b]/15 bg-[#f7fbf8] p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-[#1f5e3b]">📱 QR से अटेंडेंस</h3>
            <p className="mt-0.5 text-xs text-[#1f5e3b]/60">
              {alreadyDone
                ? 'आज की अटेंडेंस पूरी हो चुकी है।'
                : punchType === 'in'
                ? 'Kiosk का QR scan करके अटेंडेंस लगाएँ'
                : 'Kiosk का QR scan करके पंच-आउट करें'}
            </p>
          </div>
          {!alreadyDone && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="flex items-center gap-2 rounded-xl bg-[#1f5e3b] px-4 py-2.5 text-sm font-bold text-white shadow hover:bg-[#2e7d32] active:scale-95 transition-transform"
            >
              <span className="text-base">📱</span>
              QR से अटेंडेंस लगाएँ
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── Expanded scanner UI ─────────────────────────────────────────────────
  return (
    <div className="mt-5 rounded-2xl border border-[#1f5e3b]/20 bg-[#f7fbf8] p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#1f5e3b]">📱 QR से अटेंडेंस</h3>
        <button
          type="button"
          onClick={closeWidget}
          className="rounded-lg border border-[#1f5e3b]/20 px-2.5 py-1 text-xs font-semibold text-[#1f5e3b]/60 hover:bg-[#1f5e3b]/5"
        >
          ✕ बंद करें
        </button>
      </div>

      {/* GPS status pill */}
      <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
        gpsState === 'ok' ? 'bg-emerald-100 text-emerald-700' :
        gpsState === 'fetching' ? 'bg-amber-100 text-amber-700' :
        gpsState === 'err' ? 'bg-red-100 text-red-700' :
        'bg-gray-100 text-gray-500'
      }`}>
        {gpsState === 'ok' ? `📍 GPS OK (±${gpsCoords ? Math.round(gpsCoords.accuracy) : '?'}m)` :
         gpsState === 'fetching' ? '⏳ GPS ढूंढ रहे हैं...' :
         gpsState === 'err' ? (
           <span>
             ❌ GPS नहीं मिला —{' '}
             <button type="button" onClick={captureGps} className="underline font-bold">Retry</button>
           </span>
         ) : '📍 GPS...'}
      </div>

      {/* Success / error message */}
      {msg && (
        <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
          msgKind === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' :
          msgKind === 'err' ? 'bg-red-50 text-red-800 border border-red-200' :
          'bg-blue-50 text-blue-800 border border-blue-200'
        }`}>
          {msg}
        </div>
      )}

      {/* Kiosk guidance hint */}
      {showKioskHint && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-bold mb-1">💡 क्या करें?</p>
          <p className="leading-relaxed">{KIOSK_HINT}</p>
        </div>
      )}

      {/* Camera viewfinder */}
      {camOn && (
        <div className="relative overflow-hidden rounded-2xl bg-black">
          <video
            ref={videoRef}
            playsInline muted
            className="w-full h-52 object-cover"
          />
          {/* Scan frame overlay */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className={`h-36 w-36 rounded-xl border-2 transition-all ${scanning ? 'border-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.5)]' : 'border-white/40'}`} />
          </div>
          <div className="absolute bottom-2 left-0 right-0 text-center">
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${scanning ? 'bg-emerald-500 text-white' : 'bg-black/60 text-white/70'}`}>
              {busy ? 'अटेंडेंस दर्ज हो रही है...' : scanning ? '● QR ढूंढ रहे हैं' : '✓ QR मिला'}
            </span>
          </div>
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" />

      {/* Action buttons */}
      <div className="space-y-2">
        {!camOn && msgKind !== 'ok' && (
          <button
            type="button"
            disabled={busy || gpsState === 'fetching'}
            onClick={msg ? retryCamera : () => void startCamera()}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#1f5e3b] px-4 py-3 text-sm font-bold text-white shadow hover:bg-[#2e7d32] disabled:opacity-50 active:scale-95 transition-transform"
          >
            <span className="text-base">📷</span>
            {msg ? 'दोबारा Scan करें' : 'Camera खोलें — QR Scan करें'}
            <span className="text-xs font-normal opacity-80">
              ({punchType === 'in' ? 'IN' : 'OUT'})
            </span>
          </button>
        )}
        {camOn && (
          <button
            type="button"
            onClick={stopCamera}
            className="w-full rounded-xl border border-[#1f5e3b]/20 py-2.5 text-sm font-semibold text-[#1f5e3b]/60 hover:bg-[#1f5e3b]/5"
          >
            ✕ Camera बंद करें
          </button>
        )}
        {msgKind === 'ok' && (
          <button
            type="button"
            onClick={closeWidget}
            className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white hover:bg-emerald-500"
          >
            ✅ ठीक है — बंद करें
          </button>
        )}
      </div>

      {/* Instructions (only when camera isn't open and no error yet) */}
      {!camOn && !msg && (
        <div className="rounded-xl bg-white border border-[#1f5e3b]/10 px-4 py-3 space-y-1.5">
          <p className="text-xs font-bold text-[#1f5e3b]/60">कैसे करें:</p>
          {[
            '① Office पहुँचें (GPS automatic detect होगा)',
            '② "Camera खोलें" बटन दबाएँ',
            '③ Kiosk की screen पर दिख रहे QR को scan करें',
            '④ अटेंडेंस तुरंत दर्ज हो जाएगी',
          ].map(s => (
            <p key={s} className="text-xs text-[#1f5e3b]/50">{s}</p>
          ))}
        </div>
      )}
    </div>
  )
}
