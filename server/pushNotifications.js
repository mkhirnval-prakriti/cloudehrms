const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const VAPID_PATH = process.env.VAPID_KEYS_PATH || path.join(__dirname, "..", "data", "vapid.json");

let vapid = null;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  } else if (fs.existsSync(VAPID_PATH)) {
    vapid = JSON.parse(fs.readFileSync(VAPID_PATH, "utf8"));
  } else {
    vapid = webpush.generateVAPIDKeys();
    try {
      fs.mkdirSync(path.dirname(VAPID_PATH), { recursive: true });
      fs.writeFileSync(VAPID_PATH, JSON.stringify(vapid, null, 2));
    } catch (e) {
      console.warn("[push] could not persist VAPID keys:", e.message);
    }
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@hrms.local",
    vapid.publicKey,
    vapid.privateKey
  );
  console.log("[push] VAPID configured");
} catch (e) {
  console.error("[push] init failed:", e.message);
  vapid = null;
}

function getPublicKey() {
  return vapid?.publicKey || null;
}

async function sendToUsers(db, userIds, payload) {
  if (!vapid || !Array.isArray(userIds) || userIds.length === 0) return { sent: 0, failed: 0 };
  const placeholders = userIds.map(() => "?").join(",");
  const subs = db
    .prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`
    )
    .all(...userIds);
  if (subs.length === 0) return { sent: 0, failed: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 * 60 * 24 }
        );
        sent++;
        try {
          db.prepare("UPDATE push_subscriptions SET last_used_at = datetime('now') WHERE id = ?").run(s.id);
        } catch {}
      } catch (err) {
        failed++;
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          try {
            db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
          } catch {}
        }
      }
    })
  );
  return { sent, failed };
}

module.exports = { getPublicKey, sendToUsers };
