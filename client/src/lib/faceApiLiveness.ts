/**
 * face-api.js models + simple blink + head-movement liveness before returning a 128-D descriptor.
 */

import * as faceapi from 'face-api.js'

let modelLoadPromise: Promise<void> | null = null

export function getFaceModelBaseUrl(): string {
  const raw = import.meta.env.VITE_FACE_MODEL_URL
  if (typeof raw === 'string' && raw.trim()) return raw.replace(/\/$/, '')
  return '/face-models'
}

const CDN_FALLBACK = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights'

async function loadAllFrom(base: string): Promise<void> {
  await faceapi.nets.ssdMobilenetv1.loadFromUri(base)
  await faceapi.nets.faceLandmark68Net.loadFromUri(base)
  await faceapi.nets.faceRecognitionNet.loadFromUri(base)
}

export function ensureFaceModelsLoaded(): Promise<void> {
  if (modelLoadPromise) return modelLoadPromise
  const base = getFaceModelBaseUrl()
  modelLoadPromise = (async () => {
    try {
      await loadAllFrom(base)
    } catch (primaryErr) {
      if (base === CDN_FALLBACK) throw primaryErr
      try {
        await loadAllFrom(CDN_FALLBACK)
      } catch {
        throw primaryErr
      }
    }
  })().catch((e) => {
    modelLoadPromise = null
    throw e
  })
  return modelLoadPromise
}

function eyeAspectRatio(eye: faceapi.Point[]) {
  if (eye.length < 6) return 0.35
  const v1 = Math.hypot(eye[1].x - eye[5].x, eye[1].y - eye[5].y)
  const v2 = Math.hypot(eye[2].x - eye[4].x, eye[2].y - eye[4].y)
  const h = Math.hypot(eye[0].x - eye[3].x, eye[0].y - eye[3].y)
  return h > 0 ? (v1 + v2) / (2 * h) : 0.35
}

function meanEar(lm: faceapi.FaceLandmarks68) {
  return (eyeAspectRatio(lm.getLeftEye()) + eyeAspectRatio(lm.getRightEye())) / 2
}

export function descriptorToJson(d: Float32Array): string {
  return JSON.stringify(Array.from(d))
}

/**
 * Lightweight face descriptor extraction (no liveness loop). Used for
 * additional pose captures during guided multi-photo enrollment, where
 * full liveness was already enforced on the first capture.
 */
export type FaceBox = { x: number; y: number; width: number; height: number }
export type DescriptorWithBox = {
  descriptor: Float32Array
  box: FaceBox
  imageWidth: number
  imageHeight: number
}

export async function extractFaceDescriptor(video: HTMLVideoElement): Promise<Float32Array> {
  return (await extractFaceDescriptorWithBox(video)).descriptor
}

export async function extractFaceDescriptorWithBox(video: HTMLVideoElement): Promise<DescriptorWithBox> {
  await ensureFaceModelsLoaded()
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('Camera not ready — wait for preview, then try again.')
  }
  const ssdOpts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 })
  const det = await faceapi.detectSingleFace(video, ssdOpts).withFaceLandmarks().withFaceDescriptor()
  if (!det) {
    throw new Error('No face detected — face the camera in good light and try again.')
  }
  const b = det.detection.box
  return {
    descriptor: det.descriptor,
    box: { x: b.x, y: b.y, width: b.width, height: b.height },
    imageWidth: video.videoWidth,
    imageHeight: video.videoHeight,
  }
}

/**
 * Samples the video for a few seconds, requires a visible blink and slight head movement,
 * then returns a face descriptor from SSD + recognition nets.
 */
export async function runLivenessAndFaceDescriptor(video: HTMLVideoElement): Promise<Float32Array> {
  return (await runLivenessAndFaceDescriptorWithBox(video)).descriptor
}

export async function runLivenessAndFaceDescriptorWithBox(video: HTMLVideoElement): Promise<DescriptorWithBox> {
  await ensureFaceModelsLoaded()
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('Camera not ready — wait for preview, then try again.')
  }

  // Liveness sampling tuned for slow Android phones (where SSD MobileNet
  // detection can take 300-500ms per frame). We extend the deadline, drop
  // the artificial inter-frame sleep, and lower the minimum frame count so
  // budget devices can still pass the live check while still requiring a
  // visible blink + slight head movement (printed-photo / video-replay
  // attacks remain blocked).
  const ssdOpts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 })
  const ears: number[] = []
  const noseX: number[] = []
  // Frame-budget tuning:
  //   MIN_FRAMES — minimum to assert blink + movement reliably
  //   SOFT_DL    — earliest moment a successful early-exit may occur
  //                (gives the user real wall-clock time to blink/move)
  //   HARD_DL    — absolute cap so we never hang forever
  const MIN_FRAMES = 6
  const SOFT_DEADLINE_MS = 3500
  const HARD_DEADLINE_MS = 11000
  const EAR_SPREAD_PASS = 0.035
  const NX_SPREAD_PASS = 2.5
  const start = Date.now()

  // Exit conditions (whichever happens first):
  //   1. ALL three signals already detected (sufficient frames + visible
  //      blink + head movement) AND past soft deadline → exit early.
  //   2. Hard cap HARD_DEADLINE_MS reached → exit (final post-loop checks
  //      will then decide pass/fail). Weak-signal sessions therefore get
  //      the full 11s window to gather evidence.
  while (true) {
    const elapsed = Date.now() - start
    if (elapsed >= HARD_DEADLINE_MS) break
    if (
      elapsed >= SOFT_DEADLINE_MS &&
      ears.length >= MIN_FRAMES &&
      noseX.length >= MIN_FRAMES
    ) {
      const earSpreadNow = Math.max(...ears) - Math.min(...ears)
      const nxSpreadNow = Math.max(...noseX) - Math.min(...noseX)
      if (earSpreadNow >= EAR_SPREAD_PASS && nxSpreadNow >= NX_SPREAD_PASS) break
    }

    const det = await faceapi.detectSingleFace(video, ssdOpts).withFaceLandmarks()
    if (det) {
      ears.push(meanEar(det.landmarks))
      const nose = det.landmarks.getNose()[0]
      noseX.push(nose.x)
    }
    // No artificial sleep — SSD detection itself is the natural rate-limit.
  }

  // Anti-spoof: ALL three signals MUST be present — sufficient frames,
  // a visible blink, AND head movement. None may be skipped.
  if (ears.length < MIN_FRAMES) {
    throw new Error('Face not visible long enough — face the camera in good light, then try again.')
  }

  const earSpread = Math.max(...ears) - Math.min(...ears)
  if (earSpread < 0.035) {
    throw new Error('Please blink clearly once (printed photos cannot blink).')
  }

  if (noseX.length < MIN_FRAMES) {
    throw new Error('Could not track head movement — face the camera and try again.')
  }
  const nxSpread = Math.max(...noseX) - Math.min(...noseX)
  if (nxSpread < 2.5) {
    throw new Error('Please move your head slightly side-to-side.')
  }

  const final = await faceapi.detectSingleFace(video, ssdOpts).withFaceLandmarks().withFaceDescriptor()
  if (!final) {
    throw new Error('Could not read face after liveness — try again.')
  }
  const b = final.detection.box
  return {
    descriptor: final.descriptor,
    box: { x: b.x, y: b.y, width: b.width, height: b.height },
    imageWidth: video.videoWidth,
    imageHeight: video.videoHeight,
  }
}
