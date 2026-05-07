/**
 * Lightweight Server-Sent Events (SSE) channel for live dashboard updates.
 *
 * Topics broadcast (event name → payload):
 *   "attendance"   { type: 'punch_in'|'punch_out'|'edit', user_id, work_date, by? }
 *   "payroll"      { type: 'policy_change'|'override'|'breakdown', user_id?, period? }
 *   "notification" { id, user_id, title, body, kind, created_at }
 *   "leave"        { type: 'request'|'approve'|'reject', user_id, request_id }
 *   "ping"         { ts }   (heartbeat every 25s)
 *
 * Auth: pass JWT as ?token= query (EventSource cannot send custom headers).
 */
const jwt = require("jsonwebtoken");

const clients = new Map(); // id -> { res, userId, role }
let nextId = 1;

function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* socket closed */
  }
}

/**
 * Mounts /events on the API router. Broadcasts are filtered:
 *   - "notification" only goes to its target user_id
 *   - all other events go to every connected client
 */
function mountSse(router, { jwtSecret }) {
  router.get("/events", (req, res) => {
    let userId = null;
    let role = null;
    const token = String(req.query.token || "");
    if (token) {
      try {
        const decoded = jwt.verify(token, jwtSecret);
        userId = Number(decoded.sub) || null;
        role = decoded.role || null;
      } catch {
        return res.status(401).end();
      }
    }
    if (!userId) return res.status(401).end();

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const id = nextId++;
    clients.set(id, { res, userId, role });
    sendEvent(res, "hello", { ok: true, id, ts: Date.now() });

    const heartbeat = setInterval(() => sendEvent(res, "ping", { ts: Date.now() }), 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(id);
    });
  });
}

/** Broadcast to everyone (admin dashboards etc). */
function broadcast(event, data) {
  for (const c of clients.values()) sendEvent(c.res, event, data);
}

/** Broadcast to a specific user (in-app notifications). */
function broadcastToUser(userId, event, data) {
  for (const c of clients.values()) {
    if (c.userId === Number(userId)) sendEvent(c.res, event, data);
  }
}

function clientCount() {
  return clients.size;
}

module.exports = { mountSse, broadcast, broadcastToUser, clientCount };
