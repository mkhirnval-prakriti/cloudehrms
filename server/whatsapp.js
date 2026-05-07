/**
 * WhatsApp via Twilio (whatsapp:+...) or Meta Cloud API token.
 * Env (Twilio): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM=whatsapp:+...
 * Env (optional): WHATSAPP_ADMIN_NUMBERS=comma E.164, WHATSAPP_NOTIFY_PUNCH=1, WHATSAPP_NOTIFY_LEAVE=1
 */

function adminNumbers() {
  const raw = process.env.WHATSAPP_ADMIN_NUMBERS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendTwilioWhatsApp(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from || !to) return { skipped: true, reason: "missing_twilio_env" };
  const dest = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams({
    From: from,
    To: dest,
    Body: body,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Twilio: ${res.status} ${t}`);
  }
  return res.json();
}

async function sendMetaWhatsApp(to, body) {
  const token = process.env.WHATSAPP_CLOUD_TOKEN;
  const phoneId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  if (!token || !phoneId || !to) return { skipped: true, reason: "missing_meta_env" };
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Meta WA: ${res.status} ${t}`);
  }
  return res.json();
}

async function sendWhatsApp(to, body) {
  if (process.env.TWILIO_ACCOUNT_SID) {
    return sendTwilioWhatsApp(to, body);
  }
  if (process.env.WHATSAPP_CLOUD_TOKEN) {
    return sendMetaWhatsApp(to, body);
  }
  return { skipped: true, reason: "no_provider" };
}

async function notifyAdmins(message) {
  const nums = adminNumbers();
  if (nums.length === 0) return { skipped: true };
  const results = [];
  for (const n of nums) {
    try {
      results.push(await sendWhatsApp(n, message));
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  return { results };
}

async function notifyPunchWhatsApp(db, { userId, type, workDate, fullName }) {
  if (process.env.WHATSAPP_NOTIFY_PUNCH !== "1") return;
  const line = `HRMS: ${fullName || "User #" + userId} ${type === "in" ? "checked IN" : "checked OUT"} — ${workDate}`;
  await notifyAdmins(line).catch(() => {});
}

async function notifyLeaveWhatsApp(db, leaveId) {
  if (process.env.WHATSAPP_NOTIFY_LEAVE !== "1") return;
  const row = db
    .prepare(
      `SELECT lr.*, u.full_name FROM leave_requests lr JOIN users u ON u.id = lr.user_id WHERE lr.id = ?`
    )
    .get(Number(leaveId));
  if (!row) return;
  const line = `HRMS Leave #${leaveId}: ${row.full_name} → ${row.final_status} (${row.start_date}–${row.end_date})`;
  await notifyAdmins(line).catch(() => {});
}

async function notifyDailySummaryWhatsApp(db, dateStr) {
  if (process.env.WHATSAPP_DAILY_REPORT !== "1") return;
  const totalStaff = Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE active = 1").get().c);
  const statusRows = db
    .prepare(
      `SELECT ar.status, COUNT(*) AS c FROM attendance_records ar
       JOIN users u ON u.id = ar.user_id AND u.active = 1 WHERE ar.work_date = ? GROUP BY ar.status`
    )
    .all(dateStr);
  const smap = Object.fromEntries(statusRows.map((x) => [x.status, x.c]));
  const present = (smap.present || 0) + (smap.half || 0);
  const late = smap.late || 0;
  const absent = smap.absent || 0;
  const half = smap.half || 0;
  const line = `HRMS Daily ${dateStr}: Staff ${totalStaff} | Present+Half ${present} | Late ${late} | Absent ${absent} | Half ${half}`;
  await notifyAdmins(line).catch(() => {});
}

module.exports = {
  sendWhatsApp,
  notifyPunchWhatsApp,
  notifyLeaveWhatsApp,
  notifyDailySummaryWhatsApp,
};
