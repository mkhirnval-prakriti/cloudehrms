/**
 * Approval workflow for face + WebAuthn (passkey) identity updates.
 */

const {
  expireStaleApprovedRequests,
  assertCanSubmitBiometricRequest,
  canActorManageSubjectBiometric,
  markApprovalRequestCompleted,
  hasFaceProfile,
  webauthnCredentialCount,
  approvalWindowHours,
} = require("./biometricPolicy");
const { can } = require("./rbac");

function registerBiometricRoutes(router, { db, attachUser, insertAudit }) {
  function loadUserBrief(id) {
    return db
      .prepare(`SELECT id, full_name, email, branch_id, role FROM users WHERE id = ? AND deleted_at IS NULL`)
      .get(id);
  }

  router.get("/biometric/status", attachUser, (req, res) => {
    try {
      expireStaleApprovedRequests(db);
      const uid = req.currentUser.id;
      const hasFace = hasFaceProfile(db, uid);
      const embRow = db
        .prepare("SELECT embedding_json, descriptor_count FROM user_face_profiles WHERE user_id = ?")
        .get(uid);
      const faceEmbeddingActive = !!(
        embRow &&
        embRow.embedding_json &&
        String(embRow.embedding_json).trim().length > 10
      );
      const faceDescriptorCount =
        embRow && Number.isFinite(Number(embRow.descriptor_count))
          ? Number(embRow.descriptor_count)
          : null;
      const wc = webauthnCredentialCount(db, uid);
      const kinds = ["face", "biometric"];
      const pending = {};
      const approved = {};
      for (const k of kinds) {
        const p = db
          .prepare(
            `SELECT id, created_at FROM biometric_update_requests WHERE user_id = ? AND kind = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`
          )
          .get(uid, k);
        pending[k] = p || null;
        const a = db
          .prepare(
            `SELECT id, approval_expires_at, resolved_at FROM biometric_update_requests WHERE user_id = ? AND kind = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`
          )
          .get(uid, k);
        approved[k] = a || null;
      }
      const canReq = {};
      for (const k of kinds) {
        const r = assertCanSubmitBiometricRequest(db, uid, k);
        canReq[`canRequest_${k}`] = r.ok;
        if (!r.ok) canReq[`blockReason_${k}`] = r.error;
      }
      res.json({
        hasFace,
        faceEmbeddingActive,
        faceDescriptorCount,
        webauthnCount: wc,
        pending,
        approvedAwaitingEnrollment: approved,
        canRequestFaceUpdate: canReq.canRequest_face,
        canRequestBiometricUpdate: canReq.canRequest_biometric,
        blockReasonFace: canReq.blockReason_face,
        blockReasonBiometric: canReq.blockReason_biometric,
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "status failed" });
    }
  });

  router.post("/biometric/requests", attachUser, (req, res) => {
    const kind = String(req.body?.kind || "").toLowerCase();
    if (kind !== "face" && kind !== "biometric") {
      return res.status(400).json({ error: "kind must be 'face' or 'biometric'" });
    }
    const uid = req.currentUser.id;
    if (kind === "face" && !hasFaceProfile(db, uid)) {
      return res.status(400).json({ error: "Register your face first before requesting an update." });
    }
    if (kind === "biometric" && webauthnCredentialCount(db, uid) === 0) {
      return res.status(400).json({ error: "Register a passkey first before requesting an update." });
    }
    // Atomic gate + insert: prevents two concurrent submits from both passing
    // the "no pending" / "<5 in 24h" checks before either INSERT lands.
    let info;
    try {
      db.exec("BEGIN IMMEDIATE");
      const gate = assertCanSubmitBiometricRequest(db, uid, kind);
      if (!gate.ok) {
        db.exec("ROLLBACK");
        return res.status(400).json({ error: gate.error });
      }
      info = db
        .prepare(
          `INSERT INTO biometric_update_requests (user_id, requester_id, kind, status, notes)
           VALUES (?,?,?,'pending',?)`
        )
        .run(uid, uid, kind, String(req.body?.notes || "").slice(0, 500) || null);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (_) {}
      return res.status(500).json({ error: e.message || "Submit failed" });
    }
    insertAudit(uid, "biometric_request_create", "biometric_update_request", String(info.lastInsertRowid), {
      kind,
    });
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  router.get("/biometric/requests/mine", attachUser, (req, res) => {
    expireStaleApprovedRequests(db);
    const rows = db
      .prepare(
        `SELECT id, kind, status, created_at, resolved_at, completed_at, reject_reason, approval_expires_at
         FROM biometric_update_requests WHERE user_id = ? ORDER BY id DESC LIMIT 30`
      )
      .all(req.currentUser.id);
    res.json({ requests: rows });
  });

  router.get("/biometric/requests/pending", attachUser, (req, res) => {
    if (!can(req.currentUser, "biometric:admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    expireStaleApprovedRequests(db);
    const rows = db
      .prepare(
        `SELECT r.id, r.user_id, r.requester_id, r.kind, r.status, r.notes, r.created_at,
                u.full_name AS user_name, u.email AS user_email, u.branch_id,
                req.full_name AS requester_name
         FROM biometric_update_requests r
         JOIN users u ON u.id = r.user_id
         JOIN users req ON req.id = r.requester_id
         WHERE r.status = 'pending'
         ORDER BY r.id ASC`
      )
      .all();
    const filtered = rows.filter((row) => canActorManageSubjectBiometric(req.currentUser, row.user_id, db));
    res.json({ requests: filtered });
  });

  router.post("/biometric/requests/:id/cancel", attachUser, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM biometric_update_requests WHERE id = ?").get(id);
    if (!row || Number(row.user_id) !== req.currentUser.id) {
      return res.status(404).json({ error: "Not found" });
    }
    if (String(row.status) !== "pending") {
      return res.status(400).json({ error: "Only pending requests can be cancelled." });
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE biometric_update_requests SET status = 'cancelled', resolved_at = ?, resolved_by_id = ? WHERE id = ?`
    ).run(now, req.currentUser.id, id);
    insertAudit(req.currentUser.id, "biometric_request_cancel", "biometric_update_request", String(id), {});
    res.json({ ok: true });
  });

  router.post("/biometric/requests/:id/approve", attachUser, (req, res) => {
    if (!can(req.currentUser, "biometric:admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM biometric_update_requests WHERE id = ?").get(id);
    if (!row || String(row.status) !== "pending") {
      return res.status(404).json({ error: "Pending request not found" });
    }
    if (!canActorManageSubjectBiometric(req.currentUser, row.user_id, db)) {
      return res.status(403).json({ error: "You cannot approve requests for this employee (branch scope)." });
    }
    const hours = approvalWindowHours();
    const now = new Date();
    const exp = new Date(now.getTime() + hours * 3600000).toISOString();
    const nowIso = now.toISOString();
    db.prepare(
      `UPDATE biometric_update_requests SET status = 'approved', resolved_at = ?, resolved_by_id = ?, approval_expires_at = ?
       WHERE id = ?`
    ).run(nowIso, req.currentUser.id, exp, id);
    const subject = loadUserBrief(row.user_id);
    insertAudit(req.currentUser.id, "biometric_request_approve", "biometric_update_request", String(id), {
      kind: row.kind,
      subject_user_id: row.user_id,
      subject_name: subject?.full_name,
      approval_expires_at: exp,
    });
    res.json({ ok: true, approvalExpiresAt: exp });
  });

  router.post("/biometric/requests/:id/reject", attachUser, (req, res) => {
    if (!can(req.currentUser, "biometric:admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM biometric_update_requests WHERE id = ?").get(id);
    if (!row || String(row.status) !== "pending") {
      return res.status(404).json({ error: "Pending request not found" });
    }
    if (!canActorManageSubjectBiometric(req.currentUser, row.user_id, db)) {
      return res.status(403).json({ error: "You cannot reject requests for this employee (branch scope)." });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 500) || null;
    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE biometric_update_requests SET status = 'rejected', resolved_at = ?, resolved_by_id = ?, reject_reason = ?
       WHERE id = ?`
    ).run(nowIso, req.currentUser.id, reason, id);
    insertAudit(req.currentUser.id, "biometric_request_reject", "biometric_update_request", String(id), {
      kind: row.kind,
      subject_user_id: row.user_id,
      reason,
    });
    res.json({ ok: true });
  });

  router.post("/biometric/admin/users/:id/reset-face", attachUser, (req, res) => {
    if (!can(req.currentUser, "biometric:admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const subjectId = Number(req.params.id);
    const prev = db.prepare("SELECT * FROM user_face_profiles WHERE user_id = ?").get(subjectId);
    if (!canActorManageSubjectBiometric(req.currentUser, subjectId, db)) {
      return res.status(403).json({ error: "Branch scope: cannot modify this user." });
    }
    if (!prev) {
      return res.status(400).json({ error: "This user has no enrolled face to clear." });
    }
    db.prepare("DELETE FROM user_face_profiles WHERE user_id = ?").run(subjectId);
    insertAudit(req.currentUser.id, "biometric_admin_reset_face", "user_face_profiles", String(subjectId), {
      previous_reference_path: prev.reference_path,
      previous_phash_prefix: String(prev.phash || "").slice(0, 16),
    });
    res.json({ ok: true });
  });

  // Admin overview of all face-enrolled users with their pose count.
  // Branch managers / attendance managers see only their branch (via the
  // existing canActorManageSubjectBiometric scope filter).
  // Optional `?role=USER` query param narrows results to a specific role
  // (e.g. admins who only want to see line staff, not other managers).
  // Defaults to "all roles" so admin accounts that are themselves enrolled
  // still surface and can be upgraded.
  router.get("/biometric/admin/face-enrollments", attachUser, (req, res) => {
    if (!can(req.currentUser, "biometric:admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const roleFilter = String(req.query?.role || "").trim().toUpperCase();
    const rows = db
      .prepare(
        `SELECT u.id          AS user_id,
                u.full_name   AS full_name,
                u.email       AS email,
                u.login_id    AS login_id,
                u.branch_id   AS branch_id,
                u.role        AS role,
                p.descriptor_count AS descriptor_count,
                p.embedding_json IS NOT NULL AS has_embedding,
                p.updated_at  AS enrolled_at
         FROM user_face_profiles p
         JOIN users u ON u.id = p.user_id
         WHERE u.deleted_at IS NULL
         ORDER BY COALESCE(p.descriptor_count, 0) ASC, u.full_name ASC`
      )
      .all();
    const filtered = rows
      .filter((r) => !roleFilter || String(r.role || "").toUpperCase() === roleFilter)
      .filter((r) => canActorManageSubjectBiometric(req.currentUser, r.user_id, db))
      .map((r) => ({
        user_id: r.user_id,
        full_name: r.full_name,
        email: r.email,
        login_id: r.login_id,
        branch_id: r.branch_id,
        role: r.role,
        descriptor_count: r.descriptor_count == null ? null : Number(r.descriptor_count),
        has_embedding: !!r.has_embedding,
        enrolled_at: r.enrolled_at,
      }));
    // Summary counts for the dashboard header.
    const summary = { total: filtered.length, basic: 0, standard: 0, enhanced: 0, legacy: 0 };
    for (const r of filtered) {
      if (r.descriptor_count == null) summary.legacy += 1;
      else if (r.descriptor_count >= 4) summary.enhanced += 1;
      else if (r.descriptor_count === 3) summary.standard += 1;
      else summary.basic += 1; // 1 or 2
    }
    res.json({ users: filtered, summary });
  });

  router.post("/biometric/admin/users/:id/reset-webauthn", attachUser, (req, res) => {
    if (!can(req.currentUser, "biometric:admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const subjectId = Number(req.params.id);
    if (!canActorManageSubjectBiometric(req.currentUser, subjectId, db)) {
      return res.status(403).json({ error: "Branch scope: cannot modify this user." });
    }
    const creds = db.prepare("SELECT id, credential_id, device_label FROM webauthn_credentials WHERE user_id = ?").all(subjectId);
    db.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?").run(subjectId);
    insertAudit(req.currentUser.id, "biometric_admin_reset_webauthn", "webauthn_credentials", String(subjectId), {
      removed_count: creds.length,
      removed: creds.map((c) => ({ id: c.id, device_label: c.device_label })),
    });
    res.json({ ok: true, removed: creds.length });
  });
}

module.exports = { registerBiometricRoutes };
