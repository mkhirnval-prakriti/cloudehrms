"use strict";
require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");
const cors    = require("cors");
const session = require("express-session");
const rateLimit = require("express-rate-limit");

const { openDb } = require("./server/db");
const { createApiRouter }       = require("./server/api");
const { runStartupSmokeTest, pushAbsentsToSheet, fmtISTDate } = require("./server/appsScriptSync");
const { sendDailyHrmsReport }   = require("./server/dailyReport");

const app = express();
app.set("trust proxy", 1);          // Render / Railway sit behind a proxy

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "0.0.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────
function buildCors() {
  const raw = (process.env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return null;
  if (raw === "*") return cors({ origin: true, credentials: true });

  let list = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV !== "production" && process.env.CORS_STRICT !== "1") {
    ["http://127.0.0.1:5173","http://localhost:5173",
     "http://127.0.0.1:5000","http://localhost:5000"].forEach(u => {
      if (!list.includes(u)) list.push(u);
    });
  }
  return cors({
    origin(origin, cb) {
      if (!origin || list.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: blocked origin ${origin}`));
    },
    credentials: true,
  });
}
const corsMw = buildCors();
if (corsMw) app.use(corsMw);

// ─────────────────────────────────────────────────────────────────────────────
// Security headers
// ─────────────────────────────────────────────────────────────────────────────
app.use(compression({ threshold: 1024 }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options",  "nosniff");
  res.setHeader("X-Frame-Options",         "SAMEORIGIN");
  res.setHeader("X-XSS-Protection",        "1; mode=block");
  res.setHeader("Referrer-Policy",         "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy",      "geolocation=(self), camera=(self), microphone=()");
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiters — FREE-TIER optimised (low memory, stable under load)
// ─────────────────────────────────────────────────────────────────────────────

/** Global: 300 req / 15 min per IP — protects all endpoints */
const globalLimiter = rateLimit({
  windowMs : 15 * 60 * 1000,
  max      : 300,
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: "Too many requests. Please slow down." },
  skip     : (req) => req.ip === "127.0.0.1" || req.ip === "::1",
});
app.use(globalLimiter);

/** Auth: 10 attempts / 15 min — stops brute-force on login */
const authLimiter = rateLimit({
  windowMs : 15 * 60 * 1000,
  max      : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: "बहुत अधिक login attempts। कृपया 15 मिनट बाद try करें।" },
  skip     : (req) => req.ip === "127.0.0.1" || req.ip === "::1",
});

/** Attendance punch: 5 req / 10 sec per token — prevents double-punch spam */
const punchLimiter = rateLimit({
  windowMs : 10 * 1000,
  max      : 5,
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: "बहुत तेज़ punch request। कृपया रुकें।" },
  keyGenerator: (req) => {
    const auth = req.headers.authorization || "";
    return auth ? `tok_${auth.slice(-16)}` : (req.ip || "unknown");
  },
  validate: { keyGeneratorIpFallback: false },
});

/** API general: 120 req / 1 min — protects data endpoints */
const apiLimiter = rateLimit({
  windowMs : 60 * 1000,
  max      : 120,
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: "API rate limit exceeded. Please wait." },
  skip     : (req) => req.ip === "127.0.0.1" || req.ip === "::1",
});

/** File upload: 20 uploads / min — prevents storage abuse */
const uploadLimiter = rateLimit({
  windowMs : 60 * 1000,
  max      : 20,
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: "Upload limit exceeded. Please wait." },
});

/** Password reset / OTP: 5 req / 30 min — prevents OTP farming */
const otpLimiter = rateLimit({
  windowMs : 30 * 60 * 1000,
  max      : 5,
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: "बहुत अधिक OTP requests। कृपया 30 मिनट बाद try करें।" },
});

// ─────────────────────────────────────────────────────────────────────────────
// Health (no rate limit — used by UptimeRobot keepalive)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/health",     (_req, res) => res.json({ ok: true, service: "hrms-portal", ts: new Date().toISOString() }));
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "hrms-portal", ts: new Date().toISOString() }));

app.use(express.json({ limit: "2mb" }));

// ─────────────────────────────────────────────────────────────────────────────
// Static files (uploads + legacy + SPA)
// ─────────────────────────────────────────────────────────────────────────────
const uploadRoot = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });
app.use("/uploads", express.static(uploadRoot));

app.use("/legacy", express.static(path.join(__dirname, "legacy"), { index: "index.html" }));
app.get(/^\/portal\/?$/, (_req, res) => res.redirect(302, "/app/"));

// Face-API model weights (large static binary files)
const faceModelsDir = path.join(__dirname, "client", "public", "face-models");
if (fs.existsSync(faceModelsDir)) {
  app.use("/face-models", express.static(faceModelsDir, { maxAge: "30d", immutable: true }));
}

const distDir   = path.join(__dirname, "dist");
const appIndex  = path.join(distDir, "index.html");
if (!fs.existsSync(appIndex)) {
  console.warn("[hrms] SPA not built — run: npm run build");
}
app.use(express.static(distDir));

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: connect DB → wire routes → start server
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  // ── Database ───────────────────────────────────────────────────────────────
  let db;
  try {
    db = await openDb();
    console.log("[hrms] ✓ Database ready");
  } catch (e) {
    console.error("[hrms] FATAL: DB connection failed:", e.message);
    process.exit(1);
  }

  // ── Session ────────────────────────────────────────────────────────────────
  const sessionSecret = process.env.SESSION_SECRET ||
    (() => { const s = crypto.randomBytes(32).toString("hex"); process.env.SESSION_SECRET = s; return s; })();

  app.use(session({
    name   : "hrms.sid",
    secret : sessionSecret,
    resave : false,
    saveUninitialized: false,
    cookie : {
      httpOnly: true,
      sameSite: "lax",
      secure  : process.env.NODE_ENV === "production",
      maxAge  : 7 * 24 * 60 * 60 * 1000,  // 7 days
    },
  }));

  // ── Apply rate limiters to specific routes ─────────────────────────────────
  app.use("/api/auth/login",          authLimiter);
  app.use("/api/login",               authLimiter);
  app.use("/api/auth/otp",            otpLimiter);
  app.use("/api/auth/forgot-password",otpLimiter);
  app.use("/api/auth/verify-otp",     otpLimiter);
  app.use("/api/attendance/punch",    punchLimiter);
  app.use("/api/attendance/face-punch", punchLimiter);
  app.use("/api/kiosk/pin/punch",     punchLimiter);
  app.use("/api/kiosk/qr/scan",       punchLimiter);
  app.use("/api/documents",           uploadLimiter);
  app.use("/api",                     apiLimiter);

  // Cache-control for known stable read endpoints
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" || req.path === "/events") return next();
    const cacheable = ["/payroll/policy", "/holidays", "/payroll/special-holidays"];
    if (cacheable.some(p => req.path === p || req.path.startsWith(p + "?"))) {
      res.set("Cache-Control", "private, max-age=10");
    }
    next();
  });

  // ── Mount API router ───────────────────────────────────────────────────────
  const apiRouter = createApiRouter(db);
  app.use("/api", apiRouter);

  // ── SPA catch-all ──────────────────────────────────────────────────────────
  app.get("*", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (path.extname(req.path)) return next();
    if (req.path.startsWith("/api") ||
        req.path.startsWith("/uploads") ||
        req.path.startsWith("/legacy")) return next();
    if (!fs.existsSync(appIndex)) {
      return res.status(503).send("App not built. Run: npm run build");
    }
    res.setHeader("Cache-Control", "no-store, no-cache");
    res.sendFile(appIndex);
  });

  // ── 404 ────────────────────────────────────────────────────────────────────
  app.use((req, res) => {
    if (req.path.startsWith("/api"))
      return res.status(404).json({ error: "Not found", path: req.path });
    res.status(404).send("Not found");
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  const { errorMiddleware } = require("./server/errors");
  app.use(errorMiddleware);

  // ─────────────────────────────────────────────────────────────────────────
  // Start listening
  // ─────────────────────────────────────────────────────────────────────────
  const server = app.listen(PORT, HOST, () => {
    server.keepAliveTimeout = 65000;
    server.headersTimeout   = 66000;
    console.log(`[hrms] ✓ Listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    console.log(`[hrms]   NODE_ENV = ${process.env.NODE_ENV || "development"}`);

    // Startup smoke test for Google Apps Script sync
    setImmediate(() => {
      runStartupSmokeTest(db).catch(e =>
        console.error("[appsScriptSync] startup:", e.message));
    });

    // ── Daily report scheduler (fires at 19:00 IST) ────────────────────────
    let lastDailyDate = null;
    db.prepare("SELECT v FROM integration_kv WHERE k = 'daily_report_last_sent'")
      .get().then(r => { if (r?.v) lastDailyDate = String(r.v).slice(0, 10); }).catch(() => {});

    function maybeFireDailyReport() {
      try {
        const nowIST  = new Date(Date.now() + 5.5 * 3600000);
        const istHour = nowIST.getUTCHours();
        const istDate = nowIST.toISOString().slice(0, 10);
        if (istHour >= 19 && lastDailyDate !== istDate) {
          lastDailyDate = istDate;
          db.prepare(
            "INSERT INTO integration_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v"
          ).run("daily_report_last_sent", istDate).catch(() => {});
          sendDailyHrmsReport(db).catch(e => console.error("[dailyReport]", e.message));
          pushAbsentsToSheet(db, fmtISTDate(new Date().toISOString()))
            .catch(e => console.error("[appsScriptSync] absents:", e.message));
        }
      } catch (e) { console.error("[dailyReport:check]", e.message); }
    }
    setInterval(maybeFireDailyReport, 15 * 60 * 1000);
    setTimeout(maybeFireDailyReport, 30 * 1000);

    // ── Midnight auto clock-out ────────────────────────────────────────────
    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        const prev     = new Date(now.getTime() - 86400000);
        const prevDate = prev.toISOString().slice(0, 10);
        db.prepare(`
          UPDATE attendance_records
          SET punch_out_at = $1, punch_method_out = 'auto_midnight'
          WHERE work_date = $2 AND punch_in_at IS NOT NULL AND punch_out_at IS NULL
        `).run(`${prevDate}T23:59:59.000Z`, prevDate)
          .then(r => { if (r?.changes > 0) console.log(`[midnight] auto-closed ${r.changes} session(s)`); })
          .catch(e => console.error("[midnight]", e.message));
      }
    }, 60 * 1000);

    // ── Trash / soft-delete retention purge ───────────────────────────────
    setInterval(() => {
      const mode    = String(process.env.TRASH_RETENTION_MODE || "days").toLowerCase();
      const days    = Number(process.env.TRASH_RETENTION_DAYS    || 30);
      const minutes = Number(process.env.TRASH_RETENTION_MINUTES || 30);
      const ivl     = mode === "minutes" && minutes > 0 ? `${minutes} minutes` : `${days} days`;
      db.prepare(
        `DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= NOW() - INTERVAL '${ivl}'`
      ).run().catch(e => console.error("[trash]", e.message));
    }, 10 * 60 * 1000);
  });

  server.on("error", err => {
    if (err.code === "EADDRINUSE") {
      console.error(`[hrms] Port ${PORT} already in use.`); process.exit(1);
    }
    throw err;
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (sig) => {
    console.log(`[hrms] ${sig} — shutting down…`);
    server.close();
    try { await db._pool?.end(); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

start().catch(e => { console.error("[hrms] Startup failed:", e); process.exit(1); });
process.on("unhandledRejection", r => console.error("unhandledRejection:", r));
