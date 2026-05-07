"use strict";

const ALLOWED_FIELDS = ["full_name", "mobile", "dob", "address", "department"];

function registerProfileUpdateRoutes(router, { db, attachUser, insertAudit, can }) {

  router.post("/profile/update-request", attachUser, (req, res) => {
    try {
      const uid = req.currentUser.id;
      const changes = req.body?.changes || {};
      const notes = String(req.body?.notes || "").trim().slice(0, 500);

      const filtered = {};
      for (const f of ALLOWED_FIELDS) {
        if (changes[f] !== undefined && changes[f] !== null) {
          filtered[f] = String(changes[f]).trim().slice(0, 200);
        }
      }
      if (Object.keys(filtered).length === 0) {
        return res.status(400).json({ error: "कोई valid field नहीं है।" });
      }

      const existing = db.prepare(
        "SELECT id FROM profile_update_requests WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
      ).get(uid);
      if (existing) {
        return res.status(409).json({ error: "पहले से एक pending request है। Admin की approval का wait करें।" });
      }

      const info = db.prepare(
        "INSERT INTO profile_update_requests (user_id, requested_changes, notes) VALUES (?, ?, ?)"
      ).run(uid, JSON.stringify(filtered), notes || null);

      insertAudit(uid, "profile_update_request", "profile_update_requests", String(info.lastInsertRowid), { fields: Object.keys(filtered) });

      return res.json({ ok: true, id: info.lastInsertRowid });
    } catch (e) {
      return res.status(500).json({ error: e.message || "Request failed" });
    }
  });

  router.get("/profile/update-requests/mine", attachUser, (req, res) => {
    try {
      const uid = req.currentUser.id;
      const rows = db.prepare(
        "SELECT id, requested_changes, status, notes, reject_reason, created_at, resolved_at FROM profile_update_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20"
      ).all(uid);
      const result = rows.map(r => ({ ...r, requested_changes: JSON.parse(r.requested_changes || "{}") }));
      return res.json({ requests: result });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.get("/profile/update-requests/pending", attachUser, (req, res) => {
    try {
      const u = req.currentUser;
      if (!can(u, "settings:read") && !can(u, "biometric:admin")) {
        return res.status(403).json({ error: "Access denied" });
      }
      let query = `
        SELECT r.id, r.user_id, r.requested_changes, r.notes, r.status, r.created_at,
               u.full_name AS user_name, u.email AS user_email, u.branch_id
        FROM profile_update_requests r
        JOIN users u ON u.id = r.user_id
        WHERE r.status = 'pending'
      `;
      const params = [];
      if (u.role === "LOCATION_MANAGER" && u.branch_id) {
        query += " AND u.branch_id = ?";
        params.push(u.branch_id);
      }
      query += " ORDER BY r.created_at ASC";
      const rows = db.prepare(query).all(...params);
      const result = rows.map(r => ({ ...r, requested_changes: JSON.parse(r.requested_changes || "{}") }));
      return res.json({ requests: result });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.post("/profile/update-requests/:id/approve", attachUser, (req, res) => {
    try {
      const u = req.currentUser;
      if (!can(u, "settings:read") && !can(u, "biometric:admin")) {
        return res.status(403).json({ error: "Access denied" });
      }
      const id = Number(req.params.id);
      const row = db.prepare("SELECT * FROM profile_update_requests WHERE id = ?").get(id);
      if (!row) return res.status(404).json({ error: "Request not found" });
      if (row.status !== "pending") return res.status(409).json({ error: "Request is not pending" });

      const changes = JSON.parse(row.requested_changes || "{}");
      const setClauses = [];
      const vals = [];
      for (const f of ALLOWED_FIELDS) {
        if (changes[f] !== undefined) {
          setClauses.push(`${f} = ?`);
          vals.push(changes[f]);
        }
      }
      if (setClauses.length > 0) {
        vals.push(row.user_id);
        db.prepare(`UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`).run(...vals);
      }

      db.prepare(
        "UPDATE profile_update_requests SET status = 'approved', resolved_by_id = ?, resolved_at = datetime('now') WHERE id = ?"
      ).run(u.id, id);

      insertAudit(u.id, "profile_update_approve", "profile_update_requests", String(id), { fields: Object.keys(changes) });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.post("/profile/update-requests/:id/reject", attachUser, (req, res) => {
    try {
      const u = req.currentUser;
      if (!can(u, "settings:read") && !can(u, "biometric:admin")) {
        return res.status(403).json({ error: "Access denied" });
      }
      const id = Number(req.params.id);
      const row = db.prepare("SELECT * FROM profile_update_requests WHERE id = ?").get(id);
      if (!row) return res.status(404).json({ error: "Request not found" });
      if (row.status !== "pending") return res.status(409).json({ error: "Request is not pending" });

      const reason = String(req.body?.reason || "").trim().slice(0, 300) || null;
      db.prepare(
        "UPDATE profile_update_requests SET status = 'rejected', reject_reason = ?, resolved_by_id = ?, resolved_at = datetime('now') WHERE id = ?"
      ).run(reason, u.id, id);

      insertAudit(u.id, "profile_update_reject", "profile_update_requests", String(id), { reason });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.post("/profile/update-requests/:id/cancel", attachUser, (req, res) => {
    try {
      const uid = req.currentUser.id;
      const id = Number(req.params.id);
      const row = db.prepare("SELECT * FROM profile_update_requests WHERE id = ? AND user_id = ?").get(id, uid);
      if (!row) return res.status(404).json({ error: "Not found" });
      if (row.status !== "pending") return res.status(409).json({ error: "Can only cancel pending requests" });

      db.prepare(
        "UPDATE profile_update_requests SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?"
      ).run(id);

      insertAudit(uid, "profile_update_cancel", "profile_update_requests", String(id), {});
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerProfileUpdateRoutes };
