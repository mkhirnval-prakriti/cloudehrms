const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

// ── Lightweight TTL response cache ────────────────────────────────────────────
// Reduces DB load when many users poll the same read-heavy endpoints simultaneously.
// Each cache entry: { data, expiresAt }. Invalidated on writes by calling bust().
const _ttlCache = new Map();
function ttlGet(key) {
  const e = _ttlCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _ttlCache.delete(key); return null; }
  return e.data;
}
function ttlSet(key, data, ttlMs = 10000) {
  _ttlCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}
function ttlBust(...prefixes) {
  for (const [k] of _ttlCache) {
    if (prefixes.some(p => k.startsWith(p))) _ttlCache.delete(k);
  }
}
// Evict stale entries every 60s to prevent memory accumulation
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _ttlCache) { if (now > v.expiresAt) _ttlCache.delete(k); }
}, 60_000).unref();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { defaultPayrollSettings, computePayrollRow } = require("./payrollEngine");
const { can, requirePerm, listRolesMeta, ROLES } = require("./rbac");
const {
  isOrgWide,
  isBranchScoped,
  assertUserAccess,
  assertUserIdAccess,
  branchScopeSql,
  assertRoleAssignableOnCreate,
} = require("./accessScope");
const { haversineMeters, parseHmToMinutes } = require("./geo");
const { reverseGeocode } = require("./geocode");
const {
  syncAttendanceRows,
  scheduleAttendanceSync,
  scheduleLeaveSync,
  scheduleUserSync,
  scheduleBranchSync,
  scheduleAuditSync,
  fullSyncAll,
  getGoogleAuthUrl,
  exchangeCodeAndSave,
  getIntegrationStatus,
  setSyncEnabled,
  disconnectGoogle,
} = require("./googleSheets");
const { registerLeaveRoutes } = require("./leaveRoutes");
const { registerEnterpriseRoutes } = require("./enterpriseRoutes");
const { registerProductRoutes } = require("./productRoutes");
const { registerWebAuthnRoutes, verifyWebAuthnForAttendancePunch } = require("./webauthnAttendance");
const { registerBiometricRoutes } = require("./biometricRoutes");
const { registerProfileUpdateRoutes } = require("./profileUpdateRoutes");
const { phashFromBuffer, hammingHex } = require("./faceHash");
const { matchEmbedding, parseEmbeddingPayload } = require("./faceEmbedding");
const { notifyPunchWhatsApp } = require("./whatsapp");
const { createHrAlert, listRecentAlerts, generateOtp } = require("./alertsService");
const pushNotifications = require("./pushNotifications");
const { sendMail, sendAlertEmailToAdmins } = require("./emailService");
const {
  scheduleAttendance: appsScriptScheduleAttendance,
  scheduleLeave: appsScriptScheduleLeave,
  scheduleUser: appsScriptScheduleUser,
  scheduleBranch: appsScriptScheduleBranch,
  scheduleAudit: appsScriptScheduleAudit,
  scheduleNotice: appsScriptScheduleNotice,
  fullBulkPushAll: appsScriptFullBulkPushAll,
  pushAbsentsToSheet: appsScriptPushAbsentsToSheet,
  getAppsScriptStatus,
  startSyncRetryWorker: appsScriptStartSyncRetryWorker,
  clearSyncQueue: appsScriptClearSyncQueue,
} = require("./appsScriptSync");
const {
  defaultPayrollPolicy,
  daysInMonth: payrollDaysInMonth,
  aggregateMonthForUser: payrollAggregateMonth,
  computePayrollForUser: payrollComputeForUser,
  loadSpecialHolidaysSet,
} = require("./payrollEngineV2");

function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Minutes since midnight in Asia/Kolkata (IST), regardless of server TZ.
 * Used for late-mark calculation. Server runs in UTC; punch_in_at is stored
 * as UTC ISO. We convert to IST by adding +5h30m and reading UTC fields.
 */
function localMinutesFromDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  const istMs = d.getTime() + 5.5 * 3600000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// Stable JWT secret — persisted to disk so server restarts don't invalidate tokens.
let _cachedJwtSecret = null;
function jwtSecret() {
  if (_cachedJwtSecret) return _cachedJwtSecret;
  // 1. Prefer explicit env var
  let s = String(process.env.JWT_SECRET || "").trim();
  if (!s) s = String(process.env.SESSION_SECRET || "").trim();
  if (s) { _cachedJwtSecret = s; return s; }
  // 2. Fall back to persisted file secret (survives restarts)
  const secretFile = path.join(__dirname, "../data/.jwt_secret");
  try {
    if (fs.existsSync(secretFile)) {
      s = fs.readFileSync(secretFile, "utf8").trim();
      if (s) { _cachedJwtSecret = s; return s; }
    }
  } catch { /* ignore read errors */ }
  // 3. Generate a new stable secret and persist it
  s = crypto.randomBytes(48).toString("hex");
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, s, { mode: 0o600 });
  } catch (e) {
    console.warn("[hrms] jwtSecret: could not persist secret to disk:", e.message);
  }
  _cachedJwtSecret = s;
  return s;
}

function signJwt(user) {
  return jwt.sign({ sub: user.id, role: user.role }, jwtSecret(), { expiresIn: "7d" });
}

function mapSimpleRole(role) {
  if (role === ROLES.USER) return "staff";
  if (role === ROLES.LOCATION_MANAGER) return "branch_manager";
  if (role === ROLES.SUPER_ADMIN) return "super_admin";
  if (role === ROLES.ADMIN) return "admin";
  return "attendance_manager";
}

function mapIncomingRole(simple) {
  const r = String(simple || "").toLowerCase();
  if (r === "admin") return ROLES.ADMIN;
  if (r === "hr" || r === "attendance_manager") return ROLES.ATTENDANCE_MANAGER;
  if (r === "manager" || r === "location") return ROLES.LOCATION_MANAGER;
  if (r === "staff") return ROLES.USER;
  if (r === "super_admin") return ROLES.SUPER_ADMIN;
  return null;
}

function generateEmployeeLoginId() {
  return `PH-EMP-${Date.now().toString().slice(-6)}`;
}

function branchCodeFromName(name) {
  const ABBR = {
    JAIPUR: "JPR", AMRITSAR: "AMR", MEERUT: "MEE", DELHI: "DEL",
    NEWDELHI: "DEL", MUMBAI: "MUM", BANGALORE: "BLR", BENGALURU: "BLR",
    HYDERABAD: "HYD", CHENNAI: "CHE", KOLKATA: "KOL", PUNE: "PUN",
    AHMEDABAD: "AHM", LUCKNOW: "LKO", CHANDIGARH: "CHD", PATIALA: "PAT",
    LUDHIANA: "LDH", GURGAON: "GGN", GURUGRAM: "GGN", NOIDA: "NOI",
    VARANASI: "VNS", AGRA: "AGR", BHOPAL: "BPL", INDORE: "IND",
    NAGPUR: "NGP", COIMBATORE: "CBE", SURAT: "SUR", RAJKOT: "RAJ",
    FARIDABAD: "FBD", GHAZIABAD: "GZB", JALANDHAR: "JLD",
  };
  const key = String(name || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!key) return "GEN";
  if (ABBR[key]) return ABBR[key];
  return key.slice(0, 3).padEnd(3, "X");
}

function minutesBetweenIso(a, b) {
  if (!a || !b) return 0;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
  return d > 0 ? Math.round(d) : 0;
}

const realtime = require("./realtime");
const { mountNotificationRoutes, notify, notifyMany } = require("./notificationsService");

