/**
 * Face recognition net descriptors (e.g. face-api.js 128-D) — cosine / L2 match server-side.
 */

const EMBEDDING_DIM = 128;

function parseEmbeddingPayload(raw) {
  if (raw == null) return null;
  let arr = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length !== EMBEDDING_DIM) return null;
  const out = new Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const n = Number(arr[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function l2Distance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * @param {string|null|undefined} storedJson
 * @param {number[]|null} candidate
 */
function matchEmbedding(storedJson, candidate) {
  const parsed = parseEmbeddingPayload(storedJson);
  if (!parsed || !candidate) {
    return { ok: false, reason: "missing", distance: null };
  }
  const dist = l2Distance(parsed, candidate);
  const thr = Number(process.env.FACE_EMBEDDING_MATCH_THRESHOLD);
  // Default 0.68 — practical/tolerant: same person matches even with mild
  // lighting/angle changes, while still rejecting obvious imposters.
  // Range guidance: 0.4=very strict, 0.55=balanced, 0.68=tolerant, 0.8+=too loose.
  const threshold = Number.isFinite(thr) && thr > 0 && thr < 2 ? thr : 0.68;
  return { ok: dist <= threshold, distance: dist, threshold };
}

function serializeEmbedding(arr) {
  const v = parseEmbeddingPayload(arr);
  return v ? JSON.stringify(v) : null;
}

/**
 * Check whether two descriptors are so close that they almost certainly
 * came from the same head pose / frame (i.e. user did not actually move
 * between captures). Used by guided multi-pose enrollment to force the
 * user to actually turn their head between the 3 captures, otherwise
 * averaging gains nothing.
 *
 * Default threshold 0.1 — face-api.js descriptors of the SAME person
 * with even a small head rotation typically differ by 0.15-0.30; below
 * 0.1 means almost identical frames. Override via env var
 * FACE_DUPLICATE_POSE_THRESHOLD.
 *
 * @param {number[]|string|null|undefined} a
 * @param {number[]|string|null|undefined} b
 * @returns {{ tooSimilar: boolean, distance: number, threshold: number }}
 */
function tooSimilar(a, b) {
  const pa = parseEmbeddingPayload(a);
  const pb = parseEmbeddingPayload(b);
  const thr = Number(process.env.FACE_DUPLICATE_POSE_THRESHOLD);
  const threshold = Number.isFinite(thr) && thr > 0 && thr < 2 ? thr : 0.1;
  if (!pa || !pb) {
    return { tooSimilar: false, distance: Infinity, threshold };
  }
  const distance = l2Distance(pa, pb);
  return { tooSimilar: distance < threshold, distance, threshold };
}

/**
 * Average multiple 128-D descriptors (e.g. captured at different head poses)
 * into a single descriptor. Each descriptor is parsed/validated; invalid ones
 * are skipped. Returns the L2-normalized mean vector, or null if no valid
 * descriptors were supplied.
 *
 * face-api.js produces unit-length descriptors; the arithmetic mean of
 * unit vectors is not unit-length, so we re-normalize so cosine/L2-distance
 * thresholds stay calibrated against single-shot enrollments.
 *
 * @param {Array<number[]|string>} list
 * @returns {number[]|null}
 */
function averageEmbeddings(list) {
  const r = averageEmbeddingsDetailed(list);
  return r ? r.vector : null;
}

/**
 * Same as `averageEmbeddings` but also reports the count of valid descriptors
 * that were actually averaged (skipped invalid entries are excluded). Useful
 * for audit telemetry so we record what was really used, not what was sent.
 *
 * @param {Array<number[]|string>} list
 * @returns {{ vector: number[], used: number, total: number }|null}
 */
function averageEmbeddingsDetailed(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const sum = new Array(EMBEDDING_DIM).fill(0);
  let count = 0;
  for (const item of list) {
    const v = parseEmbeddingPayload(item);
    if (!v) continue;
    for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] += v[i];
    count++;
  }
  if (count === 0) return null;
  for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] /= count;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm < 1e-8) return null;
  for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] /= norm;
  return { vector: sum, used: count, total: list.length };
}

module.exports = {
  EMBEDDING_DIM,
  parseEmbeddingPayload,
  matchEmbedding,
  serializeEmbedding,
  averageEmbeddings,
  averageEmbeddingsDetailed,
  tooSimilar,
};
