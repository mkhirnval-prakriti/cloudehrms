/**
 * Outbound sync to Google Apps Script Web App (dynamic JSON; no hardcoded business fields).
 * Env: GOOGLE_APPS_SCRIPT_WEBAPP_URL (required to enable outbound sync), APPS_SCRIPT_SYNC_ENABLED=0 to disable
 *
 * Attendance tab uses unique_key = employee_id + "_" + work_date for upsert.
 * Friendly fields: employee_name, employee_id, branch, role, attendance_mode,
 *                  punch_in, punch_out, total_hours, date, status, unique_key
 */
const crypto = require("crypto");

const STRIP_KEYS = new Set(["password_hash"]);

function getWebAppUrl() {
  return String(process.env.GOOGLE_APPS_SCRIPT_WEBAPP_URL || "").trim();
}

/**
 * Returns null if the URL looks like a valid deployed Apps Script web app
 * (https://script.google.com/macros/s/<ID>/exec), otherwise a friendly
 * error string explaining what the admin probably pasted by mistake.
 */
function validateWebAppUrl(url) {
  if (!url) return "GOOGLE_APPS_SCRIPT_WEBAPP_URL is not set.";
  let u;
  try { u = new URL(url); } catch { return "URL is not a valid URL."; }
  if (u.host === "docs.google.com") {
    return "This looks like a Google Sheet/Doc URL (docs.google.com). " +
      "You need the Apps Script *Web App* URL — open script.google.com → " +
      "Deploy → New deployment → Web app, then copy the URL ending with /exec.";
  }
  if (u.host === "script.google.com" && u.pathname.includes("/d/") && !u.pathname.includes("/macros/s/")) {
    return "This looks like the Apps Script *editor* URL (script.google.com/d/...). " +
      "You need the deployed Web App URL: open the script → Deploy → " +
      "Manage deployments → copy the Web app URL ending with /exec.";
  }
  if (u.host !== "script.google.com" || !/^\/macros\/s\/[^/]+\/exec\/?$/.test(u.pathname)) {
    return "URL must look like https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec " +
      "(end with /exec). Re-deploy the Apps Script as a Web App and copy that URL.";
  }
  return null;
}

function isEnabled() {
  if (process.env.APPS_SCRIPT_SYNC_ENABLED === "0") return false;
  return !!getWebAppUrl();
}

function sanitizeValue(v) {
  if (v === undefined || v === null) return v;
  if (typeof v === "bigint") return String(v);
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
    return sanitizeObject(v);
  }
  return v;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (STRIP_KEYS.has(k)) continue;
    const v = obj[k];
    out[k] = sanitizeValue(v);
  }
  return out;
}

function buildSinglePayload(tab, row, matchKey) {
  const o = sanitizeObject(row);
  const payload = { __tab: tab, ...o };
  if (matchKey) payload.__matchKey = matchKey;
  return payload;
}

function buildBulkPayload(tab, rows, matchKey) {
  const payload = {
    __tab: tab,
    records: rows.map((r) => sanitizeObject(r)),
  };
  if (matchKey) payload.__matchKey = matchKey;
  return payload;
}

async function postWithRetry(url, body, { retries = 4 } = {}) {
  let lastErr;
  const bodyStr = JSON.stringify(body);
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
        redirect: "follow",
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { _raw: text.slice(0, 1500) };
      }
      const looksLikeHtmlError =
        /<!DOCTYPE html>/i.test(text) &&
        /<title>Error<\/title>/i.test(text);
      const looksLikeDriveHtml =
        /<!DOCTYPE html>/i.test(text) &&
        /(Web word processing|Google Drive|Sign in - Google Accounts)/i.test(text);
      if (!res.ok || looksLikeHtmlError || looksLikeDriveHtml) {
        if (looksLikeDriveHtml) {
          throw new Error(
            `HTTP ${res.status}: Google returned an HTML page, not a script ` +
            `response. The configured URL is NOT a deployed Apps Script Web App. ` +
            `Open script.google.com → your project → Deploy → New deployment → ` +
            `Web app → set "Who has access: Anyone" → copy the URL ending with /exec ` +
            `and update the GOOGLE_APPS_SCRIPT_WEBAPP_URL secret.`
          );
        }
        if (looksLikeHtmlError) {
          throw new Error(
            `HTTP ${res.status}: Google Apps Script returned an error page (not JSON). ` +
            `This usually means the script hit a quota limit or runtime error. ` +
            `Check the Apps Script execution log at script.google.com for details.`
          );
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
      }
      if (json && json.ok === false) {
        throw new Error(
          `Apps Script logical error: ${JSON.stringify(json).slice(0, 600)}`
        );
      }
      return { ok: true, status: res.status, json };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 450 * 2 ** i));
    }
  }
  throw lastErr;
}