function createApiRouter(db) {
  const router = express.Router();

  // ── Async route wrapper ────────────────────────────────────────────────────
  // Makes ALL route handlers async-compatible with PostgreSQL (pg) Promises.
  // db.prepare().get/run/all() return Promises; this wrapper catches them.
  ["get", "post", "put", "patch", "delete"].forEach((method) => {
    const original = router[method].bind(router);
    router[method] = function (path, ...handlers) {
      const wrapped = handlers.map((h) => {
        if (typeof h !== "function") return h;
        return function asyncWrap(req, res, next) {
          try {
            const r = h(req, res, next);
            if (r && typeof r.catch === "function") r.catch(next);
          } catch (e) { next(e); }
        };
      });
      return original(path, ...wrapped);
    };
  });

  // Mount SSE channel + notification CRUD early.
  realtime.mountSse(router, { jwtSecret: jwtSecret() });
  // attachUser is defined later inside this scope; pass a thunk.
  // (We mount the actual routes near the bottom — see "/* SSE + notifications mounted above */".)
  /**
   * Per-user punch cooldown — prevents duplicate rapid punches (button mashing).
   * Key: userId (number), Value: Date.now() of last successful punch.
   * Cleared automatically every 5 minutes to avoid memory growth.
   */
  const punchCooldownMap = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 30000;
    for (const [uid, ts] of punchCooldownMap) {
      if (ts < cutoff) punchCooldownMap.delete(uid);
    }
  }, 300000).unref();
  const PUNCH_COOLDOWN_MS = 8000;

  /**
   * JWT revocation set — tokens are blacklisted on logout.
   * Stores the last 32 chars of each JWT (signature tail — unique per token).
   * Cleared of expired entries every 8 hours to prevent unbounded growth.
   */
  const revokedJwtTails = new Set();
  setInterval(() => {
    revokedJwtTails.clear();
  }, 8 * 60 * 60 * 1000).unref();

  /**
   * Face photo replay protection — prevents reusing the same JPEG file across
   * rapid punch attempts. Maps userId → { hash: sha256, ts: epoch }.
   * Window: 5 minutes. If same file hash arrives within window → reject.
   */
  const faceReplayMap = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 6 * 60 * 1000;
    for (const [uid, entry] of faceReplayMap) {
      if (entry.ts < cutoff) faceReplayMap.delete(uid);
    }
  }, 300000).unref();
  function generateBranchEmployeeId(branchId) {
    const b = branchId
      ? db.prepare("SELECT id, name FROM branches WHERE id = ?").get(Number(branchId))
      : null;
    const code = branchCodeFromName(b?.name);
    const row = db
      .prepare(
        `SELECT login_id FROM users
         WHERE login_id LIKE ?
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(`PH-${code}-%`);
    const nextNum = (() => {
      if (!row?.login_id) return 101;
      const m = String(row.login_id).match(/-(\d+)$/);
      return m ? Number(m[1]) + 1 : 101;
    })();
    return `PH-${code}-${String(nextNum).padStart(3, "0")}`;
  }

  function isLoginIdTaken(loginId) {
    if (!loginId || !String(loginId).trim()) return false;
    const row = db.prepare("SELECT id FROM users WHERE login_id = ? LIMIT 1").get(String(loginId).trim());
    return !!row;
  }

  function generateUniqueBranchEmployeeId(branchId) {
    let candidate = generateBranchEmployeeId(branchId);
    let safety = 0;
    while (isLoginIdTaken(candidate) && safety < 1000) {
      const m = String(candidate).match(/^(.*-)(\d+)$/);
      if (!m) {
        candidate = generateEmployeeLoginId();
      } else {
        const next = Number(m[2]) + 1;
        candidate = `${m[1]}${String(next).padStart(Math.max(3, String(m[2]).length), "0")}`;
      }
      safety += 1;
    }
    if (isLoginIdTaken(candidate)) {
      throw new Error("Unable to generate unique employee login id");
    }
    return candidate;
  }

  function normalizeRoleInput(input) {
    const raw = String(input || "").trim().toLowerCase();
    if (raw === "super_admin" || raw === "super admin") return ROLES.SUPER_ADMIN;
    if (raw === "admin") return ROLES.ADMIN;
    if (raw === "branch_manager" || raw === "branch manager" || raw === "manager") return ROLES.LOCATION_MANAGER;
    if (raw === "attendance_manager" || raw === "attendance manager" || raw === "hr") {
      return ROLES.ATTENDANCE_MANAGER;
    }
    if (raw === "staff" || raw === "user") return ROLES.USER;
    return mapIncomingRole(raw);
  }

  const pgUploads = require("./pgUploads");

  // Wrap a multer diskStorage so that every successfully-written file is
  // also mirrored into the PostgreSQL blob store. The local disk copy is
  // still authoritative for fast serving; PG is the durable backup that
  // survives Replit container redeploys (which wipe /uploads).
  function withPgMirror(storage, subdir) {
    const orig = storage._handleFile.bind(storage);
    storage._handleFile = function (req, file, cb) {
      orig(req, file, (err, info) => {
        if (err) return cb(err);
        // Fire-and-forget mirror — never block or fail the upload because
        // of a transient PG hiccup. The local file is already saved.
        const name = `${subdir}/${info.filename}`;
        Promise.resolve()
          .then(() => pgUploads.saveFromDisk(name, info.path, file.mimetype))
          .catch((e) => console.error("[pguploads] mirror failed:", name, e.message));
        cb(null, info);
      });
    };
    return storage;
  }

  const uploadRoot = path.join(__dirname, "..", "uploads", "attendance");
  fs.mkdirSync(uploadRoot, { recursive: true });
  const upload = multer({
    storage: withPgMirror(
      multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadRoot),
        filename: (_req, file, cb) => {
          const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
          const safe = /^\.(jpg|jpeg|png|webp)$/i.test(ext) ? ext : ".jpg";
          cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${safe}`);
        },
      }),
      "attendance"
    ),
    limits: { fileSize: 6 * 1024 * 1024 },
  });

  const uploadFacesRoot = path.join(__dirname, "..", "uploads", "faces");
  fs.mkdirSync(uploadFacesRoot, { recursive: true });
  const uploadFace = multer({
    storage: withPgMirror(
      multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadFacesRoot),
        filename: (_req, file, cb) => {
          const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
          const safe = /^\.(jpg|jpeg|png|webp)$/i.test(ext) ? ext : ".jpg";
          cb(null, `face-${Date.now()}-${Math.random().toString(36).slice(2)}${safe}`);
        },
      }),
      "faces"
    ),
    limits: { fileSize: 6 * 1024 * 1024 },
  });

  const uploadDocsRoot = path.join(__dirname, "..", "uploads", "documents");
  fs.mkdirSync(uploadDocsRoot, { recursive: true });
  const uploadDoc = multer({
    storage: withPgMirror(
      multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDocsRoot),
        filename: (_req, file, cb) => {
          const ext = (path.extname(file.originalname) || ".pdf").toLowerCase();
          const safe = /^\.(pdf|jpg|jpeg|png|webp)$/i.test(ext) ? ext : ".bin";
          cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${safe}`);
        },
      }),
      "documents"
    ),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  function attachUser(req, res, next) {
    function decorateUser(u) {
      const ext = db
        .prepare(
          `SELECT cr.id AS custom_role_id, cr.name AS custom_role_name, cr.permissions_json
           FROM user_role_assignments ura
           JOIN custom_roles cr ON cr.id = ura.custom_role_id
           WHERE ura.user_id = ? AND cr.active = 1`
        )
        .get(u.id);
      if (!ext?.permissions_json) return u;
      try {
        return {
          ...u,
          custom_role_id: ext.custom_role_id,
          custom_role_name: ext.custom_role_name,
          custom_permissions: JSON.parse(ext.permissions_json),
        };
      } catch {
        return u;
      }
    }
    const auth = req.headers.authorization;
    if (auth && typeof auth === "string" && auth.startsWith("Bearer ")) {
      try {
        const rawToken = auth.slice(7);
        const tokenTail = rawToken.slice(-32);
        if (revokedJwtTails.has(tokenTail)) throw new Error("revoked");
        const payload = jwt.verify(rawToken, jwtSecret());
        const uid = payload.sub;
        if (!uid) throw new Error("no sub");
        const user = db
          .prepare(
            `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active,
             COALESCE(allow_gps,0) AS allow_gps, COALESCE(allow_face,1) AS allow_face, COALESCE(allow_biometric,1) AS allow_biometric, COALESCE(allow_manual,0) AS allow_manual,
             COALESCE(allow_biometric,1) AS allow_biometric
             FROM users WHERE id = ? AND deleted_at IS NULL`
          )
          .get(uid);
        if (!user || !user.active) throw new Error("inactive");
        req.currentUser = decorateUser(user);
        return next();
      } catch {
        // JWT invalid or expired — fall through to session-based auth below
        // (this handles server restarts with ephemeral JWT secret gracefully)
      }
    }
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const user = db
      .prepare(
        `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active,
         COALESCE(allow_gps,0) AS allow_gps, COALESCE(allow_face,1) AS allow_face, COALESCE(allow_biometric,1) AS allow_biometric, COALESCE(allow_manual,0) AS allow_manual,
         COALESCE(allow_biometric,1) AS allow_biometric
         FROM users WHERE id = ? AND deleted_at IS NULL`
      )
      .get(req.session.userId);
    if (!user || !user.active) {
      req.session.destroy();
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.currentUser = decorateUser(user);
    next();
  }

  function insertAudit(actorId, action, entityType, entityId, details) {
    const info = db
      .prepare(
        `INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, details) VALUES (?,?,?,?,?)`
      )
      .run(
        action,
        entityType,
        String(entityId),
        actorId,
        details != null ? JSON.stringify(details) : null
      );
    scheduleAuditSync(db, info.lastInsertRowid);
    appsScriptScheduleAudit(db, info.lastInsertRowid);
  }

  function raiseHrAlert(payload) {
    try {
      createHrAlert(db, payload);
      setImmediate(() => {
        sendAlertEmailToAdmins(db, {
          subject: String(payload.type || "alert"),
          text: String(payload.message || ""),
        }).catch(() => {});
      });
    } catch (e) {
      console.error("[hr_alerts]", e.message);
    }
  }

  const APP_SETTINGS_KEY = "app_runtime_settings";
  const COMPANY_PROFILE_KEY = "company_profile";
  function readCompanyProfile() {
    const r = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get(COMPANY_PROFILE_KEY);
    const base = {
      company_name: "PRAKRITI HERBS PRIVATE LIMITED",
      legal_name: "PRAKRITI HERBS PRIVATE LIMITED",
      address: "Building No. 30 & 31, South Part, Bilochi Nagar A, Amer, Jaipur, Rajasthan - 302012",
      legal_address:
        "Building No. 30 & 31, South Part, Bilochi Nagar A, Amer, Jaipur, Rajasthan - 302012",
      city: "Jaipur",
      state: "Rajasthan",
      pincode: "302012",
      gstin: "08AAQCP4095D1Z2",
      cin: "U46497RJ2025PTC109202",
      director: "Mandeep Kumar",
      authorized_signatory: "Mandeep Kumar",
      phone: "",
      email: process.env.COMPANY_EMAIL || "",
    };
    if (!r || !r.v) {
      writeCompanyProfile(base);
      return base;
    }
    try {
      return { ...base, ...JSON.parse(r.v) };
    } catch {
      return base;
    }
  }
  function writeCompanyProfile(obj) {
    db.prepare("INSERT OR REPLACE INTO integration_kv (k, v) VALUES (?, ?)").run(
      COMPANY_PROFILE_KEY,
      JSON.stringify(obj)
    );
  }

  function defaultAppSettings() {
    return {
      app_name: process.env.APP_NAME || "HRMS Portal",
      session_ttl_days: 7,
      features: {
        kiosk: true,
        geo_fence: true,
        face_recognition: false,
        wifi_restriction: false,
      },
      attendance_wifi: {
        enabled: false,
        networks: [],
        allowed_ssids: [],
      },
      daily_report: {
        enabled: true,
        recipients: (process.env.REPORT_RECIPIENTS || process.env.ALERT_EMAIL_TO || "").split(",").map(e => e.trim()).filter(Boolean),
      },
    };
  }
  function readAppSettings() {
    const r = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get(APP_SETTINGS_KEY);
    if (!r || !r.v) return defaultAppSettings();
    try {
      return { ...defaultAppSettings(), ...JSON.parse(r.v) };
    } catch {
      return defaultAppSettings();
    }
  }
  function writeAppSettings(obj) {
    db.prepare("INSERT OR REPLACE INTO integration_kv (k, v) VALUES (?, ?)").run(
      APP_SETTINGS_KEY,
      JSON.stringify(obj)
    );
  }
  const SHEET_INTEGRATION_KEY = "sheet_integration_v1";
  function readSheetIntegration() {
    const row = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get(SHEET_INTEGRATION_KEY);
    const base = {
      enabled: false,
      mode: "webhook",
      google_sheet_link: "",
      api_key: "",
      default_webhook_url: "",
      branch_map: {},
      last_sync_at: "",
      last_error: "",
      // Sheet → Portal direction is DISABLED by default after the one-time backfill.
      // Toggle ON in Settings only when admin wants to allow Sheet edits to flow back.
      sheet_to_portal_enabled: false,
      // One-shot arming flag for the manual backfill button. Auto-clears after one
      // pull (success or failure). Prevents accidental re-imports.
      backfill_armed: false,
      backfill_armed_at: "",
      backfill_armed_by: "",
      last_backfill_at: "",
    };
    if (!row?.v) return base;
    try {
      return { ...base, ...JSON.parse(row.v) };
    } catch {
      return base;
    }
  }
  function writeSheetIntegration(next) {
    db.prepare("INSERT OR REPLACE INTO integration_kv (k, v) VALUES (?, ?)").run(
      SHEET_INTEGRATION_KEY,
      JSON.stringify(next)
    );
    primeAppsScriptEnvFromConfig(next);
  }
  // The new appsScriptSync engine reads only `process.env.GOOGLE_APPS_SCRIPT_WEBAPP_URL`.
  // To honour the URL the user pasted via the Settings UI (which lives in
  // sheet_integration_v1 KV), we mirror it onto process.env every time the
  // config is saved AND once at startup. Default URL wins; otherwise we use
  // the first non-empty branch URL.
  function pickAppsScriptUrl(cfg) {
    const def = String(cfg?.default_webhook_url || "").trim();
    if (def) return def;
    const map = (cfg && cfg.branch_map) || {};
    for (const k of Object.keys(map)) {
      const v = String(map[k] || "").trim();
      if (v) return v;
    }
    return "";
  }
  function primeAppsScriptEnvFromConfig(cfg) {
    const url = pickAppsScriptUrl(cfg);
    if (url) {
      process.env.GOOGLE_APPS_SCRIPT_WEBAPP_URL = url;
      console.log(
        "[appsScriptSync] env URL primed from sheet_integration_v1 →",
        (() => { try { return new URL(url).hostname; } catch { return "(invalid)"; } })()
      );
    }
  }
  // Prime once at module load so all downstream sync calls see the URL even
  // before the user re-saves the integration page in this process lifetime.
  try { primeAppsScriptEnvFromConfig(readSheetIntegration()); } catch (e) {
    console.error("[appsScriptSync] prime at boot failed:", e.message);
  }
  // Start the persistent retry worker. Failed Portal→Sheet pushes are
  // saved to apps_script_sync_queue and replayed automatically with
  // exponential backoff so transient Google outages never lose data.
  try { appsScriptStartSyncRetryWorker(db, { intervalMs: 60_000 }); } catch (e) {
    console.error("[appsScriptSync] retry worker start failed:", e.message);
  }
  // Cached read of the canonical Apps Script file shipped with the repo.
  // This is the EXACT script that pairs with the current backend payload
  // (unique_key + status + attendance_mode + half_day handling).
  let _gasSnippetCache = null;
  function sheetConnectSnippet() {
    if (_gasSnippetCache) return _gasSnippetCache;
    try {
      const gasPath = path.join(__dirname, "..", "google-apps-script", "hrms_sync.gs");
      _gasSnippetCache = fs.readFileSync(gasPath, "utf8");
      return _gasSnippetCache;
    } catch (e) {
      console.error("[sheetConnectSnippet] failed to load hrms_sync.gs:", e.message);
      // Minimal fallback that still uses the new fields, in case the file is missing.
      return `// Fallback — please redeploy. Real script lives at google-apps-script/hrms_sync.gs
function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var tab = body.__tab || "Attendance";
  var matchKey = body.__matchKey || "unique_key";
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
  var records = Array.isArray(body.records) ? body.records : [body];
  records.forEach(function (r) {
    var headers = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
    var keys = Object.keys(r).filter(function (k) { return k !== "__tab" && k !== "__matchKey"; });
    keys.forEach(function (k) { if (headers.indexOf(k) < 0) headers.push(k); });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    var matchVal = String(r[matchKey] || "");
    var lastRow = sheet.getLastRow(), foundRow = -1, mc = headers.indexOf(matchKey);
    if (mc >= 0 && lastRow >= 2) {
      var col = sheet.getRange(2, mc + 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < col.length; i++) if (String(col[i][0]) === matchVal) { foundRow = i + 2; break; }
    }
    var row = headers.map(function (h) { return r[h] == null ? "" : r[h]; });
    if (foundRow > 0) sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
  });
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}`;
    }
  }
  async function pushAttendanceToConfiguredSheet(attendanceId) {
    const cfg = readSheetIntegration();
    if (!cfg.enabled) return { skipped: true, reason: "disabled" };
    const row = db
      .prepare(
        `SELECT ar.id, ar.work_date, ar.punch_in_at, ar.punch_out_at, ar.status, u.full_name, u.login_id, u.role,
                b.id AS branch_id, b.name AS branch_name
         FROM attendance_records ar
         JOIN users u ON u.id = ar.user_id
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE ar.id = ?`
      )
      .get(Number(attendanceId));
    if (!row) return { skipped: true, reason: "not_found" };
    const url =
      (row.branch_id != null && cfg.branch_map && cfg.branch_map[String(row.branch_id)]) ||
      cfg.default_webhook_url;
    if (!url) return { skipped: true, reason: "no_webhook_url" };
    const inAt = row.punch_in_at ? new Date(row.punch_in_at) : null;
    const outAt = row.punch_out_at ? new Date(row.punch_out_at) : null;
    const totalHours =
      inAt && outAt ? Math.max(0, ((outAt.getTime() - inAt.getTime()) / 36e5)).toFixed(2) : "";
    const payload = {
      employee_name: row.full_name,
      employee_id: row.login_id || "",
      branch: row.branch_name || "",
      role: row.role || "",
      punch_in: row.punch_in_at || "",
      punch_out: row.punch_out_at || "",
      total_hours: totalHours,
      date: row.work_date,
      status: row.status,
    };
    try {
      const r = await fetch(String(url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`Webhook sync failed (${r.status})`);
      writeSheetIntegration({
        ...cfg,
        last_sync_at: new Date().toISOString(),
        last_error: "",
      });
      return { ok: true };
    } catch (e) {
      writeSheetIntegration({
        ...cfg,
        last_error: String(e.message || e),
      });
      return { ok: false, error: String(e.message || e) };
    }
  }

  const PAYROLL_SETTINGS_KEY = "payroll_settings_v1";
  function readPayrollSettings() {
    const r = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get(PAYROLL_SETTINGS_KEY);
    if (!r || !r.v) return defaultPayrollSettings();
    try {
      return { ...defaultPayrollSettings(), ...JSON.parse(r.v) };
    } catch {
      return defaultPayrollSettings();
    }
  }
  function writePayrollSettings(obj) {
    const next = { ...readPayrollSettings(), ...obj };
    db.prepare("INSERT OR REPLACE INTO integration_kv (k, v) VALUES (?, ?)").run(
      PAYROLL_SETTINGS_KEY,
      JSON.stringify(next)
    );
    return next;
  }

  function sumDeliveryDailyForMonth(userId, period) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_inr), 0) AS s FROM payroll_delivery_daily
         WHERE user_id = ? AND substr(work_date, 1, 7) = ?`
      )
      .get(Number(userId), String(period).slice(0, 7));
    return Number(row && row.s) || 0;
  }

  function listEffectivePermissions(user) {
    const meta = {};
    const keys = [
      "dashboard:read",
      "dashboard:read_self",
      "attendance:self",
      "attendance:read_all",
      "attendance:punch",
      "attendance:manual",
      "attendance:edit_any",
      "attendance:kiosk",
      "attendance:face_placeholder",
      "history:read",
      "history:read_self",
      "history:edit",
      "branches:read",
      "branches:write",
      "departments:read",
      "departments:write",
      "users:read",
      "users:create",
      "users:update",
      "notices:read",
      "notices:write",
      "timings:read",
      "timings:read_self",
      "timings:write",
      "roles:read",
      "settings:read",
      "settings:write",
      "leave:apply",
      "leave:read_self",
      "leave:read_all",
      "leave:approve_manager",
      "export:read",
      "integrations:sync",
      "payroll:read",
      "payroll:read_self",
      "payroll:write",
      "documents:read_all",
      "documents:verify",
      "audit:read",
      "crm:read",
      "crm:write",
      "biometric:admin",
      "biometric:request_update",
    ];
    keys.forEach((k) => {
      meta[k] = can(user, k);
    });
    return meta;
  }

  function finishLogin(req, res, user) {
    req.session.userId = user.id;
    insertAudit(user.id, "login", "session", String(user.id), { path: "login" });
    const token = signJwt(user);
    res.json({
      token,
      id: user.id,
      email: user.email,
      login_id: user.login_id,
      full_name: user.full_name,
      role: user.role,
      branch_id: user.branch_id,
      permissions: listEffectivePermissions(user),
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        login_id: user.login_id,
        role: mapSimpleRole(user.role),
        rbacRole: user.role,
        branch_id: user.branch_id,
      },
    });
  }

  function loginFromBody(req, res) {
    const { email, password, login } = req.body || {};
    const idOrEmail = String(email || login || "").trim();
    if (!idOrEmail || !password) {
      return res.status(400).json({ error: "Email or user ID and password required" });
    }
    const user = db
      .prepare(
        `SELECT id, email, login_id, password_hash, full_name, role, branch_id, active, account_status, rejection_reason FROM users
         WHERE (lower(email) = lower(?) OR lower(mobile) = ? OR lower(ifnull(login_id,'')) = lower(?)) AND deleted_at IS NULL`
      )
      .get(idOrEmail, idOrEmail, idOrEmail);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    // Handle pending/rejected accounts with helpful messages
    if (user.account_status === "PENDING") {
      return res.status(403).json({
        error: "आपका अकाउंट approval के लिए pending है। Admin approval के बाद login कर पाएंगे।",
        account_status: "PENDING",
      });
    }
    if (user.account_status === "REJECTED") {
      const reason = user.rejection_reason ? ` Reason: ${user.rejection_reason}` : "";
      return res.status(403).json({
        error: `आपका registration request reject हो गया है।${reason}`,
        account_status: "REJECTED",
      });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!user.active) {
      db.prepare("UPDATE users SET active = 1 WHERE id = ? AND deleted_at IS NULL").run(user.id);
      user.active = 1;
    }
    finishLogin(req, res, user);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SELF-REGISTRATION (public — no auth required)
  // ────────────────────────────────────────────────────────────────────────────
  router.post("/register", (req, res) => {
    const { full_name, mobile, password, email, address, shift_start, shift_end } = req.body || {};
    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }
    if (!mobile || !/^\d{10,15}$/.test(String(mobile).replace(/\s/g, ""))) {
      return res.status(400).json({ error: "Valid mobile number (10-15 digits) is required" });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    // Validate shift times (mandatory)
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!shift_start || !timeRe.test(String(shift_start).trim())) {
      return res.status(400).json({ error: "Shift start time is required (HH:MM format)" });
    }
    if (!shift_end || !timeRe.test(String(shift_end).trim())) {
      return res.status(400).json({ error: "Shift end time is required (HH:MM format)" });
    }
    const mob = String(mobile).replace(/\s/g, "");
    // Prevent duplicate mobile numbers
    const existing = db.prepare("SELECT id, account_status FROM users WHERE mobile = ? AND deleted_at IS NULL").get(mob);
    if (existing) {
      if (existing.account_status === "PENDING") {
        return res.status(409).json({ error: "इस mobile number से already एक registration pending है।" });
      }
      if (existing.account_status === "ACTIVE") {
        return res.status(409).json({ error: "इस mobile number से already एक account exist करता है।" });
      }
      // If rejected, keep history intact and allow a fresh row only after manual cleanup
      db.prepare("UPDATE users SET deleted_at = NULL, active = 0 WHERE id = ? AND account_status = 'REJECTED'").run(existing.id);
    }
    const hash = bcrypt.hashSync(String(password), 10);
    const tempEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : `reg_${mob}@hrms.internal`;
    // Check email unique
    const emailExists = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL").get(tempEmail);
    if (emailExists) {
      return res.status(409).json({ error: "This email is already registered. Use your Employee ID to login." });
    }
    const info = db
      .prepare(
        `INSERT INTO users (full_name, email, mobile, password_hash, role, active, account_status, registered_via, address, shift_start, shift_end, created_at)
         VALUES (?, ?, ?, ?, 'USER', 0, 'PENDING', 'self_registration', ?, ?, ?, datetime('now'))`
      )
      .run(
        String(full_name).trim(), tempEmail, mob, hash,
        address ? String(address).trim() : null,
        String(shift_start).trim(), String(shift_end).trim()
      );
    insertAudit(info.lastInsertRowid, "self_registration", "users", info.lastInsertRowid, { mobile: mob });
    res.status(201).json({
      ok: true,
      message: "आपका अकाउंट बन गया है, approval के लिए भेज दिया गया है। Admin approval के बाद आप login कर पाएंगे।",
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PENDING REGISTRATIONS — Admin/Manager approval panel
  // ────────────────────────────────────────────────────────────────────────────
  router.get("/admin/pending-registrations", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!can(u, "users:read")) return res.status(403).json({ error: "Forbidden" });
    const rows = db
      .prepare(
        `SELECT id, full_name, mobile, email, address, created_at, account_status, rejection_reason, registered_via
         FROM users
         WHERE account_status IN ('PENDING', 'REJECTED') AND deleted_at IS NULL
         ORDER BY account_status ASC, created_at DESC
         LIMIT 200`
      )
      .all();
    res.json({ registrations: rows, count: rows.filter((r) => r.account_status === "PENDING").length });
  });

  router.get("/admin/account-audit", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!can(u, "users:read")) return res.status(403).json({ error: "Forbidden" });
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_rows,
        SUM(CASE WHEN active = 1 AND deleted_at IS NULL AND (account_status IS NULL OR account_status = 'ACTIVE') THEN 1 ELSE 0 END) AS login_ready,
        SUM(CASE WHEN account_status = 'PENDING' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN account_status = 'REJECTED' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed,
        SUM(CASE WHEN role = 'SUPER_ADMIN' THEN 1 ELSE 0 END) AS super_admins,
        SUM(CASE WHEN role = 'ADMIN' THEN 1 ELSE 0 END) AS admins,
        SUM(CASE WHEN role NOT IN ('SUPER_ADMIN','ADMIN') THEN 1 ELSE 0 END) AS staff
      FROM users
    `).get();
    const recent = db.prepare(`
      SELECT id, full_name, login_id, role, active, account_status, deleted_at, created_at
      FROM users
      ORDER BY id DESC
      LIMIT 25
    `).all();
    res.json({ stats, recent });
  });

  router.post("/admin/pending-registrations/:id/approve", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "users:create") && !can(actor, "users:update")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const pending = db.prepare("SELECT * FROM users WHERE id = ? AND account_status = 'PENDING' AND deleted_at IS NULL").get(id);
    if (!pending) return res.status(404).json({ error: "Pending registration not found" });

    // Additional details from body (admin can edit before approving)
    const { branch_id, role, department } = req.body || {};
    const branchId = branch_id ? Number(branch_id) : (pending.branch_id || 1);
    const assignedRole = role || "USER";

    // Generate employee ID — scan ALL existing login_ids (including soft-deleted)
    // matching the pattern, take the numerically-highest suffix, then loop until
    // we find a value that does not collide with any existing row (any status).
    const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId);
    const code = branchCodeFromName(branch?.name || "");
    const prefix = `PH-${code}-`;
    const allRows = db
      .prepare(`SELECT login_id FROM users WHERE login_id LIKE ? AND id != ?`)
      .all(`${prefix}%`, id);
    let maxNum = 100;
    for (const r of allRows) {
      const m = String(r.login_id || "").match(/-(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
    }
    let nextNum = maxNum + 1;
    let newLoginId = `${prefix}${nextNum}`;
    const collideStmt = db.prepare("SELECT 1 FROM users WHERE login_id = ? AND id != ? LIMIT 1");
    let safety = 0;
    while (collideStmt.get(newLoginId, id) && safety < 1000) {
      nextNum += 1;
      newLoginId = `${prefix}${nextNum}`;
      safety += 1;
    }
    // Final guard — confirm the chosen id is actually free before UPDATE.
    if (collideStmt.get(newLoginId, id)) {
      return res.status(500).json({ error: "Could not allocate a free login_id after 1000 attempts" });
    }

    // Fix email if it's an internal placeholder
    const newEmail = pending.email.endsWith("@hrms.internal")
      ? `${newLoginId.toLowerCase().replace(/-/g, ".")}@hrms.local`
      : pending.email;

    db.prepare(
      `UPDATE users
       SET active = 1, account_status = 'ACTIVE', login_id = ?, branch_id = ?, role = ?,
           email = ?, department = COALESCE(?, department), updated_at = datetime('now')
       WHERE id = ?`
    ).run(newLoginId, branchId, assignedRole, newEmail, department || null, id);

    insertAudit(actor.id, "registration_approve", "users", id, { login_id: newLoginId, approver: actor.id });
    seedRoleDefaults(assignedRole);
    const updated = db.prepare("SELECT id, full_name, login_id, email, mobile, role, branch_id FROM users WHERE id = ?").get(id);
    res.json({ ok: true, user: updated, login_id: newLoginId });
  });

  router.post("/admin/pending-registrations/:id/reject", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "users:update")) return res.status(403).json({ error: "Forbidden" });
    const id = Number(req.params.id);
    const pending = db.prepare("SELECT id FROM users WHERE id = ? AND account_status = 'PENDING' AND deleted_at IS NULL").get(id);
    if (!pending) return res.status(404).json({ error: "Pending registration not found" });
    const { reason } = req.body || {};
    db.prepare(
      `UPDATE users SET account_status = 'REJECTED', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(reason ? String(reason).trim() : null, id);
    insertAudit(actor.id, "registration_reject", "users", id, { reason });
    res.json({ ok: true });
  });

  router.post("/auth/otp/request", async (req, res, next) => {
    try {
      const email = String(req.body?.email || "").trim();
      if (!email) return res.status(400).json({ error: "email required" });
      const user = db
        .prepare(`SELECT id, email FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL AND active = 1`)
        .get(email);
      if (!user) return res.status(404).json({ error: "No active account with this email" });
      const code = generateOtp();
      const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO login_otps (email, code, expires_at) VALUES (?,?,?)`).run(email, code, exp);
      await sendMail({
        to: email,
        subject: "HRMS — login verification code",
        text: `Your one-time code: ${code}\nValid for 10 minutes.`,
      });
      res.json({ ok: true, message: "OTP sent to email" });
    } catch (e) {
      next(e);
    }
  });

  router.post("/auth/login", (req, res) => loginFromBody(req, res));
  router.post("/login", (req, res) => loginFromBody(req, res));

  router.post("/auth/change-password", attachUser, (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: "current_password and new_password (min 6 chars) required" });
    }
    const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.currentUser.id);
    if (!row || !bcrypt.compareSync(String(current_password), row.password_hash)) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(String(new_password), 10), req.currentUser.id);
    insertAudit(req.currentUser.id, "password_change", "user", String(req.currentUser.id), {});
    res.json({ ok: true });
  });

  router.post("/auth/forgot-password", async (req, res, next) => {
    try {
      const idOrMobile = String(req.body?.email || req.body?.mobile || "").trim();
      if (!idOrMobile) return res.status(400).json({ error: "email or mobile required" });
      const user = db
        .prepare(
          `SELECT id, email FROM users WHERE deleted_at IS NULL AND active = 1 AND (
            lower(email) = lower(?) OR replace(ifnull(mobile,''),' ','') = replace(?,' ','')
          )`
        )
        .get(idOrMobile, idOrMobile);
      if (!user) {
        return res.json({ ok: true, message: "If an account exists, an OTP will be sent." });
      }
      const code = generateOtp();
      const exp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      db.prepare(`DELETE FROM password_reset_otps WHERE user_id = ?`).run(user.id);
      db.prepare(`INSERT INTO password_reset_otps (user_id, otp_code, expires_at, attempts) VALUES (?,?,?,0)`).run(
        user.id,
        code,
        exp
      );
      await sendMail({
        to: user.email,
        subject: "HRMS Portal — Password Reset OTP",
        text: `Your OTP code: ${code}\nValid for 5 minutes. Do not share this code.\nIf you did not request a reset, ignore this email.`,
      });
      res.json({ ok: true, message: "If an account exists, an OTP was sent to the registered email." });
    } catch (e) {
      next(e);
    }
  });

  router.post("/auth/verify-otp", (req, res) => {
    const emailOrMobile = String(req.body?.email || req.body?.mobile || "").trim();
    const otp = String(req.body?.otp || "").trim();
    if (!emailOrMobile || !otp) {
      return res.status(400).json({ error: "email (or mobile) and otp required" });
    }
    const user = db
      .prepare(
        `SELECT id, email FROM users WHERE deleted_at IS NULL AND active = 1 AND (
          lower(email) = lower(?) OR replace(ifnull(mobile,''),' ','') = replace(?,' ','')
        )`
      )
      .get(emailOrMobile, emailOrMobile);
    if (!user) {
      return res.status(400).json({ error: "Invalid OTP" });
    }
    const row = db
      .prepare(`SELECT * FROM password_reset_otps WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
      .get(user.id);
    if (!row || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "OTP expired" });
    }
    if (Number(row.attempts) >= 3) {
      return res.status(400).json({ error: "Too many attempts. Request a new OTP." });
    }
    if (String(row.otp_code) !== otp) {
      db.prepare(`UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
      return res.status(400).json({ error: "Invalid OTP" });
    }
    const resetToken = crypto.randomBytes(32).toString("hex");
    const exp = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare(`DELETE FROM password_reset_otps WHERE user_id = ?`).run(user.id);
    db.prepare(`INSERT OR REPLACE INTO password_reset_tokens (token, user_id, expires_at) VALUES (?,?,?)`).run(
      resetToken,
      user.id,
      exp
    );
    res.json({ ok: true, reset_token: resetToken, expires_in_minutes: 15 });
  });

  router.post("/auth/reset-password", (req, res) => {
    const { token, new_password } = req.body || {};
    if (!token || !new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: "token and new_password (min 6 chars) required" });
    }
    const row = db.prepare(`SELECT * FROM password_reset_tokens WHERE token = ?`).get(String(token));
    if (!row || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
      bcrypt.hashSync(String(new_password), 10),
      row.user_id
    );
    db.prepare(`DELETE FROM password_reset_tokens WHERE token = ?`).run(String(token));
    insertAudit(row.user_id, "password_reset_token", "user", String(row.user_id), {});
    res.json({ ok: true });
  });

  router.post("/auth/logout", attachUser, (req, res) => {
    const uid = req.currentUser.id;
    insertAudit(uid, "logout", "session", String(uid), {});
    const auth = req.headers.authorization;
    if (auth && typeof auth === "string" && auth.startsWith("Bearer ")) {
      revokedJwtTails.add(auth.slice(7).slice(-32));
    }
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get("/auth/me", attachUser, (req, res) => {
    const u = req.currentUser;
    res.json({
      id: u.id,
      email: u.email,
      login_id: u.login_id,
      full_name: u.full_name,
      role: u.role,
      branch_id: u.branch_id,
      shift_start: u.shift_start,
      shift_end: u.shift_end,
      grace_minutes: u.grace_minutes,
      permissions: listEffectivePermissions(u),
    });
  });

  function branchGeoCheck(user, lat, lng) {
    if (!user.branch_id) return { ok: true };
    const b = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.branch_id);
    if (!b || b.lat == null || b.lng == null) return { ok: true };
    if (lat == null || lng == null) {
      return {
        ok: false,
        reason:
          "GPS coordinates required for this branch (enable location or use “Punch from office location”).",
      };
    }
    const dist = haversineMeters(Number(lat), Number(lng), b.lat, b.lng);
    // radius_meters = 0 means exact location — apply 5m internal GPS tolerance
    const effectiveRadius = Number(b.radius_meters) === 0 ? 5 : Number(b.radius_meters);
    if (dist > effectiveRadius) {
      const displayRadius = Number(b.radius_meters) === 0 ? '0m (strict)' : b.radius_meters + 'm';
      return {
        ok: false,
        reason: `Outside allowed radius (${Math.round(dist)}m > ${displayRadius}).`,
      };
    }
    return { ok: true, distance_m: Math.round(dist) };
  }

  function getOrCreateDay(userId, workDate) {
    // INSERT OR IGNORE is idempotent — safe if called concurrently or repeatedly.
    // A bare INSERT would throw UNIQUE(user_id, work_date) if the row already exists.
    db.prepare(
      `INSERT OR IGNORE INTO attendance_records (user_id, work_date, status, source)
       VALUES (?, ?, 'absent', 'device')`
    ).run(userId, workDate);
    return db
      .prepare("SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?")
      .get(userId, workDate);
  }

  function computeLateStatus(user, punchInIso) {
    if (!punchInIso) return "present";
    const startM = parseHmToMinutes(user.shift_start);
    const actualM = localMinutesFromDate(punchInIso);
    if (actualM > startM + Number(user.grace_minutes || 0)) return "late";
    return "present";
  }

  // Status derivation from working hours + punch-in time-of-day.
  // Spec (per HRMS policy):
  //   hours <  4   => 'half_day'
  //   hours 4..9   => 'present'
  //   hours >= 9   => 'present' (full day; same enum value)
  //   late marker  => if punch_in IST time-of-day > 09:30, status = 'late'
  //                   (overrides 'present' but NOT 'half_day')
  function istHourMin(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }
  function deriveStatusFromHours(punchInIso, punchOutIso, currentStatus) {
    if (!punchInIso || !punchOutIso) return null;
    const inMs = new Date(punchInIso).getTime();
    const outMs = new Date(punchOutIso).getTime();
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) return null;
    const hours = (outMs - inMs) / 3600000;
    if (hours < 4) return "half_day";
    // 4h+ counts as present; check late-by-punch-in
    const punchMin = istHourMin(punchInIso);
    const LATE_CUTOFF = 9 * 60 + 30; // 09:30 IST
    if (punchMin !== null && punchMin > LATE_CUTOFF) return "late";
    return currentStatus === "late" ? "late" : "present";
  }

  function devicePayload(req) {
    return JSON.stringify({
      ua: req.headers["user-agent"] || "",
      platform: req.headers["sec-ch-ua-platform"] || "",
      mobile: req.headers["sec-ch-ua-mobile"] || "",
    });
  }

  async function runPunch(req, res, next) {
    try {
      const actor = req.currentUser;
      const type = req.body.type;
      let lat = req.body.lat !== undefined && req.body.lat !== "" ? Number(req.body.lat) : null;
      let lng = req.body.lng !== undefined && req.body.lng !== "" ? Number(req.body.lng) : null;

      // ── GPS coordinate range validation ───────────────────────────────────────
      // Reject obviously fake / spoofed coordinates outside Earth's valid range.
      if (lat !== null && !Number.isNaN(lat) && (lat < -90 || lat > 90)) {
        return res.status(400).json({
          error: "Invalid GPS coordinates — latitude must be between -90 and 90. GPS spoof detected.",
          code: "INVALID_GPS_COORDS",
        });
      }
      if (lng !== null && !Number.isNaN(lng) && (lng < -180 || lng > 180)) {
        return res.status(400).json({
          error: "Invalid GPS coordinates — longitude must be between -180 and 180. GPS spoof detected.",
          code: "INVALID_GPS_COORDS",
        });
      }
      if (lat !== null && Number.isNaN(lat)) lat = null;
      if (lng !== null && Number.isNaN(lng)) lng = null;

      const source = req.body.source;
      const targetUserId = req.body.targetUserId;
      if (type !== "in" && type !== "out") {
        return res.status(400).json({ error: "type must be 'in' or 'out'" });
      }
      if (!can(actor, "attendance:punch")) {
        return res.status(403).json({ error: "Forbidden" });
      }

      let subjectId = actor.id;
      if (targetUserId && Number(targetUserId) !== actor.id) {
        if (!can(actor, "attendance:read_all")) {
          return res.status(403).json({ error: "Cannot punch for other users" });
        }
        subjectId = Number(targetUserId);
      }

      const subject = db
        .prepare(
          `SELECT id, branch_id, role, shift_start, shift_end, grace_minutes, active,
           COALESCE(allow_gps,0) AS allow_gps, COALESCE(allow_face,1) AS allow_face, COALESCE(allow_biometric,1) AS allow_biometric, COALESCE(allow_manual,0) AS allow_manual,
           COALESCE(allow_biometric,1) AS allow_biometric
           FROM users WHERE id = ? AND deleted_at IS NULL`
        )
        .get(subjectId);
      if (!subject || !subject.active) {
        return res.status(404).json({ error: "User not found" });
      }
      const scopePunch = assertUserAccess(actor, subject);
      if (!scopePunch.ok) {
        return res.status(scopePunch.status).json({ error: scopePunch.error });
      }

      // ── Per-user cooldown: prevents rapid duplicate punches ─────────────
      // Layer 1: in-memory map (fastest path, survives within a session)
      // Layer 2: DB fallback (restart-safe — kicks in when map is empty)
      const cooldownKey = subjectId;
      const lastPunch = punchCooldownMap.get(cooldownKey);
      if (lastPunch && Date.now() - lastPunch < PUNCH_COOLDOWN_MS) {
        const remaining = Math.ceil((PUNCH_COOLDOWN_MS - (Date.now() - lastPunch)) / 1000);
        return res.status(429).json({
          error: `Please wait ${remaining} second(s) before punching again. (${remaining} सेकंड बाद try करें।)`,
          code: "COOLDOWN",
        });
      }
      if (!lastPunch) {
        // DB fallback: check last punch timestamp (one indexed read, very fast)
        try {
          const todayStr = todayLocalDate();
          const lastRec = db
            .prepare(
              `SELECT punch_in_at, punch_out_at FROM attendance_records
               WHERE user_id = ? AND work_date = ? LIMIT 1`
            )
            .get(subjectId, todayStr);
          if (lastRec) {
            const timestamps = [lastRec.punch_in_at, lastRec.punch_out_at].filter(Boolean);
            const latest = timestamps.sort().at(-1);
            if (latest) {
              const msSince = Date.now() - new Date(latest).getTime();
              if (msSince < PUNCH_COOLDOWN_MS) {
                punchCooldownMap.set(cooldownKey, Date.now() - (PUNCH_COOLDOWN_MS - msSince));
                const remaining = Math.ceil((PUNCH_COOLDOWN_MS - msSince) / 1000);
                return res.status(429).json({
                  error: `Please wait ${remaining} second(s) before punching again. (${remaining} सेकंड बाद try करें।)`,
                  code: "COOLDOWN",
                });
              }
            }
          }
        } catch { /* non-fatal — proceed to main punch logic */ }
      }

      // ── Mode settings (admin-controlled) ───────────────────────────────
      const appSettings = readAppSettings();
      const appFeatures = appSettings.features || {};
      // geo_fence: true by default — GPS radius enforcement
      const geoFenceOn = appFeatures.geo_fence !== false;
      // wifi_restriction: synced from features flag OR attendance_wifi.enabled
      const wifiRestrictOn = !!(appFeatures.wifi_restriction) || !!(appSettings.attendance_wifi?.enabled);
      // Privileged actors (admin/manager) can bypass GPS for manual/kiosk ops
      const actorIsPrivileged = ["SUPER_ADMIN", "ADMIN", "ATTENDANCE_MANAGER"].includes(actor.role);
      // Kiosk methods are exempt from the new biometric policy (controlled environment)
      const isKioskMethod = ["qr_kiosk", "pin", "search_kiosk"].includes(
        String(req.body.attendanceMethod || req.body.method || "").toLowerCase()
      );

      // WiFi path: staff sends useBranchCenter=true to use office WiFi as location proof
      // We allow this always (verified below via SSID check if configured)
      const staffWifiPath = !actorIsPrivileged && req.body.useBranchCenter === true;

      // allowBranchCenter: privileged actors always allowed; staff allowed via WiFi path
      const allowBranchCenter = !geoFenceOn || actorIsPrivileged || staffWifiPath;
      if (req.body.useBranchCenter === true && subject.branch_id && allowBranchCenter) {
        const br = db.prepare("SELECT lat, lng FROM branches WHERE id = ?").get(subject.branch_id);
        if (br && br.lat != null && br.lng != null) {
          lat = Number(br.lat);
          lng = Number(br.lng);
        }
      }

      // ── WiFi SSID Verification (for staffWifiPath) ──────────────────────────
      // When staff uses WiFi path and WiFi networks are configured, verify SSID.
      // If no networks configured → WiFi path is unverified; log an HR alert so
      // admin is aware and can configure SSIDs.
      if (staffWifiPath && !isKioskMethod) {
        const wifiCfg = appSettings.attendance_wifi || {};
        const networks = Array.isArray(wifiCfg.networks) ? wifiCfg.networks : [];
        if (networks.length > 0) {
          const sentSsid = String(req.body?.wifi_ssid || req.body?.ssid || "").trim().toLowerCase();
          // Mobile app sends device IP (expo-network.getIpAddressAsync) — verify against configured subnet
          const mobileWifiIp = String(req.body?.wifi_ip || "").trim();
          const ipSubnets = networks
            .map((x) => String(x?.ip_subnet || "").trim())
            .filter(Boolean);
          const ssidList = networks.map((x) => String(x?.ssid || "").trim().toLowerCase()).filter(Boolean);

          // Check IP subnet first (mobile app path — Expo Go compatible)
          if (mobileWifiIp && ipSubnets.length > 0) {
            const ipMatch = ipSubnets.some((subnet) => mobileWifiIp.startsWith(subnet));
            console.log(`[WiFi-IP] user#${subjectId} ip=${mobileWifiIp} subnets=${ipSubnets.join(',')} match=${ipMatch}`);
            if (!ipMatch) {
              return res.status(403).json({
                error: `Office WiFi network से connect नहीं हैं। Device IP (${mobileWifiIp}) configured subnet से match नहीं हुआ। (Not on office WiFi.)`,
                code: "WIFI_IP_MISMATCH",
              });
            }
            console.log(`[WiFi-IP] ✓ VERIFIED user#${subjectId} ip=${mobileWifiIp}`);
            // IP verified — allow through without SSID check
          } else if (sentSsid || ssidList.length > 0) {
            // Fall back to SSID check (web browser / kiosk path)
            if (!sentSsid || (ssidList.length > 0 && !ssidList.includes(sentSsid))) {
              return res.status(403).json({
                error: "Office WiFi पर नहीं हैं। Authorized WiFi network से connect करें। (Not on office WiFi.)",
                code: "WIFI_NOT_VERIFIED",
              });
            }
            const matchNet = networks.find((x) => String(x?.ssid || "").trim().toLowerCase() === sentSsid);
            if (matchNet && String(matchNet.password || "").trim()) {
              const sentPass = String(req.body?.wifi_password || "").trim();
              if (String(matchNet.password).trim() !== sentPass) {
                return res.status(403).json({ error: "Invalid office WiFi password." });
              }
            }
          }
        } else {
          // No networks configured — WiFi location is unverified. Log a warning.
          raiseHrAlert({
            type: "unauthorized_mode",
            severity: "warning",
            message: `WiFi attendance used without verification for user #${subjectId} — configure WiFi networks (SSID/IP subnet) in Settings.`,
            userId: subjectId,
            actorId: actor.id,
            meta: { sentSsid: req.body?.wifi_ssid || "", wifi_ip: req.body?.wifi_ip || "" },
          });
        }
      }

      const explicitMethod = String(req.body.attendanceMethod || req.body.method || "").toLowerCase();
      const useOfficeCenter = req.body.useBranchCenter === true && subject.branch_id && allowBranchCenter;
      let punchMethod = explicitMethod;
      if (!punchMethod) {
        if (req.file) punchMethod = "face";
        else punchMethod = "gps";
      }
      const allowedMethods = ["gps", "office", "face", "fingerprint", "qr_kiosk", "pin", "search_kiosk"];
      if (!allowedMethods.includes(punchMethod)) punchMethod = req.file ? "face" : "gps";
      if (explicitMethod === "fingerprint") {
        punchMethod = "fingerprint";
      } else if (useOfficeCenter && punchMethod !== "face") {
        punchMethod = "office";
      }

      // Fingerprint fallback to branch center: only when geo_fence OFF or privileged actor
      if (punchMethod === "fingerprint" && (lat == null || lng == null) && subject.branch_id && allowBranchCenter) {
        const br = db.prepare("SELECT lat, lng FROM branches WHERE id = ?").get(subject.branch_id);
        if (br && br.lat != null && br.lng != null) {
          lat = Number(br.lat);
          lng = Number(br.lng);
        }
      }

      if (punchMethod === "face" && Number(subject.allow_face) === 0) {
        return res.status(403).json({ error: "Face attendance is disabled for this account." });
      }
      if (punchMethod === "face" && !req.file) {
        return res.status(400).json({ error: "Photo required for face attendance" });
      }
      if (punchMethod === "fingerprint" && Number(subject.allow_biometric) === 0) {
        return res.status(403).json({ error: "Fingerprint attendance is disabled for this account." });
      }

      // ── Priority 1: GPS enforcement (geo_fence ON) ──────────────────────
      if (geoFenceOn) {
        // Staff self-punch: GPS coordinates are mandatory
        // EXCEPTION: kiosk methods (QR/PIN/search) — admin-controlled, geo enforced via short-lived token
        if (lat == null || lng == null) {
          if (!actorIsPrivileged && !isKioskMethod) {
            return res.status(400).json({
              error: "GPS location required. Please enable location access and try again. (Admin ने GPS attendance अनिवार्य किया है।)",
            });
          }
          // Privileged actors: auto-use branch center as fallback
          if (subject.branch_id) {
            const br = db.prepare("SELECT lat, lng FROM branches WHERE id = ?").get(subject.branch_id);
            if (br && br.lat != null && br.lng != null) {
              lat = Number(br.lat);
              lng = Number(br.lng);
            }
          }
        }
      }

      // ── Priority 2: WiFi enforcement (geo_fence OFF, wifi restriction ON) ─
      if (!geoFenceOn && wifiRestrictOn) {
        const wifiCfg = appSettings.attendance_wifi || { enabled: false, allowed_ssids: [] };
        const ssid = String(req.body?.wifi_ssid || req.body?.ssid || "").trim().toLowerCase();
        const wifiPass = String(req.body?.wifi_password || "").trim();
        const mobileWifiIp = String(req.body?.wifi_ip || "").trim();
        const networks = Array.isArray(wifiCfg.networks) ? wifiCfg.networks : [];
        const allowed = networks.map((x) => String(x?.ssid || "").trim().toLowerCase()).filter(Boolean);
        const ipSubnets = networks.map((x) => String(x?.ip_subnet || "").trim()).filter(Boolean);
        const matchNetwork = networks.find((x) => String(x?.ssid || "").trim().toLowerCase() === ssid);
        if (!actorIsPrivileged) {
          // Mobile app: verify via device IP subnet (Expo Go compatible — SSID not available in browser/Expo Go)
          if (mobileWifiIp && ipSubnets.length > 0) {
            const ipMatch = ipSubnets.some((subnet) => mobileWifiIp.startsWith(subnet));
            console.log(`[WiFi-IP P2] user#${subjectId} ip=${mobileWifiIp} subnets=${ipSubnets.join(',')} match=${ipMatch}`);
            if (!ipMatch) {
              return res.status(403).json({
                error: `Attendance केवल office WiFi पर allowed है। Device IP (${mobileWifiIp}) configured subnet से match नहीं हुआ।`,
                code: "WIFI_IP_MISMATCH",
              });
            }
            console.log(`[WiFi-IP P2] ✓ VERIFIED user#${subjectId} ip=${mobileWifiIp}`);
            // IP subnet verified — WiFi check passed
          } else {
            // Web / kiosk path: SSID check
            if (!ssid || (allowed.length > 0 && !allowed.includes(ssid))) {
              return res.status(403).json({ error: "Attendance allowed only on office WiFi network. (Admin ने WiFi attendance अनिवार्य किया है।)" });
            }
            if (matchNetwork && String(matchNetwork.password || "").trim()) {
              if (String(matchNetwork.password).trim() !== wifiPass) {
                return res.status(403).json({ error: "Invalid office WiFi password." });
              }
            }
          }
        }
      }

      // ── GPS also permitted alongside WiFi (geo_fence ON + wifi also checked) ─
      // When geo_fence is ON, WiFi is optional (GPS is the gate)
      if (geoFenceOn) {
        const wifiCfg = appSettings.attendance_wifi || { enabled: false };
        if (wifiCfg.enabled && !actorIsPrivileged) {
          // WiFi check is soft when geo_fence is already enforcing — just log, don't block
        }
      }

      if (punchMethod === "gps" && !useOfficeCenter && lat != null && lng != null && subject.allow_gps === 0) {
        raiseHrAlert({
          type: "unauthorized_mode",
          severity: "critical",
          message: `GPS punch blocked for user #${subjectId} (${subject.email || "no email"})`,
          userId: subjectId,
          actorId: actor.id,
          meta: { mode: "gps" },
        });
        return res.status(403).json({
          error: "GPS punch disabled for this employee. Use office location or contact HR.",
        });
      }

      // Skip radius check for kiosk methods — admin's QR/PIN is the gate, not GPS distance.
      const geo = isKioskMethod ? { ok: true } : branchGeoCheck(subject, lat, lng);
      if (!geo.ok) {
        raiseHrAlert({
          type: "wrong_location",
          severity: "warning",
          message: `Outside radius / invalid location: ${geo.reason} — user #${subjectId}`,
          userId: subjectId,
          actorId: actor.id,
          meta: { lat, lng },
        });
        return res.status(400).json({ error: geo.reason });
      }

      // ── Fingerprint method: require at least one enrolled passkey ────────────
      // Prevents crafted requests from using attendanceMethod=fingerprint when no
      // WebAuthn credentials exist (auto-mode gate silently passes credCount=0).
      if (punchMethod === "fingerprint" && !actorIsPrivileged && !isKioskMethod) {
        const { credCount: fpCredCount } = db
          .prepare("SELECT COUNT(*) AS credCount FROM webauthn_credentials WHERE user_id = ?")
          .get(subjectId);
        if (!fpCredCount || Number(fpCredCount) === 0) {
          return res.status(403).json({
            error: "Fingerprint/Passkey registered नहीं है। पहले Identity Page पर जाकर Fingerprint enroll करें। (No passkey enrolled — go to Identity page.)",
            code: "FINGERPRINT_NOT_ENROLLED",
          });
        }
      }

      // ── NEW POLICY: Biometric gate — mandatory Face OR Fingerprint ───────────
      // For non-privileged staff (excluding kiosk methods):
      //   Step 1 (location) → already checked above (GPS radius or WiFi)
      //   Step 2 (biometric) → face photo OR fingerprint REQUIRED
      // QR/Kiosk/PIN methods are exempt (admin-controlled environment)
      if (!actorIsPrivileged && !isKioskMethod) {
        const hasFacePhoto = !!req.file; // face photo submitted
        const hasFingerprint = punchMethod === "fingerprint"; // fingerprint/passkey method
        if (!hasFacePhoto && !hasFingerprint) {
          raiseHrAlert({
            type: "unauthorized_mode",
            severity: "critical",
            message: `Biometric bypass attempted by user #${subjectId} — GPS-only punch blocked`,
            userId: subjectId,
            actorId: actor.id,
            meta: { punchMethod },
          });
          return res.status(403).json({
            error:
              "Face या Fingerprint verification अनिवार्य है। केवल GPS/WiFi से attendance दर्ज नहीं हो सकती। " +
              "कृपया Face capture करें या Fingerprint/Passkey use करें। " +
              "(Biometric verification is mandatory — Face or Fingerprint required.)",
            code: "BIOMETRIC_REQUIRED",
          });
        }
      }

      /** Overlap network I/O with WebAuthn user gesture / verification (saves ~0.5–3s typical). */
      const addressPromise = reverseGeocode(lat, lng, { timeoutMs: 3500 });

      // Face is itself a biometric proof — do not also demand a passkey.
      // Fingerprint/Passkey method submits its own WebAuthn assertion which is
      // verified by this gate. All other modes follow the configured policy.
      // Kiosk methods (QR/PIN/search) are exempt — admin-controlled environment.
      if (punchMethod !== "face" && !isKioskMethod) {
        const webAuthnGate = await verifyWebAuthnForAttendancePunch({
          db,
          req,
          subjectId,
          actorId: actor.id,
        });
        if (!webAuthnGate.ok) {
          return res.status(webAuthnGate.status).json({
            error: webAuthnGate.error,
            code: webAuthnGate.code,
          });
        }
      }

      if (req.file && req.file.size < 8192) {
        return res.status(400).json({ error: "Photo file too small — use a live camera capture (min 8KB)" });
      }

      // ── Face photo replay attack protection ───────────────────────────────────
      // Hash the incoming JPEG bytes. If the exact same file was submitted by the
      // same user within 5 minutes, reject it as a replay attack.
      if (punchMethod === "face" && req.file && !actorIsPrivileged) {
        try {
          const buf = fs.readFileSync(req.file.path);
          const fileHash = require("crypto").createHash("sha256").update(buf).digest("hex");
          const last = faceReplayMap.get(subjectId);
          if (last && last.hash === fileHash && Date.now() - last.ts < 5 * 60 * 1000) {
            return res.status(400).json({
              error: "Duplicate photo detected. Live camera photo use करें — same photo reuse नहीं होगी। (Face replay blocked.)",
              code: "FACE_REPLAY_DETECTED",
            });
          }
          faceReplayMap.set(subjectId, { hash: fileHash, ts: Date.now() });
        } catch { /* non-fatal — continue if hash fails */ }
      }

      let faceVerificationLabel = "none";
      if (req.file) {
        const prof = db
          .prepare("SELECT phash, embedding_json FROM user_face_profiles WHERE user_id = ?")
          .get(subjectId);
        const candEmb = parseEmbeddingPayload(req.body?.faceDescriptor);
        if (prof && prof.embedding_json && String(prof.embedding_json).trim().length > 10) {
          if (!candEmb) {
            return res.status(400).json({
              error:
                "Live face verification required: use the in-app camera flow (blink + movement) so a face descriptor is sent with the photo.",
            });
          }
          const embMatch = matchEmbedding(prof.embedding_json, candEmb);
          if (!embMatch.ok) {
            return res.status(400).json({
              error: "Face match नहीं हुआ — सीधे camera देखें, अच्छी रोशनी लें और फिर से try करें।",
              code: "FACE_EMBEDDING_MISMATCH",
            });
          }
          faceVerificationLabel = "face_embedding_matched";
        } else if (prof && prof.phash) {
          try {
            const buf = fs.readFileSync(req.file.path);
            const newHash = phashFromBuffer(buf);
            const dist = hammingHex(newHash, prof.phash);
            if (dist > 20) {
              return res.status(400).json({
                error: "Face does not match enrolled profile — use live capture aligned with enrollment.",
              });
            }
            faceVerificationLabel = "face_matched";
          } catch (e) {
            return res.status(400).json({ error: "Face verification failed: " + (e.message || String(e)) });
          }
        } else {
          faceVerificationLabel = "face_captured";
        }
      }

      const photoPath = req.file ? `/uploads/attendance/${req.file.filename}` : null;
      const devInfo = devicePayload(req);
      const devShort = String(devInfo).slice(0, 4000);
      let verificationVal = "ok";
      if (punchMethod === "face") {
        verificationVal = faceVerificationLabel;
      } else if (punchMethod === "fingerprint") {
        const vs = req.body.verificationStatus ?? req.body.fingerprintStatus;
        verificationVal =
          vs === true || vs === 1 || String(vs).toLowerCase() === "verified" ? "verified" : "pending";
      } else if (punchMethod === "gps") {
        verificationVal = geo.ok ? "gps_ok" : "gps";
      } else if (punchMethod === "office") {
        verificationVal = "office_location";
      }

      const workDate = todayLocalDate();
      const rec = getOrCreateDay(subjectId, workDate);
      const nowIso = new Date().toISOString();
      const src = source === "kiosk" ? "kiosk" : "device";

      if (type === "in") {
        if (rec.punch_in_at) {
          raiseHrAlert({
            type: "duplicate_punch",
            severity: "warning",
            message: `Duplicate punch-in attempt for user #${subjectId}`,
            userId: subjectId,
            actorId: actor.id,
          });
          return res.status(400).json({ error: "Already punched in" });
        }
        db.prepare(
          `UPDATE attendance_records
           SET punch_in_at = ?, in_lat = ?, in_lng = ?, punch_in_address = ?, punch_in_photo = ?, in_device_info = ?,
               source = ?, status = ?, last_edited_by = ?,
               punch_method_in = ?, device_in = ?, verification_in = ?
           WHERE id = ?`
        ).run(
          nowIso,
          lat,
          lng,
          null,
          photoPath,
          devInfo,
          src,
          computeLateStatus(subject, nowIso),
          actor.id,
          punchMethod,
          devShort,
          verificationVal,
          rec.id
        );
      } else {
        if (!rec.punch_in_at) {
          raiseHrAlert({
            type: "invalid_punch_sequence",
            severity: "info",
            message: `Punch-out without check-in for user #${subjectId}`,
            userId: subjectId,
            actorId: actor.id,
          });
          return res.status(400).json({ error: "Punch in required first" });
        }
        if (rec.punch_out_at) {
          raiseHrAlert({
            type: "duplicate_punch",
            severity: "warning",
            message: `Duplicate punch-out attempt for user #${subjectId}`,
            userId: subjectId,
            actorId: actor.id,
          });
          return res.status(400).json({ error: "Already punched out" });
        }
        db.prepare(
          `UPDATE attendance_records
           SET punch_out_at = ?, out_lat = ?, out_lng = ?, punch_out_address = ?, punch_out_photo = ?, out_device_info = ?, last_edited_by = ?,
               punch_method_out = ?, device_out = ?, verification_out = ?
           WHERE id = ?`
        ).run(
          nowIso,
          lat,
          lng,
          null,
          photoPath,
          devInfo,
          actor.id,
          punchMethod,
          devShort,
          verificationVal,
          rec.id
        );
        // Recompute status using working-hours rule (Half Day > Late priority)
        const recomputed = deriveStatusFromHours(rec.punch_in_at, nowIso, rec.status);
        if (recomputed) {
          db.prepare("UPDATE attendance_records SET status = ? WHERE id = ?").run(recomputed, rec.id);
        }
      }

      const fresh = db.prepare("SELECT * FROM attendance_records WHERE id = ?").get(rec.id);
      const recId = rec.id;

      // ── Set per-user cooldown immediately after successful punch ──────────
      punchCooldownMap.set(cooldownKey, Date.now());
      ttlBust(`my-today:${subjectId}:`, "live-status:", "dash-overview:");

      insertAudit(actor.id, type === "in" ? "punch_in" : "punch_out", "attendance", recId, {
        work_date: workDate,
      });
      scheduleAttendanceSync(db, recId);
      appsScriptScheduleAttendance(db, recId);

      // ── Respond immediately — geocode and notifications run in background ──
      res.json({
        record: fresh,
        checkIn: fresh.punch_in_at,
        checkOut: fresh.punch_out_at,
        status: fresh.status,
        geo,
      });

      // Realtime broadcast + in-app notification (with late/half-day alerts)
      try {
        realtime.broadcast("attendance", {
          type: type === "in" ? "punch_in" : "punch_out",
          user_id: subjectId,
          work_date: workDate,
          status: fresh.status,
          by: actor.id,
          ts: Date.now(),
        });
        const u = db.prepare("SELECT full_name FROM users WHERE id = ?").get(subjectId);
        const tm = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
        let ttl, body;
        if (type === "in") {
          if (fresh.status === "late") {
            // Calculate late minutes for the alert.
            const startM = parseHmToMinutes(subject.shift_start);
            const actualM = localMinutesFromDate(fresh.punch_in_at);
            const lateMin = Math.max(0, actualM - startM - Number(subject.grace_minutes || 0));
            ttl = `⚠️ Late Punch In (${lateMin} min late)`;
            body = `${tm} IST • Shift: ${subject.shift_start} • Late minutes monthly tracker mein add ho gaye.`;
          } else {
            ttl = "Punch In ho gaya ✓";
            body = `${(u && u.full_name) || ""} • ${tm} IST`;
          }
        } else {
          if (fresh.status === "half_day") {
            ttl = "⚠️ Half Day mark hua";
            body = `${tm} IST • Working hours kam thi. Manager se baat karo agar gadbad hai.`;
          } else {
            ttl = "Punch Out ho gaya ✓";
            body = `${(u && u.full_name) || ""} • ${tm} IST`;
          }
        }
        notify(db, {
          user_id: subjectId,
          kind: "attendance",
          title: ttl,
          body,
          link: "/#/attendance",
        });
      } catch (e) { console.warn("[realtime] punch broadcast", e.message); }

      // ── Background tasks: geocode (with 1 retry), sheet sync, WhatsApp ──
      const addrField = type === "in" ? "punch_in_address" : "punch_out_address";
      setImmediate(async () => {
        let addr = null;
        try {
          addr = await addressPromise;
        } catch (e1) {
          console.warn(`[geocode] Attempt 1 failed for record ${recId}: ${e1?.message || e1} — retrying in 5s`);
          try {
            await new Promise((r) => setTimeout(r, 5000));
            addr = await reverseGeocode(lat, lng, { timeoutMs: 4000 });
          } catch (e2) {
            console.warn(`[geocode] Attempt 2 failed for record ${recId}: ${e2?.message || e2} — address will remain null`);
          }
        }
        if (addr) {
          try {
            db.prepare(`UPDATE attendance_records SET ${addrField} = ? WHERE id = ?`).run(addr, recId);
          } catch (dbErr) {
            console.warn(`[geocode] DB update failed for record ${recId}: ${dbErr?.message || dbErr}`);
          }
        }
      });
      // NOTE: Apps Script sync is already queued earlier via scheduleAttendanceSync(db, recId).
      // The legacy pushAttendanceToConfiguredSheet() sent a payload missing __tab/__matchKey
      // which the new Apps Script rejects, so we no longer call it here.
      setImmediate(() => {
        const u = db.prepare("SELECT full_name FROM users WHERE id = ?").get(subjectId);
        notifyPunchWhatsApp(db, {
          userId: subjectId,
          type,
          workDate,
          fullName: u && u.full_name,
        }).catch(() => {});
      });
    } catch (e) {
      next(e);
    }
  }

  router.post("/attendance/punch", attachUser, upload.single("photo"), runPunch);

  function normalizePunchMultipartBody(req) {
    const b = req.body || {};
    if (b.lat !== undefined && b.lat !== "") b.lat = Number(b.lat);
    if (b.lng !== undefined && b.lng !== "") b.lng = Number(b.lng);
    if (b.useBranchCenter === "true" || b.useBranchCenter === "1") b.useBranchCenter = true;
    if (typeof b.webAuthn === "string" && b.webAuthn.trim()) {
      try {
        b.webAuthn = JSON.parse(b.webAuthn);
      } catch {
        /* keep string; verify layer will reject */
      }
    }
    if (typeof b.faceDescriptor === "string" && b.faceDescriptor.trim()) {
      try {
        b.faceDescriptor = JSON.parse(b.faceDescriptor);
      } catch {
        /* invalid JSON; match layer rejects */
      }
    }
    req.body = b;
  }

  router.post("/attendance/checkin", attachUser, (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      return upload.single("photo")(req, res, (err) => {
        if (err) return next(err);
        normalizePunchMultipartBody(req);
        req.body.type = "in";
        req.body.source = req.body.source || "device";
        runPunch(req, res, next);
      });
    }
    req.body = { ...(req.body || {}), type: "in", source: (req.body && req.body.source) || "device" };
    runPunch(req, res, next);
  });

  function kioskFaceCandidates(actor) {
    const sc = branchScopeSql(actor, "u");
    return db
      .prepare(
        `SELECT u.id, u.login_id, u.full_name, u.active, p.embedding_json, p.phash
         FROM users u
         JOIN user_face_profiles p ON p.user_id = u.id
         WHERE u.deleted_at IS NULL AND u.active = 1${sc.sql}
         ORDER BY u.id DESC
         LIMIT 500`
      )
      .all(...sc.params);
  }

  router.post("/kiosk/face/register", attachUser, upload.single("photo"), (req, res) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!req.file || req.file.size < 8192) {
      return res.status(400).json({ error: "Live photo file required" });
    }
    const loginId = String(req.body?.login_id || "").trim();
    if (!loginId) return res.status(400).json({ error: "login_id required" });
    let faceDesc = req.body?.faceDescriptor;
    if (typeof faceDesc === "string" && faceDesc.trim()) {
      try {
        faceDesc = JSON.parse(faceDesc);
      } catch {
        return res.status(400).json({ error: "Invalid faceDescriptor payload" });
      }
    }
    const descriptor = parseEmbeddingPayload(faceDesc);
    if (!descriptor) {
      return res.status(400).json({ error: "faceDescriptor required (128-D array)" });
    }
    const userRow = db
      .prepare(
        `SELECT id, login_id, full_name, active FROM users
         WHERE lower(ifnull(login_id,'')) = lower(?) AND deleted_at IS NULL`
      )
      .get(loginId);
    if (!userRow || !userRow.active) return res.status(404).json({ error: "User not found" });
    const scope = assertUserAccess(req.currentUser, userRow);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    let phash;
    try {
      phash = phashFromBuffer(fs.readFileSync(req.file.path));
    } catch (e) {
      return res.status(400).json({ error: "Could not process face image: " + (e.message || String(e)) });
    }
    const rel = `/uploads/attendance/${req.file.filename}`;
    // Kiosk path always stores exactly one descriptor — record it as a
    // single-pose enrollment so admin reports can flag it as "basic".
    db.prepare(
      `INSERT OR REPLACE INTO user_face_profiles (user_id, phash, reference_path, embedding_json, descriptor_count, updated_at)
       VALUES (?,?,?,?,?,datetime('now'))`
    ).run(userRow.id, phash, rel, JSON.stringify(descriptor), 1);
    insertAudit(req.currentUser.id, "kiosk_face_register", "user_face_profiles", String(userRow.id), {});
    return res.json({
      ok: true,
      user_id: userRow.id,
      login_id: userRow.login_id,
      full_name: userRow.full_name,
      reference_path: rel,
    });
  });

  router.post("/kiosk/face/match", attachUser, upload.single("photo"), (req, res) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!req.file || req.file.size < 8192) {
      return res.status(400).json({ error: "Live photo file required" });
    }
    let faceDesc = req.body?.faceDescriptor;
    if (typeof faceDesc === "string" && faceDesc.trim()) {
      try {
        faceDesc = JSON.parse(faceDesc);
      } catch {
        return res.status(400).json({ error: "Invalid faceDescriptor payload" });
      }
    }
    const descriptor = parseEmbeddingPayload(faceDesc);
    if (!descriptor) {
      return res.status(400).json({ error: "faceDescriptor required (128-D array)" });
    }
    const candidates = kioskFaceCandidates(req.currentUser);
    if (!candidates.length) {
      return res.status(404).json({ error: "User not registered", code: "FACE_NOT_REGISTERED" });
    }
    let best = null;
    for (const c of candidates) {
      const m = matchEmbedding(c.embedding_json, descriptor);
      if (!m.ok) continue;
      if (!best || Number(m.distance) < Number(best.distance)) {
        best = { ...c, distance: m.distance, threshold: m.threshold };
      }
    }
    if (!best) {
      return res.status(404).json({ error: "User not registered", code: "FACE_NOT_REGISTERED" });
    }
    return res.json({
      ok: true,
      matched_user_id: best.id,
      login_id: best.login_id,
      full_name: best.full_name,
      distance: best.distance,
      threshold: best.threshold,
    });
  });

  router.post("/attendance/face-punch", attachUser, upload.single("photo"), (req, res, next) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const targetUserId = Number(req.body?.matched_user_id || 0);
    if (!targetUserId) {
      return res.status(400).json({ error: "matched_user_id required" });
    }
    const target = db
      .prepare(
        `SELECT id, login_id, full_name, active FROM users WHERE id = ? AND deleted_at IS NULL`
      )
      .get(targetUserId);
    if (!target || !target.active) return res.status(404).json({ error: "User not found" });
    const day = todayLocalDate();
    const rec = db.prepare("SELECT punch_in_at, punch_out_at FROM attendance_records WHERE user_id = ? AND work_date = ?").get(target.id, day);
    let type = "in";
    if (rec && rec.punch_in_at && !rec.punch_out_at) type = "out";
    else if (rec && rec.punch_in_at && rec.punch_out_at) {
      return res.status(400).json({ error: "Already punched out", code: "ALREADY_COMPLETED" });
    }
    let faceDesc = req.body?.faceDescriptor;
    if (typeof faceDesc === "string" && faceDesc.trim()) {
      try {
        faceDesc = JSON.parse(faceDesc);
      } catch {
        return res.status(400).json({ error: "Invalid faceDescriptor payload" });
      }
    }
    req.body = {
      ...(req.body || {}),
      type,
      source: "kiosk",
      targetUserId: target.id,
      useBranchCenter: true,
      attendanceMethod: "face",
      faceDescriptor: faceDesc,
    };
    return runPunch(req, res, next);
  });

  router.post("/attendance/checkout", attachUser, (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      return upload.single("photo")(req, res, (err) => {
        if (err) return next(err);
        normalizePunchMultipartBody(req);
        req.body.type = "out";
        req.body.source = req.body.source || "device";
        runPunch(req, res, next);
      });
    }
    req.body = { ...(req.body || {}), type: "out", source: (req.body && req.body.source) || "device" };
    runPunch(req, res, next);
  });

  router.post("/kiosk/pin/register", attachUser, (req, res) => {
    if (!can(req.currentUser, "users:update")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const userId = Number(req.body?.userId || 0);
    const pin = String(req.body?.pin || "").trim();
    if (!userId || pin.length < 4 || pin.length > 8) {
      return res.status(400).json({ error: "userId and 4-8 digit pin required" });
    }
    const userRow = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").get(userId);
    if (!userRow) return res.status(404).json({ error: "User not found" });
    const hash = bcrypt.hashSync(pin, 10);
    db.prepare("UPDATE users SET kiosk_pin_hash = ? WHERE id = ?").run(hash, userId);
    insertAudit(req.currentUser.id, "kiosk_pin_register", "user", userId, {});
    res.json({ ok: true });
  });

  router.post("/kiosk/pin/punch", attachUser, (req, res) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const loginId = String(req.body?.login_id || "").trim();
    const pin = String(req.body?.pin || "").trim();
    const type = String(req.body?.type || "").toLowerCase() === "out" ? "out" : "in";
    if (!loginId || !pin) return res.status(400).json({ error: "login_id and pin required" });
    const target = db
      .prepare(
        `SELECT id, login_id, full_name, active, deleted_at, kiosk_pin_hash, allow_manual
         FROM users WHERE lower(ifnull(login_id,'')) = lower(?)`
      )
      .get(loginId);
    if (!target || target.deleted_at || !target.active) return res.status(404).json({ error: "User not found" });
    if (!target.kiosk_pin_hash || !bcrypt.compareSync(pin, target.kiosk_pin_hash)) {
      return res.status(401).json({ error: "Invalid PIN" });
    }
    if (Number(target.allow_manual ?? 1) === 0 && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Attendance disabled for this employee" });
    }
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const rec = db.prepare("SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?").get(target.id, today);
    if (!rec) {
      const punchIn = type === "in" ? now : null;
      const punchOut = type === "out" ? now : null;
      const info = db
        .prepare(
          `INSERT INTO attendance_records
           (user_id, work_date, punch_in_at, punch_out_at, status, source, notes, last_edited_by, punch_method_in, punch_method_out)
           VALUES (?,?,?,?,?,'kiosk',?,?,?,?)`
        )
        .run(
          target.id,
          today,
          punchIn,
          punchOut,
          punchIn ? "present" : "absent",
          "Kiosk PIN punch",
          req.currentUser.id,
          type === "in" ? "pin" : null,
          type === "out" ? "pin" : null
        );
      return res.json({ ok: true, record: db.prepare("SELECT * FROM attendance_records WHERE id = ?").get(info.lastInsertRowid) });
    }
    if (type === "in") {
      if (rec.punch_in_at) return res.status(400).json({ error: "Already punched in" });
      db.prepare(
        `UPDATE attendance_records SET punch_in_at = ?, status = 'present', source = 'kiosk',
         punch_method_in = 'pin', last_edited_by = ?, notes = COALESCE(notes, 'Kiosk PIN punch') WHERE id = ?`
      ).run(now, req.currentUser.id, rec.id);
    } else {
      if (!rec.punch_in_at) return res.status(400).json({ error: "Punch in first" });
      if (rec.punch_out_at) return res.status(400).json({ error: "Already punched out" });
      db.prepare(
        `UPDATE attendance_records SET punch_out_at = ?, source = 'kiosk',
         punch_method_out = 'pin', last_edited_by = ?, notes = COALESCE(notes, 'Kiosk PIN punch') WHERE id = ?`
      ).run(now, req.currentUser.id, rec.id);
      const recomputed = deriveStatusFromHours(rec.punch_in_at, now, rec.status);
      if (recomputed) {
        db.prepare("UPDATE attendance_records SET status = ? WHERE id = ?").run(recomputed, rec.id);
      }
    }
    res.json({ ok: true, record: db.prepare("SELECT * FROM attendance_records WHERE id = ?").get(rec.id) });
  });

  // ── Kiosk: search employees by name or login_id ─────────────────────────
  router.get("/kiosk/search", attachUser, (req, res) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const q = String(req.query.q || "").trim();
    if (!q || q.length < 1) return res.json({ employees: [] });
    const today = new Date().toISOString().slice(0, 10);
    const pattern = `%${q}%`;
    const rows = db
      .prepare(
        `SELECT u.id, u.full_name, u.login_id, u.branch_id,
                ar.punch_in_at, ar.punch_out_at, ar.status as att_status
         FROM users u
         LEFT JOIN attendance_records ar ON ar.user_id = u.id AND ar.work_date = ?
         WHERE u.active = 1 AND u.deleted_at IS NULL
           AND (u.full_name LIKE ? COLLATE NOCASE OR u.login_id LIKE ? COLLATE NOCASE)
         ORDER BY u.full_name LIMIT 10`
      )
      .all(today, pattern, pattern);
    return res.json({ employees: rows });
  });

  // ── Kiosk: validate PIN and return today status ──────────────────────────
  router.get("/kiosk/pin/status", attachUser, (req, res) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const loginId = String(req.query.login_id || "").trim();
    const pin = String(req.query.pin || "").trim();
    if (!loginId || !pin) return res.status(400).json({ error: "login_id and pin required" });
    const target = db
      .prepare(
        `SELECT id, full_name, login_id, active, deleted_at, kiosk_pin_hash
         FROM users WHERE lower(ifnull(login_id,'')) = lower(?) AND active = 1 AND deleted_at IS NULL`
      )
      .get(loginId);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    if (!target.kiosk_pin_hash || !bcrypt.compareSync(pin, target.kiosk_pin_hash)) {
      return res.status(401).json({ error: "Invalid PIN" });
    }
    const today = new Date().toISOString().slice(0, 10);
    const rec = db
      .prepare("SELECT punch_in_at, punch_out_at, status FROM attendance_records WHERE user_id = ? AND work_date = ?")
      .get(target.id, today);
    return res.json({
      id: target.id,
      full_name: target.full_name,
      login_id: target.login_id,
      punch_in_at: rec?.punch_in_at ?? null,
      punch_out_at: rec?.punch_out_at ?? null,
      att_status: rec?.status ?? null,
    });
  });

  // ── Kiosk: search-punch (mark IN/OUT for selected employee) ─────────────
  router.post("/kiosk/search/punch", attachUser, (req, res) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const employee_id = Number(req.body?.employee_id || 0);
    const type = String(req.body?.type || "").toLowerCase() === "out" ? "out" : "in";
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });
    const target = db
      .prepare("SELECT id, full_name, login_id FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL")
      .get(employee_id);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const rec = db
      .prepare("SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?")
      .get(target.id, today);
    if (!rec) {
      if (type === "out") return res.status(400).json({ error: "Punch in first" });
      const info = db
        .prepare(
          `INSERT INTO attendance_records
           (user_id, work_date, punch_in_at, status, source, notes, last_edited_by, punch_method_in)
           VALUES (?,?,?,'present','kiosk',?,?,?)`
        )
        .run(target.id, today, now, "Kiosk search punch", req.currentUser.id, "search_kiosk");
      insertAudit(req.currentUser.id, "kiosk_search_punch_in", "attendance", info.lastInsertRowid, {
        employee_id: target.id, employee: target.login_id, actor: req.currentUser.login_id,
      });
      return res.json({ ok: true, full_name: target.full_name });
    }
    if (type === "in") {
      if (rec.punch_in_at) return res.status(400).json({ error: "Already punched in today" });
      db.prepare(
        `UPDATE attendance_records SET punch_in_at = ?, status = 'present', source = 'kiosk',
         punch_method_in = 'search_kiosk', last_edited_by = ? WHERE id = ?`
      ).run(now, req.currentUser.id, rec.id);
      insertAudit(req.currentUser.id, "kiosk_search_punch_in", "attendance", rec.id, {
        employee_id: target.id, employee: target.login_id, actor: req.currentUser.login_id,
      });
    } else {
      if (!rec.punch_in_at) return res.status(400).json({ error: "Punch in first" });
      if (rec.punch_out_at) return res.status(400).json({ error: "Already punched out today" });
      db.prepare(
        `UPDATE attendance_records SET punch_out_at = ?, source = 'kiosk',
         punch_method_out = 'search_kiosk', last_edited_by = ? WHERE id = ?`
      ).run(now, req.currentUser.id, rec.id);
      const recomputed = deriveStatusFromHours(rec.punch_in_at, now, rec.status);
      if (recomputed) {
        db.prepare("UPDATE attendance_records SET status = ? WHERE id = ?").run(recomputed, rec.id);
      }
      insertAudit(req.currentUser.id, "kiosk_search_punch_out", "attendance", rec.id, {
        employee_id: target.id, employee: target.login_id, actor: req.currentUser.login_id,
      });
    }
    return res.json({ ok: true, full_name: target.full_name });
  });

  // ── QR Kiosk token store (in-memory, 15s TTL) ────────────────────────────
  const kioskQrTokens = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 120000;
    for (const [t, d] of kioskQrTokens.entries()) {
      if (d.expiresAt < cutoff) kioskQrTokens.delete(t);
    }
  }, 60000);

  // GET /kiosk/qr/token — generate a fresh 15-second QR token
  router.get("/kiosk/qr/token", attachUser, (req, res) => {
    if (!can(req.currentUser, "attendance:kiosk")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = Date.now() + 15000;
    kioskQrTokens.set(token, {
      expiresAt,
      used: false,
      branchId: req.currentUser.branch_id,
      generatedBy: req.currentUser.id,
    });
    return res.json({ token, expires_at: expiresAt, branch_id: req.currentUser.branch_id });
  });

  /**
   * GET /work-hours/monthly?user_id=&year=&month=
   * Returns required vs actual worked hours for the calendar month (IST).
   * - user_id defaults to self; only Super Admin / Admin / Attendance Manager
   *   may query for other users.
   * - required = (working days in month − approved leave days) × shift hours
   * - actual   = sum of (punch_out_at − punch_in_at) for completed punches
   *              (records without punch_out are skipped)
   * - shortfall = max(required − actual, 0)
   */
  router.get("/work-hours/monthly", attachUser, (req, res) => {
    try {
      const me = req.currentUser;
      const targetUserId = req.query.user_id ? Number(req.query.user_id) : me.id;
      if (targetUserId !== me.id) {
        const chk = assertUserIdAccess(db, me, targetUserId);
        if (!chk.ok) return res.status(chk.status || 403).json({ error: chk.error || "Forbidden" });
      }
      const u = db.prepare(
        "SELECT id, full_name, shift_start, shift_end FROM users WHERE id = ? AND deleted_at IS NULL"
      ).get(targetUserId);
      if (!u) return res.status(404).json({ error: "User not found" });

      // IST today
      const istNow = new Date(Date.now() + 5.5 * 3600000);
      const year  = Number(req.query.year)  || istNow.getUTCFullYear();
      const month = Number(req.query.month) || (istNow.getUTCMonth() + 1);
      if (month < 1 || month > 12) return res.status(400).json({ error: "Invalid month" });
      const monthStr = `${year}-${String(month).padStart(2, "0")}`;
      const lastDay  = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const isCurrentMonth = year === istNow.getUTCFullYear() && month === (istNow.getUTCMonth() + 1);
      const istDay = istNow.getUTCDate();

      // Shift duration (hours)
      const [sh, sm] = String(u.shift_start || "09:00").split(":").map(Number);
      const [eh, em] = String(u.shift_end   || "18:00").split(":").map(Number);
      let shiftHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
      if (!Number.isFinite(shiftHours) || shiftHours <= 0) shiftHours = 9;

      // Working days = all days in month minus Sundays (no Saturday rule yet —
      // most Prakriti branches operate 6-day weeks).
      let workingDays = 0;
      const upToDay = isCurrentMonth ? istDay : lastDay;
      for (let d = 1; d <= upToDay; d++) {
        const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
        if (dow !== 0) workingDays++;  // exclude Sunday
      }

      // Approved leave days that overlap this month — deduplicate by date
      // (overlapping leave requests must not be double-counted).
      const leaveDateSet = new Set();
      try {
        const leaveRows = db.prepare(
          `SELECT start_date AS from_date, end_date AS to_date FROM leave_requests
           WHERE user_id = ?
             AND UPPER(final_status) = 'APPROVED'
             AND date(start_date) <= date(?)
             AND date(end_date)   >= date(?)`
        ).all(
          targetUserId,
          `${monthStr}-${String(lastDay).padStart(2, "0")}`,
          `${monthStr}-01`
        );
        for (const lr of leaveRows) {
          const a = new Date(lr.from_date + "T00:00:00Z");
          const b = new Date(lr.to_date   + "T00:00:00Z");
          for (let cur = new Date(a); cur <= b; cur = new Date(cur.getTime() + 86400000)) {
            const y = cur.getUTCFullYear(), m = cur.getUTCMonth() + 1, d = cur.getUTCDate();
            if (y !== year || m !== month) continue;
            if (isCurrentMonth && d > istDay) continue;
            if (cur.getUTCDay() === 0) continue;  // Sunday already excluded from working days
            leaveDateSet.add(`${y}-${m}-${d}`);
          }
        }
      } catch (_) { /* leave table absent → leaveDateSet stays empty */ }
      const leaveDays = leaveDateSet.size;

      const requiredDays  = Math.max(workingDays - leaveDays, 0);
      const requiredHours = +(requiredDays * shiftHours).toFixed(2);

      // Actual worked hours = SUM of (punch_out − punch_in) for completed punches
      const rows = db.prepare(
        `SELECT punch_in_at, punch_out_at
         FROM attendance_records
         WHERE user_id = ?
           AND substr(work_date,1,7) = ?
           AND punch_in_at IS NOT NULL
           AND punch_out_at IS NOT NULL`
      ).all(targetUserId, monthStr);

      let actualMs = 0;
      let presentDays = 0;
      let lateDays = 0;
      for (const r of rows) {
        const t0 = new Date(r.punch_in_at).getTime();
        const t1 = new Date(r.punch_out_at).getTime();
        if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
          actualMs += (t1 - t0);
        }
      }
      const statusRows = db.prepare(
        `SELECT status FROM attendance_records
         WHERE user_id = ? AND substr(work_date,1,7) = ?`
      ).all(targetUserId, monthStr);
      for (const r of statusRows) {
        if (r.status === "present" || r.status === "late") presentDays++;
        if (r.status === "late") lateDays++;
      }

      const actualHours   = +((actualMs / 3600000).toFixed(2));
      const shortfallHours = +Math.max(requiredHours - actualHours, 0).toFixed(2);
      const onTrackPct = requiredHours > 0
        ? Math.min(100, Math.round((actualHours / requiredHours) * 100))
        : 100;

      res.json({
        user_id: targetUserId,
        full_name: u.full_name,
        period: monthStr,
        as_of_date: isCurrentMonth ? istNow.toISOString().slice(0, 10) : `${monthStr}-${String(lastDay).padStart(2, "0")}`,
        shift_start: u.shift_start,
        shift_end: u.shift_end,
        shift_hours_per_day: +shiftHours.toFixed(2),
        working_days: workingDays,
        leave_days: leaveDays,
        required_days: requiredDays,
        required_hours: requiredHours,
        actual_hours: actualHours,
        shortfall_hours: shortfallHours,
        on_track_pct: onTrackPct,
        present_days: presentDays,
        late_days: lateDays,
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "work-hours failed" });
    }
  });

  // GET /attendance/my-today — current user's today punch status
  router.get("/attendance/my-today", attachUser, (req, res) => {
    const uid = req.currentUser.id;
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `my-today:${uid}:${today}`;
    const cached = ttlGet(cacheKey);
    if (cached) return res.json(cached);
    const rec = db
      .prepare("SELECT punch_in_at, punch_out_at, status FROM attendance_records WHERE user_id = ? AND work_date = ?")
      .get(uid, today);
    const payload = {
      punch_in_at: rec?.punch_in_at ?? null,
      punch_out_at: rec?.punch_out_at ?? null,
      status: rec?.status ?? null,
    };
    ttlSet(cacheKey, payload, 8000);
    return res.json(payload);
  });

  // POST /kiosk/qr/scan — employee scans QR from mobile
  router.post("/kiosk/qr/scan", attachUser, async (req, res, next) => {
    if (!can(req.currentUser, "attendance:punch")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { token, lat, lng, accuracy, type } = req.body || {};
    if (!token) return res.status(400).json({ error: "QR token required" });

    // Validate token
    const session = kioskQrTokens.get(token);
    if (!session) return res.status(400).json({ error: "QR code invalid or already expired. Ask office to show a fresh QR." });
    if (Date.now() > session.expiresAt) {
      kioskQrTokens.delete(token);
      return res.status(400).json({ error: "QR code has expired (15 seconds). Ask office to refresh." });
    }
    if (session.used) {
      return res.status(400).json({ error: "यह QR code पहले ही use हो चुका है। नया QR scan करें।" });
    }

    // GPS is OPTIONAL for QR — admin's QR is the proof of presence.
    // If lat/lng sent, we'll record them; if not, we use branch center as location.
    const latN = lat != null && lat !== "" ? Number(lat) : null;
    const lngN = lng != null && lng !== "" ? Number(lng) : null;

    // Mark token as used immediately to prevent race-condition reuse
    session.used = true;

    // Determine punch type
    const punchType = String(type || "").toLowerCase() === "out" ? "out" : "in";

    // Inject into req.body so runPunch can read it.
    // useBranchCenter=true so runPunch substitutes branch center if no GPS provided.
    req.body = {
      type: punchType,
      lat: latN,
      lng: lngN,
      source: "qr_kiosk",
      attendanceMethod: "qr_kiosk",
      useBranchCenter: latN == null || lngN == null,
    };

    // Delegate to runPunch (handles geo-fence, duplicate checks, audit, etc.)
    return runPunch(req, res, next);
  });

  router.post(
    "/attendance/kiosk-face",
    attachUser,
    upload.single("photo"),
    (req, res) => {
      if (!can(req.currentUser, "attendance:kiosk")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const af = req.currentUser.allow_face !== undefined ? Number(req.currentUser.allow_face) : 0;
      const ab = req.currentUser.allow_biometric !== undefined ? Number(req.currentUser.allow_biometric) : 0;
      if (af === 0 && ab === 0) {
        raiseHrAlert({
          type: "unauthorized_mode",
          severity: "warning",
          message: `Kiosk face/biometric blocked for user #${req.currentUser.id}`,
          userId: req.currentUser.id,
          actorId: req.currentUser.id,
          meta: { mode: "face_kiosk" },
        });
        return res.status(403).json({ error: "Face / biometric capture disabled for this account" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Live photo (selfie) file required" });
      }
      if (req.file.size < 8192) {
        return res.status(400).json({ error: "Photo too small — use a real camera capture (min 8KB)" });
      }
      const url = `/uploads/attendance/${req.file.filename}`;
      res.json({
        ok: true,
        stored: url,
        message:
          "Face match not enabled. Image stored for audit / future biometric integration.",
      });
    }
  );

  router.post("/attendance/face-placeholder", attachUser, (req, res) => {
    if (!can(req.currentUser, "attendance:face_placeholder")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.status(501).json({
      ok: false,
      message: "Face recognition integration pending. Use punch with GPS or manual entry.",
    });
  });

  // ── Reverse sync helper: shared upsert used by route + bulk pull ─────────
  // Returns { ok, status, body } where status is HTTP code and body is the
  // JSON body to send (or to aggregate). Pure function — does not write to res.
  function upsertAttendanceFromSheetRow(payload) {
    const { unique_key, status, punch_in, punch_out, notes } = payload || {};
    if (!unique_key || typeof unique_key !== "string") {
      return { ok: false, status: 400, body: { error: "unique_key required" } };
    }
    const m = unique_key.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
    if (!m) return { ok: false, status: 400, body: { error: "unique_key must be <login_id>_<YYYY-MM-DD>" } };
    const loginId = m[1], workDate = m[2];

    const user = db.prepare("SELECT id FROM users WHERE login_id = ? AND deleted_at IS NULL").get(loginId);
    if (!user) return { ok: false, status: 404, body: { error: `User not found: ${loginId}` } };

    function toIso(hhmm, label) {
      if (hhmm === undefined || hhmm === null || hhmm === "") return { iso: null };
      const t = String(hhmm).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!t) return { error: `${label} must be HH:MM (got "${hhmm}")` };
      const istMs = Date.parse(workDate + "T00:00:00Z") - 5.5 * 3600 * 1000
                  + (Number(t[1]) * 60 + Number(t[2])) * 60 * 1000;
      return { iso: new Date(istMs).toISOString() };
    }
    const pi = toIso(punch_in, "punch_in");
    const po = toIso(punch_out, "punch_out");
    if (pi.error) return { ok: false, status: 400, body: { error: pi.error } };
    if (po.error) return { ok: false, status: 400, body: { error: po.error } };

    const existing = db.prepare(
      "SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?"
    ).get(user.id, workDate);

    const finalStatus = status ? String(status) : (existing?.status || "present");
    let recId;
    if (existing) {
      db.prepare(
        `UPDATE attendance_records
         SET punch_in_at = COALESCE(?, punch_in_at),
             punch_out_at = COALESCE(?, punch_out_at),
             status = ?,
             notes = COALESCE(?, notes),
             source = 'sheet_sync',
             last_edited_by = NULL
         WHERE id = ?`
      ).run(pi.iso, po.iso, finalStatus, notes || null, existing.id);
      recId = existing.id;
    } else {
      const info = db.prepare(
        `INSERT INTO attendance_records
           (user_id, work_date, punch_in_at, punch_out_at, status, notes, source, last_edited_by)
         VALUES (?,?,?,?,?,?, 'sheet_sync', NULL)`
      ).run(user.id, workDate, pi.iso, po.iso, finalStatus, notes || null);
      recId = info.lastInsertRowid;
    }
    try { insertAudit(null, "attendance_sheet_sync", "attendance", recId, { unique_key, status: finalStatus }); } catch {}
    return { ok: true, status: 200, body: { ok: true, id: recId, action: existing ? "update" : "insert" } };
  }

  // ── Reverse sync: Google Sheet → HRMS ────────────────────────────────────
  // Receives upserts from the Apps Script onEdit trigger.
  // Auth: shared secret in `x-sheet-sync-secret` header (env: SHEET_SYNC_SECRET).
  // Body: { unique_key, status?, punch_in?, punch_out?, notes? }
  router.post("/attendance/sheet-sync", (req, res) => {
    try {
      const secret = String(process.env.SHEET_SYNC_SECRET || "");
      if (!secret) return res.status(503).json({ error: "SHEET_SYNC_SECRET not configured" });
      const got = String(req.headers["x-sheet-sync-secret"] || "");
      if (got !== secret) return res.status(401).json({ error: "Invalid secret" });

      // ── Kill switch: Sheet → Portal direction is OFF by default after the
      // one-time backfill. Admin must explicitly enable it in Settings.
      const cfg = readSheetIntegration();
      if (!cfg.sheet_to_portal_enabled) {
        return res.status(403).json({
          ok: false,
          error: "Sheet → Portal sync is disabled. Enable it in HRMS Settings → Sheet Integration if you want Sheet edits to flow back to the portal.",
          disabled: true,
        });
      }

      const result = upsertAttendanceFromSheetRow(req.body || {});
      // NOTE: do NOT call appsScriptScheduleAttendance here — would create a sync loop.
      return res.status(result.status).json(result.body);
    } catch (e) {
      console.error("[sheet-sync]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── One-click bulk PULL: Sheet → HRMS ────────────────────────────────────
  // Server fetches every Attendance row from the connected Apps Script Web App
  // and upserts each row using the same logic as /attendance/sheet-sync.
  // The Apps Script must support the {__cmd: "fetch_attendance"} doPost command
  // (added in google-apps-script/hrms_sync.gs). Auth: SHEET_SYNC_SECRET.
  // ── Shared core: pull rows from Sheet via Apps Script and upsert into HRMS.
  // Used by both the manual /pull-from-sheet endpoint AND the background
  // poll worker. Returns { status, body } — caller writes to res or logs.
  // Does NOT enforce the FULL-backfill arm latch when isAutoPoll=true (the
  // poll always runs scoped to a date window, so it's intrinsically safe).
  async function runSheetPullCore({ fromDate = "", toDate = "", isAutoPoll = false, actorId = null } = {}) {
    const isRangeBackfill = !!(fromDate && toDate);
    if (fromDate && toDate && fromDate > toDate) {
      return { status: 400, body: { ok: false, error: "from date must be on/before to date" } };
    }
    const armCfg = readSheetIntegration();
    if (!armCfg.sheet_to_portal_enabled) {
      return {
        status: 403,
        body: {
          ok: false,
          error: "Sheet → Portal sync is disabled. Open HRMS Settings → Sheet Integration → turn ON 'Allow Sheet → Portal sync' first.",
          disabled: true,
        },
      };
    }
    if (!isAutoPoll && !isRangeBackfill && !armCfg.backfill_armed) {
      return {
        status: 403,
        body: {
          ok: false,
          error: "Full backfill not armed. Either pick a from/to date range (no arming needed) or click 'Arm Backfill' for an unscoped re-import.",
          notArmed: true,
        },
      };
    }
    // For full backfill from the UI: consume the arm flag (atomic one-shot).
    // For date-range OR auto-poll: leave arm flag untouched.
    if (!isAutoPoll) {
      writeSheetIntegration({
        ...armCfg,
        backfill_armed: isRangeBackfill ? armCfg.backfill_armed : false,
        backfill_armed_at: isRangeBackfill ? armCfg.backfill_armed_at : "",
        backfill_armed_by: isRangeBackfill ? armCfg.backfill_armed_by : "",
        last_backfill_at: new Date().toISOString(),
      });
    }
    const secret = String(process.env.SHEET_SYNC_SECRET || "");
    if (!secret) {
      return { status: 503, body: { ok: false, error: "SHEET_SYNC_SECRET env var not configured on the server.", disarmed: true } };
    }
    primeAppsScriptEnvFromConfig(readSheetIntegration());
    const url = String(process.env.GOOGLE_APPS_SCRIPT_WEBAPP_URL || "").trim();
    if (!url) {
      return { status: 400, body: { ok: false, error: "Apps Script Web App URL not configured. Open Settings → Connect Google Sheet." } };
    }
    let fetchResp;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      fetchResp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ __cmd: "fetch_attendance", __secret: secret, from_date: fromDate, to_date: toDate }),
        redirect: "follow",
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e?.name === "AbortError";
      return {
        status: aborted ? 504 : 502,
        body: {
          ok: false,
          error: aborted
            ? "Apps Script took longer than 90 seconds to respond — please re-deploy with the latest Advanced code, or contact admin."
            : `Could not reach Apps Script: ${e.message}`,
          urlInvalid: false,
        },
      };
    }
    clearTimeout(timer);
    const text = await fetchResp.text();
    const isDrive404 = /Page not found/i.test(text) && /<html/i.test(text) && fetchResp.status >= 400;
    let data;
    try { data = JSON.parse(text); } catch {
      return {
        status: 502,
        body: {
          ok: false,
          urlInvalid: isDrive404,
          error: isDrive404
            ? "❌ Apps Script Web App URL is invalid or expired (Google returned a 404 page). Open the Apps Script project, click Deploy → Manage deployments → New deployment, copy the new /exec URL, and paste it back into 'Edit Connection'."
            : `Apps Script returned non-JSON (HTTP ${fetchResp.status}). First 300 chars: ${text.slice(0, 300)}`,
        },
      };
    }
    if (!fetchResp.ok || data?.ok === false) {
      return {
        status: 502,
        body: {
          ok: false,
          error: data?.error || `Apps Script HTTP ${fetchResp.status}`,
          hint: data?.error?.includes?.("__cmd") || /Unknown command/i.test(data?.error || "")
            ? "Your Apps Script is an older version — please re-paste the latest Advanced script (Settings → 📋 Copy Code) and re-deploy."
            : data?.error?.includes?.("__secret") || /forbidden|secret|auth/i.test(data?.error || "")
            ? "SHEET_SYNC_SECRET mismatch — copy the secret value from HRMS server env and update SHEET_SYNC_SECRET in Apps Script → Project Settings → Script Properties."
            : undefined,
        },
      };
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    let inserted = 0, updated = 0, failed = 0, skipped = 0, skippedDeleted = 0;
    const errors = [];
    const skippedUsers = new Set();
    for (const row of rows) {
      const uk = row && row.unique_key ? String(row.unique_key).trim() : "";
      const empId = row && row.employee_id ? String(row.employee_id).trim() : "";
      const dt = row && row.date ? String(row.date).trim() : "";
      if (!uk || !empId || !dt) { skipped++; continue; }
      const r = upsertAttendanceFromSheetRow({
        unique_key: uk,
        status: row.status,
        punch_in: row.punch_in,
        punch_out: row.punch_out,
        notes: row.notes,
      });
      if (r.ok) {
        if (r.body.action === "insert") inserted++;
        else updated++;
      } else if (r.status === 404 && /User not found/i.test(String(r.body?.error || ""))) {
        skipped++; skippedDeleted++;
        const m = String(r.body.error).match(/User not found:\s*(\S+)/);
        if (m) skippedUsers.add(m[1]);
      } else {
        failed++;
        if (errors.length < 25) errors.push({ unique_key: uk, status: r.status, error: r.body?.error });
      }
    }
    try {
      insertAudit(actorId, isAutoPoll ? "sheet_auto_pull" : "sheet_backfill_run", "settings", "sheet_integration", {
        total: rows.length, inserted, updated, skipped, failed, auto: isAutoPoll,
      });
    } catch {}
    return {
      status: 200,
      body: {
        ok: true,
        total: rows.length,
        inserted, updated, failed, skipped,
        skippedDeleted,
        skippedDeletedUsers: skippedUsers.size ? Array.from(skippedUsers).slice(0, 30) : undefined,
        errors: errors.length ? errors : undefined,
        scoped: isRangeBackfill,
        from: fromDate || undefined,
        to: toDate || undefined,
        disarmed: !isAutoPoll && !isRangeBackfill,
        auto: isAutoPoll || undefined,
      },
    };
  }

  // ── Background auto-poll: pulls last 7 days of Sheet attendance every
  // 5 minutes, replacing the need for Apps Script's onSheetEdit trigger
  // (which would require the user to grant `script.external_request` OAuth
  // scope manually — Google does not allow servers to grant scopes on
  // behalf of users). Polling means Apps Script only needs the spreadsheet
  // scope (auto-granted on first run), so zero manual authorization needed.
  let _sheetPullWorkerHandle = null;
  let _sheetPullInflight = false;
  let _lastSheetPullResult = null; // { at, ok, summary, error }
  async function runAutoSheetPullOnce() {
    if (_sheetPullInflight) return;
    _sheetPullInflight = true;
    try {
      const cfg = readSheetIntegration();
      if (!cfg?.enabled || !cfg?.default_webhook_url || !cfg?.sheet_to_portal_enabled) {
        return; // silently skip — not configured / not enabled
      }
      // Window: today and the previous 6 days (handles late edits / holidays).
      const tz = "Asia/Kolkata";
      const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
      const isoDay = (d) => d.toISOString().slice(0, 10);
      const to = isoDay(nowIst);
      const fromDt = new Date(nowIst.getTime() - 6 * 86400 * 1000);
      const from = isoDay(fromDt);
      const r = await runSheetPullCore({ fromDate: from, toDate: to, isAutoPoll: true, actorId: null });
      const ok = r.status === 200 && r.body?.ok !== false;
      const b = r.body || {};
      _lastSheetPullResult = {
        at: new Date().toISOString(),
        ok,
        summary: ok
          ? `pulled ${b.total || 0} (ins=${b.inserted || 0}, upd=${b.updated || 0}, skip=${b.skipped || 0}, fail=${b.failed || 0})`
          : null,
        error: ok ? null : (b.error || `HTTP ${r.status}`),
        from, to,
      };
      if (!ok) {
        console.warn("[sheet-pull-worker]", _lastSheetPullResult.error);
      }
    } catch (e) {
      _lastSheetPullResult = { at: new Date().toISOString(), ok: false, error: String(e.message || e) };
      console.error("[sheet-pull-worker] crashed:", e.message);
    } finally {
      _sheetPullInflight = false;
    }
  }
  function startSheetPullWorker({ intervalMs = 5 * 60 * 1000 } = {}) {
    if (_sheetPullWorkerHandle) return;
    _sheetPullWorkerHandle = setInterval(() => { runAutoSheetPullOnce().catch(() => {}); }, intervalMs);
    setTimeout(() => { runAutoSheetPullOnce().catch(() => {}); }, 15_000);
    console.log("[sheet-pull-worker] started — polling every", Math.round(intervalMs / 1000), "s");
  }
  // Expose for /apps-script/status to surface freshness.
  router._getLastSheetPullResult = () => _lastSheetPullResult;
  // Kick the worker on boot — runs only when sheet_to_portal_enabled is true.
  try { startSheetPullWorker({ intervalMs: 5 * 60 * 1000 }); }
  catch (e) { console.error("[sheet-pull-worker] start failed:", e.message); }

  // ── Daily absent-push worker ─────────────────────────────────────────────
  // Live punches enqueue Attendance rows immediately via scheduleAttendanceSync.
  // But employees who DON'T punch leave a gap — sheet has no row for them.
  // This worker runs every 30 min and, if today's IST clock has crossed the
  // configured "absent push hour" (default 23:30 IST), pushes synthetic
  // "absent" rows for every active user with no attendance record for today.
  // Idempotent: Apps Script upserts by unique_key, so repeat runs are safe.
  let _absentPushWorkerHandle = null;
  let _absentPushInflight = false;
  let _lastAbsentPushResult = null; // { at, ok, date, count, error }
  let _lastAbsentPushDate = null;   // YYYY-MM-DD already pushed for "today"
  function istNow() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
  function istIsoDay(d) { return d.toISOString().slice(0, 10); }
  async function runAbsentPushOnce({ force = false, date = null } = {}) {
    if (_absentPushInflight) return { skipped: true, reason: "inflight" };
    _absentPushInflight = true;
    try {
      const cfg = readSheetIntegration();
      if (!cfg?.enabled || !cfg?.default_webhook_url) {
        return { skipped: true, reason: "disabled" };
      }
      const nowIst = istNow();
      const todayIst = istIsoDay(nowIst);
      const targetDate = date || todayIst;
      // Throttle: don't push the same date more than once per day unless forced.
      if (!force && _lastAbsentPushDate === targetDate) {
        return { skipped: true, reason: "already_pushed_today", date: targetDate };
      }
      // Time gate: by default only run after 23:30 IST so employees who punch
      // late still get counted as present. Override with `force=true`.
      const istHour = nowIst.getUTCHours(); // istNow() is already +5:30 shifted
      const istMin = nowIst.getUTCMinutes();
      const istMinutes = istHour * 60 + istMin;
      if (!force && date == null && istMinutes < 23 * 60 + 30) {
        return { skipped: true, reason: "before_push_hour", istMinutes };
      }
      const r = await appsScriptPushAbsentsToSheet(db, targetDate);
      _lastAbsentPushResult = {
        at: new Date().toISOString(),
        ok: r?.ok !== false && !r?.skipped,
        date: r?.date || targetDate,
        count: r?.absent ?? 0,
        skipped: !!r?.skipped,
        reason: r?.reason || null,
        error: r?.ok === false ? (r?.message || "push failed") : null,
      };
      if (_lastAbsentPushResult.ok) _lastAbsentPushDate = targetDate;
      return _lastAbsentPushResult;
    } catch (e) {
      _lastAbsentPushResult = {
        at: new Date().toISOString(), ok: false, error: String(e.message || e),
      };
      console.error("[absent-push-worker] crashed:", e.message);
      return _lastAbsentPushResult;
    } finally {
      _absentPushInflight = false;
    }
  }
  function startAbsentPushWorker({ intervalMs = 30 * 60 * 1000 } = {}) {
    if (_absentPushWorkerHandle) return;
    _absentPushWorkerHandle = setInterval(() => {
      runAbsentPushOnce().catch(() => {});
    }, intervalMs);
    console.log("[absent-push-worker] started — checking every", Math.round(intervalMs / 60000), "min (push hour: 23:30 IST)");
  }
  router._getLastAbsentPushResult = () => _lastAbsentPushResult;
  try { startAbsentPushWorker({ intervalMs: 30 * 60 * 1000 }); }
  catch (e) { console.error("[absent-push-worker] start failed:", e.message); }

  router.post("/integrations/apps-script/push-absents", attachUser, async (req, res) => {
    try {
      if (!can(req.currentUser, "integrations:sync")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const date = dateRe.test(String(req.body?.date || "")) ? String(req.body.date) : null;
      const r = await runAbsentPushOnce({ force: true, date });
      return res.json(r || { ok: false, error: "no result" });
    } catch (e) {
      console.error("[push-absents]", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post("/integrations/apps-script/pull-from-sheet", attachUser, async (req, res) => {
    try {
      if (!can(req.currentUser, "integrations:sync")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const fromDate = dateRe.test(String(req.body?.from || "")) ? String(req.body.from) : "";
      const toDate   = dateRe.test(String(req.body?.to   || "")) ? String(req.body.to)   : "";
      const r = await runSheetPullCore({
        fromDate, toDate, isAutoPoll: false, actorId: req.currentUser.id,
      });
      return res.status(r.status).json(r.body);
    } catch (e) {
      console.error("[pull-from-sheet]", e);
      return res.status(500).json({ ok: false, error: e.message, disarmed: true });
    }
  });


  router.post("/attendance/manual", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "attendance:manual")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const {
      userId,
      workDate,
      status,
      punchInAt,
      punchOutAt,
      notes,
      halfPeriod,
    } = req.body || {};
    if (!userId || !workDate || !status) {
      return res.status(400).json({ error: "userId, workDate, status required" });
    }
    const subject = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(Number(userId));
    if (!subject) return res.status(404).json({ error: "User not found" });
    const scopeMan = assertUserAccess(actor, subject);
    if (!scopeMan.ok) return res.status(scopeMan.status).json({ error: scopeMan.error });
    const am = subject.allow_manual !== undefined ? Number(subject.allow_manual) : 1;
    if (actor.role !== ROLES.SUPER_ADMIN && am === 0) {
      return res.status(403).json({ error: "Manual attendance disabled for this employee" });
    }

    const existing = db
      .prepare("SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?")
      .get(Number(userId), String(workDate));

    if (existing) {
      db.prepare(
        `UPDATE attendance_records
         SET punch_in_at = ?, punch_out_at = ?, status = ?, half_period = ?, notes = ?, source = 'manual', last_edited_by = ?
         WHERE id = ?`
      ).run(
        punchInAt || null,
        punchOutAt || null,
        String(status),
        halfPeriod || null,
        notes || null,
        actor.id,
        existing.id
      );
      const rec = db.prepare("SELECT * FROM attendance_records WHERE id = ?").get(existing.id);
      insertAudit(actor.id, "attendance_manual", "attendance", existing.id, { work_date: workDate });
      scheduleAttendanceSync(db, existing.id);
      appsScriptScheduleAttendance(db, existing.id);
      return res.json({ record: rec });
    }

    const info = db
      .prepare(
        `INSERT INTO attendance_records
         (user_id, work_date, punch_in_at, punch_out_at, status, half_period, notes, source, last_edited_by)
         VALUES (?,?,?,?,?,?,?,'manual',?)`
      )
      .run(
        Number(userId),
        String(workDate),
        punchInAt || null,
        punchOutAt || null,
        String(status),
        halfPeriod || null,
        notes || null,
        actor.id
      );
    const rec = db.prepare("SELECT * FROM attendance_records WHERE id = ?").get(info.lastInsertRowid);
    insertAudit(actor.id, "attendance_manual", "attendance", info.lastInsertRowid, { work_date: workDate });
    scheduleAttendanceSync(db, info.lastInsertRowid);
    appsScriptScheduleAttendance(db, info.lastInsertRowid);
    res.json({ record: rec });
  });

  router.patch("/attendance/:id([0-9]+)", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "attendance:edit_any") && !can(actor, "history:edit")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const rec = db.prepare("SELECT * FROM attendance_records WHERE id = ?").get(id);
    if (!rec) return res.status(404).json({ error: "Not found" });
    const subjRow = db
      .prepare(`SELECT id, branch_id, role FROM users WHERE id = ? AND deleted_at IS NULL`)
      .get(rec.user_id);
    const scopeEd = assertUserAccess(actor, subjRow);
    if (!scopeEd.ok) return res.status(scopeEd.status).json({ error: scopeEd.error });

    const {
      status,
      punchInAt,
      punchOutAt,
      halfPeriod,
      notes,
      workDate,
    } = req.body || {};
    db.prepare(
      `UPDATE attendance_records
       SET status = COALESCE(?, status),
           punch_in_at = COALESCE(?, punch_in_at),
           punch_out_at = COALESCE(?, punch_out_at),
           half_period = COALESCE(?, half_period),
           notes = COALESCE(?, notes),
           work_date = COALESCE(?, work_date),
           last_edited_by = ?
       WHERE id = ?`
    ).run(
      status || null,
      punchInAt !== undefined ? punchInAt : null,
      punchOutAt !== undefined ? punchOutAt : null,
      halfPeriod !== undefined ? halfPeriod : null,
      notes !== undefined ? notes : null,
      workDate || null,
      actor.id,
      id
    );
    const updated = db.prepare("SELECT * FROM attendance_records WHERE id = ?").get(id);
    insertAudit(actor.id, "attendance_edit", "attendance", id, {});
    scheduleAttendanceSync(db, id);
    appsScriptScheduleAttendance(db, id);
    res.json({ record: updated });
    // Realtime: every dashboard refreshes; affected user gets in-app notification.
    try {
      realtime.broadcast("attendance", {
        type: "edit",
        record_id: id,
        user_id: updated.user_id,
        work_date: updated.work_date,
        status: updated.status,
        by: actor.id,
        ts: Date.now(),
      });
      const editorName = db.prepare("SELECT full_name FROM users WHERE id = ?").get(actor.id);
      notify(db, {
        user_id: updated.user_id,
        kind: "attendance",
        title: "Aapki attendance update hui",
        body: `${updated.work_date} • status: ${updated.status} • by ${(editorName && editorName.full_name) || "admin"}`,
        link: "/#/attendance",
      });
    } catch (e) { console.warn("[realtime] attendance edit", e.message); }
  });

  router.get("/attendance/history", attachUser, (req, res) => {
    const actor = req.currentUser;
    const { userId, branchId, from, to, status } = req.query;

    if (can(actor, "history:read")) {
      if (userId) {
        const chk = assertUserIdAccess(db, actor, userId);
        if (!chk.ok) return res.status(chk.status).json({ error: chk.error });
      }
      if (branchId && isBranchScoped(actor) && Number(branchId) !== Number(actor.branch_id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      let sql = `
        SELECT ar.*, u.full_name, u.email, u.branch_id
        FROM attendance_records ar
        JOIN users u ON u.id = ar.user_id
        WHERE 1=1
      `;
      const params = [];
      if (userId) {
        sql += " AND ar.user_id = ?";
        params.push(Number(userId));
      }
      if (branchId && isOrgWide(actor)) {
        sql += " AND u.branch_id = ?";
        params.push(Number(branchId));
      }
      const sc = branchScopeSql(actor, "u");
      sql += sc.sql;
      params.push(...sc.params);
      if (from) {
        sql += " AND ar.work_date >= ?";
        params.push(String(from));
      }
      if (to) {
        sql += " AND ar.work_date <= ?";
        params.push(String(to));
      }
      if (status) {
        sql += " AND ar.status = ?";
        params.push(String(status));
      }
      sql += " ORDER BY ar.work_date DESC, ar.id DESC LIMIT 500";
      const rows = db.prepare(sql).all(...params);
      return res.json({ records: rows });
    }

    if (can(actor, "history:read_self")) {
      let sql = `
        SELECT ar.*, u.full_name, u.email, u.branch_id
        FROM attendance_records ar
        JOIN users u ON u.id = ar.user_id
        WHERE ar.user_id = ?
      `;
      const params = [actor.id];
      if (from) {
        sql += " AND ar.work_date >= ?";
        params.push(String(from));
      }
      if (to) {
        sql += " AND ar.work_date <= ?";
        params.push(String(to));
      }
      if (status) {
        sql += " AND ar.status = ?";
        params.push(String(status));
      }
      sql += " ORDER BY ar.work_date DESC, ar.id DESC LIMIT 200";
      const rows = db.prepare(sql).all(...params);
      return res.json({ records: rows });
    }

    return res.status(403).json({ error: "Forbidden" });
  });

  router.get("/attendance", attachUser, (req, res) => {
    const actor = req.currentUser;
    const { userId, branchId, from, to, status } = req.query;

    if (!can(actor, "history:read") && !can(actor, "history:read_self")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    let rows;
    if (can(actor, "history:read")) {
      if (userId) {
        const chk = assertUserIdAccess(db, actor, userId);
        if (!chk.ok) return res.status(chk.status).json({ error: chk.error });
      }
      if (branchId && isBranchScoped(actor) && Number(branchId) !== Number(actor.branch_id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      let sql = `
        SELECT ar.*, u.full_name, u.email, u.branch_id
        FROM attendance_records ar
        JOIN users u ON u.id = ar.user_id
        WHERE 1=1
      `;
      const params = [];
      if (userId) {
        sql += " AND ar.user_id = ?";
        params.push(Number(userId));
      }
      if (branchId && isOrgWide(actor)) {
        sql += " AND u.branch_id = ?";
        params.push(Number(branchId));
      }
      const sc2 = branchScopeSql(actor, "u");
      sql += sc2.sql;
      params.push(...sc2.params);
      if (from) {
        sql += " AND ar.work_date >= ?";
        params.push(String(from));
      }
      if (to) {
        sql += " AND ar.work_date <= ?";
        params.push(String(to));
      }
      if (status) {
        sql += " AND ar.status = ?";
        params.push(String(status));
      }
      sql += " ORDER BY ar.work_date DESC, ar.id DESC LIMIT 500";
      rows = db.prepare(sql).all(...params);
    } else {
      rows = db
        .prepare(
          `SELECT ar.*, u.full_name, u.email, u.branch_id
           FROM attendance_records ar
           JOIN users u ON u.id = ar.user_id
           WHERE ar.user_id = ?
           ORDER BY ar.work_date DESC, ar.id DESC
           LIMIT 200`
        )
        .all(actor.id);
    }

    const attendance = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      checkIn: r.punch_in_at,
      checkOut: r.punch_out_at,
      status: r.status,
      workDate: r.work_date,
      userName: r.full_name,
    }));
    res.json({ attendance });
  });

  router.get("/attendance/export.csv", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "export:read")) {
      return res.status(403).send("Forbidden");
    }
    const { userId, branchId, from, to, status } = req.query;
    let sql = `
      SELECT ar.*, u.full_name, u.email, u.branch_id, b.name AS branch_name
      FROM attendance_records ar
      JOIN users u ON u.id = ar.user_id
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE 1=1
    `;
    const params = [];
    if (!can(actor, "history:read")) {
      sql += " AND ar.user_id = ?";
      params.push(actor.id);
    } else {
      if (userId) {
        const chk = assertUserIdAccess(db, actor, userId);
        if (!chk.ok) return res.status(chk.status).send(chk.error);
        sql += " AND ar.user_id = ?";
        params.push(Number(userId));
      }
      if (branchId && isOrgWide(actor)) {
        sql += " AND u.branch_id = ?";
        params.push(Number(branchId));
      }
      if (branchId && isBranchScoped(actor) && Number(branchId) !== Number(actor.branch_id)) {
        return res.status(403).send("Forbidden");
      }
      const scEx = branchScopeSql(actor, "u");
      sql += scEx.sql;
      params.push(...scEx.params);
    }
    if (from) {
      sql += " AND ar.work_date >= ?";
      params.push(String(from));
    }
    if (to) {
      sql += " AND ar.work_date <= ?";
      params.push(String(to));
    }
    if (status) {
      sql += " AND ar.status = ?";
      params.push(String(status));
    }
    sql += " ORDER BY ar.work_date DESC, ar.id DESC LIMIT 5000";
    const rows = db.prepare(sql).all(...params);
    const headers = [
      "id",
      "work_date",
      "user_id",
      "full_name",
      "email",
      "branch_id",
      "branch_name",
      "status",
      "half_period",
      "punch_in_at",
      "punch_out_at",
      "source",
      "in_lat",
      "in_lng",
      "punch_in_address",
      "punch_out_address",
      "in_device_info",
      "out_device_info",
      "punch_in_photo",
      "punch_out_photo",
    ];
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return `"${s}"`;
    };
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push(
        headers
          .map((h) => esc(r[h]))
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="attendance-export.csv"'
    );
    res.send(lines.join("\n"));
  });

  router.get("/attendance/export.xlsx", attachUser, async (req, res, next) => {
    try {
      const actor = req.currentUser;
      if (!can(actor, "export:read")) {
        return res.status(403).send("Forbidden");
      }
      const { userId, branchId, from, to, status } = req.query;
      let sql = `
        SELECT ar.*, u.full_name, u.email, u.login_id, u.branch_id, b.name AS branch_name
        FROM attendance_records ar
        JOIN users u ON u.id = ar.user_id
        LEFT JOIN branches b ON b.id = u.branch_id
        WHERE 1=1
      `;
      const params = [];
      if (!can(actor, "history:read")) {
        sql += " AND ar.user_id = ?";
        params.push(actor.id);
      } else {
        if (userId) {
          const chk = assertUserIdAccess(db, actor, userId);
          if (!chk.ok) return res.status(chk.status).send(chk.error);
          sql += " AND ar.user_id = ?";
          params.push(Number(userId));
        }
        if (branchId && isOrgWide(actor)) {
          sql += " AND u.branch_id = ?";
          params.push(Number(branchId));
        }
        if (branchId && isBranchScoped(actor) && Number(branchId) !== Number(actor.branch_id)) {
          return res.status(403).send("Forbidden");
        }
        const scX = branchScopeSql(actor, "u");
        sql += scX.sql;
        params.push(...scX.params);
      }
      if (from) {
        sql += " AND ar.work_date >= ?";
        params.push(String(from));
      }
      if (to) {
        sql += " AND ar.work_date <= ?";
        params.push(String(to));
      }
      if (status) {
        sql += " AND ar.status = ?";
        params.push(String(status));
      }
      sql += " ORDER BY ar.work_date DESC, ar.id DESC LIMIT 5000";
      // Also fetch each user's shift_start for late detection
      const rows = db.prepare(sql).all(...params);

      // Build per-user shift_start map
      const shiftMap = {};
      if (rows.length > 0) {
        const uids = [...new Set(rows.map(r => r.user_id))];
        const shiftRows = db.prepare(
          `SELECT id, shift_start, grace_minutes FROM users WHERE id IN (${uids.map(() => '?').join(',')})`
        ).all(...uids);
        for (const s of shiftRows) {
          shiftMap[s.id] = { shift_start: s.shift_start || '09:00', grace: s.grace_minutes || 0 };
        }
      }

      // Per-employee total present count in filtered period
      const presentCountMap = {};
      for (const r of rows) {
        if (!presentCountMap[r.user_id]) presentCountMap[r.user_id] = 0;
        const st = (r.status || '').toUpperCase();
        if (st === 'PRESENT' || st === 'HALF_DAY') presentCountMap[r.user_id]++;
      }

      function toIST(dtStr) {
        if (!dtStr) return '';
        const d = new Date(dtStr);
        if (isNaN(d.getTime())) return dtStr;
        // IST = UTC+5:30
        const ist = new Date(d.getTime() + (5 * 60 + 30) * 60000);
        return ist.toISOString().replace('T', ' ').slice(0, 19);
      }

      function isLate(r) {
        if (!r.punch_in_at) return '';
        const sm = shiftMap[r.user_id];
        if (!sm) return '';
        const [sh, smin] = sm.shift_start.split(':').map(Number);
        const grace = sm.grace || 0;
        const shiftMs = (sh * 60 + smin + grace) * 60000;
        const punchDate = new Date(r.punch_in_at);
        if (isNaN(punchDate.getTime())) return '';
        const punchIST = new Date(punchDate.getTime() + (5 * 60 + 30) * 60000);
        const punchMs = (punchIST.getUTCHours() * 60 + punchIST.getUTCMinutes()) * 60000;
        return punchMs > shiftMs ? 'Late' : 'On Time';
      }

      function workHours(r) {
        if (!r.punch_in_at || !r.punch_out_at) return '';
        const inT = new Date(r.punch_in_at);
        const outT = new Date(r.punch_out_at);
        if (isNaN(inT.getTime()) || isNaN(outT.getTime())) return '';
        const mins = Math.round((outT - inT) / 60000);
        if (mins <= 0) return '';
        return `${Math.floor(mins / 60)}h ${mins % 60}m`;
      }

      function statusLabel(st, half) {
        const s = (st || '').toUpperCase();
        if (s === 'PRESENT') return 'Present';
        if (s === 'ABSENT') return 'Absent';
        if (s === 'HALF_DAY') return `Half-Day${half ? ' (' + half + ')' : ''}`;
        if (s === 'LEAVE') return 'On Leave';
        if (s === 'HOLIDAY') return 'Holiday';
        if (s === 'WEEKEND') return 'Weekend';
        return st || '';
      }

      const wb = new ExcelJS.Workbook();
      wb.creator = 'HRMS Portal';
      const ws = wb.addWorksheet("Attendance");

      // Header row
      const headerRow = ws.addRow([
        'Date', 'Employee Name', 'Employee ID', 'Branch',
        'Status', 'Late / On Time', 'Check-In (IST)', 'Check-Out (IST)',
        'Work Hours', 'Total Present (Period)', 'Source', 'Notes'
      ]);
      headerRow.font = { bold: true };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5E3B' } };
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.columns = [
        { width: 14 }, { width: 24 }, { width: 16 }, { width: 18 },
        { width: 14 }, { width: 14 }, { width: 20 }, { width: 20 },
        { width: 12 }, { width: 20 }, { width: 14 }, { width: 30 }
      ];

      for (const r of rows) {
        ws.addRow([
          r.work_date,
          r.full_name,
          r.login_id || '',
          r.branch_name || '',
          statusLabel(r.status, r.half_period),
          isLate(r),
          toIST(r.punch_in_at),
          toIST(r.punch_out_at),
          workHours(r),
          presentCountMap[r.user_id] || 0,
          r.source || '',
          r.notes || ''
        ]);
      }
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="attendance-export.xlsx"'
      );
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      next(e);
    }
  });

  router.get("/integrations/google/status", attachUser, (req, res) => {
    if (!can(req.currentUser, "integrations:sync")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json(getIntegrationStatus(db));
  });

  router.get("/integrations/google/auth-url", attachUser, (req, res) => {
    if (!can(req.currentUser, "integrations:sync")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const state = crypto.randomBytes(24).toString("hex");
      req.session.googleOAuthState = state;
      const url = getGoogleAuthUrl(state);
      res.json({ url });
    } catch (e) {
      res.status(503).json({ error: e.message || "OAuth not configured" });
    }
  });

  router.get("/integrations/google/oauth/callback", async (req, res) => {
    try {
      const { code, state, error: oauthErr } = req.query;
      if (oauthErr) {
        return res.redirect(
          `/portal/#/settings?google=error&reason=${encodeURIComponent(String(oauthErr))}`
        );
      }
      if (!code || !state) {
        return res.redirect("/portal/#/settings?google=error&reason=missing_params");
      }
      if (state !== req.session.googleOAuthState) {
        return res.redirect("/portal/#/settings?google=error&reason=invalid_state");
      }
      delete req.session.googleOAuthState;
      await exchangeCodeAndSave(db, String(code));
      res.redirect("/portal/#/settings?google=connected");
    } catch (e) {
      console.error("[google oauth callback]", e);
      res.redirect(
        `/portal/#/settings?google=error&reason=${encodeURIComponent(e.message || "oauth_failed")}`
      );
    }
  });

  router.post("/integrations/google/disconnect", attachUser, (req, res) => {
    if (!can(req.currentUser, "integrations:sync")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    disconnectGoogle(db);
    res.json({ ok: true });
  });

  router.post("/integrations/google/sync-enabled", attachUser, (req, res) => {
    if (!can(req.currentUser, "integrations:sync")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const enabled = !!(req.body && req.body.enabled);
    setSyncEnabled(db, enabled);
    res.json({ ok: true, syncEnabled: enabled });
  });

  router.post("/integrations/google-sheets/full-sync", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "integrations:sync")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!isOrgWide(req.currentUser)) {
        return res.status(403).json({ error: "Full sync is restricted to Super Admin / Admin" });
      }
      const result = await fullSyncAll(db);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post("/integrations/google-sheets/sync", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "integrations:sync")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const { from, to } = req.body || {};
      let sql = `
        SELECT ar.*, u.full_name, u.email, u.login_id, u.role, b.name AS branch_name
        FROM attendance_records ar
        JOIN users u ON u.id = ar.user_id
        LEFT JOIN branches b ON b.id = u.branch_id
        WHERE 1=1
      `;
      const params = [];
      const scGs = branchScopeSql(req.currentUser, "u");
      sql += scGs.sql;
      params.push(...scGs.params);
      if (from) {
        sql += " AND ar.work_date >= ?";
        params.push(String(from));
      }
      if (to) {
        sql += " AND ar.work_date <= ?";
        params.push(String(to));
      }
      sql += " ORDER BY ar.work_date ASC LIMIT 2000";
      const rows = db.prepare(sql).all(...params);
      const result = await syncAttendanceRows(db, rows);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  router.get("/integrations/sheets/status", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can access sheet integration" });
    }
    const branches = db.prepare("SELECT id, name FROM branches ORDER BY name").all();
    res.json({
      ...readSheetIntegration(),
      branches,
      snippet: sheetConnectSnippet(),
      guide: [
        "1. Google Sheet open karo",
        "2. Script editor kholo",
        "3. Code paste karo",
        "4. Deploy as webhook",
        "5. Link copy karo",
        "6. HRMS me paste karo",
      ],
    });
  });
  router.patch("/integrations/sheets/connect", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can access sheet integration" });
    }
    const cur = readSheetIntegration();
    const branchMapIn = req.body?.branch_map;
    const branchMap =
      branchMapIn && typeof branchMapIn === "object"
        ? Object.fromEntries(
            Object.entries(branchMapIn).map(([k, v]) => [String(k), String(v || "").trim()])
          )
        : cur.branch_map || {};
    const next = {
      ...cur,
      enabled: req.body?.enabled == null ? cur.enabled : !!req.body.enabled,
      mode: req.body?.mode ? String(req.body.mode) : cur.mode,
      google_sheet_link:
        req.body?.google_sheet_link != null
          ? String(req.body.google_sheet_link).trim()
          : cur.google_sheet_link,
      api_key: req.body?.api_key != null ? String(req.body.api_key).trim() : cur.api_key,
      default_webhook_url:
        req.body?.default_webhook_url != null
          ? String(req.body.default_webhook_url).trim()
          : cur.default_webhook_url,
      branch_map: branchMap,
      sheet_to_portal_enabled:
        req.body?.sheet_to_portal_enabled == null
          ? cur.sheet_to_portal_enabled
          : !!req.body.sheet_to_portal_enabled,
    };
    writeSheetIntegration(next);
    insertAudit(req.currentUser.id, "sheet_connect_update", "settings", "sheet_integration", {
      enabled: next.enabled,
      mode: next.mode,
      branchMapCount: Object.keys(next.branch_map || {}).length,
      sheet_to_portal_enabled: next.sheet_to_portal_enabled,
    });
    res.json(next);
  });

  // ── Arm one-shot backfill (Super Admin only) ─────────────────────────────
  // Sets backfill_armed=true. Auto-clears after the next pull-from-sheet call.
  // This is the safety latch that prevents accidental Sheet→Portal re-imports.
  router.post("/integrations/sheets/arm-backfill", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can arm backfill" });
    }
    const cur = readSheetIntegration();
    const next = {
      ...cur,
      backfill_armed: true,
      backfill_armed_at: new Date().toISOString(),
      backfill_armed_by: String(req.currentUser.login_id || req.currentUser.id || ""),
    };
    writeSheetIntegration(next);
    insertAudit(req.currentUser.id, "sheet_backfill_arm", "settings", "sheet_integration", {
      armed_at: next.backfill_armed_at,
    });
    res.json({ ok: true, backfill_armed: true, armed_at: next.backfill_armed_at });
  });

  // ── Disarm backfill (cancel before running) ──────────────────────────────
  router.post("/integrations/sheets/disarm-backfill", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can disarm backfill" });
    }
    const cur = readSheetIntegration();
    writeSheetIntegration({
      ...cur,
      backfill_armed: false,
      backfill_armed_at: "",
      backfill_armed_by: "",
    });
    insertAudit(req.currentUser.id, "sheet_backfill_disarm", "settings", "sheet_integration", {});
    res.json({ ok: true, backfill_armed: false });
  });
  // ── Apps Script roundtrip test (real ping with shared secret) ────────────
  // This is what the UI "Test Connection" button hits. It validates that:
  //   • Apps Script Web App URL is reachable and returns JSON (not Drive 404)
  //   • SHEET_SYNC_SECRET on server matches HRMS_SHEET_SYNC_SECRET in Script
  //   • The expected Attendance tab exists and is readable
  router.post("/integrations/apps-script/test-connection", attachUser, async (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can test sheet connection" });
    }
    primeAppsScriptEnvFromConfig(readSheetIntegration());
    const url = String(process.env.GOOGLE_APPS_SCRIPT_WEBAPP_URL || "").trim();
    const secret = String(process.env.SHEET_SYNC_SECRET || "");
    if (!url) return res.status(400).json({ ok: false, error: "Apps Script Web App URL not configured. Open Settings → Connect Google Sheet." });
    if (!secret) return res.status(503).json({ ok: false, error: "SHEET_SYNC_SECRET env var not configured on the server." });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000); // 20s — ping should be near-instant
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ __cmd: "ping", __secret: secret }),
        redirect: "follow",
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e?.name === "AbortError";
      const cur = readSheetIntegration();
      writeSheetIntegration({ ...cur, last_error: aborted ? "Ping timeout (>20s)" : `Ping failed: ${e.message}` });
      return res.status(aborted ? 504 : 502).json({
        ok: false,
        error: aborted ? "Apps Script did not respond within 20s. Re-deploy the Web App and try again." : `Could not reach Apps Script: ${e.message}`,
      });
    }
    clearTimeout(timer);
    const text = await r.text();
    const isDrive404 = /Page not found/i.test(text) && /<html/i.test(text) && r.status >= 400;
    let data;
    try { data = JSON.parse(text); } catch {
      const cur = readSheetIntegration();
      writeSheetIntegration({ ...cur, last_error: isDrive404 ? "Apps Script URL invalid (Drive 404)" : `Non-JSON HTTP ${r.status}` });
      return res.status(502).json({
        ok: false,
        urlInvalid: isDrive404,
        error: isDrive404
          ? "❌ Apps Script Web App URL is invalid or expired. Open the script → Deploy → New deployment → copy the new /exec URL."
          : `Apps Script returned non-JSON (HTTP ${r.status}). First 240 chars: ${text.slice(0, 240)}`,
      });
    }
    if (!r.ok || data?.ok === false) {
      const cur = readSheetIntegration();
      const errMsg = data?.error || `HTTP ${r.status}`;
      writeSheetIntegration({ ...cur, last_error: errMsg });
      const isSecretMismatch = /__secret|secret|HRMS_SHEET_SYNC_SECRET/i.test(errMsg);
      return res.status(502).json({
        ok: false,
        error: errMsg,
        hint: isSecretMismatch
          ? "Open Apps Script → ⚙ Project Settings → Script properties and set HRMS_SHEET_SYNC_SECRET to match the value of SHEET_SYNC_SECRET in HRMS."
          : /Unknown command/i.test(errMsg)
          ? "Your Apps Script is older — paste the latest code from 📜 Setup Guide and re-deploy."
          : undefined,
      });
    }
    // Success — refresh status and return the meta from the script.
    const cur = readSheetIntegration();
    writeSheetIntegration({ ...cur, last_error: "", last_sync_at: new Date().toISOString() });
    return res.json({
      ok: true,
      pong: true,
      service: data.service,
      spreadsheet_id: data.spreadsheet_id,
      spreadsheet_name: data.spreadsheet_name,
      attendance_tab: data.attendance_tab,
      attendance_rows: data.attendance_rows,
      attendance_found: data.attendance_found,
      autosync_enabled: data.autosync_enabled,
      ts: data.ts,
    });
  });

  router.post("/integrations/sheets/test-connection", attachUser, async (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can access sheet integration" });
    }
    const cfg = readSheetIntegration();
    const testUrl = String(req.body?.webhook_url || cfg.default_webhook_url || "").trim();
    if (!testUrl) return res.status(400).json({ error: "webhook_url required" });
    try {
      const r = await fetch(testUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}),
        },
        body: JSON.stringify({
          test: true,
          source: "hrms",
          at: new Date().toISOString(),
          message: "HRMS Test Connection",
        }),
      });
      if (!r.ok) throw new Error(`Connection failed (${r.status})`);
      writeSheetIntegration({ ...cfg, last_error: "", last_sync_at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) {
      writeSheetIntegration({ ...cfg, last_error: String(e.message || e) });
      res.status(400).json({ error: String(e.message || e) });
    }
  });
  router.post("/integrations/sheets/manual-sync", attachUser, async (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can access sheet integration" });
    }
    // Make absolutely sure the env URL is in sync with the latest saved config
    // before the bulk push runs (covers the case where the user just saved).
    primeAppsScriptEnvFromConfig(readSheetIntegration());
    try {
      const result = await appsScriptFullBulkPushAll(db);
      if (!result?.ok) {
        return res.status(400).json({
          ok: false,
          synced: 0,
          failed: 0,
          error: result?.message || "Apps Script sync disabled or URL missing",
        });
      }
      // Flatten per-tab chunk counts into a friendly synced total
      let synced = 0;
      const perTab = {};
      for (const tab of Object.keys(result.tabs || {})) {
        const t = result.tabs[tab];
        const chunks = (t && t.chunks) || 0;
        perTab[tab] = chunks;
        synced += chunks;
      }
      writeSheetIntegration({
        ...readSheetIntegration(),
        last_sync_at: new Date().toISOString(),
        last_error: "",
      });
      res.json({ ok: true, synced, failed: 0, tabs: perTab });
    } catch (e) {
      const msg = String(e?.message || e);
      writeSheetIntegration({ ...readSheetIntegration(), last_error: msg });
      res.status(500).json({ ok: false, synced: 0, failed: 1, error: msg });
    }
  });

  router.get("/dashboard/summary", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "dashboard:read") && !can(actor, "dashboard:read_self")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { branchId, from, to } = req.query;
    const fromDate = from || todayLocalDate();
    const toDate = to || todayLocalDate();

    if (can(actor, "dashboard:read_self") && !can(actor, "dashboard:read")) {
      const rows = db
        .prepare(
          `
        SELECT status, COUNT(*) AS c
        FROM attendance_records
        WHERE user_id = ? AND work_date BETWEEN ? AND ?
        GROUP BY status
      `
        )
        .all(actor.id, fromDate, toDate);
      return res.json({ scope: "self", from: fromDate, to: toDate, counts: rows });
    }

    let sql = `
      SELECT u.branch_id, b.name AS branch_name, ar.status, COUNT(*) AS c
      FROM attendance_records ar
      JOIN users u ON u.id = ar.user_id
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE ar.work_date BETWEEN ? AND ?
    `;
    const params = [fromDate, toDate];
    if (branchId && isOrgWide(actor)) {
      sql += " AND u.branch_id = ?";
      params.push(Number(branchId));
    }
    if (isBranchScoped(actor)) {
      if (actor.branch_id == null) {
        return res.json({ scope: "org", from: fromDate, to: toDate, rows: [] });
      }
      sql += " AND u.branch_id = ?";
      params.push(actor.branch_id);
    }
    sql += " GROUP BY u.branch_id, b.name, ar.status ORDER BY b.name, ar.status";
    const rows = db.prepare(sql).all(...params);
    res.json({ scope: "org", from: fromDate, to: toDate, rows });
  });

  router.get("/dashboard", attachUser, (req, res) => {
    const today = todayLocalDate();
    const totalStaff = Number(
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE active = 1 AND deleted_at IS NULL").get().c
    );
    const present = Number(
      db
        .prepare("SELECT COUNT(*) AS c FROM attendance_records WHERE work_date = ? AND punch_in_at IS NOT NULL")
        .get(today).c
    );
    const late = Number(
      db.prepare("SELECT COUNT(*) AS c FROM attendance_records WHERE work_date = ? AND status = 'late'").get(today)
        .c
    );
    const absent = Math.max(totalStaff - present, 0);
    res.json({ date: today, totalStaff, present, late, absent });
  });

  router.get("/dashboard/overview", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "dashboard:read") && !can(actor, "dashboard:read_self")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const today = todayLocalDate();
    const cacheKey = `dash-overview:${actor.id}:${today}`;
    const cached = ttlGet(cacheKey);
    if (cached) return res.json(cached);
    const _origJson = res.json.bind(res);
    res.json = (body) => { ttlSet(cacheKey, body, 15000); return _origJson(body); };
    const now = new Date();
    const dow = now.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(now);
    mon.setDate(now.getDate() + mondayOffset);
    const weekStart = mon.toISOString().slice(0, 10);

    const sc = branchScopeSql(actor, "u");
    const ba = branchAccessSql(actor, "u");
    const scSql = sc.sql + ba.sql;
    const scParams = [...sc.params, ...ba.params];

    const totalStaff = Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM users u WHERE u.deleted_at IS NULL${scSql}`)
        .get(...scParams).c
    );

    if (can(actor, "dashboard:read_self") && !can(actor, "dashboard:read")) {
      const row = db
        .prepare("SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?")
        .get(actor.id, today);
      const st = row?.status || "absent";

      // Monthly attendance summary for this user
      const monthStart = today.slice(0, 7) + "-01";
      const monthlyRows = db
        .prepare(
          `SELECT status, COUNT(*) AS c FROM attendance_records
           WHERE user_id = ? AND work_date >= ? AND work_date <= ?
           GROUP BY status`
        )
        .all(actor.id, monthStart, today);
      const mmap = Object.fromEntries(monthlyRows.map((r) => [r.status, r.c]));

      // Own leave requests (recent 10)
      const myLeaves = db
        .prepare(
          `SELECT id, start_date, end_date, reason, final_status AS status, leave_type, created_at
           FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
        )
        .all(actor.id);

      return res.json({
        scope: "self",
        today: {
          date: today,
          totalStaff: 1,
          present: st === "present" || st === "half" || st === "half_day" ? 1 : 0,
          late: st === "late" ? 1 : 0,
          absent: st === "absent" || !row ? 1 : 0,
          onLeave: st === "leave" ? 1 : 0,
          halfDay: st === "half" || st === "half_day" ? 1 : 0,
          punchInAt: row?.punch_in_at || null,
          punchOutAt: row?.punch_out_at || null,
        },
        myMonthly: {
          present: (mmap.present || 0) + (mmap.half || 0) + (mmap.half_day || 0),
          late: mmap.late || 0,
          absent: mmap.absent || 0,
          leave: mmap.leave || 0,
          halfDay: (mmap.half || 0) + (mmap.half_day || 0),
          monthStart,
        },
        myLeaves,
        stats: { workforce: 1, monthlyBudgetINR: 0, workHours: 180, offices: 1 },
        highlights: { topPerformers: [], lateDefaulters: [], violations: [], weeklyLateFlags: [] },
        insights: { leaveRequestsPending: 0, biometricRequests: 0, documentCompliancePct: 100 },
        staffByBranch: [],
        liveStatus: { currentlyIn: 0, missingOut: 0 },
        hrAlerts: [],
        alerts: { highLeaveUsers: [], frequentLateUsers: [] },
      });
    }

    const statusRows = db
      .prepare(
        `SELECT ar.status, COUNT(*) AS c
         FROM attendance_records ar
         JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
         WHERE ar.work_date = ?${scSql}
         GROUP BY ar.status`
      )
      .all(today, ...scParams);
    const smap = Object.fromEntries(statusRows.map((x) => [x.status, x.c]));
    const halfDayCount = (smap.half || 0) + (smap.half_day || 0);
    const present = (smap.present || 0) + halfDayCount;
    const late = smap.late || 0;
    const onLeave = smap.leave || 0;
    const absentOnly = Math.max(totalStaff - present - late - onLeave, 0);

    const missingOut = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM attendance_records ar
           JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
           WHERE ar.work_date = ? AND ar.punch_in_at IS NOT NULL AND ar.punch_out_at IS NULL${scSql}`
        )
        .get(today, ...scParams).c
    );

    const lateWeek = db
      .prepare(
        `SELECT u.full_name AS name, u.id AS userId, COUNT(*) AS lateDays
         FROM attendance_records ar
         JOIN users u ON u.id = ar.user_id AND u.active = 1 AND u.deleted_at IS NULL
         WHERE ar.work_date >= ? AND ar.status = 'late'${scSql}
         GROUP BY u.id
         HAVING COUNT(*) >= 3`
      )
      .all(weekStart, ...scParams);

    let leavePending = 0;
    let documentCompliancePct = 100;
    try {
      leavePending = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM leave_requests lr
             JOIN users u ON u.id = lr.user_id AND u.deleted_at IS NULL
             WHERE lr.final_status = 'PENDING'${scSql}`
          )
          .get(...scParams).c
      );
    } catch {
      leavePending = 0;
    }
    try {
      const docTotal = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM employee_documents d
             JOIN users u ON u.id = d.user_id
             WHERE 1=1${scSql}`
          )
          .get(...scParams).c
      );
      const docOk = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM employee_documents d
             JOIN users u ON u.id = d.user_id
             WHERE d.verified = 1${scSql}`
          )
          .get(...scParams).c
      );
      if (docTotal > 0) {
        documentCompliancePct = Math.round((docOk / docTotal) * 100);
      } else {
        documentCompliancePct = 100;
      }
    } catch {
      documentCompliancePct = 87;
    }

    const payrollPeriod = today.slice(0, 7);
    let payrollGross = 0;
    let payrollDed = 0;
    try {
      const pr = db
        .prepare(
          `SELECT COALESCE(SUM(p.gross_inr),0) AS g, COALESCE(SUM(p.deductions_inr),0) AS d
           FROM payroll_entries p
           JOIN users u ON u.id = p.user_id
           WHERE p.period = ?${scSql}`
        )
        .get(payrollPeriod, ...scParams);
      payrollGross = Number(pr.g) || 0;
      payrollDed = Number(pr.d) || 0;
    } catch {
      payrollGross = 0;
      payrollDed = 0;
    }

    let staffByBranch;
    if (isOrgWide(actor)) {
      staffByBranch = db
        .prepare(
          `SELECT b.name AS name, COUNT(u.id) AS staffCount
           FROM branches b
           LEFT JOIN users u ON u.branch_id = b.id AND u.active = 1 AND u.deleted_at IS NULL
           GROUP BY b.id
           ORDER BY b.name`
        )
        .all();
    } else if (isBranchScoped(actor) && actor.branch_id != null) {
      staffByBranch = db
        .prepare(
          `SELECT b.name AS name, COUNT(u.id) AS staffCount
           FROM branches b
           LEFT JOIN users u ON u.branch_id = b.id AND u.active = 1 AND u.deleted_at IS NULL
           WHERE b.id = ?
           GROUP BY b.id`
        )
        .all(actor.branch_id);
    } else {
      staffByBranch = [];
    }

    const offices = isOrgWide(actor)
      ? Number(db.prepare("SELECT COUNT(*) AS c FROM branches WHERE lower(name) NOT IN ('head office')").get().c)
      : isBranchScoped(actor) && actor.branch_id != null
        ? 1
        : 0;

    const liveIn = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM attendance_records ar
           JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
           WHERE ar.work_date = ? AND ar.punch_in_at IS NOT NULL AND ar.punch_out_at IS NULL${scSql}`
        )
        .get(today, ...scParams).c
    );

    const lateToday = db
      .prepare(
        `SELECT u.full_name AS name, ar.status AS status, ar.work_date AS workDate
         FROM attendance_records ar
         JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
         WHERE ar.work_date = ? AND ar.status = 'late'${scSql}
         LIMIT 8`
      )
      .all(today, ...scParams);

    const topRows = db
      .prepare(
        `SELECT u.full_name AS name, b.name AS branch
         FROM users u
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE u.active = 1 AND u.deleted_at IS NULL${scSql}
         ORDER BY u.id ASC
         LIMIT 5`
      )
      .all(...scParams);
    const scores = [98, 96, 94, 92, 90];
    const topPerformers = topRows.map((r, i) => ({
      name: r.name,
      branch: r.branch || "—",
      score: scores[i] || 90,
    }));

    const halfDay = halfDayCount;
    const presentOnly = smap.present || 0;
    const punchInCount = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM attendance_records ar
           INNER JOIN users u ON u.id = ar.user_id AND u.active = 1 AND u.deleted_at IS NULL
           WHERE ar.work_date = ? AND ar.punch_in_at IS NOT NULL${scSql}`
        )
        .get(today, ...scParams).c
    );
    const punchOutCount = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM attendance_records ar
           INNER JOIN users u ON u.id = ar.user_id AND u.active = 1 AND u.deleted_at IS NULL
           WHERE ar.work_date = ? AND ar.punch_out_at IS NOT NULL${scSql}`
        )
        .get(today, ...scParams).c
    );

    let noticeReadSummary = { activeNotices: 0, totalReads: 0, approxUnseen: 0 };
    try {
      const na = Number(db.prepare(`SELECT COUNT(*) AS c FROM notices WHERE active = 1`).get().c);
      const tr = Number(db.prepare(`SELECT COUNT(*) AS c FROM notice_reads`).get().c);
      noticeReadSummary = {
        activeNotices: na,
        totalReads: tr,
        approxUnseen: Math.max(0, na * totalStaff - tr),
      };
    } catch {
      /* optional tables */
    }

    const workedRows = db
      .prepare(
        `SELECT ar.punch_in_at, ar.punch_out_at FROM attendance_records ar
         INNER JOIN users u ON u.id = ar.user_id AND u.active = 1 AND u.deleted_at IS NULL
         WHERE ar.work_date = ? AND ar.punch_in_at IS NOT NULL AND ar.punch_out_at IS NOT NULL${scSql}`
      )
      .all(today, ...scParams);
    const totalMinutesWorkedToday = workedRows.reduce(
      (acc, r) => acc + minutesBetweenIso(r.punch_in_at, r.punch_out_at),
      0
    );

    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const padM = String(m).padStart(2, "0");
    const monthStart = `${y}-${padM}-01`;
    const lastD = new Date(y, m, 0).getDate();
    const monthEnd = `${y}-${padM}-${String(lastD).padStart(2, "0")}`;
    const monthRows = db
      .prepare(
        `SELECT ar.punch_in_at, ar.punch_out_at FROM attendance_records ar
         INNER JOIN users u ON u.id = ar.user_id AND u.active = 1 AND u.deleted_at IS NULL
         WHERE ar.work_date >= ? AND ar.work_date <= ? AND ar.punch_in_at IS NOT NULL AND ar.punch_out_at IS NOT NULL${scSql}`
      )
      .all(monthStart, monthEnd, ...scParams);
    const totalMinutesWorkedMonth = monthRows.reduce(
      (acc, r) => acc + minutesBetweenIso(r.punch_in_at, r.punch_out_at),
      0
    );

    const yearStart = `${y}-01-01`;
    let highLeaveUsers = [];
    try {
      highLeaveUsers = db
        .prepare(
          `SELECT u.full_name AS name, u.id AS userId, COUNT(*) AS approvedLeaves
           FROM leave_requests lr
           JOIN users u ON u.id = lr.user_id AND u.deleted_at IS NULL
           WHERE lr.final_status = 'APPROVED' AND lr.start_date >= ?${scSql}
           GROUP BY u.id
           HAVING COUNT(*) > 4
           ORDER BY approvedLeaves DESC LIMIT 12`
        )
        .all(yearStart, ...scParams);
    } catch {
      highLeaveUsers = [];
    }

    const frequentLateUsers = db
      .prepare(
        `SELECT u.full_name AS name, u.id AS userId, COUNT(*) AS lateDays
         FROM attendance_records ar
         JOIN users u ON u.id = ar.user_id AND u.active = 1 AND u.deleted_at IS NULL
         WHERE ar.work_date >= date('now', '-14 days') AND ar.status = 'late'${scSql}
         GROUP BY u.id
         HAVING COUNT(*) >= 3
         ORDER BY lateDays DESC LIMIT 12`
      )
      .all(...scParams);

    res.json({
      scope: "org",
      today: {
        date: today,
        totalStaff,
        present,
        late,
        absent: absentOnly,
        onLeave,
        halfDay,
        presentOnly,
        punchInCount,
        punchOutCount,
        totalMinutesWorked: totalMinutesWorkedToday,
        totalHoursWorkedToday: Math.round((totalMinutesWorkedToday / 60) * 10) / 10,
      },
      stats: {
        workforce: totalStaff,
        monthlyBudgetINR: 2450000,
        workHours: 176,
        offices,
        totalMinutesWorkedMonth,
        totalHoursWorkedMonth: Math.round((totalMinutesWorkedMonth / 60) * 10) / 10,
      },
      alerts: {
        highLeaveUsers,
        frequentLateUsers,
      },
      highlights: {
        topPerformers,
        lateDefaulters: lateToday,
        violations: [{ type: "Missing punch-out (today)", count: missingOut }],
        weeklyLateFlags: lateWeek,
      },
      insights: {
        leaveRequestsPending: leavePending,
        biometricRequests: 0,
        documentCompliancePct,
      },
      staffByBranch,
      liveStatus: { currentlyIn: liveIn, missingOut },
      noticeReadSummary,
      hrAlerts: listRecentAlerts(db, { limit: 12 }),
      payrollPreview: {
        grossCtcMonthlyINR: payrollGross > 0 ? payrollGross : 2450000,
        attendanceDeductionsINR: Math.min(45000, missingOut * 5000),
        netFromPayrollINR: payrollGross - payrollDed,
        period: payrollPeriod,
        note:
          payrollGross > 0
            ? `Payroll totals from payroll_entries for ${payrollPeriod}.`
            : "Add payroll rows in the Payroll module; showing org benchmark until data exists.",
      },
    });
  });

  router.get("/dashboard/today-list", attachUser, (req, res) => {
    if (!can(req.currentUser, "dashboard:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const status = String(req.query.status || "present").toLowerCase();
    const today = todayLocalDate();
    const branchId = req.query.branch_id != null && req.query.branch_id !== "" ? Number(req.query.branch_id) : null;
    const allowed = ["present", "half", "half_day", "late", "absent", "leave", "absent_leave", "all"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "status must be present|half|half_day|late|absent|leave|absent_leave|all" });
    }
    const actor = req.currentUser;

    let sql, params;

    if (status === "absent") {
      // Absent = active users who have NO punch-in today (or explicitly absent)
      sql = `
        SELECT u.id, u.full_name, u.email, u.login_id, b.name AS branch_name,
          ar.status, ar.punch_in_at, ar.punch_out_at, ar.work_date
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN attendance_records ar ON ar.user_id = u.id AND ar.work_date = ?
        WHERE u.active = 1 AND u.deleted_at IS NULL
          AND u.role NOT IN ('SUPER_ADMIN','ADMIN')
          AND (u.account_status IS NULL OR u.account_status = 'ACTIVE')
          AND (ar.id IS NULL OR ar.status IN ('absent',''))
      `;
      params = [today];
      if (branchId && isOrgWide(actor)) {
        sql += " AND u.branch_id = ?";
        params.push(branchId);
      }
      if (isBranchScoped(actor)) {
        if (actor.branch_id == null) return res.json({ date: today, status, people: [] });
        sql += " AND u.branch_id = ?";
        params.push(actor.branch_id);
      }
      sql += " ORDER BY u.full_name LIMIT 500";
      const people = db.prepare(sql).all(...params);
      return res.json({ date: today, status, people });
    }

    if (status === "absent_leave") {
      // Absent + Leave = users with no record today, or explicitly absent/leave
      sql = `
        SELECT u.id, u.full_name, u.email, u.login_id, b.name AS branch_name,
          ar.status, ar.punch_in_at, ar.punch_out_at, ar.work_date
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN attendance_records ar ON ar.user_id = u.id AND ar.work_date = ?
        WHERE u.active = 1 AND u.deleted_at IS NULL
          AND u.role NOT IN ('SUPER_ADMIN','ADMIN')
          AND (u.account_status IS NULL OR u.account_status = 'ACTIVE')
          AND (ar.id IS NULL OR ar.status IN ('absent','','leave'))
      `;
      params = [today];
      if (branchId && isOrgWide(actor)) {
        sql += " AND u.branch_id = ?";
        params.push(branchId);
      }
      if (isBranchScoped(actor)) {
        if (actor.branch_id == null) return res.json({ date: today, status, people: [] });
        sql += " AND u.branch_id = ?";
        params.push(actor.branch_id);
      }
      sql += " ORDER BY u.full_name LIMIT 500";
      const people = db.prepare(sql).all(...params);
      return res.json({ date: today, status, people });
    }

    if (status === "leave") {
      // On Leave today = users with an approved leave_request covering today,
      // OR an attendance_records row explicitly marked 'leave'. Approved leave
      // is the source of truth — most users on leave have no attendance row.
      let leaveTableExists = true;
      try {
        leaveTableExists = !!db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='leave_requests'"
        ).get();
      } catch { leaveTableExists = false; }

      sql = `
        SELECT u.id, u.full_name, u.email, u.login_id, b.name AS branch_name,
          COALESCE(lr.leave_type, ar.status) AS status,
          ar.punch_in_at, ar.punch_out_at, ar.work_date,
          lr.start_date AS leave_from, lr.end_date AS leave_to,
          lr.leave_type AS leave_type, lr.reason AS leave_reason
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN attendance_records ar ON ar.user_id = u.id AND ar.work_date = ?
        ${leaveTableExists ? `LEFT JOIN leave_requests lr ON lr.user_id = u.id
          AND UPPER(lr.final_status) = 'APPROVED'
          AND date(lr.start_date) <= date(?) AND date(lr.end_date) >= date(?)` : ''}
        WHERE u.active = 1 AND u.deleted_at IS NULL
          AND u.role NOT IN ('SUPER_ADMIN','ADMIN')
          AND (u.account_status IS NULL OR u.account_status = 'ACTIVE')
          AND (${leaveTableExists ? 'lr.id IS NOT NULL OR ' : ''}ar.status = 'leave')
      `;
      params = leaveTableExists ? [today, today, today] : [today];
      if (branchId && isOrgWide(actor)) {
        sql += " AND u.branch_id = ?";
        params.push(branchId);
      }
      if (isBranchScoped(actor)) {
        if (actor.branch_id == null) return res.json({ date: today, status, people: [] });
        sql += " AND u.branch_id = ?";
        params.push(actor.branch_id);
      }
      sql += " GROUP BY u.id ORDER BY u.full_name LIMIT 500";
      const people = db.prepare(sql).all(...params);
      return res.json({ date: today, status, people });
    }

    if (status === "all") {
      // All active employees
      sql = `
        SELECT u.id, u.full_name, u.email, u.login_id, b.name AS branch_name,
          ar.status, ar.punch_in_at, ar.punch_out_at, ar.work_date
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN attendance_records ar ON ar.user_id = u.id AND ar.work_date = ?
        WHERE u.active = 1 AND u.deleted_at IS NULL
          AND u.role NOT IN ('SUPER_ADMIN','ADMIN')
          AND (u.account_status IS NULL OR u.account_status = 'ACTIVE')
      `;
      params = [today];
      if (branchId && isOrgWide(actor)) {
        sql += " AND u.branch_id = ?";
        params.push(branchId);
      }
      if (isBranchScoped(actor)) {
        if (actor.branch_id == null) return res.json({ date: today, status, people: [] });
        sql += " AND u.branch_id = ?";
        params.push(actor.branch_id);
      }
      sql += " ORDER BY u.full_name LIMIT 500";
      const people = db.prepare(sql).all(...params);
      return res.json({ date: today, status, people });
    }

    // For present: include 'present' + half-day variants. For half: include both legacy 'half' and new 'half_day'.
    const statusFilter =
      status === "present" ? ["present", "half", "half_day"]
      : status === "half" || status === "half_day" ? ["half", "half_day"]
      : [status];
    const placeholders = statusFilter.map(() => "?").join(",");
    // IMPORTANT: WHERE clause matches the overview count query exactly:
    //   - only `u.deleted_at IS NULL` (no active/role exclusions)
    // Otherwise admins/managers/inactive users counted in the dashboard
    // count would NOT appear in the drill-down popup, causing the user-reported
    // "count says 17 but popup is empty" mismatch.
    sql = `
      SELECT u.id, u.full_name, u.email, u.login_id, u.role, b.name AS branch_name,
        ar.status, ar.punch_in_at, ar.punch_out_at, ar.work_date
      FROM attendance_records ar
      JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE ar.work_date = ? AND ar.status IN (${placeholders})
    `;
    params = [today, ...statusFilter];
    if (branchId && isOrgWide(actor)) {
      sql += " AND u.branch_id = ?";
      params.push(branchId);
    }
    if (branchId && isBranchScoped(actor) && Number(branchId) !== Number(actor.branch_id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (isBranchScoped(actor)) {
      if (actor.branch_id == null) return res.json({ date: today, status, people: [] });
      sql += " AND u.branch_id = ?";
      params.push(actor.branch_id);
    }
    sql += " ORDER BY u.full_name LIMIT 500";
    const people = db.prepare(sql).all(...params);
    console.log(`[today-list] status=${status} date=${today} actor=#${actor.id} → ${people.length} records`);
    res.json({ date: today, status, people });
  });

  router.get("/company/profile", attachUser, (req, res) => {
    if (!can(req.currentUser, "settings:read") && !can(req.currentUser, "branches:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ profile: readCompanyProfile(), branches: db.prepare("SELECT * FROM branches ORDER BY name").all() });
  });

  router.patch("/company/profile", attachUser, requirePerm("settings:write"), (req, res) => {
    const cur = readCompanyProfile();
    const next = { ...cur, ...(req.body || {}) };
    writeCompanyProfile(next);
    insertAudit(req.currentUser.id, "company_profile_update", "settings", "company", {});
    res.json({ profile: readCompanyProfile() });
  });

  router.get("/attendance/month-summary", attachUser, (req, res) => {
    const actor = req.currentUser;
    const period =
      String(req.query.month || "")
        .trim()
        .slice(0, 7) || todayLocalDate().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "month must be YYYY-MM" });
    }
    const [y, mo] = period.split("-").map(Number);
    const pad = (n) => String(n).padStart(2, "0");
    const from = `${y}-${pad(mo)}-01`;
    const lastDay = new Date(y, mo, 0).getDate();
    const to = `${y}-${pad(mo)}-${pad(lastDay)}`;
    let sql = `
      SELECT u.id, u.full_name, u.email, u.login_id,
        COUNT(CASE WHEN ar.status IN ('present','half','half_day') THEN 1 END) AS present_days,
        COUNT(CASE WHEN ar.status = 'late' THEN 1 END) AS late_days,
        COUNT(CASE WHEN ar.status = 'absent' THEN 1 END) AS absent_days,
        SUM(CASE WHEN ar.punch_in_at IS NOT NULL AND ar.punch_out_at IS NOT NULL
          THEN (julianday(ar.punch_out_at) - julianday(ar.punch_in_at)) * 24 * 60 ELSE 0 END) AS work_minutes
      FROM users u
      LEFT JOIN attendance_records ar ON ar.user_id = u.id AND ar.work_date >= ? AND ar.work_date <= ?
      WHERE u.deleted_at IS NULL
    `;
    const params = [from, to];
    if (!can(actor, "history:read")) {
      sql += " AND u.id = ?";
      params.push(actor.id);
    } else {
      sql += " AND u.active = 1";
      const scMs = branchScopeSql(actor, "u");
      sql += scMs.sql;
      params.push(...scMs.params);
    }
    sql += " GROUP BY u.id ORDER BY u.full_name LIMIT 2000";
    const rows = db.prepare(sql).all(...params);
    res.json({ period, from, to, rows });
  });

  router.get("/geocode/reverse", attachUser, async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(url, {
        headers: { "User-Agent": "HRMS-Portal/2.0", Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return res.json({ address: null, city: null, state: null, display_name: null });
      const data = await resp.json();
      const a = data.address || {};
      const city = a.city || a.town || a.village || a.county || null;
      const state = a.state || null;
      const road = [a.house_number, a.road].filter(Boolean).join(" ");
      const address = [road, a.suburb, a.neighbourhood, a.district].filter(Boolean).join(", ") || null;
      res.json({ address, city, state, display_name: data.display_name || null });
    } catch {
      res.json({ address: null, city: null, state: null, display_name: null });
    }
  });

  router.get("/branches", attachUser, (req, res) => {
    if (!can(req.currentUser, "branches:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({
      branches: db
        .prepare("SELECT * FROM branches WHERE lower(name) NOT IN ('head office') ORDER BY name")
        .all(),
    });
  });
  router.get("/departments", attachUser, (req, res) => {
    if (!can(req.currentUser, "departments:read") && !can(req.currentUser, "users:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const departments = db
      .prepare("SELECT id, name, active, created_at FROM departments WHERE active = 1 ORDER BY name")
      .all();
    res.json({ departments });
  });
  router.post("/departments", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can create departments" });
    }
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    try {
      const info = db
        .prepare("INSERT INTO departments (name, active) VALUES (?, 1)")
        .run(name);
      const department = db
        .prepare("SELECT id, name, active, created_at FROM departments WHERE id = ?")
        .get(info.lastInsertRowid);
      insertAudit(req.currentUser.id, "department_create", "department", department.id, { name });
      res.json({ department });
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "Department already exists" });
      }
      throw e;
    }
  });
  router.patch("/departments/:id", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can edit departments" });
    }
    const id = Number(req.params.id);
    const name = req.body?.name != null ? String(req.body.name).trim() : null;
    const active = req.body?.active;
    db.prepare(
      `UPDATE departments
       SET name = COALESCE(?, name),
           active = CASE WHEN ? IS NULL THEN active ELSE ? END
       WHERE id = ?`
    ).run(name, active === undefined ? null : (active ? 1 : 0), active === undefined ? null : (active ? 1 : 0), id);
    const department = db
      .prepare("SELECT id, name, active, created_at FROM departments WHERE id = ?")
      .get(id);
    if (!department) return res.status(404).json({ error: "Not found" });
    insertAudit(req.currentUser.id, "department_update", "department", id, {});
    res.json({ department });
  });
  router.delete("/departments/:id", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can delete departments" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id, name FROM departments WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare("UPDATE departments SET active = 0 WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "department_delete", "department", id, { name: row.name });
    res.json({ ok: true, id });
  });
  router.get("/locations", attachUser, (req, res) => {
    if (!can(req.currentUser, "branches:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const locations = db.prepare("SELECT * FROM branches ORDER BY name").all();
    res.json({ locations });
  });

  router.post("/branches", attachUser, requirePerm("branches:write"), (req, res) => {
    if (!isOrgWide(req.currentUser)) {
      return res.status(403).json({ error: "Only Super Admin / Admin can create branches" });
    }
    const { name, lat, lng, radius_meters, address, city, state, wifi_enabled, wifi_ssids } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const info = db
      .prepare(
        "INSERT INTO branches (name, lat, lng, radius_meters, address, city, state, wifi_enabled, wifi_ssids) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(
        name,
        lat ?? null,
        lng ?? null,
        radius_meters != null && Number(radius_meters) >= 0 ? Number(radius_meters) : 300,
        address != null ? String(address) : null,
        city != null ? String(city) : null,
        state != null ? String(state) : null,
        wifi_enabled ? 1 : 0,
        Array.isArray(wifi_ssids) ? JSON.stringify(wifi_ssids.map((x) => String(x).trim()).filter(Boolean)) : null
      );
    const b = db.prepare("SELECT * FROM branches WHERE id = ?").get(info.lastInsertRowid);
    insertAudit(req.currentUser.id, "branch_create", "branch", b.id, { name: b.name });
    scheduleBranchSync(db, b.id);
    appsScriptScheduleBranch(db, b.id);
    res.json({ branch: b });
  });

  router.patch("/branches/:id", attachUser, requirePerm("branches:write"), (req, res) => {
    if (!isOrgWide(req.currentUser)) {
      return res.status(403).json({ error: "Only Super Admin / Admin can edit branches" });
    }
    const id = Number(req.params.id);
    const { name, lat, lng, radius_meters, address, city, state, wifi_enabled, wifi_ssids } = req.body || {};
    const wifiPayload = Array.isArray(wifi_ssids)
      ? JSON.stringify(wifi_ssids.map((x) => String(x).trim()).filter(Boolean))
      : null;
    db.prepare(
      `UPDATE branches SET
        name = COALESCE(?, name),
        lat = COALESCE(?, lat),
        lng = COALESCE(?, lng),
        radius_meters = COALESCE(?, radius_meters),
        address = COALESCE(?, address),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        wifi_enabled = CASE WHEN ? IS NULL THEN wifi_enabled ELSE ? END,
        wifi_ssids = COALESCE(?, wifi_ssids)
       WHERE id = ?`
    ).run(
      name || null,
      lat ?? null,
      lng ?? null,
      radius_meters ?? null,
      address !== undefined ? String(address || "") : null,
      city !== undefined ? String(city || "") : null,
      state !== undefined ? String(state || "") : null,
      wifi_enabled === undefined ? null : (wifi_enabled ? 1 : 0),
      wifi_enabled === undefined ? null : (wifi_enabled ? 1 : 0),
      wifiPayload,
      id
    );
    const b = db.prepare("SELECT * FROM branches WHERE id = ?").get(id);
    if (!b) return res.status(404).json({ error: "Not found" });
    insertAudit(req.currentUser.id, "branch_update", "branch", id, {});
    scheduleBranchSync(db, id);
    appsScriptScheduleBranch(db, id);
    res.json({ branch: b });
  });
  router.delete("/branches/:id", attachUser, requirePerm("branches:write"), (req, res) => {
    if (!isOrgWide(req.currentUser)) {
      return res.status(403).json({ error: "Only Super Admin / Admin can delete branches" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id, name FROM branches WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const usersCount = Number(
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE branch_id = ? AND deleted_at IS NULL").get(id).c
    );
    if (usersCount > 0) {
      return res.status(400).json({ error: "Cannot delete a branch assigned to active users" });
    }
    db.prepare("DELETE FROM branches WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "branch_delete", "branch", id, { name: row.name });
    res.json({ ok: true, id });
  });

  router.get("/users", attachUser, (req, res) => {
    if (!can(req.currentUser, "users:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const scU = branchScopeSql(req.currentUser, "u");
    const baU = branchAccessSql(req.currentUser, "u");
    const hideSA = "";
    const users = db
      .prepare(
        `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active, created_at, mobile, department, account_status,
         COALESCE(allow_gps,0) AS allow_gps, COALESCE(allow_face,1) AS allow_face, COALESCE(allow_biometric,1) AS allow_biometric, COALESCE(allow_manual,0) AS allow_manual
         FROM users u WHERE u.deleted_at IS NULL AND (u.account_status IS NULL OR u.account_status = 'ACTIVE')${hideSA}${scU.sql}${baU.sql} ORDER BY u.full_name`
      )
      .all(...scU.params, ...baU.params);
    res.json({ users });
  });

  router.post("/users", attachUser, requirePerm("users:create"), (req, res) => {
    const {
      email,
      login_id,
      password,
      full_name,
      role,
      branch_id,
      shift_start,
      shift_end,
      grace_minutes,
      mobile,
      department,
      allow_gps,
      allow_face,
      allow_biometric,
      allow_manual,
    } = req.body || {};
    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: "email, password, full_name, role required" });
    }
    const normalizedRole = normalizeRoleInput(role);
    if (!normalizedRole || !Object.values(ROLES).includes(normalizedRole)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (normalizedRole === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can create another Super Admin" });
    }
    const arCheck = assertRoleAssignableOnCreate(req.currentUser, normalizedRole);
    if (!arCheck.ok) return res.status(arCheck.status).json({ error: arCheck.error });
    if (isBranchScoped(req.currentUser)) {
      const bid = branch_id != null ? Number(branch_id) : req.currentUser.branch_id;
      if (req.currentUser.branch_id == null || Number(bid) !== Number(req.currentUser.branch_id)) {
        return res.status(403).json({ error: "Users must be assigned to your branch" });
      }
    }
    const hash = bcrypt.hashSync(String(password), 10);
    const ag = allow_gps !== undefined ? (allow_gps ? 1 : 0) : 0;
    const af = allow_face !== undefined ? (allow_face ? 1 : 0) : 1;
    const abm = allow_biometric !== undefined ? (allow_biometric ? 1 : 0) : 1;
    const am = allow_manual !== undefined ? (allow_manual ? 1 : 0) : 0;
    try {
      const info = db
        .prepare(
          `INSERT INTO users (email, login_id, password_hash, full_name, role, branch_id, mobile, department, shift_start, shift_end, grace_minutes, allow_gps, allow_face, allow_biometric, allow_manual)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          String(email).trim(),
          login_id ? String(login_id).trim() : null,
          hash,
          String(full_name).trim(),
          normalizedRole,
          branch_id ? Number(branch_id) : null,
          mobile ? String(mobile) : null,
          department ? String(department) : null,
          shift_start || "09:00",
          shift_end || "18:00",
          (grace_minutes === undefined || grace_minutes === null || grace_minutes === "") ? 1 : Number(grace_minutes) || 0,
          ag,
          af,
          abm,
          am
        );
      const u = db
        .prepare(
          `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active, mobile, department,
           COALESCE(allow_gps,0) AS allow_gps, COALESCE(allow_face,1) AS allow_face, COALESCE(allow_biometric,1) AS allow_biometric, COALESCE(allow_manual,0) AS allow_manual
           FROM users WHERE id = ?`
        )
        .get(info.lastInsertRowid);
      insertAudit(req.currentUser.id, "user_create", "user", u.id, { email: u.email });
      seedRoleDefaults(normalizedRole);
      scheduleUserSync(db, u.id);
      appsScriptScheduleUser(db, u.id);
      res.json({ user: u });
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "Email already exists" });
      }
      throw e;
    }
  });

  const patchUserHandler = (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    const scopeU = assertUserAccess(req.currentUser, target);
    if (!scopeU.ok) return res.status(scopeU.status).json({ error: scopeU.error });
    if (target.role === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    console.log("[users.update] request", {
      actorId: req.currentUser?.id,
      userId: id,
      body: req.body || {},
    });
    const {
      full_name,
      login_id,
      branch_id,
      shift_start,
      shift_end,
      grace_minutes,
      mobile,
      department,
      dob,
      joining_date,
      address,
      account_number,
      ifsc,
      bank_name,
      active,
      role,
      password,
      allow_gps,
      allow_face,
      allow_biometric,
      allow_manual,
    } = req.body || {};
    if (password != null && String(password).length > 0 && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin may set password" });
    }
    if (role && role !== target.role && !isOrgWide(req.currentUser)) {
      return res.status(403).json({ error: "Only Super Admin or Admin may change roles" });
    }
    const normalizedPatchRole = role ? normalizeRoleInput(role) : null;
    if (role && !normalizedPatchRole) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (normalizedPatchRole === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin may assign Super Admin role" });
    }
    if (normalizedPatchRole === ROLES.ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin may assign Admin role" });
    }
    const branchVal = branch_id === undefined ? null : branch_id;
    const activeVal = active === undefined ? null : active ? 1 : 0;
    db.prepare(
      `UPDATE users SET
        full_name = COALESCE(?, full_name),
        login_id = COALESCE(?, login_id),
        branch_id = CASE WHEN ? IS NULL THEN branch_id ELSE ? END,
        mobile = COALESCE(?, mobile),
        department = COALESCE(?, department),
        dob = COALESCE(?, dob),
        joining_date = COALESCE(?, joining_date),
        address = COALESCE(?, address),
        account_number = COALESCE(?, account_number),
        ifsc = COALESCE(?, ifsc),
        bank_name = COALESCE(?, bank_name),
        shift_start = COALESCE(?, shift_start),
        shift_end = COALESCE(?, shift_end),
        grace_minutes = COALESCE(?, grace_minutes),
        active = CASE WHEN ? IS NULL THEN active ELSE ? END,
        role = COALESCE(?, role)
       WHERE id = ?`
    ).run(
      full_name || null,
      login_id || null,
      branchVal,
      branchVal,
      mobile || null,
      department || null,
      dob || null,
      joining_date || null,
      address || null,
      account_number || null,
      ifsc || null,
      bank_name || null,
      shift_start || null,
      shift_end || null,
      grace_minutes === undefined ? null : grace_minutes,
      activeVal,
      activeVal,
      normalizedPatchRole || null,
      id
    );
    if (allow_gps !== undefined) {
      db.prepare(`UPDATE users SET allow_gps = ? WHERE id = ?`).run(allow_gps ? 1 : 0, id);
    }
    if (allow_face !== undefined) {
      db.prepare(`UPDATE users SET allow_face = ? WHERE id = ?`).run(allow_face ? 1 : 0, id);
    }
    if (allow_biometric !== undefined) {
      db.prepare(`UPDATE users SET allow_biometric = ? WHERE id = ?`).run(allow_biometric ? 1 : 0, id);
    }
    if (allow_manual !== undefined) {
      db.prepare(`UPDATE users SET allow_manual = ? WHERE id = ?`).run(allow_manual ? 1 : 0, id);
    }
    if (password != null && String(password).length > 0) {
      const hash = bcrypt.hashSync(String(password), 10);
      db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, id);
    }
    const u = db
      .prepare(
        `SELECT id, email, login_id, full_name, role, branch_id, mobile, department, dob, joining_date, address, account_number, ifsc, bank_name, shift_start, shift_end, grace_minutes, active,
         COALESCE(allow_gps,0) AS allow_gps, COALESCE(allow_face,1) AS allow_face, COALESCE(allow_biometric,1) AS allow_biometric, COALESCE(allow_manual,0) AS allow_manual FROM users WHERE id = ?`
      )
      .get(id);
    insertAudit(req.currentUser.id, "user_update", "user", id, {});
    if (normalizedPatchRole) seedRoleDefaults(normalizedPatchRole);
    scheduleUserSync(db, id);
    appsScriptScheduleUser(db, id);
    console.log("[users.update] db_response", { id: u?.id, login_id: u?.login_id, active: u?.active });
    res.json({ user: u });
  };
  router.patch("/users/:id", attachUser, requirePerm("users:update"), patchUserHandler);
  router.patch("/staff/:id", attachUser, requirePerm("users:update"), patchUserHandler);
  router.patch("/employees/:id", attachUser, requirePerm("users:update"), patchUserHandler);
  router.put("/staff/:id", attachUser, requirePerm("users:update"), patchUserHandler);
  router.put("/users/:id", attachUser, requirePerm("users:update"), patchUserHandler);
  router.put("/employees/:id", attachUser, requirePerm("users:update"), patchUserHandler);
  router.delete("/staff/:id", attachUser, requirePerm("users:update"), (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.role === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (target.role === ROLES.ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Only Super Admin or Admin may delete Admin users" });
    }
    db.prepare("UPDATE users SET active = 0, deleted_at = datetime('now') WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "staff_delete", "user", id, {});
    res.json({ ok: true, id });
  });
  router.delete("/users/:id", attachUser, requirePerm("users:update"), (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.role === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (target.role === ROLES.ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Only Super Admin or Admin may delete Admin users" });
    }
    db.prepare("UPDATE users SET active = 0, deleted_at = datetime('now') WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "staff_delete", "user", id, {});
    res.json({ ok: true, id });
  });
  router.delete("/employees/:id", attachUser, requirePerm("users:update"), (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.role === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (target.role === ROLES.ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Only Super Admin or Admin may delete Admin users" });
    }
    db.prepare("UPDATE users SET active = 0, deleted_at = datetime('now') WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "staff_delete", "user", id, {});
    res.json({ ok: true, id });
  });
  router.post("/users/:id/lock", attachUser, requirePerm("users:update"), (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.role === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (target.role === ROLES.ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin may lock Admin users" });
    }
    db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "user_lock", "user", id, {});
    res.json({ ok: true, id, active: 0 });
  });
  router.post("/users/:id/unlock", attachUser, requirePerm("users:update"), (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.role === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    db.prepare("UPDATE users SET active = 1 WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "user_unlock", "user", id, {});
    res.json({ ok: true, id, active: 1 });
  });

  const _adminTempPasswords = new Map();
  router.post("/users/:id/reset-password", attachUser, requirePerm("users:update"), (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Only Super Admin or Admin can reset passwords" });
    }
    const id = Number(req.params.id);
    const target = db.prepare("SELECT id, role, full_name FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    // ADMIN can only reset USER / LOCATION_MANAGER passwords; SUPER_ADMIN can reset anyone except another SUPER_ADMIN
    if (req.currentUser.role === ROLES.ADMIN && ![ROLES.USER, ROLES.LOCATION_MANAGER].includes(target.role)) {
      return res.status(403).json({ error: "Admin can only reset passwords for Staff and Location Managers" });
    }
    if (target.role === ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Cannot reset Super Admin password" });
    }
    // Accept a custom password from request body, or generate a random one
    const customPw = String(req.body?.new_password || "").trim();
    let pwd;
    if (customPw) {
      if (customPw.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
      pwd = customPw;
    } else {
      const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$";
      pwd = "";
      for (let i = 0; i < 10; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(pwd, 10), id);
    _adminTempPasswords.set(id, { pwd, at: Date.now() });
    insertAudit(req.currentUser.id, "admin_password_reset", "user", id, { target_name: target.full_name, custom: !!customPw });
    res.json({ ok: true, new_password: pwd, staff_name: target.full_name, message: "Password updated. Share securely with the staff member." });
  });

  router.post("/users/:id/reveal-password", attachUser, requirePerm("users:update"), (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN && req.currentUser.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Only Super Admin or Admin can reveal passwords" });
    }
    const id = Number(req.params.id);
    const entry = _adminTempPasswords.get(id);
    if (!entry) {
      return res.status(404).json({ error: "No temporary password found. Use 'Generate temp password' first." });
    }
    const ageMs = Date.now() - entry.at;
    if (ageMs > 86400000) {
      _adminTempPasswords.delete(id);
      return res.status(410).json({ error: "Temporary password expired (>24h). Generate a new one." });
    }
    insertAudit(req.currentUser.id, "admin_password_reveal", "user", id, {});
    res.json({ temporary_password: entry.pwd, note: `Set ${Math.round(ageMs / 60000)}m ago` });
  });

  router.post("/staff/:id/photo", attachUser, requirePerm("users:update"), uploadFace.single("photo"), (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (!req.file) return res.status(400).json({ error: "photo file required" });
    const photoPath = `/uploads/faces/${req.file.filename}`;
    db.prepare("UPDATE users SET profile_photo = ? WHERE id = ?").run(photoPath, id);
    insertAudit(req.currentUser.id, "staff_photo_upload", "user", id, {});
    res.json({ id, profile_photo: photoPath });
  });

  router.get("/timings/me", attachUser, (req, res) => {
    const u = req.currentUser;
    res.json({
      shift_start: u.shift_start,
      shift_end: u.shift_end,
      grace_minutes: u.grace_minutes,
    });
  });

  router.patch("/timings/bulk", attachUser, (req, res) => {
    if (!can(req.currentUser, "timings:write")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { ids, shift_start, shift_end, grace_minutes } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    const stmt = db.prepare(
      `UPDATE users SET shift_start = COALESCE(?, shift_start),
        shift_end = COALESCE(?, shift_end),
        grace_minutes = COALESCE(?, grace_minutes)
       WHERE id = ? AND deleted_at IS NULL`
    );
    let updated = 0;
    for (const uid of ids) {
      const r = stmt.run(shift_start || null, shift_end || null, grace_minutes ?? null, Number(uid));
      if (r.changes > 0) updated++;
    }
    res.json({ ok: true, updated });
  });

  router.patch("/timings/:userId", attachUser, (req, res) => {
    if (!can(req.currentUser, "timings:write")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.userId);
    const { shift_start, shift_end, grace_minutes } = req.body || {};
    db.prepare(
      `UPDATE users SET shift_start = COALESCE(?, shift_start),
        shift_end = COALESCE(?, shift_end),
        grace_minutes = COALESCE(?, grace_minutes)
       WHERE id = ?`
    ).run(shift_start || null, shift_end || null, grace_minutes ?? null, id);
    const u = db
      .prepare(
        "SELECT id, email, full_name, role, branch_id, shift_start, shift_end, grace_minutes FROM users WHERE id = ?"
      )
      .get(id);
    appsScriptScheduleUser(db, id);
    res.json({ user: u });
  });

  router.get("/employees/preview-id", attachUser, (req, res) => {
    const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;
    const preview = generateUniqueBranchEmployeeId(branchId);
    res.json({ preview });
  });

  router.get("/roles", attachUser, (req, res) => {
    if (!can(req.currentUser, "roles:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ roles: listRolesMeta() });
  });
  router.get("/roles/custom", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const roles = db
      .prepare(
        `SELECT id, name, permissions_json, active, created_at, updated_at
         FROM custom_roles ORDER BY id DESC`
      )
      .all()
      .map((r) => ({
        ...r,
        permissions: (() => {
          try {
            return JSON.parse(r.permissions_json || "[]");
          } catch {
            return [];
          }
        })(),
      }));
    res.json({ roles });
  });
  router.post("/roles/custom", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const name = String(req.body?.name || "").trim();
    const permissions = Array.isArray(req.body?.permissions)
      ? req.body.permissions.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!name) return res.status(400).json({ error: "name required" });
    const info = db
      .prepare(
        `INSERT INTO custom_roles (name, permissions_json, active, created_by)
         VALUES (?, ?, 1, ?)`
      )
      .run(name, JSON.stringify(permissions), req.currentUser.id);
    insertAudit(req.currentUser.id, "role_create", "custom_role", info.lastInsertRowid, { name, permissions });
    res.json({ role: db.prepare("SELECT * FROM custom_roles WHERE id = ?").get(info.lastInsertRowid) });
  });
  router.patch("/roles/custom/:id", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const id = Number(req.params.id);
    const name = req.body?.name != null ? String(req.body.name).trim() : null;
    const permissions = Array.isArray(req.body?.permissions)
      ? req.body.permissions.map((x) => String(x).trim()).filter(Boolean)
      : null;
    const active = req.body?.active;
    db.prepare(
      `UPDATE custom_roles SET
       name = COALESCE(?, name),
       permissions_json = COALESCE(?, permissions_json),
       active = CASE WHEN ? IS NULL THEN active ELSE ? END,
       updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      name || null,
      permissions ? JSON.stringify(permissions) : null,
      active === undefined ? null : (active ? 1 : 0),
      active === undefined ? null : (active ? 1 : 0),
      id
    );
    const role = db.prepare("SELECT * FROM custom_roles WHERE id = ?").get(id);
    if (!role) return res.status(404).json({ error: "Not found" });
    insertAudit(req.currentUser.id, "role_update", "custom_role", id, {});
    res.json({ role });
  });
  router.delete("/roles/custom/:id", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const id = Number(req.params.id);
    const r = db.prepare("SELECT id FROM custom_roles WHERE id = ?").get(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    db.prepare("DELETE FROM user_role_assignments WHERE custom_role_id = ?").run(id);
    db.prepare("DELETE FROM custom_roles WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "role_delete", "custom_role", id, {});
    res.json({ ok: true, id });
  });
  router.post("/roles/custom/:id/assign-user", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const roleId = Number(req.params.id);
    const userId = Number(req.body?.user_id || 0);
    if (!userId) return res.status(400).json({ error: "user_id required" });
    const role = db.prepare("SELECT id, active FROM custom_roles WHERE id = ?").get(roleId);
    if (!role || !role.active) return res.status(404).json({ error: "Role not found" });
    const user = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").get(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    db.prepare(
      `INSERT OR REPLACE INTO user_role_assignments (user_id, custom_role_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(userId, roleId, req.currentUser.id);
    insertAudit(req.currentUser.id, "role_assign", "user", userId, { roleId });
    res.json({ ok: true, user_id: userId, custom_role_id: roleId });
  });
  router.delete("/roles/custom/unassign-user/:userId", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Super Admin only" });
    }
    const userId = Number(req.params.userId);
    db.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").run(userId);
    insertAudit(req.currentUser.id, "role_unassign", "user", userId, {});
    res.json({ ok: true, user_id: userId });
  });

  // ── Notice Board (upgraded: types, targeting, reply controls) ────────────
  const NOTICE_TYPES = ["announcement", "discussion", "alert", "query"];

  // Audience gate for any notice-by-id route. Returns true if the user is
  // allowed to read/interact with the given notice based on branch/role/visibility.
  function canAccessNotice(user, noticeId) {
    if (!user) return false;
    const n = db.prepare(
      `SELECT id, active, target_branch_id, target_role, visible_from, visible_until
       FROM notices WHERE id = ?`
    ).get(noticeId);
    if (!n) return false;
    // Writers (Admin/SA/etc with notices:write) can access any active notice
    if (can(user, "notices:write")) return n.active === 1;
    if (n.active !== 1) return false;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    if (n.visible_from && n.visible_from > now) return false;
    if (n.visible_until && n.visible_until < now) return false;
    if (n.target_branch_id != null && Number(n.target_branch_id) !== Number(user.branch_id || 0)) return false;
    if (n.target_role && n.target_role !== user.role) return false;
    return true;
  }

  router.get("/notices", attachUser, (req, res) => {
    if (!can(req.currentUser, "notices:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const u = req.currentUser;
    const isWriter = can(u, "notices:write");

    // Scope: 'active' (default) shows live notices; 'archive' (Admin/SA only)
    // shows soft-deleted OR past-visible_until notices for history view.
    const scope = String(req.query.scope || "active").toLowerCase();
    const isAdminOrSA = u.role === ROLES.SUPER_ADMIN || u.role === ROLES.ADMIN;
    const wantArchive = scope === "archive" && isAdminOrSA;

    // Build the query safely with parameterized values only
    let sql = `
      SELECT n.*,
        u2.full_name AS author_name,
        CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END AS read_by_me,
        (SELECT COUNT(*) FROM notice_replies WHERE notice_id = n.id) AS reply_count,
        b.name AS target_branch_name
      FROM notices n
      JOIN users u2 ON u2.id = n.created_by
      LEFT JOIN notice_reads nr ON nr.notice_id = n.id AND nr.user_id = ?
      LEFT JOIN branches b ON b.id = n.target_branch_id
      WHERE 1=1`;

    const params = [u.id];

    if (wantArchive) {
      // Archive: deleted (active=0) OR expired (visible_until in past)
      sql += `
        AND (
          n.active = 0
          OR (n.visible_until IS NOT NULL AND datetime(n.visible_until) < datetime('now'))
        )`;
    } else {
      // Active: live + within visibility window
      sql += `
        AND n.active = 1
        AND (n.visible_from IS NULL OR datetime(n.visible_from) <= datetime('now'))
        AND (n.visible_until IS NULL OR datetime(n.visible_until) >= datetime('now'))`;
    }

    if (!isWriter) {
      sql += `
        AND (n.target_branch_id IS NULL OR n.target_branch_id = ?)
        AND (n.target_role IS NULL OR n.target_role = ?)`;
      params.push(Number(u.branch_id) || 0, u.role);
    }

    // Admin branch filter
    if (isWriter && req.query.branch_id) {
      sql += ` AND n.target_branch_id = ?`;
      params.push(Number(req.query.branch_id));
    }
    if (isWriter && req.query.notice_type) {
      sql += ` AND n.notice_type = ?`;
      params.push(String(req.query.notice_type));
    }

    sql += ` ORDER BY n.created_at DESC LIMIT 200`;
    const rows = db.prepare(sql).all(...params);
    res.json({ notices: rows });
  });

  // PATCH /notices/:id — full edit (Admin / Super Admin only, per spec)
  router.patch("/notices/:id", attachUser, (req, res) => {
    const u = req.currentUser;
    const isAdminOrSA = u.role === ROLES.SUPER_ADMIN || u.role === ROLES.ADMIN;
    if (!isAdminOrSA) {
      return res.status(403).json({ error: "Only Admin / Super Admin can edit notices" });
    }
    const id = Number(req.params.id);
    const cur = db.prepare(`SELECT * FROM notices WHERE id = ?`).get(id);
    if (!cur) return res.status(404).json({ error: "Not found" });

    const b = req.body || {};
    const next = {
      title: b.title !== undefined ? String(b.title).trim() : cur.title,
      body: b.body !== undefined ? String(b.body) : cur.body,
      notice_type: b.notice_type && NOTICE_TYPES.includes(b.notice_type) ? b.notice_type : cur.notice_type,
      target_branch_id: b.target_branch_id !== undefined
        ? (b.target_branch_id === null || b.target_branch_id === "" ? null : Number(b.target_branch_id))
        : cur.target_branch_id,
      target_role: b.target_role !== undefined
        ? (b.target_role && b.target_role !== "ALL" ? String(b.target_role) : null)
        : cur.target_role,
      allow_replies: b.allow_replies !== undefined ? (b.allow_replies ? 1 : 0) : cur.allow_replies,
      admin_replies_only: b.admin_replies_only !== undefined ? (b.admin_replies_only ? 1 : 0) : cur.admin_replies_only,
      visible_from: b.visible_from !== undefined ? (b.visible_from || null) : cur.visible_from,
      visible_until: b.visible_until !== undefined ? (b.visible_until || null) : cur.visible_until,
      active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
    };

    if (!next.title || !next.body) {
      return res.status(400).json({ error: "title and body required" });
    }

    // Non-admin writers locked to their own branch (same rule as POST)
    if (!isAdminOrSA) {
      next.target_branch_id = u.branch_id || null;
    }

    db.prepare(
      `UPDATE notices
         SET title = ?, body = ?, notice_type = ?,
             target_branch_id = ?, target_role = ?,
             allow_replies = ?, admin_replies_only = ?,
             visible_from = ?, visible_until = ?, active = ?
       WHERE id = ?`
    ).run(
      next.title, next.body, next.notice_type,
      next.target_branch_id, next.target_role,
      next.allow_replies, next.admin_replies_only,
      next.visible_from, next.visible_until, next.active,
      id
    );

    appsScriptScheduleNotice(db, id);
    insertAudit(u.id, "notice_update", "notice", id, { title: next.title });

    const n = db.prepare(
      `SELECT n.*, u2.full_name AS author_name,
              0 AS read_by_me,
              (SELECT COUNT(*) FROM notice_replies WHERE notice_id = n.id) AS reply_count,
              b.name AS target_branch_name
         FROM notices n
         JOIN users u2 ON u2.id = n.created_by
         LEFT JOIN branches b ON b.id = n.target_branch_id
        WHERE n.id = ?`
    ).get(id);
    res.json({ notice: n });
  });

  router.post("/notices", attachUser, requirePerm("notices:write"), (req, res) => {
    const { title, body, visible_from, visible_until, notice_type, target_branch_id, target_role, allow_replies, admin_replies_only } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: "title and body required" });

    const type = NOTICE_TYPES.includes(notice_type) ? notice_type : "announcement";
    const u = req.currentUser;

    // Branch restriction: non-SA/Admin writers can only target their own branch
    let branchId = target_branch_id != null ? Number(target_branch_id) || null : null;
    const isSuperOrAdmin = u.role === ROLES.SUPER_ADMIN || u.role === ROLES.ADMIN;
    if (!isSuperOrAdmin && branchId !== null && branchId !== u.branch_id) {
      branchId = u.branch_id || null; // Enforce own branch
    }
    if (!isSuperOrAdmin && branchId === null) {
      branchId = u.branch_id || null; // Non-SA/Admin always scoped to their branch
    }

    const roleFilter = target_role && target_role !== "ALL" ? String(target_role) : null;
    const allowReplies = allow_replies === false || allow_replies === 0 ? 0 : 1;
    const adminRepliesOnly = admin_replies_only ? 1 : 0;

    const info = db
      .prepare(
        `INSERT INTO notices
           (title, body, created_by, visible_from, visible_until,
            notice_type, target_branch_id, target_role, allow_replies, admin_replies_only)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        String(title), String(body), u.id,
        visible_from || null, visible_until || null,
        type, branchId, roleFilter, allowReplies, adminRepliesOnly
      );
    appsScriptScheduleNotice(db, info.lastInsertRowid);
    const n = db
      .prepare(`SELECT n.*, u2.full_name AS author_name, 0 AS read_by_me, 0 AS reply_count, b.name AS target_branch_name
                FROM notices n JOIN users u2 ON u2.id = n.created_by LEFT JOIN branches b ON b.id = n.target_branch_id
                WHERE n.id = ?`)
      .get(info.lastInsertRowid);
    // Fire-and-forget push notification to all targeted recipients
    try {
      let recipientSql = `SELECT id FROM users WHERE active = 1 AND deleted_at IS NULL
                          AND (account_status IS NULL OR account_status = 'ACTIVE')
                          AND id != ?`;
      const recipientParams = [u.id];
      if (branchId !== null) { recipientSql += ` AND branch_id = ?`; recipientParams.push(branchId); }
      if (roleFilter)        { recipientSql += ` AND role = ?`;      recipientParams.push(roleFilter); }
      const ids = db.prepare(recipientSql).all(...recipientParams).map(r => r.id);
      if (ids.length) {
        pushNotifications.sendToUsers(db, ids, {
          title: `📢 ${String(title).slice(0, 60)}`,
          body: String(body).slice(0, 140),
          url: "/notices",
          tag: `notice-${info.lastInsertRowid}`,
          noticeId: info.lastInsertRowid,
        }).catch(() => {});
      }
    } catch (e) { /* never block notice creation */ }
    res.json({ notice: n });
  });

  router.delete("/notices/:id", attachUser, requirePerm("notices:write"), (req, res) => {
    const id = Number(req.params.id);
    const n = db.prepare("SELECT id, created_by FROM notices WHERE id = ?").get(id);
    if (!n) return res.status(404).json({ error: "Not found" });
    // Non-SA/Admin can only delete their own notices
    const u = req.currentUser;
    if (u.role !== ROLES.SUPER_ADMIN && u.role !== ROLES.ADMIN && n.created_by !== u.id) {
      return res.status(403).json({ error: "Can only delete your own notices" });
    }
    db.prepare("UPDATE notices SET active = 0 WHERE id = ?").run(id);
    insertAudit(u.id, "notice_delete", "notice", id, { title: n.title });
    res.json({ ok: true });
  });

  // Lightweight unread badge (called frequently from sidebar)
  router.get("/notices/unread-count", attachUser, (req, res) => {
    if (!can(req.currentUser, "notices:read")) return res.json({ count: 0 });
    const u = req.currentUser;
    const isWriter = can(u, "notices:write");
    let sql = `SELECT COUNT(*) AS c FROM notices n
               LEFT JOIN notice_reads nr ON nr.notice_id = n.id AND nr.user_id = ?
               WHERE n.active = 1 AND nr.user_id IS NULL
                 AND (n.visible_from IS NULL OR datetime(n.visible_from) <= datetime('now'))
                 AND (n.visible_until IS NULL OR datetime(n.visible_until) >= datetime('now'))
                 AND n.created_by != ?`;
    const params = [u.id, u.id];
    if (!isWriter) {
      sql += ` AND (n.target_branch_id IS NULL OR n.target_branch_id = ?)
               AND (n.target_role IS NULL OR n.target_role = ?)`;
      params.push(Number(u.branch_id) || 0, u.role);
    }
    try {
      const row = db.prepare(sql).get(...params);
      res.json({ count: Number(row?.c || 0) });
    } catch { res.json({ count: 0 }); }
  });

  // ── Web Push subscription endpoints ───────────────────────────────────
  router.get("/push/vapid-public-key", (req, res) => {
    const k = pushNotifications.getPublicKey();
    if (!k) return res.status(503).json({ error: "Push not configured" });
    res.json({ key: k });
  });

  router.post("/push/subscribe", attachUser, (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "Invalid subscription" });
    }
    const ua = String(req.headers["user-agent"] || "").slice(0, 240);
    try {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
         VALUES (?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id=excluded.user_id,
           p256dh=excluded.p256dh,
           auth=excluded.auth,
           user_agent=excluded.user_agent,
           last_used_at=datetime('now')`
      ).run(req.currentUser.id, endpoint, keys.p256dh, keys.auth, ua);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/push/unsubscribe", attachUser, (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
      .run(endpoint, req.currentUser.id);
    res.json({ ok: true });
  });

  router.post("/notices/:id/read", attachUser, (req, res) => {
    const id = Number(req.params.id);
    if (!canAccessNotice(req.currentUser, id)) return res.status(404).json({ error: "Not found" });
    db.prepare("INSERT OR REPLACE INTO notice_reads (notice_id, user_id, read_at) VALUES (?,?,datetime('now'))").run(
      id, req.currentUser.id
    );
    res.json({ ok: true });
  });

  router.get("/notices/:id/replies", attachUser, (req, res) => {
    if (!can(req.currentUser, "notices:read")) return res.status(403).json({ error: "Forbidden" });
    const id = Number(req.params.id);
    if (!canAccessNotice(req.currentUser, id)) return res.status(404).json({ error: "Not found" });
    const rows = db
      .prepare(
        `SELECT r.id, r.notice_id, r.user_id, r.body, r.created_at,
                u.full_name AS user_name, u.role AS user_role,
                r.is_admin_reply
         FROM notice_replies r
         JOIN users u ON u.id = r.user_id
         WHERE r.notice_id = ?
         ORDER BY r.id ASC`
      )
      .all(id);
    res.json({ replies: rows });
  });

  router.post("/notices/:id/replies", attachUser, (req, res) => {
    const id = Number(req.params.id);
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ error: "body required" });
    if (!canAccessNotice(req.currentUser, id)) return res.status(404).json({ error: "Not found" });
    const n = db.prepare("SELECT id, allow_replies, admin_replies_only FROM notices WHERE id = ? AND active = 1").get(id);
    if (!n) return res.status(404).json({ error: "Not found" });
    if (!n.allow_replies) return res.status(403).json({ error: "Replies are disabled for this notice" });
    const u = req.currentUser;
    const isWriter = can(u, "notices:write");
    if (n.admin_replies_only && !isWriter) {
      return res.status(403).json({ error: "Only admins can reply to this notice" });
    }
    const isAdminReply = isWriter ? 1 : 0;
    const info = db
      .prepare("INSERT INTO notice_replies (notice_id, user_id, body, is_admin_reply) VALUES (?,?,?,?)")
      .run(id, u.id, body, isAdminReply);
    const row = db
      .prepare(
        `SELECT r.id, r.notice_id, r.user_id, r.body, r.created_at,
                u.full_name AS user_name, u.role AS user_role, r.is_admin_reply
         FROM notice_replies r JOIN users u ON u.id = r.user_id WHERE r.id = ?`
      )
      .get(info.lastInsertRowid);
    res.json({ reply: row });
  });

  router.delete("/notices/:id/replies/:rid", attachUser, (req, res) => {
    const rid = Number(req.params.rid);
    const r = db.prepare("SELECT id, user_id FROM notice_replies WHERE id = ?").get(rid);
    if (!r) return res.status(404).json({ error: "Not found" });
    const u = req.currentUser;
    // Writer can delete any reply; staff can delete their own
    if (!can(u, "notices:write") && r.user_id !== u.id) {
      return res.status(403).json({ error: "Not allowed" });
    }
    db.prepare("DELETE FROM notice_replies WHERE id = ?").run(rid);
    res.json({ ok: true });
  });

  // Helper: return the list of users who are intended recipients for a notice
  // (active + not deleted + account ACTIVE, excluding the author) filtered by
  // its target_branch_id / target_role if set.
  function targetUsersForNotice(notice) {
    let sql = `SELECT u.id, u.full_name, u.role, b.name AS branch_name
               FROM users u
               LEFT JOIN branches b ON b.id = u.branch_id
               WHERE u.active = 1 AND u.deleted_at IS NULL
                 AND (u.account_status IS NULL OR u.account_status = 'ACTIVE')
                 AND u.id != ?`;
    const params = [notice.created_by];
    if (notice.target_branch_id) { sql += ` AND u.branch_id = ?`; params.push(notice.target_branch_id); }
    if (notice.target_role)      { sql += ` AND u.role = ?`;      params.push(notice.target_role); }
    sql += ` ORDER BY b.name, u.full_name`;
    return db.prepare(sql).all(...params);
  }

  router.get("/notices/:id/stats", attachUser, requirePerm("notices:write"), (req, res) => {
    const id = Number(req.params.id);
    const notice = db
      .prepare("SELECT id, title, created_by, target_branch_id, target_role FROM notices WHERE id = ?")
      .get(id);
    if (!notice) return res.status(404).json({ error: "Not found" });
    const readCount = Number(db.prepare("SELECT COUNT(*) AS c FROM notice_reads WHERE notice_id = ?").get(id).c);
    const replyCount = Number(db.prepare("SELECT COUNT(*) AS c FROM notice_replies WHERE notice_id = ?").get(id).c);
    const reads = db
      .prepare(
        `SELECT nr.user_id, nr.read_at, u.full_name, u.role, b.name AS branch_name
         FROM notice_reads nr
         JOIN users u ON u.id = nr.user_id
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE nr.notice_id = ?
         ORDER BY nr.read_at DESC LIMIT 500`
      )
      .all(id);
    // Unread list = target users MINUS those in notice_reads
    const readIds = new Set(reads.map(r => r.user_id));
    const targets = targetUsersForNotice(notice);
    const unreads = targets
      .filter(t => !readIds.has(t.id))
      .map(t => ({ user_id: t.id, full_name: t.full_name, role: t.role, branch_name: t.branch_name }));
    const unansweredQueries = db
      .prepare(
        `SELECT COUNT(*) AS c FROM notice_replies
         WHERE notice_id = ? AND is_admin_reply = 0
           AND id > COALESCE((SELECT MAX(id) FROM notice_replies WHERE notice_id = ? AND is_admin_reply = 1), 0)`
      )
      .get(id, id);
    res.json({
      notice: { id: notice.id, title: notice.title },
      readCount,
      replyCount,
      targetCount: targets.length,
      unreadCount: unreads.length,
      reads,
      unreads,
      unansweredQueries: Number(unansweredQueries?.c || 0),
    });
  });

  // POST /notices/:id/nudge — re-send a push notification to every user who
  // has NOT yet read this notice. Rate-limit: one nudge per notice per 5 min
  // to avoid spam. Admin / Super Admin only (per spec).
  const lastNudgeAt = new Map(); // notice_id -> epoch ms
  router.post("/notices/:id/nudge", attachUser, (req, res) => {
    const u = req.currentUser;
    if (u.role !== ROLES.SUPER_ADMIN && u.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Only Admin / Super Admin can nudge" });
    }
    const id = Number(req.params.id);
    const n = db
      .prepare("SELECT id, title, body, created_by, target_branch_id, target_role, active FROM notices WHERE id = ?")
      .get(id);
    if (!n || !n.active) return res.status(404).json({ error: "Not found" });

    const now = Date.now();
    const last = lastNudgeAt.get(id) || 0;
    const cooldownMs = 5 * 60 * 1000;
    if (now - last < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - (now - last)) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSec}s before nudging again` });
    }

    const readRows = db.prepare("SELECT user_id FROM notice_reads WHERE notice_id = ?").all(id);
    const readIds = new Set(readRows.map(r => r.user_id));
    const targets = targetUsersForNotice(n);
    const unreadIds = targets.filter(t => !readIds.has(t.id)).map(t => t.id);

    if (unreadIds.length === 0) {
      return res.json({ ok: true, sent: 0, message: "Everyone has already seen this notice" });
    }

    lastNudgeAt.set(id, now);
    pushNotifications.sendToUsers(db, unreadIds, {
      title: `🔔 Reminder: ${String(n.title).slice(0, 55)}`,
      body: String(n.body).slice(0, 140),
      url: "/notices",
      tag: `notice-nudge-${id}`,
      noticeId: id,
    }).catch(() => {});
    insertAudit(u.id, "notice_nudge", "notice", id, { sent: unreadIds.length, title: n.title });
    res.json({ ok: true, sent: unreadIds.length });
  });

  router.get("/settings", attachUser, (req, res) => {
    if (!can(req.currentUser, "settings:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json(readAppSettings());
  });

  // ── Module Visibility Settings (stored in visibility_settings table) ──────
  const MODULE_VISIBILITY_DEFAULTS = {
    USER: {
      "dashboard.company_stats": false,
      "dashboard.today_attendance": true,
      "dashboard.employee_highlights": false,
      "dashboard.staff_by_branch": false,
      "dashboard.payroll": false,
      "dashboard.live_status": false,
      "dashboard.smart_alerts": false,
      "dashboard.pending_leaves": false,
      "nav.employees": false,
      "nav.reports": false,
      "nav.attendance": true,
      "nav.branches": false,
      "nav.payroll": true,
      "nav.kiosk": false,
    },
    ATTENDANCE_MANAGER: {
      "dashboard.company_stats": false,
      "dashboard.today_attendance": true,
      "dashboard.employee_highlights": true,
      "dashboard.staff_by_branch": true,
      "dashboard.payroll": false,
      "dashboard.live_status": true,
      "dashboard.smart_alerts": false,
      "dashboard.pending_leaves": true,
      "nav.employees": false,
      "nav.reports": true,
      "nav.attendance": true,
      "nav.branches": false,
      "nav.payroll": false,
      "nav.kiosk": true,
    },
    LOCATION_MANAGER: {
      "dashboard.company_stats": false,
      "dashboard.today_attendance": true,
      "dashboard.employee_highlights": false,
      "dashboard.staff_by_branch": true,
      "dashboard.payroll": false,
      "dashboard.live_status": true,
      "dashboard.smart_alerts": false,
      "dashboard.pending_leaves": false,
      "nav.employees": false,
      "nav.reports": false,
      "nav.attendance": true,
      "nav.branches": true,
      "nav.payroll": false,
      "nav.kiosk": true,
    },
    ADMIN: {
      "dashboard.company_stats": true,
      "dashboard.today_attendance": true,
      "dashboard.employee_highlights": true,
      "dashboard.staff_by_branch": true,
      "dashboard.payroll": true,
      "dashboard.live_status": true,
      "dashboard.smart_alerts": true,
      "dashboard.pending_leaves": true,
      "nav.employees": true,
      "nav.reports": true,
      "nav.attendance": true,
      "nav.branches": true,
      "nav.payroll": true,
      "nav.kiosk": true,
    },
    SUPER_ADMIN: {
      "dashboard.company_stats": true,
      "dashboard.today_attendance": true,
      "dashboard.employee_highlights": true,
      "dashboard.staff_by_branch": true,
      "dashboard.payroll": true,
      "dashboard.live_status": true,
      "dashboard.smart_alerts": true,
      "dashboard.pending_leaves": true,
      "nav.employees": true,
      "nav.reports": true,
      "nav.attendance": true,
      "nav.branches": true,
      "nav.payroll": true,
      "nav.kiosk": true,
    },
  };

  function readModuleVisibility() {
    const rows = db.prepare("SELECT role, feature, enabled FROM visibility_settings").all();
    const result = {};
    for (const [role, features] of Object.entries(MODULE_VISIBILITY_DEFAULTS)) {
      result[role] = { ...features };
    }
    if (rows.length === 0) {
      // Migrate from old KV store if available
      const kv = db.prepare("SELECT v FROM integration_kv WHERE k = 'module_visibility_v1'").get();
      if (kv?.v) {
        try {
          const stored = JSON.parse(kv.v);
          const stmt = db.prepare("INSERT OR IGNORE INTO visibility_settings (role, feature, enabled) VALUES (?, ?, ?)");
          for (const [role, features] of Object.entries(stored)) {
            if (MODULE_VISIBILITY_DEFAULTS[role]) {
              for (const [feature, enabled] of Object.entries(features)) {
                stmt.run(role, feature, enabled ? 1 : 0);
              }
            }
          }
          const migrated = db.prepare("SELECT role, feature, enabled FROM visibility_settings").all();
          for (const row of migrated) {
            if (result[row.role]) result[row.role][row.feature] = !!row.enabled;
          }
        } catch { /* ignore */ }
      }
    } else {
      for (const row of rows) {
        if (result[row.role]) result[row.role][row.feature] = !!row.enabled;
      }
    }
    return result;
  }

  function writeVisibilitySetting(role, feature, enabled) {
    db.prepare("INSERT OR REPLACE INTO visibility_settings (role, feature, enabled) VALUES (?, ?, ?)").run(
      role, feature, enabled ? 1 : 0
    );
  }

  /**
   * Seed default visibility settings for a role.
   * Uses INSERT OR IGNORE — never overwrites custom settings saved by Super Admin.
   * Safe to call repeatedly; idempotent.
   */
  function seedRoleDefaults(role) {
    const defaults = MODULE_VISIBILITY_DEFAULTS[role];
    if (!defaults) return;
    const stmt = db.prepare("INSERT OR IGNORE INTO visibility_settings (role, feature, enabled) VALUES (?, ?, ?)");
    for (const [feature, enabled] of Object.entries(defaults)) {
      stmt.run(role, feature, enabled ? 1 : 0);
    }
  }

  // Seed defaults for ALL roles on every startup (INSERT OR IGNORE = safe, no overwrites)
  for (const role of Object.keys(MODULE_VISIBILITY_DEFAULTS)) {
    seedRoleDefaults(role);
  }

  // Helper: get branch IDs that are blocked for a given role
  function getHiddenBranchIds(role) {
    const rows = db.prepare("SELECT branch_id FROM branch_access_rules WHERE role = ? AND accessible = 0").all(role);
    return rows.map((r) => r.branch_id);
  }

  // Build extra SQL for branch access rules (applies to ADMIN viewing scoped data)
  function branchAccessSql(actor, alias = "u") {
    if (!actor || actor.role === "SUPER_ADMIN") return { sql: "", params: [] };
    if (actor.role === "ADMIN") {
      const hidden = getHiddenBranchIds("ADMIN");
      if (hidden.length === 0) return { sql: "", params: [] };
      const ph = hidden.map(() => "?").join(",");
      return { sql: ` AND ${alias}.branch_id NOT IN (${ph})`, params: hidden };
    }
    return { sql: "", params: [] };
  }

  router.get("/settings/module-visibility", attachUser, (req, res) => {
    if (!can(req.currentUser, "settings:read")) return res.status(403).json({ error: "Forbidden" });
    res.json(readModuleVisibility());
  });
  router.post("/settings/module-visibility", attachUser, requirePerm("settings:write"), (req, res) => {
    if (req.currentUser.role !== "SUPER_ADMIN") return res.status(403).json({ error: "Super Admin only" });
    const body = req.body || {};
    for (const role of Object.keys(MODULE_VISIBILITY_DEFAULTS)) {
      if (body[role] && typeof body[role] === "object") {
        for (const [feature, enabled] of Object.entries(body[role])) {
          writeVisibilitySetting(role, feature, !!enabled);
        }
      }
    }
    insertAudit(req.currentUser.id, "module_visibility_update", "settings", "module_visibility", {});
    res.json(readModuleVisibility());
  });

  // ── Branch Access Control ─────────────────────────────────────────────────
  router.get("/settings/branch-access", attachUser, (req, res) => {
    if (!can(req.currentUser, "settings:read")) return res.status(403).json({ error: "Forbidden" });
    const branches = db.prepare("SELECT id, name FROM branches ORDER BY name").all();
    const rules = db.prepare("SELECT role, branch_id, accessible FROM branch_access_rules").all();
    const ruleMap = {};
    for (const r of rules) {
      if (!ruleMap[r.role]) ruleMap[r.role] = {};
      ruleMap[r.role][r.branch_id] = !!r.accessible;
    }
    res.json({ branches, rules: ruleMap });
  });
  router.post("/settings/branch-access", attachUser, requirePerm("settings:write"), (req, res) => {
    if (req.currentUser.role !== "SUPER_ADMIN") return res.status(403).json({ error: "Super Admin only" });
    const body = req.body || {};
    // body: { ADMIN: { 1: true, 2: false }, ATTENDANCE_MANAGER: { ... } }
    const stmt = db.prepare("INSERT OR REPLACE INTO branch_access_rules (role, branch_id, accessible) VALUES (?, ?, ?)");
    for (const [role, branchMap] of Object.entries(body)) {
      if (!MODULE_VISIBILITY_DEFAULTS[role]) continue;
      for (const [branchId, accessible] of Object.entries(branchMap)) {
        stmt.run(role, Number(branchId), accessible ? 1 : 0);
      }
    }
    insertAudit(req.currentUser.id, "branch_access_update", "settings", "branch_access", {});
    const branches = db.prepare("SELECT id, name FROM branches ORDER BY name").all();
    const rules = db.prepare("SELECT role, branch_id, accessible FROM branch_access_rules").all();
    const ruleMap = {};
    for (const r of rules) {
      if (!ruleMap[r.role]) ruleMap[r.role] = {};
      ruleMap[r.role][r.branch_id] = !!r.accessible;
    }
    res.json({ branches, rules: ruleMap });
  });
  router.get("/attendance/wifi-config", attachUser, (req, res) => {
    if (!can(req.currentUser, "settings:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const s = readAppSettings();
    const cfg = s.attendance_wifi || { enabled: false, networks: [], allowed_ssids: [] };
    res.json({
      enabled: !!cfg.enabled,
      networks: Array.isArray(cfg.networks) ? cfg.networks : [],
      allowed_ssids: Array.isArray(cfg.allowed_ssids) ? cfg.allowed_ssids : [],
    });
  });
  router.get("/attendance/geo-check", attachUser, (req, res) => {
    const lat = req.query.lat != null ? Number(req.query.lat) : null;
    const lng = req.query.lng != null ? Number(req.query.lng) : null;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ ok: false, error: "lat and lng required" });
    }
    const u = req.currentUser;
    if (!u?.branch_id) {
      return res.json({ ok: true, within: true, distance_m: 0, radius_m: null, branch: null });
    }
    const b = db.prepare("SELECT id, name, lat, lng, radius_meters FROM branches WHERE id = ?").get(u.branch_id);
    if (!b || b.lat == null || b.lng == null) {
      return res.json({ ok: true, within: true, distance_m: 0, radius_m: null, branch: b ? { id: b.id, name: b.name } : null });
    }
    const dist = Math.round(haversineMeters(lat, lng, b.lat, b.lng));
    const effectiveRadius = Number(b.radius_meters) === 0 ? 5 : Number(b.radius_meters);
    return res.json({
      ok: true,
      within: dist <= effectiveRadius,
      distance_m: dist,
      radius_m: Number(b.radius_meters),
      branch: { id: b.id, name: b.name },
    });
  });
  router.get("/attendance/wifi-options", attachUser, (req, res) => {
    const s = readAppSettings();
    const cfg = s.attendance_wifi || { enabled: false, networks: [] };
    const networks = (Array.isArray(cfg.networks) ? cfg.networks : []).map((n) => ({
      ssid: String(n?.ssid || "").trim(),
      requires_password: !!String(n?.password || "").trim(),
    })).filter((n) => n.ssid);
    res.json({ enabled: !!cfg.enabled, networks });
  });
  router.patch("/attendance/wifi-config", attachUser, requirePerm("settings:write"), (req, res) => {
    const cur = readAppSettings();
    const enabled = !!req.body?.enabled;
    const networks = Array.isArray(req.body?.networks)
      ? req.body.networks
          .map((n) => ({
            ssid: String(n?.ssid || "").trim(),
            password: String(n?.password || "").trim(),
            // ip_subnet: for mobile app WiFi verification (e.g. "192.168.1")
            // The mobile app sends device IP; server checks if it starts with this prefix.
            ip_subnet: String(n?.ip_subnet || "").trim(),
          }))
          .filter((n) => n.ssid || n.ip_subnet)
      : [];
    const ssids = networks.filter((n) => n.ssid).map((n) => n.ssid);
    const next = {
      ...cur,
      attendance_wifi: {
        enabled,
        networks,
        allowed_ssids: ssids,
      },
    };
    writeAppSettings(next);
    insertAudit(req.currentUser.id, "attendance_wifi_update", "settings", "attendance_wifi", {
      enabled,
      count: networks.length,
    });
    res.json(next.attendance_wifi);
  });

  router.patch("/settings", attachUser, requirePerm("settings:write"), (req, res) => {
    const cur = readAppSettings();
    const body = req.body || {};
    const mergedFeatures = { ...cur.features, ...(body.features || {}) };
    // Sync wifi_restriction feature flag with attendance_wifi.enabled
    const wifiRestrictionToggled = body.features?.wifi_restriction !== undefined;
    const curWifi = cur.attendance_wifi || { enabled: false, networks: [], allowed_ssids: [] };
    const syncedWifi = wifiRestrictionToggled
      ? { ...curWifi, enabled: !!mergedFeatures.wifi_restriction }
      : curWifi;
    const next = {
      ...cur,
      ...body,
      features: mergedFeatures,
      attendance_wifi: syncedWifi,
    };
    writeAppSettings(next);
    insertAudit(req.currentUser.id, "settings_update", "settings", "app", { keys: Object.keys(body) });
    res.json(readAppSettings());
  });
  router.get("/settings/daily-report", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can view report recipients" });
    }
    const s = readAppSettings();
    res.json(
      s.daily_report || {
        enabled: true,
        recipients: (process.env.REPORT_RECIPIENTS || process.env.ALERT_EMAIL_TO || "").split(",").map(e => e.trim()).filter(Boolean),
      }
    );
  });
  router.patch("/settings/daily-report", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can edit report recipients" });
    }
    const cur = readAppSettings();
    const recipients = Array.isArray(req.body?.recipients)
      ? req.body.recipients.map((x) => String(x).trim()).filter(Boolean)
      : (cur.daily_report?.recipients || []);
    const enabled = req.body?.enabled == null ? !!cur.daily_report?.enabled : !!req.body.enabled;
    const next = {
      ...cur,
      daily_report: {
        enabled,
        recipients,
      },
    };
    writeAppSettings(next);
    insertAudit(req.currentUser.id, "daily_report_settings_update", "settings", "daily_report", {
      enabled,
      recipientsCount: recipients.length,
    });
    res.json(next.daily_report);
  });

  router.get("/settings/daily-report/smtp-status", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin" });
    }
    const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    res.json({
      configured,
      host: process.env.SMTP_HOST || null,
      port: process.env.SMTP_PORT || null,
      user_set: !!process.env.SMTP_USER,
      pass_set: !!process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    });
  });

  router.get("/reports/daily-attendance", attachUser, (req, res) => {
    if (
      req.currentUser.role !== ROLES.SUPER_ADMIN &&
      req.currentUser.role !== ROLES.ADMIN &&
      req.currentUser.role !== ROLES.ATTENDANCE_MANAGER
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const { buildDailyReportData } = require("./dailyReport");
      const date = String(req.query.date || "").trim();
      const data = buildDailyReportData(db, /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined);
      res.json(data);
    } catch (e) {
      console.error("[reports/daily-attendance]", e);
      res.status(500).json({ error: e.message || "Failed to build report" });
    }
  });

  router.post("/settings/daily-report/test", attachUser, async (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can send test email" });
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(503).json({
        error: "SMTP not configured",
        hint: "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in environment secrets.",
      });
    }
    try {
      const { sendDailyHrmsReport } = require("./dailyReport");
      const r = await sendDailyHrmsReport(db);
      insertAudit(req.currentUser.id, "daily_report_test_send", "settings", "daily_report", { result: r });
      res.json({ ok: true, result: r });
    } catch (e) {
      console.error("[dailyReport:test]", e);
      res.status(500).json({ error: e.message || "Failed to send test email" });
    }
  });

  router.get("/hr/alerts", attachUser, (req, res) => {
    if (
      req.currentUser.role !== ROLES.SUPER_ADMIN &&
      req.currentUser.role !== ROLES.ADMIN &&
      req.currentUser.role !== ROLES.ATTENDANCE_MANAGER
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ alerts: listRecentAlerts(db, { limit: Number(req.query.limit) || 100 }) });
  });

  router.patch("/hr/alerts/:id/read", attachUser, (req, res) => {
    if (
      req.currentUser.role !== ROLES.SUPER_ADMIN &&
      req.currentUser.role !== ROLES.ADMIN &&
      req.currentUser.role !== ROLES.ATTENDANCE_MANAGER
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    db.prepare(`UPDATE hr_alerts SET read_by_admin = 1 WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  router.get("/audit/logs", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2000);
    const action = req.query.action ? String(req.query.action).trim() : null;
    const branchId = req.query.branch ? Number(req.query.branch) : null;
    const from = req.query.from ? String(req.query.from).trim() : null;
    const to = req.query.to ? String(req.query.to).trim() : null;
    const conds = [];
    const params = [];
    if (action) { conds.push("a.action = ?"); params.push(action); }
    if (branchId) { conds.push("u.branch_id = ?"); params.push(branchId); }
    if (from) { conds.push("a.created_at >= ?"); params.push(from); }
    if (to) { conds.push("a.created_at <= ?"); params.push(to + " 23:59:59"); }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    params.push(limit);
    const rows = db
      .prepare(
        `SELECT a.*, u.full_name AS actor_name, u.role AS actor_role, u.branch_id AS actor_branch
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ${where}
         ORDER BY a.id DESC
         LIMIT ?`
      )
      .all(...params);
    const actions = db.prepare("SELECT DISTINCT action FROM audit_logs ORDER BY action").all().map(r => r.action);
    res.json({ logs: rows, actions });
  });

  router.get("/trash/users", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const rows = db
      .prepare(
        `SELECT id, full_name, login_id, email, mobile, role, branch_id, deleted_at
         FROM users
         WHERE deleted_at IS NOT NULL
         ORDER BY datetime(deleted_at) DESC
         LIMIT 1000`
      )
      .all();
    res.json({ users: rows });
  });

  router.post("/trash/users/:id/restore", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NOT NULL").get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare("UPDATE users SET deleted_at = NULL, active = 1 WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "staff_restore", "user", id, {});
    res.json({ ok: true, id });
  });

  router.delete("/trash/users/:id", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can permanently delete" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id, full_name FROM users WHERE id = ? AND deleted_at IS NOT NULL").get(id);
    if (!row) return res.status(404).json({ error: "Not found in trash" });
    try {
      // node:sqlite (DatabaseSync) does NOT support db.transaction() like better-sqlite3.
      // Use manual BEGIN/COMMIT/ROLLBACK instead.
      const safeDelete = (sql, ...params) => {
        try { db.prepare(sql).run(...params); } catch (_) { /* table may not exist */ }
      };
      const deleteUser = (userId) => {
        db.exec("BEGIN");
        try {
          safeDelete("DELETE FROM attendance_records WHERE user_id = ?", userId);
          safeDelete("DELETE FROM leave_threads WHERE author_id = ?", userId);
          safeDelete("DELETE FROM leave_requests WHERE user_id = ? OR manager_action_by = ? OR admin_action_by = ?", userId, userId, userId);
          // Soft-delete the staff's own documents so they can be restored from Trash;
          // for documents this user verified, just clear the verifier link (don't lose the doc).
          try {
            db.prepare(
              `UPDATE employee_documents
               SET deleted_at = COALESCE(deleted_at, datetime('now')), deleted_by = ?
               WHERE user_id = ? AND deleted_at IS NULL`
            ).run(userId, userId);
          } catch (_) { /* column may not exist on legacy DBs */ }
          try {
            db.prepare("UPDATE employee_documents SET verified_by = NULL WHERE verified_by = ?").run(userId);
          } catch (_) { /* ignore */ }
          safeDelete("DELETE FROM payroll_entries WHERE user_id = ?", userId);
          safeDelete("DELETE FROM notice_reads WHERE user_id = ?", userId);
          safeDelete("DELETE FROM notice_replies WHERE user_id = ?", userId);
          safeDelete("DELETE FROM user_face_profiles WHERE user_id = ?", userId);
          safeDelete("DELETE FROM push_subscriptions WHERE user_id = ?", userId);
          safeDelete("DELETE FROM hr_chat_messages WHERE thread_user_id = ? OR author_id = ?", userId, userId);
          safeDelete("DELETE FROM hr_alerts WHERE user_id = ? OR actor_id = ?", userId, userId);
          safeDelete("DELETE FROM password_reset_tokens WHERE user_id = ?", userId);
          safeDelete("DELETE FROM password_reset_otps WHERE user_id = ?", userId);
          safeDelete("DELETE FROM user_role_assignments WHERE user_id = ? OR assigned_by = ?", userId, userId);
          safeDelete("DELETE FROM custom_roles WHERE created_by = ?", userId);
          safeDelete("DELETE FROM webauthn_credentials WHERE user_id = ?", userId);
          safeDelete("DELETE FROM biometric_update_requests WHERE user_id = ?", userId);
          safeDelete("DELETE FROM biometric_update_verifications WHERE request_user_id = ? OR reviewed_by = ?", userId, userId);
          safeDelete("DELETE FROM audit_logs WHERE actor_id = ?", userId);
          db.prepare("DELETE FROM users WHERE id = ?").run(userId);
          db.exec("COMMIT");
        } catch (txErr) {
          try { db.exec("ROLLBACK"); } catch (_) { /* ignore rollback errors */ }
          throw txErr;
        }
      };
      deleteUser(id);
      // insertAudit is non-critical — wrap so a logging failure never aborts the response
      try {
        insertAudit(req.currentUser.id, "staff_permanent_delete", "user", id, { name: row.full_name });
      } catch (auditErr) {
        console.warn("[trash] insertAudit failed after permanent delete (non-critical):", auditErr?.message);
      }
      console.log(`[trash] Permanently deleted user #${id} (${row.full_name}) by admin #${req.currentUser.id}`);
      res.json({ ok: true, id, name: row.full_name });
    } catch (e) {
      console.error("[trash] Permanent delete FAILED for user #" + id + ":", e?.message);
      res.status(500).json({ error: (e && e.message) ? e.message : "Permanent delete failed" });
    }
  });

  router.post("/trash/users/restore-all", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = db.prepare("UPDATE users SET deleted_at = NULL, active = 1 WHERE deleted_at IS NOT NULL").run();
    insertAudit(req.currentUser.id, "staff_restore_all", "user", 0, { restored: result.changes || 0 });
    res.json({ ok: true, restored: result.changes || 0 });
  });

  router.get("/trash/retention", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({
      mode: String(process.env.TRASH_RETENTION_MODE || "days"),
      days: Number(process.env.TRASH_RETENTION_DAYS || 30),
      minutes: Number(process.env.TRASH_RETENTION_MINUTES || 30),
    });
  });

  router.patch("/trash/retention", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const mode = String(req.body?.mode || process.env.TRASH_RETENTION_MODE || "days").toLowerCase();
    const days = Number(req.body?.days ?? process.env.TRASH_RETENTION_DAYS ?? 30);
    const minutes = Number(req.body?.minutes ?? process.env.TRASH_RETENTION_MINUTES ?? 30);
    if (mode !== "days" && mode !== "minutes") {
      return res.status(400).json({ error: "mode must be days or minutes" });
    }
    process.env.TRASH_RETENTION_MODE = mode;
    process.env.TRASH_RETENTION_DAYS = String(Number.isFinite(days) && days > 0 ? Math.floor(days) : 30);
    process.env.TRASH_RETENTION_MINUTES = String(
      Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 30
    );
    // Persist to DB so settings survive server restarts
    try {
      const retCfg = JSON.stringify({
        mode: process.env.TRASH_RETENTION_MODE,
        days: Number(process.env.TRASH_RETENTION_DAYS),
        minutes: Number(process.env.TRASH_RETENTION_MINUTES),
      });
      db.prepare(
        "INSERT INTO integration_kv(k, v) VALUES('trash_retention_v1', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
      ).run(retCfg);
    } catch (_) {}
    insertAudit(req.currentUser.id, "trash_retention_update", "settings", "trash_retention", {
      mode: process.env.TRASH_RETENTION_MODE,
      days: process.env.TRASH_RETENTION_DAYS,
      minutes: process.env.TRASH_RETENTION_MINUTES,
    });
    res.json({
      mode: process.env.TRASH_RETENTION_MODE,
      days: Number(process.env.TRASH_RETENTION_DAYS),
      minutes: Number(process.env.TRASH_RETENTION_MINUTES),
    });
  });

  router.get("/attendance/live-status", attachUser, (req, res) => {
    if (!can(req.currentUser, "attendance:read_all") && !can(req.currentUser, "history:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const today = todayLocalDate();
    const cacheKey = `live-status:${today}`;
    const cached = ttlGet(cacheKey);
    if (cached) return res.json(cached);
    const rows = db
      .prepare(
        `SELECT ar.*, u.full_name, u.email, u.login_id
         FROM attendance_records ar
         JOIN users u ON u.id = ar.user_id
         WHERE ar.work_date = ? AND ar.punch_in_at IS NOT NULL AND ar.punch_out_at IS NULL
         ORDER BY u.full_name`
      )
      .all(today);
    const payload = { date: today, currently_in: rows };
    ttlSet(cacheKey, payload, 12000);
    res.json(payload);
  });

  // Missed punch-out endpoint — returns records with open punch from previous days
  router.get("/attendance/missed-punchout", attachUser, (req, res) => {
    const u = req.currentUser;
    const today = todayLocalDate();
    if (can(u, "attendance:read_all")) {
      // Admins/managers see all employees with missed punch-outs
      const rows = db
        .prepare(
          `SELECT ar.id, ar.user_id, ar.work_date, ar.punch_in_at, u.full_name, u.login_id
           FROM attendance_records ar
           JOIN users u ON u.id = ar.user_id
           WHERE ar.work_date < ? AND ar.punch_in_at IS NOT NULL AND ar.punch_out_at IS NULL
             AND u.deleted_at IS NULL
           ORDER BY ar.work_date DESC, u.full_name
           LIMIT 200`
        )
        .all(today);
      return res.json({ missed: rows });
    }
    // Regular user sees only their own missed punch-outs
    const rows = db
      .prepare(
        `SELECT id, user_id, work_date, punch_in_at
         FROM attendance_records
         WHERE user_id = ? AND work_date < ? AND punch_in_at IS NOT NULL AND punch_out_at IS NULL
         ORDER BY work_date DESC
         LIMIT 10`
      )
      .all(u.id, today);
    res.json({ missed: rows });
  });

  function listEmployeesHandler(req, res) {
    const mapRow = (r) => ({
      id: r.id,
      name: r.full_name,
      role: mapSimpleRole(r.role),
      rbacRole: r.role,
      department: r.department || null,
      mobile: r.mobile || null,
      email: r.email,
      branch_id: r.branch_id,
      login_id: r.login_id ?? null,
      profile_photo: r.profile_photo || null,
      dob: r.dob || null,
      joining_date: r.joining_date || null,
      address: r.address || null,
      account_number: r.account_number || null,
      ifsc: r.ifsc || null,
      bank_name: r.bank_name || null,
      document_count: Number(r.document_count || 0),
      active: r.active,
      allow_gps: r.allow_gps,
      allow_face: r.allow_face,
      allow_biometric: r.allow_biometric,
      allow_manual: r.allow_manual,
      shift_start: r.shift_start,
      shift_end: r.shift_end,
      grace_minutes: r.grace_minutes,
    });
    if (can(req.currentUser, "users:read")) {
      const scE = branchScopeSql(req.currentUser, "u");
      const baE = branchAccessSql(req.currentUser, "u");
      // Hide SUPER_ADMIN and ADMIN from anyone who is not SUPER_ADMIN
      const hideSA = "";
      const rows = db
        .prepare(
          `SELECT u.id, u.full_name, u.email, u.login_id, u.role, u.branch_id, u.mobile, u.department, u.active, u.shift_start, u.shift_end, u.grace_minutes, u.profile_photo, u.dob, u.joining_date, u.address, u.account_number, u.ifsc, u.bank_name,
           (SELECT COUNT(*) FROM employee_documents d WHERE d.user_id = u.id) AS document_count,
           COALESCE(u.allow_gps,0) AS allow_gps, COALESCE(u.allow_face,1) AS allow_face, COALESCE(u.allow_biometric,1) AS allow_biometric, COALESCE(u.allow_manual,0) AS allow_manual
           FROM users u WHERE u.deleted_at IS NULL AND (u.account_status IS NULL OR u.account_status = 'ACTIVE')${hideSA}${scE.sql}${baE.sql} ORDER BY u.full_name`
        )
        .all(...scE.params, ...baE.params);
      return res.json({ employees: rows.map(mapRow) });
    }
    const self = db
      .prepare(
        `SELECT id, full_name, email, login_id, role, branch_id, mobile, department, active, shift_start, shift_end, grace_minutes, profile_photo, dob, joining_date, address, account_number, ifsc, bank_name,
         (SELECT COUNT(*) FROM employee_documents d WHERE d.user_id = users.id) AS document_count,
         COALESCE(allow_gps,0) AS allow_gps, COALESCE(allow_face,1) AS allow_face, COALESCE(allow_biometric,1) AS allow_biometric, COALESCE(allow_manual,0) AS allow_manual
         FROM users WHERE id = ? AND deleted_at IS NULL AND (account_status IS NULL OR account_status = 'ACTIVE')`
      )
      .get(req.currentUser.id);
    if (!self) {
      return res.status(404).json({ error: "Not found" });
    }
    return res.json({ employees: [mapRow(self)] });
  }

  router.get("/employees", attachUser, listEmployeesHandler);
  router.get("/staff", attachUser, listEmployeesHandler);

  function createEmployeeHandler(req, res) {
    let { name, mobile, password, role, staff_sub_type, department, email, login_id, dob, joining_date, address, account_number, ifsc, bank_name, branch_id, shift_start, shift_end, grace_minutes } =
      req.body || {};

    // ── FAIL-SAFE: only name is required ──────────────────────────────
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Employee name is required" });
    }

    // Auto-fill role
    if (!role || !String(role).trim()) role = "staff";

    // Branch is mandatory — must be selected explicitly. Branch-scoped users
    // (e.g. Branch Manager) auto-use their own branch; admins must pick one.
    if (branch_id == null || String(branch_id).trim() === "") {
      if (req.currentUser?.branch_id && isBranchScoped(req.currentUser)) {
        branch_id = req.currentUser.branch_id;
      } else {
        return res.status(400).json({ error: "Branch is required — please select a branch (Jaipur, Amritsar, Meerut, etc.) before creating staff" });
      }
    }
    // Validate branch exists.
    const branchExists = db.prepare("SELECT id, name FROM branches WHERE id = ?").get(Number(branch_id));
    if (!branchExists) {
      return res.status(400).json({ error: "Invalid branch — please choose a valid branch" });
    }

    // Auto-generate password if not provided
    let passwordWasAutoGenerated = false;
    if (!password || !String(password).trim()) {
      password = crypto.randomBytes(6).toString("base64url") + "!P9";
      passwordWasAutoGenerated = true;
    }

    // Auto-fill mobile with placeholder if missing
    if (!mobile || !String(mobile).trim()) {
      mobile = null;
    }

    console.log("[employees.create] request", {
      actorId: req.currentUser?.id,
      name,
      role,
      branch_id,
      login_id,
      email,
    });
    const mapped = normalizeRoleInput(role);
    if (!mapped) {
      return res.status(400).json({ error: "role must be valid role id" });
    }
    const roleCreateCheck = assertRoleAssignableOnCreate(req.currentUser, mapped);
    if (!roleCreateCheck.ok) return res.status(roleCreateCheck.status).json({ error: roleCreateCheck.error });
    const branchId = Number(branch_id);
    if (Number.isNaN(branchId)) {
      const firstBranch = db.prepare("SELECT id FROM branches ORDER BY id LIMIT 1").get();
      branch_id = firstBranch?.id || 1;
    }
    if (isBranchScoped(req.currentUser) && Number(req.currentUser.branch_id) !== Number(branchId)) {
      return res.status(403).json({ error: "Users must be assigned to your branch" });
    }
    const em =
      email && String(email).trim()
        ? String(email).trim()
        : `emp${Date.now()}@hrms.local`;
    const requestedLoginId = login_id && String(login_id).trim() ? String(login_id).trim() : null;
    if (requestedLoginId && isLoginIdTaken(requestedLoginId)) {
      return res.status(409).json({ error: "Employee ID already exists" });
    }
    // Duplicate-name guard: block if an active user with the same full_name
    // already exists. Returns existing login_id so UI can show it.
    const trimmedName = String(name).trim();
    const dup = db
      .prepare(
        `SELECT id, login_id, full_name, branch_id
         FROM users
         WHERE lower(trim(full_name)) = lower(?) AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(trimmedName);
    if (dup) {
      return res.status(409).json({
        error: `इस नाम से पहले से ID बनी हुई है: ${dup.login_id || "(no ID)"}`,
        existing_login_id: dup.login_id,
        existing_user_id: dup.id,
        existing_name: dup.full_name,
      });
    }
    const loginId = requestedLoginId || generateUniqueBranchEmployeeId(branchId);
    const hash = bcrypt.hashSync(String(password), 10);
    try {
      const info = db
        .prepare(
          `INSERT INTO users (email, login_id, password_hash, full_name, role, branch_id, mobile, department, dob, joining_date, address, account_number, ifsc, bank_name, shift_start, shift_end, grace_minutes, allow_gps, allow_face, allow_biometric, allow_manual)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,1,0)`
        )
        .run(
          em,
          loginId,
          hash,
          String(name).trim(),
          mapped,
          branchId,
          mobile ? String(mobile) : null,
          department ? String(department) : staff_sub_type ? String(staff_sub_type) : null,
          dob ? String(dob) : null,
          joining_date ? String(joining_date) : null,
          address ? String(address) : null,
          account_number ? String(account_number) : null,
          ifsc ? String(ifsc) : null,
          bank_name ? String(bank_name) : null,
          shift_start ? String(shift_start) : "09:00",
          shift_end ? String(shift_end) : "18:00",
          grace_minutes ? Number(grace_minutes) : 15
        );
      const u = db
        .prepare(
          "SELECT id, email, login_id, full_name, role, branch_id, mobile, department, dob, joining_date, address, account_number, ifsc, bank_name FROM users WHERE id = ?"
        )
        .get(info.lastInsertRowid);
      insertAudit(req.currentUser.id, "employee_create", "user", u.id, { email: u.email });
      seedRoleDefaults(mapped);
      scheduleUserSync(db, u.id);
      appsScriptScheduleUser(db, u.id);
      console.log("[employees.create] db_response", { id: u.id, email: u.email, login_id: u.login_id });
      res.json({
        employee: {
          id: u.id,
          name: u.full_name,
          role: mapSimpleRole(u.role),
          rbacRole: u.role,
          department: u.department,
          mobile: u.mobile,
          email: u.email,
          login_id: u.login_id,
          dob: u.dob,
          joining_date: u.joining_date,
          address: u.address,
          account_number: u.account_number,
          ifsc: u.ifsc,
          bank_name: u.bank_name,
        },
        // Only included when no password was provided by admin — show once so admin can share with staff
        generated_password: passwordWasAutoGenerated ? password : undefined,
      });
    } catch (e) {
      if (String(e.message).includes("users.login_id")) {
        return res.status(409).json({ error: "Employee ID already exists" });
      }
      if (String(e.message).includes("users.email")) {
        return res.status(409).json({ error: "Email already exists" });
      }
      if (String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "Duplicate employee record" });
      }
      throw e;
    }
  }

  router.post("/employees", attachUser, requirePerm("users:create"), createEmployeeHandler);
  router.post("/staff", attachUser, requirePerm("users:create"), createEmployeeHandler);


  router.get("/logs", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2000);
    const rows = db
      .prepare(
        `SELECT a.id, a.actor_id, u.full_name AS actor_name, a.action, a.created_at, a.entity_type, a.entity_id, a.details
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.id DESC
         LIMIT ?`
      )
      .all(limit);
    const logs = rows.map((r) => ({
      id: r.id,
      userId: r.actor_id,
      actorName: r.actor_name,
      action: r.action,
      timestamp: r.created_at,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: r.details
        ? (() => {
            try {
              return JSON.parse(r.details);
            } catch {
              return r.details;
            }
          })()
        : null,
    }));
    res.json({ logs });
  });

  router.get("/reports", attachUser, (req, res) => {
    if (!can(req.currentUser, "export:read") && !can(req.currentUser, "dashboard:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const now = new Date();
    const y = Number(req.query.year) || now.getFullYear();
    const m = Number(req.query.month) || now.getMonth() + 1;
    res.json({
      generatedAt: new Date().toISOString(),
      exports: {
        attendanceCsv: "/api/attendance/export.csv",
        attendanceXlsx: "/api/attendance/export.xlsx",
        monthlyCsv: `/api/reports/monthly.csv?year=${y}&month=${m}`,
        monthlyPdf: `/api/reports/monthly.pdf?year=${y}&month=${m}`,
        monthlyAttendanceXlsx: `/api/reports/monthly-attendance.xlsx?year=${y}&month=${m}`,
        dailyPdf: "/api/reports/daily.pdf",
        dailyXlsx: "/api/reports/daily.xlsx",
        employeesCsv: "/api/employees/export.csv",
        leaveCsv: "/api/leave/export.csv",
        documentsXlsx: "/api/documents/export.xlsx",
        payrollXlsx: `/api/payroll/export.xlsx?period=${y}-${String(m).padStart(2, "0")}`,
      },
      meta: "/api/meta",
      note: "Use Authorization: Bearer token for downloads. PDF/XLSX/CSV supported.",
    });
  });
  router.get("/mobile/apk", attachUser, (req, res) => {
    const apkUrl = process.env.APK_DOWNLOAD_URL || "/downloads/hrms-app.apk";
    res.json({ apk_url: apkUrl, note: "Download and install HRMS APK on Android devices." });
  });
  router.get("/warnings/me", attachUser, (req, res) => {
    const u = req.currentUser;
    const today = todayLocalDate();
    const month = today.slice(0, 7);
    const rows = [];
    const todayRec = db
      .prepare("SELECT status, punch_in_at, punch_out_at FROM attendance_records WHERE user_id = ? AND work_date = ?")
      .get(u.id, today);
    if (todayRec?.status === "late") {
      rows.push({ type: "attendance", severity: "warning", message: "Aaj aap late mark hue hain." });
    }
    if (todayRec?.punch_in_at && !todayRec?.punch_out_at) {
      rows.push({ type: "attendance", severity: "warning", message: "Aaj ka punch-out pending hai." });
    }
    const approvedLeaves = Number(
      db.prepare("SELECT COUNT(*) AS c FROM leave_requests WHERE user_id = ? AND final_status = 'APPROVED'").get(u.id).c
    );
    if (approvedLeaves >= 2) {
      rows.push({
        type: "leave",
        severity: approvedLeaves >= 4 ? "critical" : "warning",
        message:
          approvedLeaves >= 4
            ? `Aapki ${approvedLeaves} leaves approve ho chuki hain. Ab salary deduction apply ho sakta hai.`
            : `Aapki ${approvedLeaves} leave use ho chuki hain.`,
      });
    }
    const payrollRow = db
      .prepare(
        `SELECT COALESCE(deductions_inr,0) AS d FROM payroll_entries WHERE user_id = ? AND period = ? ORDER BY id DESC LIMIT 1`
      )
      .get(u.id, month);
    if (Number(payrollRow?.d || 0) > 0) {
      rows.push({
        type: "payroll",
        severity: "warning",
        message: `Is month aapki payroll deduction Rs ${Math.round(Number(payrollRow.d))} hai.`,
      });
    }
    res.json({ warnings: rows });
  });
  router.get("/warnings/overview", attachUser, (req, res) => {
    if (
      req.currentUser.role !== ROLES.SUPER_ADMIN &&
      req.currentUser.role !== ROLES.ADMIN &&
      req.currentUser.role !== ROLES.ATTENDANCE_MANAGER
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const lateToday = Number(
      db.prepare("SELECT COUNT(*) AS c FROM attendance_records WHERE work_date = ? AND status = 'late'").get(todayLocalDate()).c
    );
    const missedPunchOut = Number(
      db.prepare("SELECT COUNT(*) AS c FROM attendance_records WHERE work_date = ? AND punch_in_at IS NOT NULL AND punch_out_at IS NULL").get(todayLocalDate()).c
    );
    const leaveHeavyUsers = db
      .prepare(
        `SELECT u.id, u.full_name, COUNT(*) AS approved_count
         FROM leave_requests lr JOIN users u ON u.id = lr.user_id
         WHERE lr.final_status = 'APPROVED'
         GROUP BY u.id
         HAVING approved_count >= 2
         ORDER BY approved_count DESC
         LIMIT 20`
      )
      .all();
    res.json({ lateToday, missedPunchOut, leaveHeavyUsers });
  });

  function employeeDateFilterClause(req) {
    const mode = String(req.query.date_filter || "all").toLowerCase();
    if (mode === "today") {
      const d = todayLocalDate();
      return { sql: " AND date(created_at) = ?", params: [d], tag: d };
    }
    if (mode === "yesterday") {
      const t = new Date();
      t.setDate(t.getDate() - 1);
      const d = t.toISOString().slice(0, 10);
      return { sql: " AND date(created_at) = ?", params: [d], tag: d };
    }
    if (mode === "custom") {
      const from = String(req.query.from || "").slice(0, 10);
      const to = String(req.query.to || "").slice(0, 10);
      if (from && to) return { sql: " AND date(created_at) BETWEEN ? AND ?", params: [from, to], tag: `${from}_${to}` };
    }
    return { sql: "", params: [], tag: "all" };
  }

  function employeeExportRows(req) {
    const f = employeeDateFilterClause(req);
    const sql = `SELECT id, email, login_id, full_name, role, branch_id, shift_start, shift_end, grace_minutes, active, created_at, mobile, department, dob, joining_date, address, account_number, ifsc, bank_name
         FROM users WHERE deleted_at IS NULL${f.sql} ORDER BY full_name`;
    const rows = db.prepare(sql).all(...f.params);
    return { rows, tag: f.tag };
  }

  router.get("/employees/export.csv", attachUser, (req, res) => {
    if (!can(req.currentUser, "users:read") || !can(req.currentUser, "export:read")) {
      return res.status(403).send("Forbidden");
    }
    const { rows, tag } = employeeExportRows(req);
    const headers = [
      "id",
      "email",
      "login_id",
      "full_name",
      "role",
      "branch_id",
      "shift_start",
      "shift_end",
      "grace_minutes",
      "active",
      "created_at",
      "mobile",
      "department",
      "dob",
      "joining_date",
      "address",
      "account_number",
      "ifsc",
      "bank_name",
    ];
    const esc = (v) => {
      if (v == null) return '""';
      const s = String(v).replace(/"/g, '""');
      return `"${s}"`;
    };
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push(headers.map((h) => esc(r[h])).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="employees-${tag}.csv"`);
    res.send(lines.join("\n"));
  });

  router.get("/employees/export.xlsx", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "users:read") || !can(req.currentUser, "export:read")) {
        return res.status(403).send("Forbidden");
      }
      const { rows, tag } = employeeExportRows(req);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Employees");
      const headers = ["ID", "Employee ID", "Name", "Role", "Branch", "Mobile", "Email", "DOB", "Joining Date", "Address", "Account Number", "IFSC", "Bank Name", "Created At"];
      ws.addRow(headers);
      rows.forEach((r) => {
        ws.addRow([r.id, r.login_id || "", r.full_name, r.role, r.branch_id ?? "", r.mobile || "", r.email || "", r.dob || "", r.joining_date || "", r.address || "", r.account_number || "", r.ifsc || "", r.bank_name || "", r.created_at || ""]);
      });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=\"employees-${tag}.xlsx\"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      next(e);
    }
  });

  router.get("/employees/export.pdf", attachUser, (req, res) => {
    if (!can(req.currentUser, "users:read") || !can(req.currentUser, "export:read")) {
      return res.status(403).send("Forbidden");
    }
    const { rows, tag } = employeeExportRows(req);
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=\"employees-${tag}.pdf\"`);
    doc.pipe(res);
    doc.fontSize(14).text(`Employees Export (${tag})`);
    doc.moveDown(0.5);
    rows.slice(0, 500).forEach((r, idx) => {
      doc.fontSize(9).text(`${idx + 1}. ${r.full_name} | ${r.login_id || "-"} | ${r.mobile || "-"} | ${r.role} | ${r.branch_id || "-"}`);
    });
    doc.end();
  });
  router.get("/system/export.xlsx", attachUser, (req, res, next) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can export full system data" });
    }
    try {
      const wb = new ExcelJS.Workbook();
      const sheets = [
        ["Employees", "SELECT id, full_name, email, login_id, role, branch_id, mobile, department, active, created_at FROM users WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 5000"],
        ["Attendance", "SELECT id, user_id, work_date, status, punch_in_at, punch_out_at, punch_method_in, punch_method_out, verification_in, verification_out FROM attendance_records ORDER BY id DESC LIMIT 10000"],
        ["Payroll", "SELECT id, user_id, period, gross_inr, deductions_inr, net_inr, notes, created_at FROM payroll_entries ORDER BY id DESC LIMIT 10000"],
        ["Leaves", "SELECT id, user_id, start_date, end_date, reason, final_status, manager_review, admin_review, created_at FROM leave_requests ORDER BY id DESC LIMIT 10000"],
        ["Documents", "SELECT id, user_id, doc_type, file_name, file_path, verified, created_at FROM employee_documents ORDER BY id DESC LIMIT 10000"],
      ];
      for (const [name, sql] of sheets) {
        const ws = wb.addWorksheet(name);
        const rows = db.prepare(sql).all();
        if (rows.length) {
          ws.columns = Object.keys(rows[0]).map((k) => ({ header: k, key: k }));
          rows.forEach((r) => ws.addRow(r));
        } else {
          ws.addRow(["No data"]);
        }
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="full-system-${todayLocalDate()}.xlsx"`);
      wb.xlsx.write(res).then(() => res.end()).catch(next);
    } catch (e) {
      next(e);
    }
  });
  router.get("/system/export.pdf", attachUser, (req, res) => {
    if (req.currentUser.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can export full system data" });
    }
    const totals = {
      employees: Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL").get().c),
      attendance: Number(db.prepare("SELECT COUNT(*) AS c FROM attendance_records").get().c),
      payroll: Number(db.prepare("SELECT COUNT(*) AS c FROM payroll_entries").get().c),
      leaves: Number(db.prepare("SELECT COUNT(*) AS c FROM leave_requests").get().c),
      documents: Number(db.prepare("SELECT COUNT(*) AS c FROM employee_documents").get().c),
    };
    const doc = new PDFDocument({ margin: 36, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="full-system-${todayLocalDate()}.pdf"`);
    doc.pipe(res);
    doc.fontSize(16).text("HRMS Portal - Full System Export");
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown();
    Object.entries(totals).forEach(([k, v]) => doc.text(`${k}: ${v}`));
    doc.moveDown();
    doc.text("Use XLSX export for full row-level data.");
    doc.end();
  });

  router.get("/reports/monthly.csv", attachUser, (req, res) => {
    if (!can(req.currentUser, "export:read")) {
      return res.status(403).send("Forbidden");
    }
    const y = Number(req.query.year) || new Date().getFullYear();
    const m = Number(req.query.month) || new Date().getMonth() + 1;
    const pad = (n) => String(n).padStart(2, "0");
    const from = `${y}-${pad(m)}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${pad(m)}-${pad(lastDay)}`;
    let sql = `
      SELECT ar.*, u.full_name, u.email, u.login_id, b.name AS branch_name
      FROM attendance_records ar
      JOIN users u ON u.id = ar.user_id
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE ar.work_date >= ? AND ar.work_date <= ?
    `;
    const params = [from, to];
    if (!can(req.currentUser, "history:read")) {
      sql += " AND ar.user_id = ?";
      params.push(req.currentUser.id);
    }
    sql += " ORDER BY ar.work_date ASC, u.full_name ASC LIMIT 20000";
    const recs = db.prepare(sql).all(...params);
    const headers = [
      "id",
      "work_date",
      "user_id",
      "full_name",
      "email",
      "branch_name",
      "status",
      "punch_in_at",
      "punch_out_at",
    ];
    const esc = (v) => {
      if (v == null) return '""';
      return `"${String(v).replace(/"/g, '""')}"`;
    };
    const lines = [headers.join(",")];
    for (const r of recs) {
      lines.push(headers.map((h) => esc(r[h])).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance-report-${y}-${pad(m)}.csv"`
    );
    res.send(lines.join("\n"));
  });

  router.get("/payroll/overview", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "payroll:read") && !can(actor, "payroll:read_self")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const period =
      String(req.query.period || "")
        .trim()
        .slice(0, 7) || todayLocalDate().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "period must be YYYY-MM" });
    }
    const entries = can(actor, "payroll:read")
      ? db
          .prepare(
            `SELECT p.*, u.full_name, u.email, u.branch_id
             FROM payroll_entries p
             JOIN users u ON u.id = p.user_id
             WHERE p.period = ?
             ORDER BY u.full_name`
          )
          .all(period)
      : db
          .prepare(
            `SELECT p.*, u.full_name, u.email, u.branch_id
             FROM payroll_entries p
             JOIN users u ON u.id = p.user_id
             WHERE p.period = ? AND p.user_id = ?
             ORDER BY u.full_name`
          )
          .all(period, actor.id);
    const sumGross = entries.reduce((a, e) => a + (Number(e.gross_inr) || 0), 0);
    const sumDed = entries.reduce((a, e) => a + (Number(e.deductions_inr) || 0), 0);
    const sumNet = entries.reduce((a, e) => a + (Number(e.net_inr) || 0), 0);
    const sumIncentive = entries.reduce((a, e) => a + (Number(e.incentive_inr) || 0), 0);
    res.json({
      period,
      totals: {
        gross_inr: sumGross,
        deductions_inr: sumDed,
        net_inr: sumNet,
        incentive_inr: sumIncentive,
        count: entries.length,
      },
      entries,
    });
  });

  router.get("/payroll/entries", attachUser, (req, res) => {
    const actor = req.currentUser;
    const period =
      String(req.query.period || "")
        .trim()
        .slice(0, 7) || todayLocalDate().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "period must be YYYY-MM" });
    }
    if (can(actor, "payroll:read")) {
      const rows = db
        .prepare(
          `SELECT p.*, u.full_name, u.email FROM payroll_entries p
           JOIN users u ON u.id = p.user_id WHERE p.period = ? ORDER BY u.full_name`
        )
        .all(period);
      return res.json({ period, entries: rows });
    }
    if (can(actor, "payroll:read_self")) {
      const rows = db
        .prepare(
          `SELECT p.*, u.full_name, u.email FROM payroll_entries p
           JOIN users u ON u.id = p.user_id WHERE p.period = ? AND p.user_id = ?`
        )
        .all(period, actor.id);
      return res.json({ period, entries: rows });
    }
    return res.status(403).json({ error: "Forbidden" });
  });

  router.post("/payroll/entries", attachUser, (req, res) => {
    const actor = req.currentUser;
    if (!can(actor, "payroll:write")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { user_id, period, gross_inr, deductions_inr, notes } = req.body || {};
    if (!user_id || !period) {
      return res.status(400).json({ error: "user_id and period (YYYY-MM) required" });
    }
    const p = String(period).trim().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(p)) {
      return res.status(400).json({ error: "period must be YYYY-MM" });
    }
    const gross = Number(gross_inr) || 0;
    const ded = Number(deductions_inr) || 0;
    const net = gross - ded;
    const uid = Number(user_id);
    const existing = db.prepare("SELECT id FROM payroll_entries WHERE user_id = ? AND period = ?").get(uid, p);
    if (existing) {
      db.prepare(
        `UPDATE payroll_entries SET gross_inr = ?, deductions_inr = ?, net_inr = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(gross, ded, net, notes || null, existing.id);
    } else {
      db.prepare(
        `INSERT INTO payroll_entries (user_id, period, gross_inr, deductions_inr, net_inr, notes) VALUES (?,?,?,?,?,?)`
      ).run(uid, p, gross, ded, net, notes || null);
    }
    const row = db
      .prepare(
        `SELECT p.*, u.full_name FROM payroll_entries p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND p.period = ?`
      )
      .get(uid, p);
    if (!row) {
      return res.status(500).json({ error: "Payroll row missing after save" });
    }
    insertAudit(actor.id, "payroll_upsert", "payroll_entry", row.id, { period: p, user_id: uid });
    res.json({ entry: row });
  });

  // ── Payroll Policy V2 (combined leaves + half-day rule) ─────────────────
  // Stored in integration_kv as `payroll_policy_v2`. Knobs:
  //   monthly_leave_limit (default 4) — combined absent + weekoff + half/2
  //   half_day_unit (default 0.5) — 2 half-days = 1 leave
  //   min_working_hours (default 8) — below this → auto half-day
  //   auto_half_day_enabled (toggle)
  //   half_day_counts_in_leave (toggle)
  //   weekoff_counts_in_leave (toggle)
  const PAYROLL_POLICY_KEY = "payroll_policy_v2";
  function readPayrollPolicy() {
    const r = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get(PAYROLL_POLICY_KEY);
    if (!r || !r.v) return defaultPayrollPolicy();
    try {
      return { ...defaultPayrollPolicy(), ...JSON.parse(r.v) };
    } catch {
      return defaultPayrollPolicy();
    }
  }
  function writePayrollPolicy(obj) {
    const next = { ...readPayrollPolicy(), ...obj };
    db.prepare("INSERT OR REPLACE INTO integration_kv (k, v) VALUES (?, ?)").run(
      PAYROLL_POLICY_KEY,
      JSON.stringify(next)
    );
    return next;
  }

  router.get("/payroll/policy", attachUser, (req, res) => {
    if (!can(req.currentUser, "payroll:read") && !can(req.currentUser, "payroll:read_self")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ policy: readPayrollPolicy() });
  });

  router.put("/payroll/policy", attachUser, requirePerm("payroll:write"), (req, res) => {
    const allowedKeys = [
      "monthly_leave_limit", "half_day_unit", "min_working_hours",
      "auto_half_day_enabled", "half_day_counts_in_leave", "weekoff_counts_in_leave",
      "per_day_divisor", "bonus_enabled",
      "late_minutes_threshold", "late_deduction_enabled",
      "late_free_minutes", "late_block_minutes", "late_block_days",
    ];
    const patch = {};
    for (const k of allowedKeys) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) patch[k] = req.body[k];
    }
    // Coerce numbers / booleans
    if (patch.monthly_leave_limit != null) patch.monthly_leave_limit = Math.max(0, Number(patch.monthly_leave_limit) || 0);
    if (patch.half_day_unit != null) patch.half_day_unit = Math.max(0, Math.min(1, Number(patch.half_day_unit) || 0.5));
    if (patch.min_working_hours != null) patch.min_working_hours = Math.max(0, Math.min(24, Number(patch.min_working_hours) || 8));
    if (patch.per_day_divisor != null) patch.per_day_divisor = Math.max(1, Math.min(31, Number(patch.per_day_divisor) || 30));
    if (patch.late_minutes_threshold != null) patch.late_minutes_threshold = Math.max(0, Number(patch.late_minutes_threshold) || 0);
    if (patch.late_free_minutes != null) patch.late_free_minutes = Math.max(0, Math.min(600, Number(patch.late_free_minutes) || 0));
    if (patch.late_block_minutes != null) patch.late_block_minutes = Math.max(1, Math.min(600, Number(patch.late_block_minutes) || 30));
    if (patch.late_block_days != null) patch.late_block_days = Math.max(0, Math.min(10, Number(patch.late_block_days) || 1));
    if (patch.auto_half_day_enabled != null) patch.auto_half_day_enabled = !!patch.auto_half_day_enabled;
    if (patch.half_day_counts_in_leave != null) patch.half_day_counts_in_leave = !!patch.half_day_counts_in_leave;
    if (patch.weekoff_counts_in_leave != null) patch.weekoff_counts_in_leave = !!patch.weekoff_counts_in_leave;
    if (patch.bonus_enabled != null) patch.bonus_enabled = !!patch.bonus_enabled;
    if (patch.late_deduction_enabled != null) patch.late_deduction_enabled = !!patch.late_deduction_enabled;
    const next = writePayrollPolicy(patch);
    insertAudit(req.currentUser.id, "payroll_policy_update", "payroll_policy", null, patch);
    res.json({ policy: next });
  });

  // Per-user breakdown for a period — used by both admin grid and staff self.
  // Staff can only request their own user_id; admins can request any.
  router.get("/payroll/breakdown", attachUser, (req, res) => {
    const actor = req.currentUser;
    const period = String(req.query.period || "").trim().slice(0, 7) || todayLocalDate().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "period must be YYYY-MM" });
    }
    const reqUid = req.query.user_id ? Number(req.query.user_id) : null;
    const adminView = can(actor, "payroll:read");
    const selfView = can(actor, "payroll:read_self");
    if (!adminView && !selfView) return res.status(403).json({ error: "Forbidden" });

    const policy = readPayrollPolicy();
    const specialHolidays = loadSpecialHolidaysSet(db, period);
    const userCols = "id, full_name, email, base_salary_inr, shift_start, shift_end, grace_minutes, min_working_hours_override";
    const userRows = adminView
      ? db.prepare(`SELECT ${userCols} FROM users WHERE deleted_at IS NULL AND active = 1 ORDER BY full_name`).all()
      : db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).all(actor.id);

    const targetRows = reqUid ? userRows.filter((u) => u.id === reqUid) : userRows;
    if (reqUid && !adminView && reqUid !== actor.id) {
      return res.status(403).json({ error: "Cannot view another user" });
    }

    const breakdown = targetRows.map((u) => {
      const agg = payrollAggregateMonth(db, u.id, period, policy, { specialHolidays, user: u });
      // Manual override: if an admin saved an explicit `net_inr` to payroll_entries
      // for this period, surface it as the override.
      const stored = db.prepare("SELECT net_inr, deductions_inr, gross_inr, notes FROM payroll_entries WHERE user_id = ? AND period = ?").get(u.id, period);
      const override = stored && /manual/i.test(String(stored.notes || "")) ? stored.net_inr : null;
      const monthly = Number(u.base_salary_inr) || 0;
      const calc = payrollComputeForUser({ monthlySalary: monthly, agg, policy, override });
      return {
        user_id: u.id,
        full_name: u.full_name,
        email: u.email,
        ...calc,
      };
    });

    res.json({ period, policy, breakdown });
  });

  // Helper: compute breakdown rows for export (mirrors GET /payroll/breakdown).
  function payrollBreakdownRowsFor(actor, period, reqUid) {
    const policy = readPayrollPolicy();
    const specialHolidays = loadSpecialHolidaysSet(db, period);
    const adminView = can(actor, "payroll:read");
    const userCols = "id, full_name, email, base_salary_inr, shift_start, shift_end, grace_minutes, min_working_hours_override";
    const userRows = adminView
      ? db.prepare(`SELECT ${userCols} FROM users WHERE deleted_at IS NULL AND active = 1 ORDER BY full_name`).all()
      : db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).all(actor.id);
    const targetRows = reqUid ? userRows.filter((u) => u.id === reqUid) : userRows;
    return targetRows.map((u) => {
      const agg = payrollAggregateMonth(db, u.id, period, policy, { specialHolidays, user: u });
      const stored = db.prepare("SELECT net_inr, notes FROM payroll_entries WHERE user_id = ? AND period = ?").get(u.id, period);
      const override = stored && /manual/i.test(String(stored.notes || "")) ? stored.net_inr : null;
      const monthly = Number(u.base_salary_inr) || 0;
      const calc = payrollComputeForUser({ monthlySalary: monthly, agg, policy, override });
      return { user_id: u.id, full_name: u.full_name, email: u.email, ...calc };
    });
  }

  // Excel export — single employee or all (admin/self).
  router.get("/payroll/export-v2.xlsx", attachUser, async (req, res) => {
    try {
      const actor = req.currentUser;
      const adminView = can(actor, "payroll:read");
      const selfView = can(actor, "payroll:read_self");
      if (!adminView && !selfView) return res.status(403).json({ error: "Forbidden" });
      const period = String(req.query.period || "").trim().slice(0, 7) || todayLocalDate().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period must be YYYY-MM" });
      const reqUid = req.query.user_id ? Number(req.query.user_id) : null;
      if (reqUid && !adminView && reqUid !== actor.id) return res.status(403).json({ error: "Cannot view another user" });
      const effectiveUid = adminView ? reqUid : actor.id;
      const rows = payrollBreakdownRowsFor(actor, period, effectiveUid);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(`Payroll ${period}`);
      ws.columns = [
        { header: "Employee", key: "name", width: 28 },
        { header: "Email", key: "email", width: 26 },
        { header: "Monthly Salary", key: "monthly", width: 14 },
        { header: "Per Day", key: "perday", width: 10 },
        { header: "Half Day", key: "half", width: 10 },
        { header: "Present", key: "present", width: 10 },
        { header: "Absent", key: "absent", width: 10 },
        { header: "Half Days", key: "halfd", width: 10 },
        { header: "Week-Off", key: "weekoff", width: 10 },
        { header: "Late", key: "late", width: 8 },
        { header: "Leaves Used", key: "used", width: 12 },
        { header: "Leave Limit", key: "limit", width: 12 },
        { header: "Unused", key: "unused", width: 10 },
        { header: "Bonus (₹)", key: "bonus", width: 12 },
        { header: "Deduction (₹)", key: "ded", width: 14 },
        { header: "Final Salary (₹)", key: "final", width: 16 },
      ];
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F5E3B" } };
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      for (const r of rows) {
        ws.addRow({
          name: r.full_name,
          email: r.email || "",
          monthly: r.monthly_salary,
          perday: r.per_day_salary,
          half: r.half_day_rate,
          present: r.breakdown.present_days,
          absent: r.breakdown.absent_days,
          halfd: r.half_day_count,
          weekoff: r.breakdown.weekoff_days,
          late: r.late_days,
          used: r.combined_leave_units,
          limit: r.leave_limit,
          unused: r.unused_leaves,
          bonus: r.unused_leave_bonus_inr,
          ded: r.total_deduction_inr,
          final: r.final_salary_inr,
        });
      }
      const buf = await wb.xlsx.writeBuffer();
      const fname = effectiveUid && rows[0]
        ? `payroll-${rows[0].full_name.replace(/\s+/g, "_")}-${period}.xlsx`
        : `payroll-${period}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      res.send(Buffer.from(buf));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // PDF export — single employee or all (admin/self).
  router.get("/payroll/export-v2.pdf", attachUser, (req, res) => {
    try {
      const actor = req.currentUser;
      const adminView = can(actor, "payroll:read");
      const selfView = can(actor, "payroll:read_self");
      if (!adminView && !selfView) return res.status(403).json({ error: "Forbidden" });
      const period = String(req.query.period || "").trim().slice(0, 7) || todayLocalDate().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period must be YYYY-MM" });
      const reqUid = req.query.user_id ? Number(req.query.user_id) : null;
      if (reqUid && !adminView && reqUid !== actor.id) return res.status(403).json({ error: "Cannot view another user" });
      const effectiveUid = adminView ? reqUid : actor.id;
      const rows = payrollBreakdownRowsFor(actor, period, effectiveUid);

      const fname = effectiveUid && rows[0]
        ? `payroll-${rows[0].full_name.replace(/\s+/g, "_")}-${period}.pdf`
        : `payroll-${period}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      const doc = new PDFDocument({ size: "A4", margin: 36 });
      doc.pipe(res);
      doc.fontSize(16).fillColor("#1f5e3b").text("HRMS Portal — Payroll Report", { align: "center" });
      doc.fontSize(10).fillColor("#555").text(`Period: ${period}    |    Employees: ${rows.length}    |    Generated: ${new Date().toISOString().slice(0, 10)}`, { align: "center" });
      doc.moveDown(0.8);

      if (rows.length === 1) {
        const r = rows[0];
        doc.fontSize(13).fillColor("#1f5e3b").text(r.full_name, { underline: true });
        doc.fontSize(9).fillColor("#333").text(r.email || "");
        doc.moveDown(0.4);
        const lines = [
          ["Base Monthly Salary", `₹${r.monthly_salary}`],
          ["Per Day Salary", `₹${r.per_day_salary}  (Monthly ÷ 30)`],
          ["Half Day Rate", `₹${r.half_day_rate}`],
          ["", ""],
          ["Present Days", String(r.breakdown.present_days)],
          ["Absent", String(r.breakdown.absent_days)],
          ["Half Days", String(r.half_day_count)],
          ["Week-Offs", String(r.breakdown.weekoff_days)],
          ["Late Days", String(r.late_days)],
          ["Special Holidays", String(r.breakdown.special_holiday_count)],
          ["", ""],
          ["Leaves Used", `${r.combined_leave_units} of ${r.leave_limit}`],
          ["Unused Leaves", String(r.unused_leaves)],
          ["Extra Leaves", String(r.excess_leaves)],
          ["", ""],
          ["+ Bonus (Unused × Per Day)", `₹${r.unused_leave_bonus_inr}`],
          ["- Half-day Deduction", `₹${r.half_day_deduction_inr}`],
          ["- Extra-leave Deduction", `₹${r.excess_leave_deduction_inr}`],
          ["- Late Deduction", `₹${r.late_deduction_inr}`],
          ["", ""],
        ];
        doc.fontSize(10).fillColor("#000");
        for (const [k, v] of lines) {
          if (!k && !v) { doc.moveDown(0.2); continue; }
          doc.text(`${k.padEnd(34, " ")}  ${v}`);
        }
        doc.moveDown(0.4);
        doc.fontSize(13).fillColor("#0d47a1").text(`Final Salary: ₹${r.final_salary_inr}`, { align: "right" });
        if (r.manual_override) {
          doc.moveDown(0.3);
          doc.fontSize(9).fillColor("#a35200").text("(Manual override applied by admin)", { align: "right" });
        }
      } else {
        const cols = [
          { h: "Employee", w: 130 },
          { h: "Monthly", w: 60 },
          { h: "Pres", w: 38 },
          { h: "Abs", w: 32 },
          { h: "Half", w: 32 },
          { h: "Late", w: 32 },
          { h: "Used/Lim", w: 60 },
          { h: "Bonus", w: 55 },
          { h: "Deduct", w: 55 },
          { h: "Final", w: 65 },
        ];
        let x = 36;
        const startY = doc.y;
        doc.fontSize(9).fillColor("#fff").rect(36, startY, cols.reduce((a, c) => a + c.w, 0), 18).fill("#1f5e3b");
        doc.fillColor("#fff");
        x = 36;
        cols.forEach((c) => { doc.text(c.h, x + 3, startY + 5, { width: c.w - 6 }); x += c.w; });
        doc.fillColor("#000");
        let y = startY + 20;
        doc.fontSize(8.5);
        for (const r of rows) {
          if (y > 780) { doc.addPage(); y = 50; }
          x = 36;
          const cells = [
            r.full_name,
            `₹${r.monthly_salary}`,
            String(r.breakdown.present_days),
            String(r.breakdown.absent_days),
            String(r.half_day_count),
            String(r.late_days),
            `${r.combined_leave_units}/${r.leave_limit}`,
            `+₹${r.unused_leave_bonus_inr}`,
            `−₹${r.total_deduction_inr}`,
            `₹${r.final_salary_inr}`,
          ];
          cells.forEach((cell, i) => { doc.text(cell, x + 3, y, { width: cols[i].w - 6 }); x += cols[i].w; });
          y += 14;
        }
      }
      doc.end();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Auto-apply the V2 breakdown as payroll_entries (admin only).
  router.post("/payroll/auto-deduct-v2", attachUser, requirePerm("payroll:write"), (req, res) => {
    const period = String(req.body?.period || "").trim().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "period (YYYY-MM) required" });
    }
    const policy = readPayrollPolicy();
    const specialHolidays = loadSpecialHolidaysSet(db, period);
    const users = db.prepare(
      "SELECT id, full_name, base_salary_inr, shift_start, shift_end, grace_minutes, min_working_hours_override FROM users WHERE deleted_at IS NULL AND active = 1"
    ).all();
    let updated = 0;
    const details = [];
    for (const u of users) {
      const monthly = Number(u.base_salary_inr) || 0;
      if (monthly <= 0) continue;
      const agg = payrollAggregateMonth(db, u.id, period, policy, { specialHolidays, user: u });
      const calc = payrollComputeForUser({ monthlySalary: monthly, agg, policy, override: null });
      const noteParts = [
        `Auto V2: present=${agg.present_days}`,
        `half=${agg.half_days}`,
        `absent=${agg.absent_days}`,
        `weekoff=${agg.weekoff_days}`,
        `combined=${agg.combined_leave_units}/${policy.monthly_leave_limit}`,
        `excess=${calc.excess_leaves}`,
        `bonus=₹${calc.unused_leave_bonus_inr}`,
      ];
      const note = noteParts.join(" | ");
      const existing = db.prepare("SELECT id, notes FROM payroll_entries WHERE user_id = ? AND period = ?").get(u.id, period);
      // Don't overwrite manual overrides.
      if (existing && /manual/i.test(String(existing.notes || ""))) continue;
      if (existing) {
        db.prepare(
          `UPDATE payroll_entries SET gross_inr = ?, deductions_inr = ?, net_inr = ?,
            notes = ?, base_salary_snapshot = ?, total_leaves = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(monthly, calc.total_deduction_inr, calc.final_salary_inr, note, monthly, agg.combined_leave_units, existing.id);
      } else {
        db.prepare(
          `INSERT INTO payroll_entries (user_id, period, gross_inr, deductions_inr, net_inr, notes, base_salary_snapshot, total_leaves)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(u.id, period, monthly, calc.total_deduction_inr, calc.final_salary_inr, note, monthly, agg.combined_leave_units);
      }
      updated += 1;
      details.push({ user_id: u.id, name: u.full_name, ...calc });
    }
    insertAudit(req.currentUser.id, "payroll_auto_deduct_v2", "payroll", null, { period, count: updated });
    res.json({ ok: true, period, updated_count: updated, policy, details });
  });

  // ── Special / Festival Holidays ────────────────────────────────────────
  // Paid days — no deduction even if employee was absent.
  router.get("/payroll/holidays", attachUser, (req, res) => {
    if (!can(req.currentUser, "payroll:read") && !can(req.currentUser, "payroll:read_self")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const year = String(req.query.year || "").trim();
    let rows;
    if (/^\d{4}$/.test(year)) {
      rows = db.prepare(
        "SELECT id, holiday_date, name, created_at FROM payroll_special_holidays WHERE substr(holiday_date,1,4) = ? ORDER BY holiday_date"
      ).all(year);
    } else {
      rows = db.prepare(
        "SELECT id, holiday_date, name, created_at FROM payroll_special_holidays ORDER BY holiday_date DESC LIMIT 100"
      ).all();
    }
    res.json({ holidays: rows });
  });

  router.post("/payroll/holidays", attachUser, requirePerm("payroll:write"), (req, res) => {
    const { holiday_date, name } = req.body || {};
    if (!holiday_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(holiday_date))) {
      return res.status(400).json({ error: "holiday_date must be YYYY-MM-DD" });
    }
    const nm = String(name || "").trim().slice(0, 120);
    if (!nm) return res.status(400).json({ error: "name required" });
    try {
      const info = db.prepare(
        "INSERT INTO payroll_special_holidays (holiday_date, name, created_by) VALUES (?,?,?)"
      ).run(holiday_date, nm, req.currentUser.id);
      insertAudit(req.currentUser.id, "payroll_holiday_add", "payroll_special_holidays", info.lastInsertRowid, { holiday_date, name: nm });
      const row = db.prepare("SELECT id, holiday_date, name, created_at FROM payroll_special_holidays WHERE id = ?").get(info.lastInsertRowid);
      res.json({ holiday: row });
    } catch (e) {
      if (String(e.message || "").includes("UNIQUE")) {
        return res.status(409).json({ error: "Holiday already exists for that date" });
      }
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  router.delete("/payroll/holidays/:id", attachUser, requirePerm("payroll:write"), (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id required" });
    const row = db.prepare("SELECT * FROM payroll_special_holidays WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare("DELETE FROM payroll_special_holidays WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "payroll_holiday_delete", "payroll_special_holidays", id, row);
    res.json({ ok: true });
  });

  // Per-employee payroll settings (salary + min hours override).
  router.put("/payroll/user/:id", attachUser, requirePerm("payroll:write"), (req, res) => {
    const uid = Number(req.params.id);
    if (!uid) return res.status(400).json({ error: "user id required" });
    const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(uid);
    if (!exists) return res.status(404).json({ error: "User not found" });
    const patch = {};
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "base_salary_inr")) {
      patch.base_salary_inr = Math.max(0, Number(req.body.base_salary_inr) || 0);
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "min_working_hours_override")) {
      const v = req.body.min_working_hours_override;
      patch.min_working_hours_override = (v === null || v === "" || v === undefined)
        ? null
        : Math.max(0, Math.min(24, Number(v) || 0));
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "no fields to update" });
    const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
    db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ ...patch, id: uid });
    insertAudit(req.currentUser.id, "payroll_user_update", "users", uid, patch);
    const row = db.prepare(
      "SELECT id, full_name, email, base_salary_inr, shift_start, shift_end, min_working_hours_override FROM users WHERE id = ?"
    ).get(uid);
    res.json({ user: row });
  });

  // Auto-calculate leave-based salary deductions for a period (V1 — kept for back-compat)
  router.post("/payroll/auto-deduct", attachUser, requirePerm("payroll:write"), (req, res) => {
    const { period, working_days } = req.body || {};
    if (!period || !/^\d{4}-\d{2}$/.test(String(period))) {
      return res.status(400).json({ error: "period (YYYY-MM) required" });
    }
    const p = String(period).slice(0, 7);
    const workDays = Number(working_days) > 0 ? Number(working_days) : 26;
    const [yr, mo] = p.split("-").map(Number);
    const monthStart = `${p}-01`;
    const lastDay = new Date(yr, mo, 0).getDate();
    const monthEnd = `${p}-${String(lastDay).padStart(2, "0")}`;

    // Get all payroll entries for this period
    const entries = db
      .prepare("SELECT p.id, p.user_id, p.gross_inr FROM payroll_entries p WHERE p.period = ?")
      .all(p);

    const updated = [];
    for (const entry of entries) {
      // Count approved leave days in this period
      const leaves = db
        .prepare(
          `SELECT start_date, end_date FROM leave_requests
           WHERE user_id = ? AND final_status = 'APPROVED'
             AND start_date <= ? AND end_date >= ?`
        )
        .all(entry.user_id, monthEnd, monthStart);

      let leaveDays = 0;
      for (const lv of leaves) {
        const start = new Date(Math.max(new Date(lv.start_date), new Date(monthStart)));
        const end = new Date(Math.min(new Date(lv.end_date), new Date(monthEnd)));
        const days = Math.max(0, Math.round((end - start) / 86400000) + 1);
        leaveDays += days;
      }

      // Count late/absent days from attendance
      const absentRows = db
        .prepare(
          `SELECT COUNT(*) AS c FROM attendance_records
           WHERE user_id = ? AND work_date >= ? AND work_date <= ?
             AND status IN ('ABSENT', 'LATE')`
        )
        .get(entry.user_id, monthStart, monthEnd);
      const absentDays = Number(absentRows?.c || 0);

      const totalDedDays = leaveDays + Math.max(0, absentDays - leaveDays);
      const gross = Number(entry.gross_inr) || 0;
      const perDay = gross / workDays;
      const deductions = Math.round(perDay * totalDedDays);
      const net = Math.max(0, gross - deductions);

      db.prepare(
        `UPDATE payroll_entries SET deductions_inr = ?, net_inr = ?,
         notes = COALESCE(notes, '') || ' | Auto: ' || ? || ' leave+absent days @ Rs' || ? || '/day',
         updated_at = datetime('now')
         WHERE id = ?`
      ).run(deductions, net, totalDedDays, Math.round(perDay), entry.id);

      updated.push({ user_id: entry.user_id, leave_days: leaveDays, absent_days: absentDays, deductions, net });
    }

    insertAudit(req.currentUser.id, "payroll_auto_deduct", "payroll", null, { period: p, count: updated.length });
    res.json({ ok: true, period: p, updated_count: updated.length, details: updated });
  });

  // Preview leave-based deductions without saving
  router.get("/payroll/deduction-preview", attachUser, requirePerm("payroll:read"), (req, res) => {
    const period = String(req.query.period || "").trim().slice(0, 7);
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "period (YYYY-MM) required" });
    }
    const workDays = Number(req.query.working_days) > 0 ? Number(req.query.working_days) : 26;
    const [yr, mo] = period.split("-").map(Number);
    const monthStart = `${period}-01`;
    const lastDay = new Date(yr, mo, 0).getDate();
    const monthEnd = `${period}-${String(lastDay).padStart(2, "0")}`;

    const entries = db
      .prepare(
        `SELECT p.id, p.user_id, p.gross_inr, u.full_name
         FROM payroll_entries p JOIN users u ON u.id = p.user_id
         WHERE p.period = ? ORDER BY u.full_name`
      )
      .all(period);

    const preview = entries.map((entry) => {
      const leaves = db
        .prepare(
          `SELECT start_date, end_date FROM leave_requests
           WHERE user_id = ? AND final_status = 'APPROVED'
             AND start_date <= ? AND end_date >= ?`
        )
        .all(entry.user_id, monthEnd, monthStart);

      let leaveDays = 0;
      for (const lv of leaves) {
        const start = new Date(Math.max(new Date(lv.start_date), new Date(monthStart)));
        const end = new Date(Math.min(new Date(lv.end_date), new Date(monthEnd)));
        const days = Math.max(0, Math.round((end - start) / 86400000) + 1);
        leaveDays += days;
      }

      const absentRows = db
        .prepare(
          `SELECT COUNT(*) AS c FROM attendance_records
           WHERE user_id = ? AND work_date >= ? AND work_date <= ?
             AND status IN ('ABSENT', 'LATE')`
        )
        .get(entry.user_id, monthStart, monthEnd);
      const absentDays = Number(absentRows?.c || 0);

      const gross = Number(entry.gross_inr) || 0;
      const perDay = gross / workDays;
      const deductions = Math.round(perDay * (leaveDays + Math.max(0, absentDays - leaveDays)));

      return {
        user_id: entry.user_id,
        full_name: entry.full_name,
        gross_inr: gross,
        leave_days: leaveDays,
        absent_days: absentDays,
        per_day_rate: Math.round(perDay),
        deductions,
        net_inr: Math.max(0, gross - deductions),
      };
    });

    res.json({ period, working_days: workDays, preview });
  });

  router.get("/documents", attachUser, (req, res) => {
    const u = req.currentUser;
    let rows;
    if (can(u, "documents:read_all")) {
      rows = db
        .prepare(
          `SELECT d.*, usr.full_name AS user_name, usr.email AS user_email
           FROM employee_documents d
           JOIN users usr ON usr.id = d.user_id
           WHERE d.deleted_at IS NULL
           ORDER BY d.id DESC
           LIMIT 500`
        )
        .all();
    } else {
      rows = db
        .prepare(
          `SELECT d.*, usr.full_name AS user_name, usr.email AS user_email
           FROM employee_documents d
           JOIN users usr ON usr.id = d.user_id
           WHERE d.user_id = ? AND d.deleted_at IS NULL
           ORDER BY d.id DESC`
        )
        .all(u.id);
    }
    res.json({ documents: rows });
  });

  // ── Soft-delete / Trash / Restore for documents ────────────────────────────
  router.get("/documents/trash", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!can(u, "documents:read_all") && u.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const rows = db
      .prepare(
        `SELECT d.*, usr.full_name AS user_name, usr.email AS user_email,
                actor.full_name AS deleted_by_name
         FROM employee_documents d
         JOIN users usr ON usr.id = d.user_id
         LEFT JOIN users actor ON actor.id = d.deleted_by
         WHERE d.deleted_at IS NOT NULL
         ORDER BY datetime(d.deleted_at) DESC
         LIMIT 1000`
      )
      .all();
    res.json({ documents: rows });
  });

  router.delete("/documents/:id", attachUser, (req, res) => {
    const u = req.currentUser;
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id, user_id, doc_type FROM employee_documents WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    // Owner can delete own; admins with verify perm can delete any
    const isOwner = row.user_id === u.id;
    const isAdmin = can(u, "documents:verify") || u.role === ROLES.SUPER_ADMIN;
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "Forbidden" });
    db.prepare(
      `UPDATE employee_documents SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`
    ).run(u.id, id);
    insertAudit(u.id, "document_delete", "employee_document", id, { doc_type: row.doc_type, owner: row.user_id });
    res.json({ ok: true, id });
  });

  router.post("/documents/:id/restore", attachUser, (req, res) => {
    const u = req.currentUser;
    if (!can(u, "documents:verify") && u.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id, doc_type FROM employee_documents WHERE id = ? AND deleted_at IS NOT NULL").get(id);
    if (!row) return res.status(404).json({ error: "Not in trash" });
    db.prepare("UPDATE employee_documents SET deleted_at = NULL, deleted_by = NULL WHERE id = ?").run(id);
    insertAudit(u.id, "document_restore", "employee_document", id, { doc_type: row.doc_type });
    res.json({ ok: true, id });
  });

  router.delete("/documents/:id/permanent", attachUser, (req, res) => {
    const u = req.currentUser;
    if (u.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: "Only Super Admin can permanently delete" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id, file_path, doc_type FROM employee_documents WHERE id = ? AND deleted_at IS NOT NULL").get(id);
    if (!row) return res.status(404).json({ error: "Not in trash" });
    db.prepare("DELETE FROM employee_documents WHERE id = ?").run(id);
    // Best-effort: remove the underlying file too. Anchor strictly under <cwd>/uploads/
    // to prevent path traversal even if file_path was somehow tampered.
    try {
      const fs = require("fs");
      const path = require("path");
      const uploadsRoot = path.resolve(process.cwd(), "uploads") + path.sep;
      const rel = String(row.file_path || "").replace(/^\/+/, "");
      const abs = path.resolve(process.cwd(), rel);
      if (abs.startsWith(uploadsRoot) && fs.existsSync(abs)) {
        fs.unlinkSync(abs);
      }
    } catch (_) { /* ignore fs errors */ }
    insertAudit(u.id, "document_permanent_delete", "employee_document", id, { doc_type: row.doc_type });
    res.json({ ok: true, id });
  });

  // Serve the canonical Google Apps Script source so the UI can show a copy-able guide.
  router.get("/integrations/sheets/script", attachUser, (req, res) => {
    const u = req.currentUser;
    if (u.role !== ROLES.SUPER_ADMIN && !can(u, "settings:read")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const fs = require("fs");
      const path = require("path");
      const file = path.join(__dirname, "..", "google-apps-script", "hrms_sync.gs");
      const code = fs.readFileSync(file, "utf8");
      res.json({ filename: "hrms_sync.gs", code });
    } catch (e) {
      res.status(500).json({ error: "Script template missing", details: e.message });
    }
  });

  router.post("/documents", attachUser, uploadDoc.single("file"), (req, res) => {
    const u = req.currentUser;
    if (!req.file) {
      return res.status(400).json({ error: "file required (multipart field: file)" });
    }
    const doc_type = String((req.body && req.body.doc_type) || "other");
    let targetUserId = u.id;
    if (req.body && req.body.user_id != null && String(req.body.user_id) !== String(u.id)) {
      if (!can(u, "users:update") && u.role !== ROLES.SUPER_ADMIN) {
        return res.status(403).json({ error: "Cannot upload for another user" });
      }
      targetUserId = Number(req.body.user_id);
    }
    const rel = `/uploads/documents/${req.file.filename}`;
    const info = db
      .prepare(
        `INSERT INTO employee_documents (user_id, doc_type, file_name, file_path, verified, doc_status) VALUES (?,?,?,?,0,'pending')`
      )
      .run(targetUserId, doc_type, req.file.originalname || req.file.filename, rel);
    const row = db.prepare("SELECT * FROM employee_documents WHERE id = ?").get(info.lastInsertRowid);
    insertAudit(u.id, "document_upload", "employee_document", row.id, { doc_type });

    // Notify admins of pending verification (best-effort, non-blocking)
    try {
      const ownerName = db.prepare("SELECT full_name FROM users WHERE id = ?").get(targetUserId)?.full_name || "Staff";
      const adminIds = db
        .prepare(`SELECT id FROM users WHERE role IN ('ADMIN','SUPER_ADMIN') AND active = 1 AND deleted_at IS NULL`)
        .all()
        .map((r) => r.id);
      if (adminIds.length) {
        pushNotifications.sendToUsers(db, adminIds, {
          title: "📄 New document for verification",
          body: `${ownerName} uploaded ${doc_type.replace(/_/g, " ")}`,
          url: "/documents",
          tag: `doc-pending-${row.id}`,
        }).catch(() => {});
      }
    } catch { /* ignore notification failures */ }

    res.json({ document: row });
  });

  router.patch("/documents/:id/verify", attachUser, (req, res) => {
    if (!can(req.currentUser, "documents:verify")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    const { verified, status, verifier_notes } = req.body || {};
    let nextStatus = "pending";
    if (status === "approved" || status === "rejected" || status === "pending") {
      nextStatus = String(status);
    } else if (verified === true || verified === 1) {
      nextStatus = "approved";
    } else if (verified === false || verified === 0) {
      nextStatus = "rejected";
    }
    // Rejection reason is mandatory per spec
    const notes = verifier_notes != null ? String(verifier_notes).trim() : "";
    if (nextStatus === "rejected" && !notes) {
      return res.status(400).json({ error: "Rejection reason is required" });
    }
    const v = nextStatus === "approved" ? 1 : 0;
    db.prepare(
      `UPDATE employee_documents
       SET verified = ?, doc_status = ?, verified_by = ?, verified_at = datetime('now'), verifier_notes = ?
       WHERE id = ?`
    ).run(v, nextStatus, req.currentUser.id, notes || null, id);
    const row = db.prepare("SELECT * FROM employee_documents WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ error: "Not found" });
    }
    insertAudit(req.currentUser.id, "document_verify", "employee_document", id, { verified: v, status: nextStatus });

    // Notify the staff member of the verification outcome (best-effort)
    if (nextStatus === "approved" || nextStatus === "rejected") {
      try {
        const human = String(row.doc_type || "document").replace(/_/g, " ");
        pushNotifications.sendToUsers(db, [row.user_id], {
          title: nextStatus === "approved" ? "✅ Document approved" : "❌ Document rejected",
          body: nextStatus === "approved"
            ? `Your ${human} has been verified.`
            : `Your ${human} was rejected. Reason: ${notes.slice(0, 120)}`,
          url: "/documents",
          tag: `doc-result-${row.id}`,
        }).catch(() => {});
      } catch { /* ignore */ }
    }

    res.json({ document: row });
  });

  registerWebAuthnRoutes(router, { db, attachUser, insertAudit });
  registerBiometricRoutes(router, { db, attachUser, insertAudit });
  registerProfileUpdateRoutes(router, { db, attachUser, insertAudit, can });

  registerLeaveRoutes(router, db, {
    attachUser,
    can,
    onLeaveChange: (leaveId) => {
      scheduleLeaveSync(db, leaveId);
      appsScriptScheduleLeave(db, leaveId);
      ttlBust("dash-overview:", "live-status:");
    },
    auditLeave: (actorId, action, leaveId, details) =>
      insertAudit(actorId, action, "leave_request", leaveId, details),
  });

  registerEnterpriseRoutes(router, {
    db,
    attachUser,
    can,
    ROLES,
    insertAudit,
    bcrypt,
    requirePerm,
  });

  registerProductRoutes(router, {
    db,
    attachUser,
    can,
    ROLES,
    requirePerm,
    todayLocalDate,
    uploadFace,
    insertAudit,
  });

  router.get("/integrations/apps-script/status", attachUser, (req, res) => {
    if (!can(req.currentUser, "integrations:sync")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const base = getAppsScriptStatus(db);
    res.json({
      ...base,
      auto_pull: router._getLastSheetPullResult ? router._getLastSheetPullResult() : null,
      auto_pull_interval_sec: 300,
      absent_push: router._getLastAbsentPushResult ? router._getLastAbsentPushResult() : null,
      absent_push_hour_ist: "23:30",
    });
  });

  router.post("/integrations/apps-script/bulk-push", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "integrations:sync")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const result = await appsScriptFullBulkPushAll(db);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post("/integrations/apps-script/clear-queue", attachUser, (req, res) => {
    if (!can(req.currentUser, "integrations:sync")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { tab, deadOnly } = req.body || {};
    const cleared = appsScriptClearSyncQueue(db, { tab, deadOnly: !!deadOnly });
    res.json({ ok: true, cleared });
  });

  // Notification CRUD (uses attachUser defined above).
  mountNotificationRoutes(router, db, { attachUser });

  // 404 inside /api → structured response handled by global errorMiddleware.
  router.use((req, _res, next) => {
    const err = new Error(`Not found: ${req.path}`);
    err.status = 404;
    err.reason = `Aapne jo endpoint call kiya (${req.method} /api${req.path}) wo server par exist nahi karta.`;
    err.solution = "Page reload karo. Problem rahe to admin ko bataao.";
    err.code = "api_not_found";
    next(err);
  });

  return router;
}

module.exports = { createApiRouter };
