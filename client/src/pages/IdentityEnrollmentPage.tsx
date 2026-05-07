import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { assessCaptureQuality, captureVideoFrameToJpegBlob, getFaceCameraConstraints, type CaptureQuality } from '../lib/faceCapture'
import { descriptorToJson, ensureFaceModelsLoaded, extractFaceDescriptorWithBox, runLivenessAndFaceDescriptorWithBox } from '../lib/faceApiLiveness'
import {
  browserSupportsWebAuthn,
  deleteWebAuthnCredential,
  fetchWebAuthnAttendanceStatus,
  listWebAuthnCredentials,
  registerNewPasskey,
  type ListedWebAuthnCred,
  type WebAuthnAttendanceStatus,
} from '../lib/webauthnAttendance'

type BioPending = { id: number; created_at: string } | null
type BioApproved = { id: number; approval_expires_at: string | null } | null

type BioStatus = {
  hasFace: boolean
  faceEmbeddingActive?: boolean
  faceDescriptorCount?: number | null
  webauthnCount: number
  pending: { face: BioPending; biometric: BioPending }
  approvedAwaitingEnrollment: { face: BioApproved; biometric: BioApproved }
  canRequestFaceUpdate: boolean
  canRequestBiometricUpdate: boolean
  blockReasonFace?: string
  blockReasonBiometric?: string
}

type MineReq = {
  id: number
  kind: string
  status: string
  created_at: string
  reject_reason: string | null
  approval_expires_at: string | null
  completed_at: string | null
}

