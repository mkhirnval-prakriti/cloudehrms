/**
 * Fast path for attendance face: smaller JPEGs upload quicker and decode faster server-side (jpeg-js).
 */

const DEFAULT_MAX_EDGE = 640
const DEFAULT_QUALITY = 0.78

export function getFaceCameraConstraints(): MediaStreamConstraints {
  return {
    video: {
      facingMode: 'user',
      width: { ideal: 640, max: 1280 },
      height: { ideal: 480, max: 720 },
    },
    audio: false,
  }
}

export function captureVideoFrameToJpegBlob(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  options?: { maxEdge?: number; quality?: number }
): Promise<Blob | null> {
  const maxEdge = options?.maxEdge ?? DEFAULT_MAX_EDGE
  const quality = options?.quality ?? DEFAULT_QUALITY
  return new Promise((resolve) => {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) {
      resolve(null)
      return
    }
    let tw = vw
    let th = vh
    if (vw > maxEdge || vh > maxEdge) {
      const scale = maxEdge / Math.max(vw, vh)
      tw = Math.max(1, Math.round(vw * scale))
      th = Math.max(1, Math.round(vh * scale))
    }
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      resolve(null)
      return
    }
    ctx.drawImage(video, 0, 0, tw, th)
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
  })
}

/**
 * Quick per-thumbnail quality check: brightness (mean luma), sharpness
 * (Laplacian variance), and — if a face bbox is supplied — the fraction of
 * the frame the face occupies. Returns human-readable warnings so the UI
 * can flag bad captures before they get averaged into the embedding.
 */
export type CaptureQuality = {
  brightness: number
  sharpness: number
  faceFrac: number | null
  warnings: string[]
}

const BRIGHTNESS_DARK = 55
const BRIGHTNESS_BRIGHT = 232
const SHARPNESS_MIN = 18
const FACE_FRAC_MIN = 0.05

async function decodeBlobToBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob)
    } catch {
      /* fall through to HTMLImageElement */
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('decode-failed'))
      i.src = url
    })
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function assessCaptureQuality(
  blob: Blob,
  opts?: {
    faceBox?: { x: number; y: number; width: number; height: number } | null
    sourceWidth?: number
    sourceHeight?: number
  },
): Promise<CaptureQuality> {
  const warnings: string[] = []
  const sample = 160
  let brightness = 0
  let sharpness = 0
  let w = 0
  let h = 0
  try {
    const bmp = await decodeBlobToBitmap(blob)
    const sw = (bmp as ImageBitmap).width || (bmp as HTMLImageElement).naturalWidth
    const sh = (bmp as ImageBitmap).height || (bmp as HTMLImageElement).naturalHeight
    if (sw && sh) {
      const scale = Math.min(1, sample / Math.max(sw, sh))
      w = Math.max(1, Math.round(sw * scale))
      h = Math.max(1, Math.round(sh * scale))
      const c =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(w, h)
          : Object.assign(document.createElement('canvas'), { width: w, height: h })
      const ctx = (c as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null
      if (ctx) {
        ctx.drawImage(bmp as CanvasImageSource, 0, 0, w, h)
        const data = ctx.getImageData(0, 0, w, h).data
        const luma = new Float32Array(w * h)
        let sum = 0
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          luma[p] = y
          sum += y
        }
        brightness = sum / luma.length
        // Laplacian variance: |4*c - up - down - left - right|, then variance
        let lapSum = 0
        let lapSqSum = 0
        let count = 0
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x
            const v = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w]
            lapSum += v
            lapSqSum += v * v
            count++
          }
        }
        if (count > 0) {
          const mean = lapSum / count
          sharpness = Math.max(0, lapSqSum / count - mean * mean)
        }
      }
    }
  } catch {
    /* keep defaults; we'll still return whatever we have */
  }

  let faceFrac: number | null = null
  if (opts?.faceBox && opts.sourceWidth && opts.sourceHeight) {
    const area = opts.faceBox.width * opts.faceBox.height
    const total = opts.sourceWidth * opts.sourceHeight
    if (total > 0) faceFrac = area / total
  }

  if (brightness > 0 && brightness < BRIGHTNESS_DARK) warnings.push('Too dark — retake in better light')
  else if (brightness > BRIGHTNESS_BRIGHT) warnings.push('Overexposed — reduce backlight')
  if (sharpness > 0 && sharpness < SHARPNESS_MIN) warnings.push('Looks blurry — hold the camera steady')
  if (faceFrac != null && faceFrac < FACE_FRAC_MIN) warnings.push('Face too small — move closer')

  return { brightness, sharpness, faceFrac, warnings }
}
