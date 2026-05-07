/**
 * In-app notification center.
 *
 * Schema (created on demand):
 *   notifications(id, user_id, kind, title, body, link, read_at, created_at)
 *
 * Use:
 *   notify(db, { user_id, kind, title, body, link })   → also pushes via SSE
 *   notifyMany(db, [user_ids], { ... })
 *   mountNotificationRoutes(router, db, { attachUser, requirePerm })
 */

const realtime = require("./realtime");

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'info',
      title       TEXT    NOT NULL,
      body        TEXT    DEFAULT '',
      link        TEXT    DEFAULT '',
      read_at     TEXT    DEFAULT NULL,
      created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user_unread
      ON notifications(user_id, read_at, created_at DESC);
  `);
}

/** Insert one notification + push via SSE. */
function notify(db, { user_id, kind = "info", title, body = "", link = "" }) {
  if (!user_id || !title) return null;
  ensureSchema(db);
  const info = db.prepare(
    `INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?,?,?,?,?)`
  ).run(Number(user_id), String(kind), String(title), String(body || ""), String(link || ""));
  const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(info.lastInsertRowid);
  try {
    realtime.broadcastToUser(user_id, "notification", row);
  } catch { /* sse optional */ }
  return row;
}

function notifyMany(db, userIds, payload) {
  const out = [];
  for (const uid of userIds || []) {
    const r = notify(db, { ...payload, user_id: uid });
    if (r) out.push(r);
  }
  return out;
}

function mountNotificationRoutes(router, db, { attachUser }) {
  ensureSchema(db);

  // List my notifications (newest first). ?limit=50&unread_only=1
  router.get("/notifications", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const unreadOnly = String(req.query.unread_only || "") === "1";
    const where = unreadOnly ? "AND read_at IS NULL" : "";
    const rows = db.prepare(
      `SELECT * FROM notifications WHERE user_id = ? ${where} ORDER BY id DESC LIMIT ?`
    ).all(u.id, limit);
    const unread = db.prepare(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL`
    ).get(u.id).c;
    res.json({ notifications: rows, unread_count: unread });
  });

  // Unread count (cheap, polled / called on demand)
  router.get("/notifications/unread-count", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    const c = db.prepare(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL`
    ).get(u.id).c;
    res.json({ unread_count: c });
  });

  // Mark one as read
  router.post("/notifications/:id/read", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id) || 0;
    db.prepare(
      `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND read_at IS NULL`
    ).run(id, u.id);
    res.json({ ok: true });
  });

  // Mark all as read
  router.post("/notifications/read-all", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    db.prepare(
      `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND read_at IS NULL`
    ).run(u.id);
    res.json({ ok: true });
  });

  // Delete one
  router.delete("/notifications/:id", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id) || 0;
    db.prepare(`DELETE FROM notifications WHERE id = ? AND user_id = ?`).run(id, u.id);
    res.json({ ok: true });
  });
}

module.exports = { ensureSchema, notify, notifyMany, mountNotificationRoutes };
