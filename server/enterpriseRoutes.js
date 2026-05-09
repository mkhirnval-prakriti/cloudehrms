/**
 * Enterprise routes: search, guides, notice CRUD/read receipts, admin deletes, password reset.
 */
const crypto = require("crypto");
const { scheduleUserSync } = require("./googleSheets");
const {
  scheduleAttendance: appsScriptScheduleAttendance,
  scheduleLeave: appsScriptScheduleLeave,
  scheduleUser: appsScriptScheduleUser,
  scheduleNotice: appsScriptScheduleNotice,
} = require("./appsScriptSync");

function isSuper(u, ROLES) {
  return u && u.role === ROLES.SUPER_ADMIN;
}

function registerEnterpriseRoutes(router, ctx) {
  const { db, attachUser, can, ROLES, insertAudit, bcrypt, requirePerm } = ctx;

  router.get("/search", attachUser, (req, res) => {
    if (!can(req.currentUser, "users:read") && !can(req.currentUser, "dashboard:read_self")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const q = String(req.query.q || "").trim();
    if (q.length < 1) {
      return res.json({ employees: [], branches: [], query: q });
    }
    const like = `%${q.replace(/%/g, "")}%`;
    const employees = db
      .prepare(
        `SELECT id, email, login_id, full_name, role, branch_id, department
         FROM users
         WHERE active = 1 AND deleted_at IS NULL AND (
           lower(full_name) LIKE lower(?) OR lower(email) LIKE lower(?) OR lower(coalesce(login_id,'')) LIKE lower(?) OR lower(coalesce(department,'')) LIKE lower(?)
         )
         ORDER BY full_name LIMIT 30`
      )
      .all(like, like, like, like);
    let branches = [];
    if (can(req.currentUser, "branches:read")) {
      branches = db
        .prepare(`SELECT id, name, lat, lng, radius_meters FROM branches WHERE lower(name) LIKE lower(?) ORDER BY name LIMIT 20`)
        .all(like);
    }
    res.json({ employees, branches, query: q });
  });

  router.get("/guides", attachUser, (req, res) => {
    const rows = db
      .prepare(`SELECT id, title, slug, sort_order, updated_at FROM system_guides ORDER BY sort_order ASC, id ASC`)
      .all();
    res.json({ guides: rows });
  });

  router.get("/guides/:slug", attachUser, (req, res) => {
    const row = db.prepare(`SELECT * FROM system_guides WHERE slug = ?`).get(req.params.slug);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ guide: row });
  });

  router.post("/guides", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES)) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const { title, slug, body, sort_order } = req.body || {};
    if (!title || !slug) return res.status(400).json({ error: "title and slug required" });
    try {
      const info = db
        .prepare(
          `INSERT INTO system_guides (title, slug, body, sort_order, created_by) VALUES (?,?,?,?,?)`
        )
        .run(String(title), String(slug), String(body || ""), Number(sort_order) || 0, req.currentUser.id);
      const g = db.prepare(`SELECT * FROM system_guides WHERE id = ?`).get(info.lastInsertRowid);
      insertAudit(req.currentUser.id, "guide_create", "system_guide", g.id, { slug: g.slug });
      res.json({ guide: g });
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "Slug already exists" });
      }
      throw e;
    }
  });

  router.patch("/guides/:id", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES)) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const id = Number(req.params.id);
    const { title, slug, body, sort_order } = req.body || {};
    db.prepare(
      `UPDATE system_guides SET
        title = COALESCE(?, title),
        slug = COALESCE(?, slug),
        body = COALESCE(?, body),
        sort_order = COALESCE(?, sort_order),
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(title || null, slug || null, body !== undefined ? body : null, sort_order !== undefined ? sort_order : null, id);
    const g = db.prepare(`SELECT * FROM system_guides WHERE id = ?`).get(id);
    if (!g) return res.status(404).json({ error: "Not found" });
    insertAudit(req.currentUser.id, "guide_update", "system_guide", id, {});
    res.json({ guide: g });
  });

  router.delete("/guides/:id", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES)) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const id = Number(req.params.id);
    const g = db.prepare(`SELECT id FROM system_guides WHERE id = ?`).get(id);
    if (!g) return res.status(404).json({ error: "Not found" });
    db.prepare(`DELETE FROM system_guides WHERE id = ?`).run(id);
    insertAudit(req.currentUser.id, "guide_delete", "system_guide", id, {});
    res.json({ ok: true });
  });

  router.post("/users/:id/reset-password", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES)) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const id = Number(req.params.id);
    const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    const tempPass =
      process.env.RESET_PASSWORD_PLAIN ||
      `Ph@${crypto.randomBytes(4).toString("hex")}${crypto.randomBytes(2).toString("hex")}`;
    const hash = bcrypt.hashSync(tempPass, 10);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, id);
    insertAudit(req.currentUser.id, "password_reset", "user", id, {});
    scheduleUserSync(db, id);
    appsScriptScheduleUser(db, id);
    res.json({
      ok: true,
      message: "Temporary password issued. User must change after login.",
      temporary_password: tempPass,
    });
  });

  router.post("/users/:id/reveal-password", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES)) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const id = Number(req.params.id);
    const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    const temporaryPassword =
      `Ph@${crypto.randomBytes(4).toString("hex")}${crypto.randomBytes(2).toString("hex")}`;
    const hash = bcrypt.hashSync(temporaryPassword, 10);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, id);
    insertAudit(req.currentUser.id, "password_reveal_temp_issue", "user", id, {});
    scheduleUserSync(db, id);
    appsScriptScheduleUser(db, id);
    res.json({
      ok: true,
      temporary_password: temporaryPassword,
      note: "For security, stored passwords are hashed. A temporary password has been issued.",
    });
  });

  router.delete("/attendance/:id", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES) && !can(req.currentUser, "attendance:edit_any")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const rec = db.prepare(`SELECT * FROM attendance_records WHERE id = ?`).get(id);
    if (!rec) return res.status(404).json({ error: "Not found" });
    db.prepare(`DELETE FROM attendance_records WHERE id = ?`).run(id);
    insertAudit(req.currentUser.id, "attendance_delete", "attendance", id, { work_date: rec.work_date });
    res.json({ ok: true });
  });

  router.delete("/leave/:id", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES)) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT id FROM leave_requests WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare(`DELETE FROM leave_requests WHERE id = ?`).run(id);
    insertAudit(req.currentUser.id, "leave_delete", "leave_request", id, {});
    res.json({ ok: true });
  });

  router.delete("/payroll/entries/:id", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES) && !can(req.currentUser, "payroll:write")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT id FROM payroll_entries WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare(`DELETE FROM payroll_entries WHERE id = ?`).run(id);
    insertAudit(req.currentUser.id, "payroll_delete", "payroll_entry", id, {});
    res.json({ ok: true });
  });

  router.delete("/documents/:id", attachUser, (req, res) => {
    if (!isSuper(req.currentUser, ROLES) && !can(req.currentUser, "documents:verify")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT * FROM employee_documents WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare(`DELETE FROM employee_documents WHERE id = ?`).run(id);
    insertAudit(req.currentUser.id, "document_delete", "employee_document", id, {});
    res.json({ ok: true });
  });

  // NOTE: PATCH /notices/:id, DELETE /notices/:id, and POST /notices/:id/read
  // are intentionally NOT defined here — they live in server/api.js with proper
  // soft-delete, full-field edit, and access-control gates (canAccessNotice +
  // creator/admin checks). Defining them again here would create dead duplicate
  // routes that confuse maintenance.
}

module.exports = { registerEnterpriseRoutes };