function logLine(db, tab, ok, detail) {
  try {
    const snippet =
      typeof detail === "string" ? detail.slice(0, 2000) : JSON.stringify(detail).slice(0, 2000);
    const err = ok ? null : snippet;
    db.prepare(
      `INSERT INTO apps_script_sync_log (tab, ok, response_snippet, error) VALUES (?,?,?,?)`
    ).run(tab || "", ok ? 1 : 0, ok ? snippet : null, ok ? null : err);
  } catch (e) {
    console.error("[appsScriptSync] log failed", e.message);
  }
}

async function sendPayload(db, tab, payload) {
  const url = getWebAppUrl();
  const why = validateWebAppUrl(url);
  if (why) {
    logLine(db, tab, false, why);
    throw new Error(why);
  }
  const result = await postWithRetry(url, payload);
  logLine(db, tab, true, result.json);
  return result;
}

function queueJob(db, tab, asyncWork) {
  if (!isEnabled()) return;
  setImmediate(async () => {
    try {
      await asyncWork();
    } catch (e) {
      console.error("[appsScriptSync]", tab, e.message);
      logLine(db, tab, false, e.message);
    }
  });
}

/**
 * Persist a failed single-row push so a background worker can replay it
 * later. Survives restarts. Keeps the system "Sheet-eventually-consistent"
 * even if Google Apps Script is briefly down or rate-limited.
 */
function enqueueRetry(db, tab, payload, matchKey, errMsg) {
  try {
    // Logical dedupe identity = the matchKey's value in the payload (e.g.
    // unique_key for Attendance, id for Users). Multiple updates to the
    // same entity while Apps Script is down collapse into ONE queue row
    // (latest payload wins) instead of stacking up forever.
    const idVal = (matchKey && payload && payload[matchKey] != null)
      ? String(payload[matchKey])
      : "";
    const dedupeKey = idVal || `noid:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO apps_script_sync_queue
         (tab, dedupe_key, payload_json, match_key, attempts, last_error, next_attempt_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, datetime('now', '+60 seconds'), datetime('now'))
       ON CONFLICT(tab, dedupe_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         match_key    = excluded.match_key,
         last_error   = excluded.last_error,
         updated_at   = datetime('now'),
         dead         = 0,
         next_attempt_at = MIN(apps_script_sync_queue.next_attempt_at, excluded.next_attempt_at)`
    ).run(
      tab || "",
      dedupeKey,
      JSON.stringify(payload || {}),
      matchKey || null,
      String(errMsg || "").slice(0, 1000)
    );
  } catch (e) {
    console.error("[appsScriptSync] enqueueRetry failed", e.message);
  }
}

/**
 * Retention: dead rows are kept 7 days for admin inspection then deleted.
 * Also caps live queue size: if pending > 5000 we drop the oldest 1000
 * (a runaway is almost always a config bug, not real data, and we'd rather
 * keep the system responsive than try to flush a corrupted backlog).
 */
function pruneSyncQueue(db) {
  try {
    const r1 = db.prepare(
      `DELETE FROM apps_script_sync_queue
       WHERE dead = 1 AND updated_at < datetime('now', '-7 days')`
    ).run();
    const pending = db.prepare(
      `SELECT COUNT(*) AS c FROM apps_script_sync_queue WHERE dead = 0`
    ).get().c;
    let r2 = { changes: 0 };
    if (pending > 5000) {
      r2 = db.prepare(
        `DELETE FROM apps_script_sync_queue
         WHERE id IN (SELECT id FROM apps_script_sync_queue WHERE dead = 0 ORDER BY id ASC LIMIT 1000)`
      ).run();
      console.warn(`[appsScriptSync] queue overflow (${pending}); pruned ${r2.changes} oldest pending`);
    }
    return { dead_pruned: r1.changes, overflow_pruned: r2.changes };
  } catch (e) {
    console.error("[appsScriptSync] pruneSyncQueue failed", e.message);
    return { error: e.message };
  }
}

