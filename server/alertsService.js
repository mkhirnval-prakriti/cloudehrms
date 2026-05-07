/**
 * Enterprise security / attendance alerts — stored in DB; optional email to admins.
 */
const crypto = require("crypto");

function createHrAlert(db, { type, severity, message, userId, actorId, meta }) {
  const info = db
    .prepare(
      `INSERT INTO hr_alerts (type, severity, message, user_id, actor_id, meta)
       VALUES (?,?,?,?,?,?)`
    )
    .run(
      String(type || "general"),
      String(severity || "warning"),
      String(message || ""),
      userId != null ? Number(userId) : null,
      actorId != null ? Number(actorId) : null,
      meta != null ? JSON.stringify(meta) : null
    );
  return info.lastInsertRowid;
}

function listRecentAlerts(db, { limit = 80, unreadOnly = false, branchId = null } = {}) {
  let sql = `SELECT a.*, u.full_name AS user_name, ua.full_name AS actor_name
    FROM hr_alerts a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN users ua ON ua.id = a.actor_id`;
  const cond = [];
  const params = [];
  if (unreadOnly) cond.push("a.read_by_admin = 0");
  if (branchId != null && branchId !== "") {
    cond.push("(a.user_id IS NULL OR u.branch_id = ?)");
    params.push(Number(branchId));
  }
  if (cond.length) sql += " WHERE " + cond.join(" AND ");
  sql += " ORDER BY a.id DESC LIMIT ?";
  params.push(Math.min(Math.max(Number(limit) || 80, 1), 500));
  return db.prepare(sql).all(...params);
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

module.exports = { createHrAlert, listRecentAlerts, generateOtp };