export function IdentityEnrollmentPage() {
  const { user } = useAuth()
  const [bio, setBio] = useState<BioStatus | null>(null)
  const [mine, setMine] = useState<MineReq[]>([])
  const [wa, setWa] = useState<WebAuthnAttendanceStatus | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgType, setMsgType] = useState<'info' | 'error' | 'success'>('info')
  const [busy, setBusy] = useState(false)

  // ─── camera refs — always in DOM, visibility toggled by CSS ──────────────
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [camOn, setCamOn] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [faceBlob, setFaceBlob] = useState<Blob | null>(null)
  const [faceDescriptorJson, setFaceDescriptorJson] = useState<string | null>(null)
  const [liveCheckFailed, setLiveCheckFailed] = useState(false)
  const [singlePhotoQuality, setSinglePhotoQuality] = useState<CaptureQuality | null>(null)
  // ─── guided multi-pose enrollment ────────────────────────────────────────
  type GuidedPose = { descriptor: string; thumbBlob: Blob; thumbUrl: string; quality: CaptureQuality }
  const [guidedMode, setGuidedMode] = useState(true)
  // Slots: 0=Straight, 1=Left, 2=Right (REQUIRED), 3=Up/Down tilt (OPTIONAL).
  // Server accepts any 1-4 length faceDescriptors array, so the 4th slot is
  // a true optional add-on for staff working under overhead lights / caps.
  const REQUIRED_POSES = 3
  const TOTAL_POSE_SLOTS = 4
  const [guidedPoses, setGuidedPoses] = useState<(GuidedPose | null)[]>(
    () => Array.from({ length: TOTAL_POSE_SLOTS }, () => null),
  )
  const guidedPosesRef = useRef(guidedPoses)
  useEffect(() => { guidedPosesRef.current = guidedPoses }, [guidedPoses])
  const capturedCount = guidedPoses.filter(Boolean).length
  const requiredCapturedCount = guidedPoses.slice(0, REQUIRED_POSES).filter(Boolean).length
  const nextPoseIdx = guidedPoses.findIndex((p) => !p) // -1 if all slots filled
  const guidedStep = nextPoseIdx === -1 ? TOTAL_POSE_SLOTS : nextPoseIdx
  const allRequiredCaptured = requiredCapturedCount >= REQUIRED_POSES
  const [passLabel, setPassLabel] = useState('')
  const [creds, setCreds] = useState<ListedWebAuthnCred[]>([])

  const isAdmin = canPerm(user, 'biometric:admin')
  const canRequest = canPerm(user, 'biometric:request_update')

  // Detect contexts that block WebAuthn / camera (Translate proxy, in-app
  // browsers, embedded iframes). These cause "request is not allowed by the
  // user agent" errors with no real way to recover from inside the page.
  const blockedContext = useMemo<{ kind: 'translate' | 'iframe' | 'inapp'; label: string } | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const host = window.location.hostname || ''
      const ref = document.referrer || ''
      // 1) Google Translate proxy — hostname pattern *.translate.goog or
      //    referrer from translate.google.com / translate.goog.
      if (
        /\.translate\.goog$/i.test(host) ||
        /(^|\.)translate\.google\.com$/i.test(host) ||
        /translate\.google\.com|translate\.goog/i.test(ref)
      ) {
        return { kind: 'translate', label: 'Google Translate' }
      }
      // 2) Embedded inside another site's iframe.
      if (window.top && window.top !== window.self) {
        return { kind: 'iframe', label: 'embedded frame' }
      }
      // 3) In-app browsers (WhatsApp, Instagram, FB, LinkedIn, Line, Android WebView).
      const ua = navigator.userAgent || ''
      if (/FBAN|FBAV|Instagram|LinkedInApp|Line\/|MicroMessenger|; wv\)|WhatsApp/i.test(ua)) {
        return { kind: 'inapp', label: 'in-app browser' }
      }
    } catch {
      // window.top access can throw cross-origin — treat as iframe.
      return { kind: 'iframe', label: 'embedded frame' }
    }
    return null
  }, [])

  const showMsg = (text: string, type: 'info' | 'error' | 'success' = 'info') => {
    setMsg(text)
    setMsgType(type)
  }

  const refresh = useCallback(async () => {
    setMsg(null)
    try {
      const [b, w, m] = await Promise.all([
        api<BioStatus>('/biometric/status'),
        fetchWebAuthnAttendanceStatus().catch(() => null),
        api<{ requests: MineReq[] }>('/biometric/requests/mine').catch(() => ({ requests: [] })),
      ])
      setBio(b)
      setWa(w)
      setMine(m.requests || [])
      if (w && w.credCount > 0) {
        setCreds(await listWebAuthnCredentials().catch(() => []))
      } else {
        setCreds([])
      }
    } catch (e) {
      showMsg((e as Error).message || 'Status load failed.', 'error')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }
  }, [previewUrl])

  // ─── Camera helpers ───────────────────────────────────────────────────────
  function resetGuided() {
    setGuidedPoses((prev) => {
      prev.forEach((p) => p && URL.revokeObjectURL(p.thumbUrl))
      return Array.from({ length: TOTAL_POSE_SLOTS }, () => null)
    })
  }

  function retakePose(idx: number) {
    setGuidedPoses((prev) => {
      const next = [...prev]
      if (next[idx]) URL.revokeObjectURL(next[idx]!.thumbUrl)
      next[idx] = null
      return next
    })
    if (idx === 0) {
      // Pose 1's photo is what gets uploaded — clear the preview/blob too.
      setFaceBlob(null)
      if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
      setLiveCheckFailed(false)
      setSinglePhotoQuality(null)
    }
    setMsg(null)
  }

  // Revoke any remaining thumbnail URLs on unmount (read from ref to avoid setState during cleanup).
  useEffect(() => {
    return () => {
      guidedPosesRef.current.forEach((p) => p && URL.revokeObjectURL(p.thumbUrl))
    }
  }, [])

  async function startCamera() {
    setMsg(null)
    setLiveCheckFailed(false)
    setFaceBlob(null)
    setFaceDescriptorJson(null)
    setSinglePhotoQuality(null)
    resetGuided()
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    try {
      // check getUserMedia support
      if (!navigator.mediaDevices?.getUserMedia) {
        showMsg('Camera API not supported in this browser. Try Chrome or Safari.', 'error')
        return
      }
      // Pre-stop any existing stream on the element before re-opening,
      // otherwise browsers throw a false "NotReadableError".
      const vEl = videoRef.current
      if (vEl?.srcObject) {
        try { (vEl.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
        vEl.srcObject = null
      }
      const tryOpen = async () => await navigator.mediaDevices.getUserMedia(getFaceCameraConstraints())
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
      // Assign stream BEFORE setting camOn — video element must be in DOM
      const v = videoRef.current
      if (v) {
        v.srcObject = stream
        try { await v.play() } catch { /* may auto-play */ }
      }
      setCamOn(true)
      // Pre-warm face-api models in the background so capture is instant
      ensureFaceModelsLoaded().catch(() => { /* surfaced on capture */ })
    } catch (err) {
      const e = err as DOMException
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        showMsg('Camera permission denied. Please allow camera access in your browser settings.', 'error')
      } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        showMsg('No camera found on this device.', 'error')
      } else if (e.name === 'NotReadableError') {
        showMsg('Camera busy — refresh the page or close other camera tabs and try again.', 'error')
      } else {
        showMsg('Camera unavailable: ' + (e.message || e.name), 'error')
      }
    }
  }

  // Release camera stream when leaving the page (prevents false "camera in use" errors)
  useEffect(() => {
    return () => {
      const v = videoRef.current
      if (v?.srcObject) {
        try { (v.srcObject as MediaStream).getTracks().forEach(t => t.stop()) } catch { /* noop */ }
        v.srcObject = null
      }
    }
  }, [])

  function stopCamera() {
    const v = videoRef.current
    if (v && v.srcObject) {
      ;(v.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
      v.srcObject = null
    }
    setCamOn(false)
    setLiveCheckFailed(false)
    resetGuided()
  }

  // ─── Guided multi-pose capture (straight → left → right) ─────────────────
  // Step 0 (straight) runs full liveness; later poses use a lightweight
  // descriptor extraction so we don't force the user to blink three times.
  async function guidedCaptureStep(targetIdx?: number) {
    const idx = targetIdx ?? nextPoseIdx
    if (idx < 0 || idx > TOTAL_POSE_SLOTS - 1) return
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c) { showMsg('Camera not ready.', 'error'); return }
    if (!v.videoWidth || !v.videoHeight) {
      showMsg('Camera stream not ready — wait a moment then try again.', 'error')
      return
    }
    setBusy(true)
    setMsg(null)
    if (idx === 0) setLiveCheckFailed(false)
    try {
      let descJson: string
      let descBox: Awaited<ReturnType<typeof extractFaceDescriptorWithBox>>
      if (idx === 0) {
        descBox = await runLivenessAndFaceDescriptorWithBox(v)
      } else {
        descBox = await extractFaceDescriptorWithBox(v)
      }
      descJson = descriptorToJson(descBox.descriptor)
      // Reject obviously-duplicate poses: if the new descriptor is too close
      // to ANY previously stored one, the user did not actually move their
      // head and averaging gains nothing. All-pairs check mirrors the server
      // (so e.g. pose1==pose3 with a different pose2 is also caught here for
      // immediate feedback). Threshold 0.1 mirrors the server default.
      const existingPoses = guidedPoses
        .map((p, i) => (p && i !== idx ? { slot: i, desc: p.descriptor } : null))
        .filter((x): x is { slot: number; desc: string } => !!x)
      if (existingPoses.length > 0) {
        try {
          const cur = JSON.parse(descJson) as number[]
          if (Array.isArray(cur)) {
            for (const ep of existingPoses) {
              const prevDesc = JSON.parse(ep.desc) as number[]
              if (!Array.isArray(prevDesc) || prevDesc.length !== cur.length) continue
              let s = 0
              for (let i = 0; i < cur.length; i++) {
                const d = prevDesc[i] - cur[i]
                s += d * d
              }
              const dist = Math.sqrt(s)
              if (dist < 0.1) {
                const hint = idx === 1
                  ? 'slight LEFT'
                  : idx === 2
                  ? 'slight RIGHT'
                  : idx === 3
                  ? 'चिन UP या DOWN tilt'
                  : 'a different angle'
                showMsg(`⚠️ यह pose ${ep.slot + 1} जैसा ही दिख रहा है — कृपया सिर थोड़ा ${hint} घुमाएं और फिर से capture करें।`, 'error')
                return // do not store descriptor or thumbnail
              }
            }
          }
        } catch { /* fall through — let server be the final guard */ }
      }
      const blob = await captureVideoFrameToJpegBlob(v, c)
      if (!blob) throw new Error('Could not capture photo frame — try again.')
      const quality = await assessCaptureQuality(blob, {
        faceBox: descBox.box,
        sourceWidth: descBox.imageWidth,
        sourceHeight: descBox.imageHeight,
      })
      const thumbUrl = URL.createObjectURL(blob)
      setGuidedPoses((prev) => {
        const next = [...prev]
        if (next[idx]) URL.revokeObjectURL(next[idx]!.thumbUrl)
        next[idx] = { descriptor: descJson, thumbBlob: blob, thumbUrl, quality }
        return next
      })
      if (idx === 0) {
        setFaceBlob(blob)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(URL.createObjectURL(blob))
      }
      const requiredFilledAfter = guidedPoses
        .slice(0, REQUIRED_POSES)
        .filter((p, i) => (i === idx ? true : !!p)).length
      const qualitySuffix = quality.warnings.length
        ? ` ⚠ Quality issue on this pose: ${quality.warnings.join('; ')}. Consider retaking.`
        : ''
      const successType: 'info' | 'success' = quality.warnings.length ? 'info' : 'success'
      if (idx === 3) {
        // 4th (optional) pose just captured.
        showMsg(
          `✓ Pose 4 (optional tilt) captured. Click "Register face" to save the averaged AI embedding.${qualitySuffix}`,
          successType,
        )
      } else if (requiredFilledAfter >= REQUIRED_POSES) {
        showMsg(
          `✓ All 3 required poses captured. Click "Register face" to save — or optionally capture pose 4 (chin up/down) for tougher lighting.${qualitySuffix}`,
          successType,
        )
      } else {
        const remainingRequired = [0, 1, 2].filter((i) => i !== idx && !guidedPoses[i])
        const nextIdx = remainingRequired[0]
        const hint = nextIdx === 0 ? 'STRAIGHT at the camera' : nextIdx === 1 ? 'slight LEFT' : 'slight RIGHT'
        showMsg(
          `✓ Captured pose ${idx + 1} (${requiredFilledAfter}/${REQUIRED_POSES}). Now look ${hint} and capture pose ${nextIdx + 1}.${qualitySuffix}`,
          successType,
        )
      }
    } catch (e) {
      if (idx === 0) setLiveCheckFailed(true)
      showMsg((e as Error).message || 'Capture failed — try again.', 'error')
    } finally {
      setBusy(false)
    }
  }

  // ─── Live check (AI blink + head move + 128-D descriptor) ────────────────
  async function liveCheckAndCapture() {
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c) { showMsg('Camera not ready.', 'error'); return }
    if (!v.videoWidth || !v.videoHeight) { showMsg('Camera stream not ready — wait a moment then try again.', 'error'); return }
    setBusy(true)
    setMsg(null)
    setLiveCheckFailed(false)
    setSinglePhotoQuality(null)
    try {
      const descBox = await runLivenessAndFaceDescriptorWithBox(v)
      setFaceDescriptorJson(descriptorToJson(descBox.descriptor))
      const blob = await captureVideoFrameToJpegBlob(v, c)
      if (blob) {
        setFaceBlob(blob)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(URL.createObjectURL(blob))
        const quality = await assessCaptureQuality(blob, {
          faceBox: descBox.box,
          sourceWidth: descBox.imageWidth,
          sourceHeight: descBox.imageHeight,
        })
        setSinglePhotoQuality(quality)
        const qualitySuffix = quality.warnings.length
          ? ` ⚠ Quality issue: ${quality.warnings.join('; ')}. Consider retaking.`
          : ''
        showMsg(
          `✓ Live check passed! Face captured. Click "Register face" to save.${qualitySuffix}`,
          quality.warnings.length ? 'info' : 'success',
        )
      } else {
        setFaceDescriptorJson(null)
        showMsg('Could not capture photo frame — try again.', 'error')
      }
    } catch (e) {
      setFaceDescriptorJson(null)
      setLiveCheckFailed(true)
      showMsg((e as Error).message || 'Live check failed. You can use Simple Capture as fallback.', 'error')
    } finally {
      setBusy(false)
    }
  }

  // ─── Simple capture (no AI — direct JPEG frame grab) ─────────────────────
  async function captureSimple() {
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c) { showMsg('Camera not ready.', 'error'); return }
    if (!v.videoWidth || !v.videoHeight) { showMsg('Camera stream not ready — wait a moment.', 'error'); return }
    setBusy(true)
    setMsg(null)
    setSinglePhotoQuality(null)
    try {
      const blob = await captureVideoFrameToJpegBlob(v, c)
      if (blob && blob.size > 4096) {
        setFaceBlob(blob)
        setFaceDescriptorJson(null)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(URL.createObjectURL(blob))
        setLiveCheckFailed(false)
        const quality = await assessCaptureQuality(blob)
        setSinglePhotoQuality(quality)
        const qualitySuffix = quality.warnings.length
          ? ` ⚠ Quality issue: ${quality.warnings.join('; ')}. Consider retaking.`
          : ''
        showMsg(`Photo captured (simple mode — no AI embedding). Click "Register face" to save.${qualitySuffix}`, 'info')
      } else {
        showMsg('Photo too small or blank — ensure your face is visible in good light.', 'error')
      }
    } catch (e) {
      showMsg((e as Error).message || 'Capture failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  // ─── Save face to server ──────────────────────────────────────────────────
  async function submitFace(approvalRequestId?: number) {
    // Guided mode only requires the first 3 (REQUIRED) poses; pose 4 (tilt)
    // is optional and submitted only when present.
    const useGuided = guidedMode && allRequiredCaptured
    const photoBlob = useGuided ? guidedPoses[0]!.thumbBlob : faceBlob
    if (!user || !photoBlob) {
      showMsg('Capture your face first (Live check or Simple Capture).', 'error')
      return
    }
    if (photoBlob.size < 4096) {
      showMsg('Photo too small — ensure good lighting and face is visible.', 'error')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const fd = new FormData()
      fd.append('photo', photoBlob, 'face.jpg')
      if (useGuided) {
        // Send only the captured poses (3 required, plus pose 4 if filled).
        // Server averaging route accepts any non-empty descriptor array (1-N).
        const descriptors = guidedPoses
          .filter((p): p is GuidedPose => p !== null)
          .map((p) => JSON.parse(p.descriptor))
        fd.append('faceDescriptors', JSON.stringify(descriptors))
      } else if (faceDescriptorJson) {
        fd.append('faceDescriptor', faceDescriptorJson)
      }
      if (approvalRequestId != null) fd.append('approvalRequestId', String(approvalRequestId))
      await api(`/users/${user.id}/face-enrollment`, { method: 'POST', body: fd })
      showMsg(
        useGuided
          ? `✓ Face profile saved — averaged AI embedding from ${capturedCount} pose capture${capturedCount === 1 ? '' : 's'} (best matching accuracy).`
          : faceDescriptorJson
          ? '✓ Face profile saved with AI embedding (full attendance matching active).'
          : '✓ Face photo saved (simple mode — ask HR to re-enroll with live check for AI matching).',
        'success'
      )
      setFaceBlob(null)
      setFaceDescriptorJson(null)
      setLiveCheckFailed(false)
      setSinglePhotoQuality(null)
      resetGuided()
      if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
      stopCamera()
      await refresh()
    } catch (e) {
      showMsg((e as Error).message || 'Face enrollment failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function requestKind(kind: 'face' | 'biometric') {
    setBusy(true)
    setMsg(null)
    try {
      await api('/biometric/requests', { method: 'POST', body: JSON.stringify({ kind }) })
      showMsg('Request submitted. A manager will review it.', 'success')
      await refresh()
    } catch (e) {
      showMsg((e as Error).message || 'Request failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function cancelRequest(id: number) {
    setBusy(true)
    setMsg(null)
    try {
      await api(`/biometric/requests/${id}/cancel`, { method: 'POST', body: '{}' })
      showMsg('Request cancelled.', 'info')
      await refresh()
    } catch (e) {
      showMsg((e as Error).message || 'Cancel failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function registerPasskey(approvalRequestId?: number) {
    setBusy(true)
    setMsg(null)
    try {
      await registerNewPasskey(passLabel, approvalRequestId)
      showMsg('✓ Passkey registered successfully.', 'success')
      setPassLabel('')
      await refresh()
    } catch (e) {
      const errMsg = (e as Error).message || 'Passkey registration failed.'
      if (errMsg.includes('cancelled') || errMsg.includes('user cancel') || errMsg.includes('NotAllowedError')) {
        showMsg('Passkey registration was cancelled. Try again when ready.', 'info')
      } else {
        showMsg(errMsg, 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const apprFace = bio?.approvedAwaitingEnrollment?.face
  const apprBio = bio?.approvedAwaitingEnrollment?.biometric

  const msgColor =
    msgType === 'success'
      ? 'bg-green-50 text-green-900 ring-green-200'
      : msgType === 'error'
      ? 'bg-red-50 text-red-900 ring-red-200'
      : 'bg-white text-[#14261a] ring-[#1f5e3b]/10'

  return (
    <div className="mx-auto max-w-[900px] space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Identity &amp; biometrics</h1>
        <p className="mt-1 text-sm text-[#1f5e3b]/75">
          Face and passkeys are enrolled once. Further changes need manager approval (or HR can update you directly).
          WebAuthn uses your device PIN or biometrics per OS policy — raw fingerprints are not uploaded.
        </p>
      </div>

      {blockedContext && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-lg leading-none" aria-hidden>⚠️</span>
            <div className="space-y-1.5">
              <p className="font-semibold">
                Page is open inside {blockedContext.label} — Face ID / passkey will not work here.
              </p>
              {blockedContext.kind === 'translate' && (
                <p>
                  Tap <span className="font-semibold">“Done”</span> at the top of the Translate bar
                  (or open the original page) and try again. Browser blocks biometric prompts
                  inside the Translate proxy.
                </p>
              )}
              {blockedContext.kind === 'iframe' && (
                <p>
                  Open this page directly in your browser (Chrome / Safari) instead of inside
                  another site’s frame. Biometric prompts are blocked inside embedded frames.
                </p>
              )}
              {blockedContext.kind === 'inapp' && (
                <p>
                  Tap the menu (⋮ / share) and choose <span className="font-semibold">“Open in
                  Chrome / Safari”</span>. The in-app browser does not allow Face ID / passkeys.
                </p>
              )}
              <p className="text-xs text-amber-800/80">
                URL to open directly:{' '}
                <span className="font-mono">{(typeof window !== 'undefined' ? window.location.host + window.location.pathname : '')}</span>
              </p>
            </div>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-2xl border border-[#2e7d32]/30 bg-[#e8f5e9] p-4 text-sm text-[#14261a]">
          You can approve staff requests and use direct reset tools on the{' '}
          <Link to="/biometric-requests" className="font-semibold text-[#1f5e3b] underline">
            Biometric requests
          </Link>{' '}
          page.
        </div>
      )}

      {msg && (
        <p className={`rounded-xl p-3 text-sm shadow-sm ring-1 ${msgColor}`}>{msg}</p>
      )}

      {wa && (
        <div className="rounded-2xl border border-[#1f5e3b]/10 bg-[#1f5e3b]/5 px-4 py-3 text-xs text-[#1f5e3b]/80">
          <span className="font-medium">Attendance WebAuthn policy:</span> {wa.mode} ·{' '}
          <span className="font-medium">Passkeys on file:</span> {wa.credCount}
        </div>
      )}

      {/* ── Face enrollment ─────────────────────────────────────────────── */}
      <div className="ph-card space-y-4 rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-[#1f5e3b]">Face (attendance matching)</h2>
        <p className="text-xs text-[#1f5e3b]/70">
          Status:{' '}
          <span className="font-semibold">{bio?.hasFace ? 'Enrolled' : 'Not enrolled yet'}</span>
          {bio?.faceEmbeddingActive ? (
            <span className="ml-1 font-semibold text-[#2e7d32]">· AI embedding active</span>
          ) : (
            <span className="ml-1 text-[#1f5e3b]/60">· legacy photo match until you re-save with live check</span>
          )}
        </p>

        {bio?.hasFace && (() => {
          const n = bio.faceDescriptorCount
          let label: string
          let cls: string
          if (n == null || n <= 0) {
            label = 'Legacy enrollment'
            cls = 'bg-gray-100 text-gray-800 ring-gray-300'
          } else if (n >= 4) {
            label = `Enhanced — ${n} poses`
            cls = 'bg-blue-50 text-blue-800 ring-blue-200'
          } else if (n === 3) {
            label = 'Basic — 3 poses'
            cls = 'bg-emerald-50 text-emerald-800 ring-emerald-200'
          } else {
            label = `Basic — ${n} pose${n === 1 ? '' : 's'}`
            cls = 'bg-amber-50 text-amber-800 ring-amber-200'
          }
          const isLegacy = n == null || n <= 0
          const showUpgradeTip = isLegacy || n < 4
          return (
            <div className="space-y-1.5">
              <span className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${cls}`}>
                {label}
              </span>
              {showUpgradeTip && (
                <p className="text-xs text-[#1f5e3b]/70">
                  Tip: an optional 4th pose (chin slightly up or down) helps attendance match under tough lighting like overhead lights or caps.{' '}
                  {canRequest
                    ? 'Use "Request face update" below to re-enroll with all 4 poses.'
                    : 'Ask HR to re-enroll your face with the 4th pose added.'}
                </p>
              )}
            </div>
          )
        })()}

        {!bio?.hasFace && (
          <span className="text-xs font-semibold uppercase tracking-wide text-[#2e7d32]">First-time register</span>
        )}

        {bio?.hasFace && canRequest && (
          <button
            type="button"
            disabled={busy || !bio.canRequestFaceUpdate}
            title={bio.blockReasonFace}
            onClick={() => requestKind('face')}
            className="rounded-xl border border-[#1f5e3b]/25 px-4 py-2 text-sm font-semibold text-[#1f5e3b] disabled:opacity-50"
          >
            Request face update
          </button>
        )}

        {apprFace && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-950">
            <p className="font-semibold">Approved — complete face update</p>
            <p className="mt-1 text-xs">
              Expires: {apprFace.approval_expires_at ? new Date(apprFace.approval_expires_at).toLocaleString() : '—'}
            </p>
          </div>
        )}

        {(!bio?.hasFace || apprFace) && (
          <div className="space-y-3 border-t border-[#1f5e3b]/10 pt-4">
            {/* Mode toggle: 3-pose guided vs single-photo legacy */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-[#1f5e3b]/80">Capture mode:</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setGuidedMode(true); resetGuided(); setFaceBlob(null); setFaceDescriptorJson(null); setSinglePhotoQuality(null); if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) } }}
                className={`rounded-lg px-3 py-1 font-semibold ring-1 ${guidedMode ? 'bg-[#1f5e3b] text-white ring-[#1f5e3b]' : 'bg-white text-[#1f5e3b] ring-[#1f5e3b]/20'}`}
              >
                Guided 3-pose (recommended)
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setGuidedMode(false); resetGuided(); setFaceBlob(null); setFaceDescriptorJson(null); setSinglePhotoQuality(null); if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) } }}
                className={`rounded-lg px-3 py-1 font-semibold ring-1 ${!guidedMode ? 'bg-[#1f5e3b] text-white ring-[#1f5e3b]' : 'bg-white text-[#1f5e3b] ring-[#1f5e3b]/20'}`}
              >
                Single photo
              </button>
            </div>

            {guidedMode ? (
              <p className="text-xs text-[#1f5e3b]/70">
                Open the camera and capture <span className="font-semibold">3 photos</span> at slightly different angles
                (straight, slight left, slight right). The server averages the 3 AI embeddings into one descriptor for
                more robust attendance matching across head poses.
              </p>
            ) : (
              <p className="text-xs text-[#1f5e3b]/70">
                Open the camera, run <span className="font-semibold">Live check &amp; capture</span> (blink once + small head
                move), then save. This stores a 128-D embedding for attendance matching.
              </p>
            )}
            <p className="text-xs text-amber-800">
              If the AI live check fails (slow internet / older device), switch to <span className="font-semibold">Single photo</span> mode and use <span className="font-semibold">Simple Capture</span> as fallback — it stores your photo without AI embedding.
            </p>

            {/* ── Always in DOM — visibility toggled by CSS ── */}
            <video
              ref={videoRef}
              playsInline
              muted
              className={`max-h-48 rounded-xl border border-[#1f5e3b]/20 ${camOn ? 'block' : 'hidden'}`}
            />
            <canvas ref={canvasRef} className="hidden" />

            {!camOn ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => startCamera()}
                className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Open camera
              </button>
            ) : guidedMode ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-[#1f5e3b]/15 bg-[#1f5e3b]/5 p-3">
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[#1f5e3b]">
                    <span>
                      {allRequiredCaptured
                        ? guidedPoses[3]
                          ? 'All 4 poses captured'
                          : 'Optional pose 4 available'
                        : `Step ${Math.min(guidedStep + 1, REQUIRED_POSES)} of ${REQUIRED_POSES}`}
                    </span>
                    <span>
                      {requiredCapturedCount}/{REQUIRED_POSES} required
                      {guidedPoses[3] ? ' · +1 optional' : ''}
                    </span>
                  </div>
                  <div className="mb-2 flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`h-1.5 flex-1 rounded-full ${
                          guidedPoses[i]
                            ? i === 3
                              ? 'bg-[#1565c0]' // optional pose: blue when filled
                              : 'bg-[#2e7d32]'
                            : i === 3
                            ? 'bg-[#1565c0]/15'
                            : 'bg-[#1f5e3b]/15'
                        }`}
                      />
                    ))}
                  </div>
                  {/* Thumbnail strip — one tile per pose with a per-pose retake button */}
                  <div className="mb-2 grid grid-cols-4 gap-2">
                    {[0, 1, 2, 3].map((i) => {
                      const pose = guidedPoses[i]
                      const labels = ['Straight', 'Left', 'Right', 'Tilt']
                      const isOptional = i === 3
                      return (
                        <div
                          key={i}
                          className={`flex flex-col overflow-hidden rounded-lg border ${
                            pose
                              ? isOptional
                                ? 'border-[#1565c0]/40 bg-white'
                                : 'border-[#2e7d32]/40 bg-white'
                              : isOptional
                              ? 'border-dashed border-[#1565c0]/30 bg-white/50'
                              : 'border-dashed border-[#1f5e3b]/25 bg-white/50'
                          }`}
                        >
                          <div className="relative aspect-square w-full bg-[#1f5e3b]/5">
                            {pose ? (
                              <img
                                src={pose.thumbUrl}
                                alt={`Pose ${i + 1} (${labels[i]})`}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-center text-[10px] font-medium leading-tight text-[#1f5e3b]/50">
                                {isOptional ? 'Optional' : 'Not captured'}
                              </div>
                            )}
                            <span
                              className={`absolute left-1 top-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white ${
                                isOptional ? 'bg-[#1565c0]/85' : 'bg-black/55'
                              }`}
                            >
                              {i + 1} · {labels[i]}
                            </span>
                            {pose && pose.quality.warnings.length > 0 && (
                              <span
                                className="absolute right-1 top-1 rounded bg-amber-500/95 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow"
                                title={pose.quality.warnings.join('; ')}
                              >
                                ⚠ Quality
                              </span>
                            )}
                          </div>
                          {pose && pose.quality.warnings.length > 0 && (
                            <p
                              className="px-1 pt-1 text-[10px] leading-tight text-amber-800"
                              title={pose.quality.warnings.join('; ')}
                            >
                              {pose.quality.warnings[0]}
                            </p>
                          )}
                          {pose && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => retakePose(i)}
                              className="border-t border-[#1f5e3b]/10 px-1 py-1 text-[10px] font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5 disabled:opacity-50"
                            >
                              Retake
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {guidedStep < REQUIRED_POSES ? (
                    <p className="text-xs text-[#1f5e3b]/80">
                      {guidedStep === 0 && (
                        <>
                          <span className="font-semibold">Pose 1 — Look STRAIGHT at the camera.</span> Blink once and
                          move your head slightly so we can verify liveness.
                        </>
                      )}
                      {guidedStep === 1 && (
                        <>
                          <span className="font-semibold">Pose 2 — Turn your head SLIGHTLY LEFT</span> (about 15-20°)
                          while keeping your eyes on the camera.
                        </>
                      )}
                      {guidedStep === 2 && (
                        <>
                          <span className="font-semibold">Pose 3 — Turn your head SLIGHTLY RIGHT</span> (about 15-20°)
                          while keeping your eyes on the camera.
                        </>
                      )}
                    </p>
                  ) : !guidedPoses[3] ? (
                    <p className="text-xs text-[#1565c0]">
                      <span className="font-semibold">All 3 required poses captured.</span> You can save now — or
                      optionally capture <span className="font-semibold">Pose 4 (chin slightly UP or DOWN)</span> to
                      improve matching under overhead lights / caps.
                    </p>
                  ) : (
                    <p className="text-xs font-semibold text-[#2e7d32]">
                      All 4 poses captured — ready to save.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {nextPoseIdx !== -1 ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => guidedCaptureStep()}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${
                        nextPoseIdx === 3 ? 'bg-[#1565c0]' : 'bg-[#2e7d32]'
                      }`}
                    >
                      {busy
                        ? nextPoseIdx === 0
                          ? 'Running live check…'
                          : 'Capturing…'
                        : nextPoseIdx === 0
                        ? 'Capture pose 1 (with live check)'
                        : nextPoseIdx === 3
                        ? 'Capture pose 4 (optional tilt)'
                        : `Capture pose ${nextPoseIdx + 1}`}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { resetGuided(); setFaceBlob(null); setFaceDescriptorJson(null); if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }; showMsg('Restarting guided capture from pose 1.', 'info') }}
                    className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs text-[#1f5e3b]"
                  >
                    Restart
                  </button>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs text-[#1f5e3b]"
                  >
                    Close camera
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => liveCheckAndCapture()}
                  className="rounded-lg bg-[#2e7d32] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {busy ? 'Running live check…' : 'Live check & capture'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => captureSimple()}
                  className="rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 disabled:opacity-50"
                  title="Skip AI liveness — directly capture frame (fallback for slow devices)"
                >
                  Simple capture
                </button>
                <button
                  type="button"
                  onClick={stopCamera}
                  className="rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs text-[#1f5e3b]"
                >
                  Close camera
                </button>
              </div>
            )}

            {liveCheckFailed && !faceBlob && (
              <p className="text-xs text-amber-800">
                Live check failed (AI models may be loading slowly). Click <strong>Simple capture</strong> above to take a photo without liveness detection.
              </p>
            )}

            {previewUrl && !guidedMode && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-[#1f5e3b]/70">Captured photo preview:</p>
                <div className="relative inline-block">
                  <img src={previewUrl} alt="Captured face" className="max-h-40 rounded-xl border border-[#1f5e3b]/15" />
                  {singlePhotoQuality && singlePhotoQuality.warnings.length > 0 && (
                    <span
                      className="absolute right-1 top-1 rounded bg-amber-500/95 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow"
                      title={singlePhotoQuality.warnings.join('; ')}
                    >
                      ⚠ Quality
                    </span>
                  )}
                </div>
                {singlePhotoQuality && singlePhotoQuality.warnings.length > 0 && (
                  <p className="text-xs text-amber-800">
                    ⚠ {singlePhotoQuality.warnings.join('; ')}. You can retake or save anyway.
                  </p>
                )}
                {!faceDescriptorJson && (
                  <p className="text-xs text-amber-700">Simple mode — no AI embedding. Attendance matching may be less accurate.</p>
                )}
              </div>
            )}

            {(() => {
              const guidedWarnings = guidedMode
                ? guidedPoses
                    .map((p, i) => (p && p.quality.warnings.length ? `Pose ${i + 1}: ${p.quality.warnings.join(', ')}` : null))
                    .filter((s): s is string => !!s)
                : []
              const singleWarnings =
                !guidedMode && singlePhotoQuality ? singlePhotoQuality.warnings : []
              const allWarnings = [...guidedWarnings, ...singleWarnings]
              const captureReady = guidedMode ? allRequiredCaptured : !!faceBlob
              const saveDisabled = busy || !captureReady
              const tooltip = !captureReady
                ? guidedMode
                  ? `Capture all ${REQUIRED_POSES} required poses first (${requiredCapturedCount}/${REQUIRED_POSES} done)`
                  : 'Capture a photo first'
                : allWarnings.length
                ? `Quality warnings — consider retaking before saving:\n• ${allWarnings.join('\n• ')}`
                : undefined
              return (
                <>
                  {captureReady && allWarnings.length > 0 && (
                    <div className="rounded-xl border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-900">
                      <p className="font-semibold">⚠ Quality warnings — consider retaking before saving:</p>
                      <ul className="mt-1 list-disc pl-5">
                        {allWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={saveDisabled}
                    title={tooltip}
                    onClick={() => submitFace(apprFace?.id)}
                    className={`rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                      captureReady && allWarnings.length > 0
                        ? 'bg-gradient-to-r from-amber-600 to-amber-700'
                        : 'bg-gradient-to-r from-[#1f5e3b] to-[#2e7d32]'
                    }`}
                  >
                    {guidedMode && !allRequiredCaptured
                      ? `Register face (capture ${requiredCapturedCount}/${REQUIRED_POSES} required poses first)`
                      : allWarnings.length > 0
                      ? guidedMode
                        ? bio?.hasFace
                          ? `Save anyway (${capturedCount} pose${capturedCount === 1 ? '' : 's'}, quality warning)`
                          : `Register anyway (${capturedCount} pose${capturedCount === 1 ? '' : 's'}, quality warning)`
                        : bio?.hasFace
                        ? 'Save anyway (quality warning)'
                        : 'Register anyway (quality warning)'
                      : guidedMode
                      ? bio?.hasFace
                        ? `Save new face (${capturedCount} pose${capturedCount === 1 ? '' : 's'}, approved update)`
                        : `Register face (${capturedCount} pose${capturedCount === 1 ? '' : 's'})`
                      : bio?.hasFace
                      ? 'Save new face (approved update)'
                      : 'Register face'}
                  </button>
                </>
              )
            })()}
          </div>
        )}
      </div>

      {/* ── Passkey / WebAuthn ──────────────────────────────────────────── */}
      <div className="ph-card space-y-4 rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-[#1f5e3b]">Passkey (WebAuthn)</h2>
        <p className="text-xs text-[#1f5e3b]/70">
          Registered passkeys: <span className="font-semibold">{bio?.webauthnCount ?? 0}</span>
        </p>

        {!browserSupportsWebAuthn() ? (
          <p className="text-xs font-medium text-amber-900">
            This browser does not support WebAuthn passkeys. Use Chrome, Safari, or Edge on a modern device.
          </p>
        ) : null}

        {bio && bio.webauthnCount === 0 && browserSupportsWebAuthn() && (
          <div className="space-y-2">
            <p className="text-xs text-[#1f5e3b]/70">
              Register your device (phone fingerprint, face ID, or PIN) as a passkey for attendance verification.
            </p>
            <label className="text-xs font-medium text-[#1f5e3b]">Label (optional)</label>
            <input
              value={passLabel}
              onChange={(e) => setPassLabel(e.target.value)}
              className="mt-1 w-full max-w-md rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm"
              placeholder="e.g. My Phone, Office PC"
              maxLength={120}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => registerPasskey()}
              className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Waiting for device…' : 'Register passkey'}
            </button>
          </div>
        )}

        {bio && bio.webauthnCount > 0 && canRequest && (
          <button
            type="button"
            disabled={busy || !bio.canRequestBiometricUpdate}
            title={bio.blockReasonBiometric}
            onClick={() => requestKind('biometric')}
            className="rounded-xl border border-[#1f5e3b]/25 px-4 py-2 text-sm font-semibold text-[#1f5e3b] disabled:opacity-50"
          >
            Request passkey update
          </button>
        )}

        {apprBio && browserSupportsWebAuthn() && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-950">
            <p className="font-semibold">Approved — register replacement passkey</p>
            <p className="mt-1 text-xs">
              Expires: {apprBio.approval_expires_at ? new Date(apprBio.approval_expires_at).toLocaleString() : '—'}
            </p>
            <input
              value={passLabel}
              onChange={(e) => setPassLabel(e.target.value)}
              className="mt-2 w-full max-w-md rounded-xl border border-amber-300/60 bg-white px-3 py-2 text-sm"
              placeholder="New passkey label"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => registerPasskey(apprBio.id)}
              className="mt-2 rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Complete passkey update
            </button>
          </div>
        )}

        {creds.length > 0 && (
          <ul className="space-y-2 border-t border-[#1f5e3b]/10 pt-3 text-sm">
            {creds.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#1f5e3b]/5 px-3 py-2"
              >
                <span>
                  <span className="font-medium">{c.device_label || 'Passkey'}</span>
                  <span className="ml-2 text-xs text-[#1f5e3b]/70">
                    {c.created_at ? new Date(c.created_at).toLocaleString() : ''}
                  </span>
                </span>
                {user?.role !== 'USER' || creds.length > 1 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await deleteWebAuthnCredential(c.id)
                        showMsg('Passkey removed.', 'info')
                        await refresh()
                      } catch (e) {
                        showMsg((e as Error).message, 'error')
                      } finally {
                        setBusy(false)
                      }
                    }}
                    className="text-xs font-semibold text-red-700 underline"
                  >
                    Remove
                  </button>
                ) : (
                  <span className="text-xs text-[#1f5e3b]/60">Staff cannot remove their only passkey here.</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── My requests ─────────────────────────────────────────────────── */}
      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1f5e3b]/80">My requests</h2>
        {mine.length === 0 ? (
          <p className="mt-2 text-sm text-[#1f5e3b]/60">No recent requests.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {mine.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#1f5e3b]/10 px-3 py-2"
              >
                <span>
                  <span className="font-medium capitalize">{r.kind}</span> · {r.status}
                  {r.reject_reason ? <span className="ml-2 text-red-700">({r.reject_reason})</span> : null}
                </span>
                {r.status === 'pending' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => cancelRequest(r.id)}
                    className="text-xs font-semibold text-[#1f5e3b] underline"
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-center text-sm">
        <Link to="/attendance" className="font-semibold text-[#2e7d32] underline">
          Back to Attendance
        </Link>
      </p>
    </div>
  )
}