/**
 * Try to push a single payload; on failure persist it to the retry queue
 * so the background worker will replay it. Idempotent because every push
 * uses a stable matchKey (unique_key/id) and the Apps Script upserts.
 */
async function tryPushOrEnqueue(db, tab, payload, matchKey) {
  if (!isEnabled()) {
    console.warn(`[appsScriptSync] ${tab} push skipped — sync not enabled (no GOOGLE_APPS_SCRIPT_WEBAPP_URL)`);
    return;
  }
  try {
    await sendPayload(db, tab, buildSinglePayload(tab, payload, matchKey));
    if (tab === "Attendance") {
      console.log(`[appsScriptSync:Attendance] ✓ pushed to sheet: ${payload.unique_key || payload.employee_name || ""}`);
    }
  } catch (e) {
    console.warn(`[appsScriptSync] ${tab} push failed, queuing retry: ${e.message}`);
    enqueueRetry(db, tab, payload, matchKey, e.message);
  }
}

/**
 * Drain a small batch of pending retry rows. Successful rows are deleted;
 * failures are rescheduled with exponential backoff (60s, 2m, 4m, ... up
 * to 1h). After 10 attempts the row is marked dead so the worker stops
 * touching it (admins can inspect via getAppsScriptStatus.queue_dead).
 */
