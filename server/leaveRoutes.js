const { ROLES } = require("./rbac");
const { notifyLeaveWhatsApp } = require("./whatsapp");

function registerLeaveRoutes(router, db, { attachUser, can, onLeaveChange, auditLeave }) {
  function todayYmd() {
    return new Date().toISOString().slice(0, 10);
  }
  function toYmd(d) {
    return new Date(d).toISOString().slice(0, 10);
  }
  function dateRange(start, end) {
    const out = [];
    const s = new Date(`${start}T00:00:00Z`);
    const e = new Date(`${end}T00:00:00Z`);
    for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(toYmd(d));
    }
    return out;
  }
  function applyApprovedLeaveToAttendance(leaveRow, editorId) {
    const days = dateRange(String(leaveRow.start_date), String(leaveRow.end_date));
    for (const day of days) {
      const existing = db
        .prepare("SELECT id, punch_in_at, punch_out_at FROM attendance_records WHERE user_id = ? AND work_date = ?")
        .get(leaveRow.user_id, day);
      if (!existing) {
        db.prepare(
          `INSERT INTO attendance_records
           (user_id, work_date, status, source, notes, last_edited_by)
           VALUES (?, ?, 'leave', 'manual', ?, ?)`
        ).run(leaveRow.user_id, day, `Leave approved (#${leaveRow.id})`, editorId);
        continue;
      }
      if (!existing.punch_in_at && !existing.punch_out_at) {
        db.prepare(
          `UPDATE attendance_records
           SET status = 'leave', source = 'manual', notes = ?, last_edited_by = ?
           WHERE id = ?`
        ).run(`Leave approved (#${leaveRow.id})`, editorId, existing.id);
      }
    }
  }
  function canAccessLeaveThread(currentUser, leaveRow) {
    if (!leaveRow) return false;
    if (Number(currentUser.id) === Number(leaveRow.user_id)) return true;
    return can(currentUser, "leave:read_all");
  }
  function afterLeaveChange(leaveId) {
    if (typeof onLeaveChange === "function") onLeaveChange(leaveId);
  }

  // Centralized realtime + in-app notification for any leave decision.
  // action: "approve" | "reject"; level: "manager" | "admin"
  function emitLeaveEvent(leaveRow, action, level) {
    if (!leaveRow) return;
    try {
      const rt = require("./realtime");
      const ns = require("./notificationsService");
      rt.broadcast("leave", {
        type: action,
        level,
        user_id: leaveRow.user_id,
        request_id: leaveRow.id,
        final_status: leaveRow.final_status,
      });
      const titleMap = {
        approve: "Leave Approved ✓",
        reject:  "Leave Rejected",
      };
      const bodyMap = {
        approve: `${leaveRow.start_date} → ${leaveRow.end_date} approve ho gayi.`,
        reject:  `${leaveRow.start_date} → ${leaveRow.end_date} reject ho gayi (${level}).`,
      };
      ns.notify(db, {
        user_id: leaveRow.user_id,
        kind: "leave",
        title: titleMap[action] || "Leave Update",
        body:  bodyMap[action] || "",
        link: "/#/leaves",
      });
    } catch (e) {
      console.warn("[realtime] leave emit", e.message);
    }
  }

  // Roles that are NEVER allowed to apply leave (they only administer)
  const LEAVE_APPLY_BLOCKED = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

  router.post("/leave/apply", attachUser, (req, res) => {
    const u = req.currentUser;
    // Block Admin and Super Admin explicitly (Super Admin has "*" which would match leave:apply)
    if (LEAVE_APPLY_BLOCKED.includes(u.role)) {
      return res.status(403).json({ error: "Admin/Super Admin छुट्टी नहीं ले सकते" });
    }
    if (!can(u, "leave:apply")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { start_date, end_date, reason } = req.body || {};
    if (!start_date || !end_date || !reason) {
      return res.status(400).json({ error: "start_date, end_date, reason required" });
    }
    const s = String(start_date);
    const e = String(end_date);
    if (s < todayYmd() || e < todayYmd()) {
      return res.status(400).json({ error: "Backdated leave is not allowed" });
    }
    if (e < s) {
      return res.status(400).json({ error: "end_date must be on/after start_date" });
    }
    // Duplicate/overlap check: block if a PENDING or APPROVED request overlaps these dates
    const overlap = db
      .prepare(
        `SELECT id FROM leave_requests
         WHERE user_id = ? AND final_status IN ('PENDING','APPROVED')
           AND start_date <= ? AND end_date >= ?
         LIMIT 1`
      )
      .get(u.id, e, s);
    if (overlap) {
      const pending = db
        .prepare("SELECT final_status FROM leave_requests WHERE id = ?")
        .get(overlap.id);
      if (pending && pending.final_status === "PENDING") {
        return res.status(400).json({ error: "पहले वाली रिक्वेस्ट अभी pending है — एक दिन में एक ही रिक्वेस्ट डाल सकते हैं" });
      }
      return res.status(400).json({ error: "इन तारीखों के लिए पहले से leave approved है" });
    }
    // Same-day rule: if leave starts today and employee already punched in, block it
    if (s === todayYmd()) {
      const todayPunch = db
        .prepare("SELECT id FROM attendance_records WHERE user_id = ? AND work_date = ? AND punch_in_at IS NOT NULL LIMIT 1")
        .get(u.id, todayYmd());
      if (todayPunch) {
        return res.status(400).json({ error: "Same-day leave cannot be applied after punching in. Contact your manager for manual adjustment." });
      }
    }
    const info = db
      .prepare(
        `INSERT INTO leave_requests (user_id, start_date, end_date, reason, final_status, updated_at)
         VALUES (?,?,?,?, 'PENDING', datetime('now'))`
      )
      .run(u.id, s, e, String(reason).trim());
    const row = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(info.lastInsertRowid);
    if (typeof auditLeave === "function") {
      auditLeave(u.id, "leave_apply", row.id, { start_date, end_date });
    }
    afterLeaveChange(row.id);
    res.json({ leave: row });
  });
  router.post("/leaves", attachUser, (req, res, next) => {
    req.url = "/leave/apply";
    return router.handle(req, res, next);
  });

  router.get("/leave", attachUser, (req, res) => {
    const u = req.currentUser;
    if (can(u, "leave:read_all")) {
      const rows = db
        .prepare(
          `SELECT lr.*, u.full_name, u.email, u.role
           FROM leave_requests lr
           JOIN users u ON u.id = lr.user_id
           ORDER BY lr.created_at DESC
           LIMIT 200`
        )
        .all();
      return res.json({ leaves: rows });
    }
    if (can(u, "leave:read_self")) {
      const rows = db
        .prepare(
          `SELECT lr.*, u.full_name, u.email
           FROM leave_requests lr
           JOIN users u ON u.id = lr.user_id
           WHERE lr.user_id = ?
           ORDER BY lr.created_at DESC`
        )
        .all(u.id);
      return res.json({ leaves: rows });
    }
    return res.status(403).json({ error: "Forbidden" });
  });
  router.get("/leaves", attachUser, (req, res, next) => {
    req.url = "/leave";
    return router.handle(req, res, next);
  });

  function getLeave(id) {
    return db
      .prepare(
        `SELECT lr.*, u.full_name, u.email
         FROM leave_requests lr
         JOIN users u ON u.id = lr.user_id
         WHERE lr.id = ?`
      )
      .get(Number(id));
  }

  router.post("/leave/:id/manager-approve", attachUser, (req, res) => {
    if (!can(req.currentUser, "leave:approve_manager")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const row = getLeave(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (Number(req.currentUser.id) === Number(row.user_id)) {
      return res.status(400).json({ error: "आप अपनी ही छुट्टी को approve नहीं कर सकते" });
    }
    // Branch Manager cannot approve another Branch Manager's leave
    if (req.currentUser.role === ROLES.LOCATION_MANAGER && row.role === ROLES.LOCATION_MANAGER) {
      return res.status(403).json({ error: "Branch Manager किसी दूसरे Branch Manager की leave approve नहीं कर सकते" });
    }
    if (row.final_status !== "PENDING" || row.manager_review != null) {
      return res.status(400).json({ error: "Invalid state for manager action" });
    }
    db.prepare(
      `UPDATE leave_requests SET
        manager_review = 'APPROVED',
        manager_comment = ?,
        manager_action_at = datetime('now'),
        manager_action_by = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    ).run((req.body && req.body.comment) || null, req.currentUser.id, row.id);
    const updated = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(row.id);
    applyApprovedLeaveToAttendance(updated, req.currentUser.id);
    if (typeof auditLeave === "function") {
      auditLeave(req.currentUser.id, "leave_manager_approve", row.id, {});
    }
    afterLeaveChange(row.id);
    res.json({ leave: updated });
    emitLeaveEvent(updated, "approve", "manager");
  });

  router.post("/leave/:id/manager-reject", attachUser, (req, res) => {
    if (!can(req.currentUser, "leave:approve_manager")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const row = getLeave(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (Number(req.currentUser.id) === Number(row.user_id)) {
      return res.status(400).json({ error: "आप अपनी ही छुट्टी को reject नहीं कर सकते" });
    }
    if (req.currentUser.role === ROLES.LOCATION_MANAGER && row.role === ROLES.LOCATION_MANAGER) {
      return res.status(403).json({ error: "Branch Manager किसी दूसरे Branch Manager की leave reject नहीं कर सकते" });
    }
    if (row.final_status !== "PENDING" || row.manager_review != null) {
      return res.status(400).json({ error: "Invalid state" });
    }
    db.prepare(
      `UPDATE leave_requests SET
        manager_review = 'REJECTED',
        manager_comment = ?,
        manager_action_at = datetime('now'),
        manager_action_by = ?,
        final_status = 'REJECTED',
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(String((req.body && req.body.comment) || ""), req.currentUser.id, row.id);
    const updated = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(row.id);
    if (typeof auditLeave === "function") {
      auditLeave(req.currentUser.id, "leave_manager_reject", row.id, {});
    }
    afterLeaveChange(row.id);
    setImmediate(() => notifyLeaveWhatsApp(db, row.id).catch(() => {}));
    res.json({ leave: updated });
    emitLeaveEvent(updated, "reject", "manager");
  });

  router.post("/leave/:id/admin-approve", attachUser, (req, res) => {
    if (!can(req.currentUser, "leave:approve_manager")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const row = getLeave(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (Number(req.currentUser.id) === Number(row.user_id)) {
      return res.status(400).json({ error: "आप अपनी ही छुट्टी को approve नहीं कर सकते" });
    }
    if (row.manager_review !== "APPROVED" || row.final_status !== "PENDING") {
      return res.status(400).json({ error: "Manager approval required first" });
    }
    if (row.admin_review != null) {
      return res.status(400).json({ error: "Already decided" });
    }
    db.prepare(
      `UPDATE leave_requests SET
        admin_review = 'APPROVED',
        admin_comment = ?,
        admin_action_at = datetime('now'),
        admin_action_by = ?,
        final_status = 'APPROVED',
        updated_at = datetime('now')
       WHERE id = ?`
    ).run((req.body && req.body.comment) || null, req.currentUser.id, row.id);
    const updated = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(row.id);
    applyApprovedLeaveToAttendance(updated, req.currentUser.id);
    if (typeof auditLeave === "function") {
      auditLeave(req.currentUser.id, "leave_admin_approve", row.id, {});
    }
    afterLeaveChange(row.id);
    setImmediate(() => notifyLeaveWhatsApp(db, row.id).catch(() => {}));
    res.json({ leave: updated });
    emitLeaveEvent(updated, "approve", "admin");
  });

  router.post("/leave/:id/admin-reject", attachUser, (req, res) => {
    if (!can(req.currentUser, "leave:approve_manager")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const row = getLeave(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (Number(req.currentUser.id) === Number(row.user_id)) {
      return res.status(400).json({ error: "आप अपनी ही छुट्टी को reject नहीं कर सकते" });
    }
    if (row.manager_review !== "APPROVED" || row.final_status !== "PENDING") {
      return res.status(400).json({ error: "Invalid state" });
    }
    db.prepare(
      `UPDATE leave_requests SET
        admin_review = 'REJECTED',
        admin_comment = ?,
        admin_action_at = datetime('now'),
        admin_action_by = ?,
        final_status = 'REJECTED',
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(String((req.body && req.body.comment) || ""), req.currentUser.id, row.id);
    const updated = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(row.id);
    if (typeof auditLeave === "function") {
      auditLeave(req.currentUser.id, "leave_admin_reject", row.id, {});
    }
    afterLeaveChange(row.id);
    setImmediate(() => notifyLeaveWhatsApp(db, row.id).catch(() => {}));
    res.json({ leave: updated });
    emitLeaveEvent(updated, "reject", "admin");
  });

  // ── Unified decide endpoint: handles the approval hierarchy in one shot ──
  // Hierarchy rules:
  //   • No self-approval (ever)
  //   • Branch Manager (LOCATION_MANAGER) cannot approve another Branch Manager's leave
  //   • Admin and Super Admin can approve any leave (except their own)
  //   • Branch Manager can approve Staff and Attendance Manager leave
  router.post("/leave/:id/decide", attachUser, (req, res) => {
    const actor = req.currentUser;
    const canApproveLeave = can(actor, "leave:approve_manager");
    if (!canApproveLeave) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { action, comment } = req.body || {};
    if (action !== "approve" && action !== "reject") {
      return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }
    const row = getLeave(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (String(row.final_status).toUpperCase() !== "PENDING") {
      return res.status(400).json({ error: "यह leave request पहले से decided है" });
    }
    // Self-approval block
    if (Number(actor.id) === Number(row.user_id)) {
      return res.status(400).json({ error: "आप अपनी ही छुट्टी को approve नहीं कर सकते" });
    }
    // Hierarchy: Branch Manager cannot approve Branch Manager leave
    if (actor.role === ROLES.LOCATION_MANAGER && row.role === ROLES.LOCATION_MANAGER) {
      return res.status(403).json({ error: "Branch Manager किसी दूसरे Branch Manager की leave approve नहीं कर सकते। Admin या Super Admin से approve करवाएं।" });
    }
    const approved = action === "approve";
    const newStatus = approved ? "APPROVED" : "REJECTED";
    const commentVal = String(comment || (approved ? "Approved" : "Rejected")).trim();
    // For Branch Manager: use manager_review column; for Admin/SuperAdmin: fill both columns
    const isBranchMgr = actor.role === ROLES.LOCATION_MANAGER;
    if (isBranchMgr) {
      db.prepare(
        `UPDATE leave_requests SET
           manager_review = ?,
           manager_comment = ?,
           manager_action_at = datetime('now'),
           manager_action_by = ?,
           final_status = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(newStatus, commentVal, actor.id, newStatus, row.id);
    } else {
      db.prepare(
        `UPDATE leave_requests SET
           manager_review = COALESCE(manager_review, ?),
           admin_review = ?,
           admin_comment = ?,
           admin_action_at = datetime('now'),
           admin_action_by = ?,
           final_status = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(newStatus, newStatus, commentVal, actor.id, newStatus, row.id);
    }
    const updated = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(row.id);
    if (approved) applyApprovedLeaveToAttendance(updated, actor.id);
    if (typeof auditLeave === "function") {
      auditLeave(actor.id, `leave_decide_${action}`, row.id, { comment: commentVal });
    }
    afterLeaveChange(row.id);
    setImmediate(() => notifyLeaveWhatsApp(db, row.id).catch(() => {}));
    res.json({ leave: updated });
    emitLeaveEvent(updated, action, isBranchMgr ? "manager" : "admin");
  });

  router.put("/leaves/:id", attachUser, (req, res) => {
    const { final_status, comment } = req.body || {};
    const desired = String(final_status || "").toUpperCase();
    if (desired !== "APPROVED" && desired !== "REJECTED") {
      return res.status(400).json({ error: "final_status must be APPROVED or REJECTED" });
    }
    const id = Number(req.params.id);
    if (req.currentUser.role === ROLES.SUPER_ADMIN) {
      req.params.id = String(id);
      req.body = { comment: comment || null };
      if (desired === "APPROVED") req.url = `/leave/${id}/admin-approve`;
      else req.url = `/leave/${id}/admin-reject`;
      return router.handle(req, res, () => {});
    }
    if (!can(req.currentUser, "leave:approve_manager")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.params.id = String(id);
    req.body = { comment: comment || null };
    if (desired === "APPROVED") req.url = `/leave/${id}/manager-approve`;
    else req.url = `/leave/${id}/manager-reject`;
    return router.handle(req, res, () => {});
  });

  router.delete("/leaves/:id", attachUser, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const isOwner = Number(row.user_id) === Number(req.currentUser.id);
    const canDeleteAny = req.currentUser.role === ROLES.SUPER_ADMIN || can(req.currentUser, "leave:approve_manager");
    if (!isOwner && !canDeleteAny) {
      return res.status(403).json({ error: "Forbidden" });
    }
    db.prepare("DELETE FROM leave_requests WHERE id = ?").run(id);
    if (typeof auditLeave === "function") {
      auditLeave(req.currentUser.id, "leave_delete", id, {});
    }
    afterLeaveChange(id);
    res.json({ ok: true, id });
  });

  router.get("/leave/:id/thread", attachUser, (req, res) => {
    const id = Number(req.params.id);
    const leaveRow = getLeave(id);
    if (!leaveRow) return res.status(404).json({ error: "Not found" });
    if (!canAccessLeaveThread(req.currentUser, leaveRow)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const messages = db
      .prepare(
        `SELECT t.id, t.leave_id, t.author_id, u.full_name AS author_name, u.role AS author_role, t.body, t.created_at
         FROM leave_threads t
         JOIN users u ON u.id = t.author_id
         WHERE t.leave_id = ?
         ORDER BY t.id ASC`
      )
      .all(id);
    res.json({ leave: leaveRow, messages });
  });

  router.post("/leave/:id/thread", attachUser, (req, res) => {
    const id = Number(req.params.id);
    const leaveRow = getLeave(id);
    if (!leaveRow) return res.status(404).json({ error: "Not found" });
    if (!canAccessLeaveThread(req.currentUser, leaveRow)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (String(leaveRow.final_status || "").toUpperCase() !== "PENDING") {
      return res.status(400).json({ error: "Thread closed after final decision" });
    }
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ error: "body required" });
    const info = db
      .prepare("INSERT INTO leave_threads (leave_id, author_id, body) VALUES (?,?,?)")
      .run(id, req.currentUser.id, body);
    const message = db
      .prepare(
        `SELECT t.id, t.leave_id, t.author_id, u.full_name AS author_name, u.role AS author_role, t.body, t.created_at
         FROM leave_threads t
         JOIN users u ON u.id = t.author_id
         WHERE t.id = ?`
      )
      .get(info.lastInsertRowid);
    res.json({ message });
  });
}

module.exports = { registerLeaveRoutes };
