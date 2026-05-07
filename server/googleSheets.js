/**
 * Google Sheets integration: OAuth or service account, dynamic headers, multi-tab upsert.
 * Env (OAuth): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI
 *   Redirect path: /api/integrations/google/oauth/callback (include full URL in env for production)
 * Env (optional SA): GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SERVICE_ACCOUNT / GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY, GOOGLE_SHEETS_SPREADSHEET_ID
 * Encryption: INTEGRATION_SECRET or SESSION_SECRET (AES-256-GCM for stored tokens)
 */
const crypto = require("crypto");
const { google } = require("googleapis");
const {
  loadServiceAccountCredentials,
  hasServiceAccountEnv,
} = require("./googleServiceAccount");

const SPREADSHEET_TITLE = "HRMS Master Data";
const REQUIRED_SHEETS = [
  "Attendance Logs",
  "Leave Requests",
  "Users",
  "Branches",
  "Audit Logs",
];

const KV = {
  OAUTH: "google_oauth_tokens",
  SPREADSHEET: "google_spreadsheet_id",
  SYNC: "google_sync_enabled",
  LAST_ERR: "google_last_error",
  LAST_SYNC: "google_last_sync_at",
};

function kvGet(db, key) {
  const r = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get(key);
  return r ? r.v : null;
}

function kvSet(db, key, val) {
  db.prepare("INSERT OR REPLACE INTO integration_kv (k, v) VALUES (?, ?)").run(key, val);
}

function kvDel(db, key) {
  db.prepare("DELETE FROM integration_kv WHERE k = ?").run(key);
}