async function drainSyncQueue(db, { batch = 10 } = {}) {
  if (!isEnabled()) return { skipped: true, reason: "disabled" };
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, tab, payload_json, match_key, attempts
         FROM apps_script_sync_queue
         WHERE dead = 0 AND next_attempt_at <= datetime('now')
         ORDER BY CASE WHEN tab IN ('Attendance','Leave','Users','Branches') THEN 0 ELSE 1 END,
                  id ASC
         LIMIT ?`
      )
      .all(batch);
  } catch (e) {
    console.error("[appsScriptSync] drain query failed", e.message);
    return { ok: false, error: e.message };
  }
  if (!rows.length) return { ok: true, processed: 0 };

  let ok = 0;
  let fail = 0;
  let consecutiveFails = 0;
  for (const r of rows) {
    if (consecutiveFails >= 3) {
      break;
    }
    try {
      const payload = JSON.parse(r.payload_json);
      await sendPayload(db, r.tab, buildSinglePayload(r.tab, payload, r.match_key || null));
      db.prepare(`DELETE FROM apps_script_sync_queue WHERE id = ?`).run(r.id);
      ok++;
      consecutiveFails = 0;
    } catch (e) {
      consecutiveFails++;
      const attempts = (r.attempts || 0) + 1;
      const dead = attempts >= 10 ? 1 : 0;
      const backoffSec = dead ? 86400 : Math.min(3600, 60 * Math.pow(2, attempts - 1));
      try {
        db.prepare(
          `UPDATE apps_script_sync_queue
             SET attempts = ?, last_error = ?, dead = ?,
                 next_attempt_at = datetime('now', '+' || ? || ' seconds')
             WHERE id = ?`
        ).run(attempts, String(e.message || "").slice(0, 1000), dead, backoffSec, r.id);
      } catch (_) { /* ignore */ }
      fail++;
    }
    if (ok + fail < rows.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (consecutiveFails >= 3) {
    console.warn(`[appsScriptSync] drain stopped early — 3 consecutive failures (Google may be rate-limiting)`);
  }
  return { ok: true, processed: ok + fail, succeeded: ok, failed: fail };
}

function clearSyncQueue(db, { tab, deadOnly = false } = {}) {
  try {
    if (tab) {
      if (deadOnly) {
        return db.prepare("DELETE FROM apps_script_sync_queue WHERE tab = ? AND dead = 1").run(tab).changes;
      }
      return db.prepare("DELETE FROM apps_script_sync_queue WHERE tab = ?").run(tab).changes;
    }
    if (deadOnly) {
      return db.prepare("DELETE FROM apps_script_sync_queue WHERE dead = 1").run().changes;
    }
    return db.prepare("DELETE FROM apps_script_sync_queue").run().changes;
  } catch (e) {
    console.error("[appsScriptSync] clearSyncQueue failed:", e.message);
    return 0;
  }
}

let _retryWorkerHandle = null;
let _pruneWorkerHandle = null;
function startSyncRetryWorker(db, { intervalMs = 60000 } = {}) {
  if (_retryWorkerHandle) return;
  _retryWorkerHandle = setInterval(() => {
    drainSyncQueue(db).catch((e) =>
      console.error("[appsScriptSync] drain failed", e.message)
    );
  }, intervalMs);
  // Best-effort kick 5s after boot so any jobs that were pending at
  // shutdown get replayed quickly without waiting for the first interval.
  setTimeout(() => {
    drainSyncQueue(db).catch(() => {});
  }, 5000);
  // Hourly retention sweep: prune dead rows older than 7 days and cap
  // pending queue at 5000 to prevent runaway growth.
  if (!_pruneWorkerHandle) {
    _pruneWorkerHandle = setInterval(() => pruneSyncQueue(db), 3600_000);
    setTimeout(() => pruneSyncQueue(db), 30_000);
  }
  console.log("[appsScriptSync] retry worker started (every", Math.round(intervalMs / 1000), "s)");
}

async function sendChunkedBulk(db, tab, rows, matchKey, chunkSize = 40) {
  if (!isEnabled() || !rows.length) return { ok: true, chunks: 0, failed: 0 };
  let chunks = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    try {
      await sendPayload(db, tab, buildBulkPayload(tab, slice, matchKey));
      chunks++;
    } catch (e) {
      failed++;
      console.warn(`[appsScriptSync] ${tab} bulk chunk ${Math.floor(i / chunkSize) + 1} failed: ${e.message}`);
      for (const row of slice) {
        enqueueRetry(db, tab, row, matchKey, e.message);
      }
    }
    if (i + chunkSize < rows.length) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { ok: failed === 0, chunks, failed };
}

// ── Attendance payload helpers ────────────────────────────────────────────────

/**
 * Converts a UTC ISO timestamp to "HH:MM" in IST (UTC+5:30).
 */
function fmtISTTime(isoUtc) {
  if (!isoUtc) return "";
  try {
    const ms = new Date(isoUtc).getTime() + 5.5 * 3600 * 1000;
    const d = new Date(ms);
    return (
      String(d.getUTCHours()).padStart(2, "0") +
      ":" +
      String(d.getUTCMinutes()).padStart(2, "0")
    );
  } catch {
    return "";
  }
}

/**
 * Converts a UTC ISO date string to YYYY-MM-DD in IST.
 */
function fmtISTDate(isoUtc) {
  if (!isoUtc) return "";
  try {
    const ms = new Date(isoUtc).getTime() + 5.5 * 3600 * 1000;
    const d = new Date(ms);
    return (
      d.getUTCFullYear() +
      "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getUTCDate()).padStart(2, "0")
    );
  } catch {
    return "";
  }
}

/**
 * Transform a raw DB attendance + user + branch joined row into the
 * friendly Google Sheet payload.
 *
 * unique_key = employee_id (login_id) + "_" + work_date
 * This allows the Apps Script to upsert by unique_key instead of internal DB id.
 */
function buildAttendancePayload(rec) {
  const empId = rec.user_login_id || String(rec.user_id);
  const date = rec.work_date || fmtISTDate(rec.punch_in_at);
  const uniqueKey = `${empId}_${date}`;

  let totalHours = null;
  if (rec.punch_in_at && rec.punch_out_at) {
    const ms =
      new Date(rec.punch_out_at).getTime() - new Date(rec.punch_in_at).getTime();
    if (ms > 0) totalHours = Math.round((ms / 3600000) * 100) / 100;
  }

  const mode = rec.punch_method_in || rec.source || "manual";
  const punchInTime = fmtISTTime(rec.punch_in_at);
  const punchOutTime = fmtISTTime(rec.punch_out_at);

  // Derive "late" by comparing punch_in time-of-day vs (shift_start + grace_minutes).
  let late = 0;
  try {
    if (rec.punch_in_at && rec.shift_start) {
      const punchDate = new Date(rec.punch_in_at);
      // Convert to IST minutes since midnight
      const istDate = new Date(punchDate.getTime() + 5.5 * 3600 * 1000);
      const punchMin = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
      const m = String(rec.shift_start).match(/^(\d{1,2}):(\d{2})/);
      if (m) {
        const shiftMin = Number(m[1]) * 60 + Number(m[2]) + Number(rec.grace_minutes || 0);
        if (punchMin > shiftMin) late = 1;
      }
    }
  } catch (_) { /* ignore */ }

  // Final status: trust the DB value, but fall back so the sheet always
  // shows something meaningful even if the DB row was inserted without one.
  let status = String(rec.status || "").toLowerCase();
  if (!status) {
    if (rec.punch_in_at) status = "present";
    else status = "absent";
  }
  const isHalfDay = status === "half_day" || status === "half-day";
  const isPresent = status === "present" || status === "late" || isHalfDay;
  const isAbsent = status === "absent";

  return {
    unique_key: uniqueKey,
    employee_name: rec.user_full_name || "",
    employee_id: empId,
    branch: rec.branch_name || "",
    role: rec.user_role || "",
    date,
    attendance_mode: mode,
    punch_in: punchInTime,
    punch_out: punchOutTime,
    total_hours: totalHours,
    working_hours: totalHours,           // friendly alias
    status,
    present: isPresent ? 1 : 0,
    absent: isAbsent ? 1 : 0,
    late,
    half_day: isHalfDay ? 1 : 0,
    notes: rec.notes || "",
    // Friendly camelCase aliases for downstream sheet templates
    name: rec.user_full_name || "",
    mobile: rec.user_mobile || "",
    city: rec.branch_city || "",
    punchIn: punchInTime,
    punchOut: punchOutTime,
    totalHours: totalHours,
    workingHours: totalHours,
    halfDay: isHalfDay ? 1 : 0,
    _hrms_id: rec.id,
    _synced_at: new Date().toISOString(),
  };
}

const ATTENDANCE_JOIN_SQL = `
  SELECT ar.*, u.full_name AS user_full_name, u.email AS user_email,
         u.login_id AS user_login_id, u.role AS user_role,
         u.mobile AS user_mobile, u.shift_start, u.grace_minutes,
         b.name AS branch_name, b.city AS branch_city
  FROM attendance_records ar
  JOIN users u ON u.id = ar.user_id
  LEFT JOIN branches b ON b.id = u.branch_id
  WHERE ar.id = ?`;

// ── Per-entity schedule functions ─────────────────────────────────────────────

function scheduleAttendance(db, attendanceId) {
  queueJob(db, "Attendance", async () => {
    const rec = db.prepare(ATTENDANCE_JOIN_SQL).get(Number(attendanceId));
    if (!rec) {
      console.warn(`[appsScriptSync:Attendance] record ${attendanceId} not found — skipping sheet push`);
      return;
    }
    const payload = buildAttendancePayload(rec);
    console.log(`[appsScriptSync:Attendance] pushing id=${attendanceId} key=${payload.unique_key} date=${payload.date}`);
    await tryPushOrEnqueue(db, "Attendance", payload, "unique_key");
  });
}

function scheduleLeave(db, leaveId) {
  queueJob(db, "Leave Requests", async () => {
    const row = db
      .prepare(
        `SELECT lr.*, u.full_name AS user_full_name, u.email AS user_email, u.role AS user_role
         FROM leave_requests lr
         JOIN users u ON u.id = lr.user_id
         WHERE lr.id = ?`
      )
      .get(Number(leaveId));
    if (!row) return;
    await tryPushOrEnqueue(db, "Leave Requests", sanitizeObject(row), "id");
  });
}

function scheduleUser(db, userId) {
  queueJob(db, "Users", async () => {
    const u = db
      .prepare(
        `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active, created_at
         FROM users WHERE id = ?`
      )
      .get(Number(userId));
    if (!u) return;
    await tryPushOrEnqueue(db, "Users", sanitizeObject(u), "id");
  });
}

function scheduleBranch(db, branchId) {
  queueJob(db, "Branches", async () => {
    const b = db.prepare("SELECT * FROM branches WHERE id = ?").get(Number(branchId));
    if (!b) return;
    await tryPushOrEnqueue(db, "Branches", sanitizeObject(b), "id");
  });
}

function scheduleAudit(db, auditId) {
  if (!isEnabled()) return;
  try {
    const a = db.prepare("SELECT * FROM audit_logs WHERE id = ?").get(Number(auditId));
    if (!a) return;
    enqueueRetry(db, "Logs", sanitizeObject(a), "id", "enqueued (deferred)");
  } catch (e) {
    /* audit sync is best-effort */
  }
}

function scheduleNotice(db, noticeId) {
  queueJob(db, "Notices", async () => {
    const n = db
      .prepare(
        `SELECT n.*, u.full_name AS author_name
         FROM notices n JOIN users u ON u.id = n.created_by
         WHERE n.id = ?`
      )
      .get(Number(noticeId));
    if (!n) return;
    await tryPushOrEnqueue(db, "Notices", sanitizeObject(n), "id");
  });
}

// ── End-of-day absent push ────────────────────────────────────────────────────

/**
 * For every active employee who has NO attendance record on `date`,
 * push a synthetic "absent" row to the Attendance sheet.
 * Does NOT write to the DB — sheet-only.
 *
 * @param {object} db   - better-sqlite3 db instance
 * @param {string} date - YYYY-MM-DD in IST
 */
async function pushAbsentsToSheet(db, date) {
  if (!isEnabled()) return { skipped: true, reason: "disabled_or_no_url" };
  if (!date) date = fmtISTDate(new Date().toISOString());

  const absentStaff = db
    .prepare(
      `SELECT u.id, u.login_id, u.full_name, u.role,
              b.name AS branch_name
       FROM users u
       LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.active = 1
         AND u.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM attendance_records ar
           WHERE ar.user_id = u.id AND ar.work_date = ?
         )
       ORDER BY u.id ASC`
    )
    .all(date);

  if (!absentStaff.length) return { ok: true, absent: 0, date };

  const rows = absentStaff.map((u) => ({
    unique_key: `${u.login_id}_${date}`,
    employee_name: u.full_name || "",
    employee_id: u.login_id || String(u.id),
    branch: u.branch_name || "",
    role: u.role || "",
    date,
    attendance_mode: "auto",
    punch_in: "",
    punch_out: "",
    total_hours: null,
    status: "absent",
    notes: "Auto-generated absent (no punch record)",
    _hrms_id: null,
    _synced_at: new Date().toISOString(),
  }));

  await sendChunkedBulk(db, "Attendance", rows, "unique_key");
  console.log(`[appsScriptSync] pushAbsentsToSheet → ${rows.length} absent rows for ${date}`);
  return { ok: true, absent: rows.length, date };
}

// ── Full bulk push (admin-triggered) ─────────────────────────────────────────

async function fullBulkPushAll(db) {
  if (!isEnabled()) {
    return { ok: false, message: "Apps Script sync disabled or URL missing" };
  }
  const out = { tabs: {} };

  const attRaw = db
    .prepare(
      `SELECT ar.*, u.full_name AS user_full_name, u.email AS user_email,
              u.login_id AS user_login_id, u.role AS user_role,
              u.mobile AS user_mobile, u.shift_start, u.grace_minutes,
              b.name AS branch_name, b.city AS branch_city
       FROM attendance_records ar
       JOIN users u ON u.id = ar.user_id
       LEFT JOIN branches b ON b.id = u.branch_id
       ORDER BY ar.id ASC LIMIT 20000`
    )
    .all();
  const attPayloads = attRaw.map(buildAttendancePayload);
  out.tabs.Attendance = await sendChunkedBulk(db, "Attendance", attPayloads, "unique_key");

  const leaves = db
    .prepare(
      `SELECT lr.*, u.full_name AS user_full_name, u.email AS user_email, u.role AS user_role
       FROM leave_requests lr JOIN users u ON u.id = lr.user_id ORDER BY lr.id ASC LIMIT 10000`
    )
    .all();
  out.tabs["Leave Requests"] = await sendChunkedBulk(db, "Leave Requests", leaves, "id");

  const users = db
    .prepare(
      `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active, created_at
       FROM users ORDER BY id ASC`
    )
    .all();
  out.tabs.Users = await sendChunkedBulk(db, "Users", users, "id");

  const branches = db.prepare("SELECT * FROM branches ORDER BY id ASC").all();
  out.tabs.Branches = await sendChunkedBulk(db, "Branches", branches, "id");

  const audits = db.prepare("SELECT * FROM audit_logs ORDER BY id ASC LIMIT 20000").all();
  out.tabs.Logs = await sendChunkedBulk(db, "Logs", audits, "id");

  const notices = db
    .prepare(
      `SELECT n.*, u.full_name AS author_name FROM notices n JOIN users u ON u.id = n.created_by ORDER BY n.id ASC`
    )
    .all();
  out.tabs.Notices = await sendChunkedBulk(db, "Notices", notices, "id");

  return { ok: true, ...out };
}

// ── Startup smoke test ────────────────────────────────────────────────────────

async function runStartupSmokeTest(db) {
  if (!isEnabled()) {
    console.log("[appsScriptSync] Skipped startup test (disabled or no URL)");
    return { skipped: true };
  }
  const row = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get("apps_script_startup_test_ok");
  if (row && row.v === "1" && process.env.APPS_SCRIPT_FORCE_TEST !== "1") {
    return { skipped: true, reason: "already_ok" };
  }
  const testId = `hrms_test_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const payload = {
    __tab: "HRMS_Integration_Test",
    __matchKey: "test_id",
    test_id: testId,
    message: "HRMS portal automatic connectivity test",
    at: new Date().toISOString(),
    source: "hrms-portal",
  };
  try {
    await sendPayload(db, "HRMS_Integration_Test", payload);
    db.prepare("INSERT OR REPLACE INTO integration_kv (k, v) VALUES (?, ?)").run(
      "apps_script_startup_test_ok",
      "1"
    );
    console.log("[appsScriptSync] Startup test OK → Google Apps Script");
    return { ok: true, testId };
  } catch (e) {
    console.error("[appsScriptSync] Startup test failed:", e.message);
    return { ok: false, error: e.message };
  }
}

