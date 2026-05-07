/**
 * Controlled face + WebAuthn enrollment: first-time, approval-gated updates, admin bypass.
 */

const { ROLES, can } = require("./rbac");

const MS_DAY = 86400000;

/** Self-service passkeys allowed without manager approval (e.g. phone + laptop + spare). */
const MAX_SELF_WEBAUTHN_CREDENTIALS = 3;

function cooldownDays() {
  const n = Number(process.env.BIOMETRIC_UPDATE_COOLDOWN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function approvalWindowHours() {
  const n = Number(process.env.BIOMETRIC_APPROVAL_WINDOW_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function hasFaceProfile(db, userId) {
  return !!db.prepare("SELECT 1 FROM user_face_profiles WHERE user_id = ?").get(userId);
}

function webauthnCredentialCount(db, userId) {
  const r = db.prepare("SELECT COUNT(*) AS c FROM webauthn_credentials WHERE user_id = ?").get(userId);
  return Number(r?.c || 0);
}

function expireStaleApprovedRequests(db) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE biometric_update_requests
     SET status = 'expired', resolved_at = COALESCE(resolved_at, ?)
     WHERE status = 'approved' AND approval_expires_at IS NOT NULL AND approval_expires_at < ?`
  ).run(now, now);
}

/**
 * @param {import('./db').WrappedDb} db
 * @param {{ userId: number, requestId: unknown, kind: 'face'|'biometric' }} p
 */
function findConsumableApproval(db, p) {
  expireStaleApprovedRequests(db);
  const id = Number(p.requestId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: "Valid approvalRequestId is required for this update." };
  }
  const row = db.prepare("SELECT * FROM biometric_update_requests WHERE id = ? AND user_id = ?").get(id, p.userId);
  if (!row) return { ok: false, error: "Approval request not found." };
  if (String(row.kind) !== p.kind) return { ok: false, error: "Approval request type does not match this action." };
  if (String(row.status) !== "approved") {
    return { ok: false, error: "This request is not in an approved state (it may have expired or been used)." };
  }
  const exp = row.approval_expires_at;
  if (exp && new Date(String(exp)).getTime() < Date.now()) {
    db.prepare("UPDATE biometric_update_requests SET status = 'expired' WHERE id = ?").run(id);
    return { ok: false, error: "Approval has expired. Ask an administrator to approve a new request." };
  }
  return { ok: true, row };
}

function markApprovalRequestCompleted(db, requestId) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE biometric_update_requests SET status = 'completed', completed_at = ?, approval_expires_at = NULL WHERE id = ?`
  ).run(now, requestId);
}

/** Super Admin, Admin, Attendance Manager, or same-branch Branch Manager. */
function canActorManageSubjectBiometric(actor, subjectUserId, db) {
  if (!actor || subjectUserId == null) return false;
  if (
    actor.role === ROLES.SUPER_ADMIN ||
    actor.role === ROLES.ADMIN ||
    actor.role === ROLES.ATTENDANCE_MANAGER
  ) {
    return true;
  }
  if (actor.role === ROLES.LOCATION_MANAGER) {
    const sub = db.prepare("SELECT branch_id FROM users WHERE id = ?").get(subjectUserId);
    if (!sub) return false;
    return Number(sub.branch_id) === Number(actor.branch_id);
  }
  return false;
}

function assertCanSubmitBiometricRequest(db, userId, kind) {
  expireStaleApprovedRequests(db);
  const pending = db
    .prepare(
      `SELECT id FROM biometric_update_requests WHERE user_id = ? AND kind = ? AND status = 'pending'`
    )
    .get(userId, kind);
  if (pending) {
    return { ok: false, error: "You already have a pending request for this type." };
  }
  // Cooldown applies ONLY after completed or expired updates (to prevent
  // abusing approved enrollments). Rejected and cancelled requests do NOT
  // trigger any cooldown — staff must be able to fix issues admin flagged
  // and immediately re-submit.
  const lastBlocking = db
    .prepare(
      `SELECT status, completed_at, resolved_at FROM biometric_update_requests
       WHERE user_id = ? AND kind = ? AND status IN ('completed','expired')
       ORDER BY id DESC LIMIT 1`
    )
    .get(userId, kind);
  if (lastBlocking) {
    const ref = lastBlocking.completed_at || lastBlocking.resolved_at;
    if (ref) {
      const elapsed = Date.now() - new Date(String(ref)).getTime();
      if (elapsed < cooldownDays() * MS_DAY) {
        return {
          ok: false,
          error: `Update requests for this type are limited to once every ${cooldownDays()} days. Try again later or contact HR.`,
        };
      }
    }
  }
  // Spam safety: cap total submissions to 5 per kind per rolling 24h so a
  // staff member cannot flood admins after repeated rejections.
  // NOTE: created_at is stored via SQLite `datetime('now')` ("YYYY-MM-DD
  // HH:MM:SS"), so we MUST compare against the same format. Mixing JS ISO
  // strings ("...T...Z") would break lexicographic comparison.
  const dayCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM biometric_update_requests
       WHERE user_id = ? AND kind = ? AND created_at >= datetime('now','-1 day')`
    )
    .get(userId, kind);
  if (Number(dayCount?.c || 0) >= 5) {
    return {
      ok: false,
      error: "Daily request limit reached for this type (5 in 24h). Please contact HR.",
    };
  }
  return { ok: true };
}

/**
 * Face enrollment authorization.
 */
function assertFaceEnrollmentAllowed({ db, actor, subjectId, approvalRequestId }) {
  const sid = Number(subjectId);
  const aid = Number(actor.id);
  const hasFace = hasFaceProfile(db, sid);
  const isSelf = aid === sid;

  const isBiometricAdmin = can(actor, "biometric:admin");

  if (isBiometricAdmin && canActorManageSubjectBiometric(actor, sid, db)) {
    return { ok: true, mode: "direct_admin" };
  }

  if (isSelf) {
    if (!hasFace) {
      return { ok: true, mode: "first_self" };
    }
    const ap = findConsumableApproval(db, { userId: sid, requestId: approvalRequestId, kind: "face" });
    if (!ap.ok) return { ok: false, status: 403, error: ap.error };
    return { ok: true, mode: "approval_self", approvalRow: ap.row };
  }

  return { ok: false, status: 403, error: "You cannot enroll face for this account." };
}

/**
 * WebAuthn registration (new credential) for self.
 * @returns {{ ok: true, mode: 'first'|'additional'|'approval_replace', approvalRow? } | { ok: false, status: number, error: string }}
 */
function assertWebAuthnSelfRegistrationAllowed({ db, actor, approvalRequestId }) {
  const sid = Number(actor.id);
  const n = webauthnCredentialCount(db, sid);
  if (n === 0) {
    return { ok: true, mode: "first" };
  }
  if (n < MAX_SELF_WEBAUTHN_CREDENTIALS) {
    return { ok: true, mode: "additional" };
  }
  const ap = findConsumableApproval(db, { userId: sid, requestId: approvalRequestId, kind: "biometric" });
  if (!ap.ok) {
    return {
      ok: false,
      status: 403,
      error: `You already have ${MAX_SELF_WEBAUTHN_CREDENTIALS} passkeys. Request an approved update on Identity & biometrics to replace them, or ask HR to remove old passkeys.`,
    };
  }
  return { ok: true, mode: "approval_replace", approvalRow: ap.row };
}

module.exports = {
  ROLES,
  MAX_SELF_WEBAUTHN_CREDENTIALS,
  cooldownDays,
  approvalWindowHours,
  hasFaceProfile,
  webauthnCredentialCount,
  expireStaleApprovedRequests,
  findConsumableApproval,
  markApprovalRequestCompleted,
  canActorManageSubjectBiometric,
  assertCanSubmitBiometricRequest,
  assertFaceEnrollmentAllowed,
  assertWebAuthnSelfRegistrationAllowed,
};