function integrationKey() {
  const raw = process.env.INTEGRATION_SECRET || process.env.SESSION_SECRET || "hrms-dev-key";
  return crypto.createHash("sha256").update(String(raw)).digest();
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const key = integrationKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptJson(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const key = integrationKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

function redirectUri() {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/api/integrations/google/oauth/callback`
  );
}

function createOAuth2Client() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for OAuth.");
  }
  return new google.auth.OAuth2(id, secret, redirectUri());
}

function getGoogleAuthUrl(state) {
  const oauth2 = createOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/spreadsheets"],
    state,
  });
}

function getSpreadsheetId(db) {
  return kvGet(db, KV.SPREADSHEET) || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || null;
}

function isSyncEnabled(db) {
  const v = kvGet(db, KV.SYNC);
  if (v === "0") return false;
  return true;
}

function setSyncEnabled(db, enabled) {
  kvSet(db, KV.SYNC, enabled ? "1" : "0");
}

function hasOAuthTokens(db) {
  return !!kvGet(db, KV.OAUTH);
}

function hasServiceAccount() {
  return hasServiceAccountEnv();
}

async function withRetry(fn, times = 4) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const code = e.code || e.response?.status;
      const retryable =
        code === 429 ||
        code === 503 ||
        code === 500 ||
        (typeof code === "number" && code >= 502 && code <= 504);
      if (!retryable && i > 0) break;
      if (i < times - 1) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
    }
  }
  throw last;
}

function escapeSheet(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function colLetterFromIndex(n) {
  let s = "";
  let c = Math.max(1, Number(n) || 1);
  while (c > 0) {
    const rem = (c - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s || "A";
}

function ensureRecordIdFirst(headers) {
  const rid = "Record ID";
  const rest = headers.filter((h) => h !== rid);
  return [rid, ...rest];
}

function mergeHeaderLists(existing, incomingKeys) {
  const e = (existing || []).map((x) => String(x).trim()).filter(Boolean);
  const set = new Set(e);
  const out = [...e];
  for (const k of incomingKeys) {
    if (!set.has(k)) {
      out.push(k);
      set.add(k);
    }
  }
  return ensureRecordIdFirst(out);
}

function humanizeKey(k) {
  return String(k)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function flattenExtra(rec, reserved) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (reserved.has(k)) continue;
    const label = humanizeKey(k);
    if (label === "Record ID") continue;
    out[label] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v;
  }
  return out;
}

function persistOAuthFromClient(db, oauth2) {
  try {
    if (oauth2 && oauth2.credentials) {
      kvSet(db, KV.OAUTH, encryptJson(oauth2.credentials));
    }
  } catch (e) {
    console.error("[googleSheets] persist OAuth", e.message);
  }
}

async function getAuthAndSheets(db) {
  const enc = kvGet(db, KV.OAUTH);
  if (enc) {
    const tokens = decryptJson(enc);
    const oauth2 = createOAuth2Client();
    oauth2.setCredentials(tokens);
    oauth2.on("tokens", () => {
      persistOAuthFromClient(db, oauth2);
    });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });
    return { sheets, auth: oauth2, mode: "oauth" };
  }
  const saCreds = loadServiceAccountCredentials();
  if (saCreds) {
    const auth = new google.auth.GoogleAuth({
      credentials: saCreds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    return { sheets, auth: client, mode: "service_account" };
  }
  return null;
}

async function createSpreadsheetInDrive(db, sheetsApi) {
  const res = await withRetry(() =>
    sheetsApi.spreadsheets.create({
      requestBody: {
        properties: { title: SPREADSHEET_TITLE },
        sheets: REQUIRED_SHEETS.map((title) => ({
          properties: {
            title,
            gridProperties: { rowCount: 5000, columnCount: 40 },
          },
        })),
      },
    })
  );
  const id = res.data.spreadsheetId;
  kvSet(db, KV.SPREADSHEET, id);
  return id;
}

async function ensureSheetsExist(sheetsApi, spreadsheetId) {
  const meta = await withRetry(() => sheetsApi.spreadsheets.get({ spreadsheetId }));
  const titles = new Set((meta.data.sheets || []).map((s) => s.properties.title));
  const requests = [];
  for (const title of REQUIRED_SHEETS) {
    if (!titles.has(title)) {
      requests.push({
        addSheet: {
          properties: {
            title,
            gridProperties: { rowCount: 5000, columnCount: 40 },
          },
        },
      });
    }
  }
  if (requests.length) {
    await withRetry(() =>
      sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      })
    );
  }
}

async function upsertRowInternal(sheetsApi, spreadsheetId, sheetTitle, flatObject) {
  const esc = escapeSheet(sheetTitle);
  const rid = flatObject["Record ID"];
  if (rid == null || String(rid) === "") {
    throw new Error("Sheet row requires Record ID");
  }

  const hdrRes = await withRetry(() =>
    sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${esc}!1:1`,
    })
  );
  const existingRow =
    hdrRes.data.values && hdrRes.data.values[0] ? hdrRes.data.values[0] : [];
  const keys = Object.keys(flatObject);
  const merged = mergeHeaderLists(existingRow, keys);
  const row1 = merged.map((h) => h);

  const sameLen =
    existingRow.length === merged.length &&
    merged.every((h, i) => String(existingRow[i] || "").trim() === String(h).trim());
  if (!sameLen) {
    await withRetry(() =>
      sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `${esc}!1:1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row1] },
      })
    );
  }

  const colA = await withRetry(() =>
    sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${esc}!A2:A50000`,
    })
  );
  const vals = colA.data.values || [];
  let rowNum = -1;
  const want = String(rid);
  for (let i = 0; i < vals.length; i++) {
    if (String((vals[i] && vals[i][0]) || "") === want) {
      rowNum = i + 2;
      break;
    }
  }

  const rowData = merged.map((h) => {
    const v = flatObject[h];
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  const lastCol = colLetterFromIndex(merged.length);
  if (rowNum > 0) {
    await withRetry(() =>
      sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `${esc}!A${rowNum}:${lastCol}${rowNum}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      })
    );
  } else {
    await withRetry(() =>
      sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: `${esc}!A1`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [rowData] },
      })
    );
  }
}

async function upsertDynamicRow(db, sheetTitle, flatObject) {
  if (!isSyncEnabled(db)) {
    return { skipped: true, reason: "sync_disabled" };
  }
  const client = await getAuthAndSheets(db);
  if (!client) {
    return { ok: false, skipped: true, message: "Google not connected (OAuth or service account)." };
  }
  let spreadsheetId = getSpreadsheetId(db);
  if (!spreadsheetId) {
    spreadsheetId = await createSpreadsheetInDrive(db, client.sheets);
  }
  await ensureSheetsExist(client.sheets, spreadsheetId);
  await upsertRowInternal(client.sheets, spreadsheetId, sheetTitle, flatObject);
  if (client.mode === "oauth") persistOAuthFromClient(db, client.auth);
  kvSet(db, KV.LAST_SYNC, new Date().toISOString());
  kvSet(db, KV.LAST_ERR, "");
  return { ok: true };
}

function buildAttendanceFlat(rec, user, branchName) {
  const gpsLat =
    rec.in_lat != null && rec.in_lat !== ""
      ? rec.in_lat
      : rec.out_lat != null && rec.out_lat !== ""
        ? rec.out_lat
        : "";
  const gpsLng =
    rec.in_lng != null && rec.in_lng !== ""
      ? rec.in_lng
      : rec.out_lng != null && rec.out_lng !== ""
        ? rec.out_lng
        : "";
  let address = "";
  if (rec.punch_in_address && rec.punch_out_address) {
    address = `In: ${rec.punch_in_address} | Out: ${rec.punch_out_address}`;
  } else {
    address = rec.punch_in_address || rec.punch_out_address || "";
  }
  let photoUrl = "";
  if (rec.punch_in_photo && rec.punch_out_photo) {
    photoUrl = `In: ${rec.punch_in_photo} | Out: ${rec.punch_out_photo}`;
  } else {
    photoUrl = rec.punch_in_photo || rec.punch_out_photo || "";
  }
  let deviceInfo = "";
  if (rec.in_device_info && rec.out_device_info) {
    deviceInfo = `In: ${rec.in_device_info} | Out: ${rec.out_device_info}`;
  } else {
    deviceInfo = rec.in_device_info || rec.out_device_info || "";
  }

  const reserved = new Set([
    "id",
    "user_id",
    "full_name",
    "email",
    "branch_name",
    "login_id",
    "role",
    "work_date",
    "punch_in_at",
    "punch_out_at",
    "status",
    "half_period",
    "in_lat",
    "in_lng",
    "out_lat",
    "out_lng",
    "punch_in_address",
    "punch_out_address",
    "punch_in_photo",
    "punch_out_photo",
    "in_device_info",
    "out_device_info",
    "source",
    "notes",
    "created_at",
    "last_edited_by",
  ]);

  const base = {
    "Record ID": String(rec.id),
    Name: user.full_name || "",
    "User ID": user.login_id || user.email || "",
    Role: user.role || "",
    "Work Date": rec.work_date || "",
    "Time In": rec.punch_in_at || "",
    "Time Out": rec.punch_out_at || "",
    "GPS Lat": gpsLat,
    "GPS Lng": gpsLng,
    Address: address,
    Branch: branchName || "",
    Status: rec.status || "",
    "Photo URL": photoUrl,
    "Device Info": deviceInfo,
    "Created At": rec.created_at || "",
  };
  return { ...base, ...flattenExtra(rec, reserved) };
}

function buildLeaveFlat(row) {
  const reserved = new Set([
    "id",
    "user_id",
    "full_name",
    "email",
    "role",
  ]);
  const base = {
    "Record ID": `L-${row.id}`,
    "Leave ID": String(row.id),
    "Employee Name": row.full_name || "",
    Email: row.email || "",
    Role: row.role || "",
    "Start Date": row.start_date || "",
    "End Date": row.end_date || "",
    Reason: row.reason || "",
    "Final Status": row.final_status || "",
    "Manager Review": row.manager_review || "",
    "Admin Review": row.admin_review || "",
    "Manager Comment": row.manager_comment || "",
    "Admin Comment": row.admin_comment || "",
    "Manager Action At": row.manager_action_at || "",
    "Admin Action At": row.admin_action_at || "",
    "Created At": row.created_at || "",
    "Updated At": row.updated_at || "",
  };
  return { ...base, ...flattenExtra(row, reserved) };
}

function buildUserFlat(u) {
  return {
    "Record ID": `U-${u.id}`,
    "User ID": u.login_id || "",
    Email: u.email || "",
    Name: u.full_name || "",
    Role: u.role || "",
    "Branch ID": u.branch_id ?? "",
    "Shift Start": u.shift_start || "",
    "Shift End": u.shift_end || "",
    "Grace Minutes": u.grace_minutes ?? "",
    Active: u.active ?? "",
    "Created At": u.created_at || "",
  };
}

function buildBranchFlat(b) {
  return {
    "Record ID": `B-${b.id}`,
    "Branch ID": String(b.id),
    Name: b.name || "",
    Lat: b.lat ?? "",
    Lng: b.lng ?? "",
    "Radius M": b.radius_meters ?? "",
    "Created At": b.created_at || "",
  };
}

function buildAuditFlat(a) {
  let details = a.details;
  if (details && typeof details === "string") {
    try {
      details = JSON.stringify(JSON.parse(details));
    } catch {
      /* keep string */
    }
  }
  return {
    "Record ID": `A-${a.id}`,
    Action: a.action || "",
    "Entity Type": a.entity_type || "",
    "Entity ID": String(a.entity_id || ""),
    "Actor ID": a.actor_id ?? "",
    Details: details || "",
    "Created At": a.created_at || "",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scheduleSheets(db, label, fn) {
  setImmediate(async () => {
    try {
      if (!isSyncEnabled(db)) return;
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fn();
          return;
        } catch (e) {
          lastErr = e;
          console.error(`[googleSheets] ${label} attempt ${attempt}`, e.message);
          if (attempt < 3) await sleep(400 * attempt);
        }
      }
      throw lastErr;
    } catch (e) {
      console.error(`[googleSheets] ${label}`, e.message);
      try {
        kvSet(
          db,
          KV.LAST_ERR,
          JSON.stringify({ at: new Date().toISOString(), message: e.message })
        );
      } catch {
        /* ignore */
      }
    }
  });
}

function scheduleAttendanceSync(db, attendanceId) {
  scheduleSheets(db, "attendance", async () => {
    const rec = db
      .prepare(
        `SELECT ar.*, u.full_name, u.email, u.login_id, u.role, b.name AS branch_name
         FROM attendance_records ar
         JOIN users u ON u.id = ar.user_id
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE ar.id = ?`
      )
      .get(Number(attendanceId));
    if (!rec) return;
    const { branch_name, full_name, email, login_id, role, ...ar } = rec;
    const user = { full_name, email, login_id, role };
    const flat = buildAttendanceFlat(ar, user, branch_name);
    await upsertDynamicRow(db, "Attendance Logs", flat);
  });
}

function scheduleLeaveSync(db, leaveId) {
  scheduleSheets(db, "leave", async () => {
    const row = db
      .prepare(
        `SELECT lr.*, u.full_name, u.email, u.role
         FROM leave_requests lr
         JOIN users u ON u.id = lr.user_id
         WHERE lr.id = ?`
      )
      .get(Number(leaveId));
    if (!row) return;
    const flat = buildLeaveFlat(row);
    await upsertDynamicRow(db, "Leave Requests", flat);
  });
}

function scheduleUserSync(db, userId) {
  scheduleSheets(db, "user", async () => {
    const u = db
      .prepare(
        `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active, created_at
         FROM users WHERE id = ?`
      )
      .get(Number(userId));
    if (!u) return;
    await upsertDynamicRow(db, "Users", buildUserFlat(u));
  });
}

function scheduleBranchSync(db, branchId) {
  scheduleSheets(db, "branch", async () => {
    const b = db.prepare("SELECT * FROM branches WHERE id = ?").get(Number(branchId));
    if (!b) return;
    await upsertDynamicRow(db, "Branches", buildBranchFlat(b));
  });
}

function scheduleAuditSync(db, auditId) {
  scheduleSheets(db, "audit", async () => {
    const a = db.prepare("SELECT * FROM audit_logs WHERE id = ?").get(Number(auditId));
    if (!a) return;
    await upsertDynamicRow(db, "Audit Logs", buildAuditFlat(a));
  });
}

async function exchangeCodeAndSave(db, code) {
  const oauth2 = createOAuth2Client();
  const { tokens } = await withRetry(() => oauth2.getToken(code));
  kvSet(db, KV.OAUTH, encryptJson(tokens));
  oauth2.setCredentials(tokens);
  const sheets = google.sheets({ version: "v4", auth: oauth2 });
  let spreadsheetId = getSpreadsheetId(db);
  if (!spreadsheetId) {
    spreadsheetId = await createSpreadsheetInDrive(db, sheets);
  } else {
    await ensureSheetsExist(sheets, spreadsheetId);
  }
  kvSet(db, KV.SYNC, "1");
  kvSet(db, KV.LAST_ERR, "");
  persistOAuthFromClient(db, oauth2);
  return { spreadsheetId };
}

function disconnectGoogle(db) {
  kvDel(db, KV.OAUTH);
  kvDel(db, KV.SPREADSHEET);
  kvSet(db, KV.SYNC, "0");
}

function getIntegrationStatus(db) {
  let lastErr = null;
  try {
    const raw = kvGet(db, KV.LAST_ERR);
    lastErr = raw ? JSON.parse(raw) : null;
  } catch {
    lastErr = kvGet(db, KV.LAST_ERR);
  }
  const connected = hasOAuthTokens(db) || hasServiceAccount();
  return {
    oauthConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    connected,
    connectionStatus: connected ? "Connected" : "Not Connected",
    oauthLinked: hasOAuthTokens(db),
    serviceAccountConfigured: hasServiceAccount(),
    spreadsheetId: getSpreadsheetId(db),
    syncEnabled: isSyncEnabled(db),
    lastSyncAt: kvGet(db, KV.LAST_SYNC),
    lastError: lastErr,
  };
}

async function fullSyncAll(db) {
  const client = await getAuthAndSheets(db);
  if (!client) {
    return { ok: false, message: "Connect Google OAuth or set GOOGLE_SERVICE_ACCOUNT_JSON." };
  }
  if (!isSyncEnabled(db)) {
    return { ok: false, message: "Sync is disabled. Enable it in Settings." };
  }
  let spreadsheetId = getSpreadsheetId(db);
  if (!spreadsheetId) {
    spreadsheetId = await createSpreadsheetInDrive(db, client.sheets);
  }
  await ensureSheetsExist(client.sheets, spreadsheetId);

  const att = db
    .prepare(
      `SELECT ar.*, u.full_name, u.email, u.login_id, u.role, b.name AS branch_name
       FROM attendance_records ar
       JOIN users u ON u.id = ar.user_id
       LEFT JOIN branches b ON b.id = u.branch_id
       ORDER BY ar.id ASC LIMIT 10000`
    )
    .all();
  for (const rec of att) {
    const { branch_name, full_name, email, login_id, role, ...ar } = rec;
    const flat = buildAttendanceFlat(ar, { full_name, email, login_id, role }, branch_name);
    await upsertRowInternal(client.sheets, spreadsheetId, "Attendance Logs", flat);
  }

  const leaves = db
    .prepare(
      `SELECT lr.*, u.full_name, u.email, u.role
       FROM leave_requests lr
       JOIN users u ON u.id = lr.user_id
       ORDER BY lr.id ASC LIMIT 5000`
    )
    .all();
  for (const row of leaves) {
    await upsertRowInternal(client.sheets, spreadsheetId, "Leave Requests", buildLeaveFlat(row));
  }

  const users = db
    .prepare(
      `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active, created_at
       FROM users ORDER BY id ASC`
    )
    .all();
  for (const u of users) {
    await upsertRowInternal(client.sheets, spreadsheetId, "Users", buildUserFlat(u));
  }

  const branches = db.prepare("SELECT * FROM branches ORDER BY id ASC").all();
  for (const b of branches) {
    await upsertRowInternal(client.sheets, spreadsheetId, "Branches", buildBranchFlat(b));
  }

  const audits = db.prepare("SELECT * FROM audit_logs ORDER BY id ASC LIMIT 10000").all();
  for (const a of audits) {
    await upsertRowInternal(client.sheets, spreadsheetId, "Audit Logs", buildAuditFlat(a));
  }

  if (client.mode === "oauth") persistOAuthFromClient(db, client.auth);
  kvSet(db, KV.LAST_SYNC, new Date().toISOString());
  kvSet(db, KV.LAST_ERR, "");
  return {
    ok: true,
    spreadsheetId,
    counts: {
      attendance: att.length,
      leaves: leaves.length,
      users: users.length,
      branches: branches.length,
      audit: audits.length,
    },
  };
}

/** Batch upsert attendance rows (date-filtered manual sync). */
async function syncAttendanceRows(db, rows) {
  const client = await getAuthAndSheets(db);
  if (!client) {
    return {
      ok: false,
      skipped: true,
      message:
        "Connect Google (OAuth) in Settings or set GOOGLE_SERVICE_ACCOUNT_JSON and spreadsheet id.",
    };
  }
  if (!isSyncEnabled(db)) {
    return { ok: false, skipped: true, message: "Sync is disabled in Settings." };
  }
  let spreadsheetId = getSpreadsheetId(db);
  if (!spreadsheetId) {
    spreadsheetId = await createSpreadsheetInDrive(db, client.sheets);
  }
  await ensureSheetsExist(client.sheets, spreadsheetId);
  for (const rec of rows) {
    const { branch_name, full_name, email, login_id, role, ...ar } = rec;
    const user = { full_name, email, login_id, role };
    const flat = buildAttendanceFlat(ar, user, branch_name);
    await upsertRowInternal(client.sheets, spreadsheetId, "Attendance Logs", flat);
  }
  if (client.mode === "oauth") persistOAuthFromClient(db, client.auth);
  kvSet(db, KV.LAST_SYNC, new Date().toISOString());
  kvSet(db, KV.LAST_ERR, "");
  return { ok: true, upserted: rows.length };
}

module.exports = {
  syncAttendanceRows,
  getGoogleAuthUrl,
  exchangeCodeAndSave,
  getIntegrationStatus,
  setSyncEnabled,
  disconnectGoogle,
  scheduleAttendanceSync,
  scheduleLeaveSync,
  scheduleUserSync,
  scheduleBranchSync,
  scheduleAuditSync,
  fullSyncAll,
  upsertDynamicRow,
  buildAttendanceFlat,
  KV,
  kvGet,
  hasOAuthTokens,
};