function getAppsScriptStatus(db) {
  const enabled = isEnabled();
  const url = getWebAppUrl();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const logs = db
    .prepare(
      `SELECT id, created_at, tab, ok, substr(COALESCE(response_snippet, error, ''), 1, 400) AS detail
       FROM apps_script_sync_log ORDER BY id DESC LIMIT 25`
    )
    .all();
  const tested = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get("apps_script_startup_test_ok");
  let queue_pending = 0;
  let queue_dead = 0;
  try {
    queue_pending = db.prepare(`SELECT COUNT(*) AS c FROM apps_script_sync_queue WHERE dead = 0`).get().c;
    queue_dead = db.prepare(`SELECT COUNT(*) AS c FROM apps_script_sync_queue WHERE dead = 1`).get().c;
  } catch (_) { /* table may not yet exist on first boot */ }
  return {
    enabled,
    webapp_host: host,
    startup_test_completed: !!(tested && tested.v === "1"),
    queue_pending,
    queue_dead,
    recent_logs: logs,
  };
}

module.exports = {
  getWebAppUrl,
  isEnabled,
  scheduleAttendance,
  scheduleLeave,
  scheduleUser,
  scheduleBranch,
  scheduleAudit,
  scheduleNotice,
  pushAbsentsToSheet,
  fullBulkPushAll,
  runStartupSmokeTest,
  getAppsScriptStatus,
  sanitizeObject,
  fmtISTDate,
  startSyncRetryWorker,
  drainSyncQueue,
  pruneSyncQueue,
  clearSyncQueue,
};
