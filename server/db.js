"use strict";
/**
 * HRMS Portal — PostgreSQL Database Layer (SYNC wrapper via deasync)
 * Provides better-sqlite3 compatible synchronous API on top of pg pool.
 * Compatible with Neon, Supabase, Railway Postgres, or any standard PostgreSQL.
 */
const { Pool } = require("pg");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
let deasync = null;
try {
  deasync = require("deasync");
} catch (e) {
  console.warn("[db] deasync not available - falling back to async-only mode");
}
const { ROLES } = require("./rbac");

const HRMS_BOOTSTRAP_PW_KEY = "hrms_bootstrap_admin_password";

let _pool = null;

function getPool() {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required. Set it to your PostgreSQL connection string.");
    _pool = new Pool({
      connectionString: url,
      ssl: (url.includes("neon.tech") || url.includes("supabase.co") || process.env.DB_SSL === "1")
        ? { rejectUnauthorized: false }
        : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    _pool.on("error", (e) => {
      if (!e.message.includes("Connection terminated")) {
        console.error("[db] Pool error:", e.message);
      }
    });
  }
  return _pool;
}

function toPgSql(sql) {
  sql = sql.replace(/datetime\('now'\)/gi, "NOW()");
  sql = sql.replace(
    /datetime\('now',\s*'([+-])(\d+)\s+(days?|hours?|minutes?)'\)/gi,
    (_, dir, amt, unit) => dir === "-"
      ? `NOW() - INTERVAL '${amt} ${unit}'`
      : `NOW() + INTERVAL '${amt} ${unit}'`
  );
  sql = sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
  sql = sql.replace(/AUTOINCREMENT/gi, "");
  sql = sql.replace(
    /INSERT OR IGNORE INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi,
    (_, table, cols, vals) => `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`
  );
  sql = sql.replace(/INSERT OR IGNORE INTO/gi, "INSERT INTO");
  sql = sql.replace(
    /INSERT OR REPLACE INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi,
    (_, table, cols, vals) => {
      const colArr = cols.split(",").map(c => c.trim());
      const updates = colArr.slice(1).map(c => `${c} = EXCLUDED.${c}`).join(", ");
      return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT (${colArr[0]}) DO UPDATE SET ${updates}`;
    }
  );
  return sql.trim();
}

function convertPlaceholders(sql, args) {
  if (args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0])) {
    const obj = args[0];
    const order = [];
    const seen = new Set();
    const re = /@(\w+)/g;
    let m;
    while ((m = re.exec(sql))) {
      if (!seen.has(m[1])) { seen.add(m[1]); order.push(m[1]); }
    }
    let out = sql;
    order.forEach((k, i) => { out = out.replace(new RegExp(`@${k}\\b`, "g"), `$${i + 1}`); });
    return { sql: out, values: order.map(k => obj[k] !== undefined ? obj[k] : null) };
  }
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  return { sql: pgSql, values: args.map(v => v !== undefined ? v : null) };
}

function makeSyncQuery(pool) {
  if (!deasync) {
    throw new Error("deasync not loaded — cannot provide sync query API");
  }
  function pgQueryCb(sql, values, cb) {
    pool.query(sql, values).then(r => cb(null, r)).catch(e => cb(e));
  }
  const querySync = deasync(pgQueryCb);
  return querySync;
}

function makeDb(pool) {
  const querySync = makeSyncQuery(pool);

  const db = {
    _pool: pool,

    exec(sql) {
      const pgSql = toPgSql(sql);
      const stmts = pgSql.split(";").map(s => s.trim()).filter(s => s.length > 0);
      for (const stmt of stmts) {
        try {
          querySync(stmt, []);
        } catch (e) {
          if (e.code !== "42P07" && e.code !== "42710") {
            console.warn("[db] exec warn:", e.message.slice(0, 120));
          }
        }
      }
    },

    prepare(sqlIn) {
      return {
        _sql: sqlIn,

        run(...args) {
          const { sql, values } = convertPlaceholders(sqlIn, args);
          let pgSql = toPgSql(sql);
          const upper = pgSql.toUpperCase().trim();
          if (upper.startsWith("INSERT") && !upper.includes("RETURNING")) {
            const tablesNoId = /INTO\s+(visibility_settings|branch_access_rules|notice_reads|integration_kv|user_face_profiles|user_role_assignments)\b/i;
            if (!tablesNoId.test(pgSql)) {
              pgSql += " RETURNING id";
            }
          }
          try {
            const res = querySync(pgSql, values);
            return { changes: res.rowCount, lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : null };
          } catch (e) {
            if (e.code === "23505" || e.code === "23503") return { changes: 0, lastInsertRowid: null };
            console.error("[db.run]", e.message, "\nSQL:", pgSql.slice(0, 200));
            return { changes: 0, lastInsertRowid: null };
          }
        },

        get(...args) {
          const { sql, values } = convertPlaceholders(sqlIn, args);
          const pgSql = toPgSql(sql);
          try {
            const res = querySync(pgSql, values);
            return res.rows && res.rows[0] ? res.rows[0] : undefined;
          } catch (e) {
            console.error("[db.get]", e.message, "\nSQL:", pgSql.slice(0, 200));
            return undefined;
          }
        },

        all(...args) {
          const { sql, values } = convertPlaceholders(sqlIn, args);
          const pgSql = toPgSql(sql);
          try {
            const res = querySync(pgSql, values);
            return res.rows || [];
          } catch (e) {
            console.error("[db.all]", e.message, "\nSQL:", pgSql.slice(0, 200));
            return [];
          }
        },
      };
    },

    transaction(fn) {
      return (...fnArgs) => {
        try {
          querySync("BEGIN", []);
          const result = fn(...fnArgs);
          querySync("COMMIT", []);
          return result;
        } catch (e) {
          try { querySync("ROLLBACK", []); } catch {}
          throw e;
        }
      };
    },
  };
  return db;
}

async function readKv(pool, key) {
  try {
    const res = await pool.query("SELECT v FROM integration_kv WHERE k = $1", [key]);
    if (!res.rows[0]?.v) return "";
    const o = JSON.parse(res.rows[0].v);
    return String(o.secret || o.password || "").trim();
  } catch { return ""; }
}

async function writeKv(pool, key, obj) {
  await pool.query(
    `INSERT INTO integration_kv (k, v) VALUES ($1, $2)
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [key, JSON.stringify(obj)]
  );
}

async function hydrateRuntimeSecrets(pool) {
  async function hydrateOne(envName, kvKey, byteLength) {
    const fromEnv = String(process.env[envName] || "").trim();
    if (fromEnv) { process.env[envName] = fromEnv; return; }
    const fromDb = await readKv(pool, kvKey);
    if (fromDb) { process.env[envName] = fromDb; return; }
    const generated = crypto.randomBytes(byteLength).toString("hex");
    await writeKv(pool, kvKey, { secret: generated });
    process.env[envName] = generated;
    console.warn(`[hrms] ${envName} auto-generated and stored in DB.`);
  }
  await hydrateOne("SESSION_SECRET", "hrms_runtime_session_secret", 32);
  await hydrateOne("JWT_SECRET", "hrms_runtime_jwt_secret", 48);
}

async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS branches (id SERIAL PRIMARY KEY, name TEXT NOT NULL, lat REAL, lng REAL, radius_meters INTEGER NOT NULL DEFAULT 300, address TEXT, city TEXT, state TEXT, wifi_enabled INTEGER DEFAULT 0, wifi_ssids TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_name ON branches(lower(name))`,
      `CREATE TABLE IF NOT EXISTS departments (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, login_id TEXT, password_hash TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT NOT NULL, branch_id INTEGER REFERENCES branches(id), shift_start TEXT NOT NULL DEFAULT '09:00', shift_end TEXT NOT NULL DEFAULT '18:00', grace_minutes INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, mobile TEXT, department TEXT, allow_gps INTEGER DEFAULT 0, allow_face INTEGER DEFAULT 1, allow_manual INTEGER DEFAULT 0, allow_biometric INTEGER DEFAULT 1, profile_photo TEXT, dob TEXT, address TEXT, account_number TEXT, ifsc TEXT, bank_name TEXT, kiosk_pin_hash TEXT, base_salary_inr REAL DEFAULT 12000, joining_date TEXT, payroll_job_role TEXT DEFAULT 'delivery', min_working_hours_override REAL, account_status TEXT DEFAULT 'ACTIVE', rejection_reason TEXT, registered_via TEXT, deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_id ON users(login_id) WHERE login_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_users_active ON users(active, deleted_at, role)`,
      `CREATE TABLE IF NOT EXISTS attendance_records (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), work_date TEXT NOT NULL, punch_in_at TIMESTAMPTZ, punch_out_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'absent', half_period TEXT, source TEXT NOT NULL DEFAULT 'device', in_lat REAL, in_lng REAL, out_lat REAL, out_lng REAL, notes TEXT, last_edited_by INTEGER REFERENCES users(id), punch_in_address TEXT, punch_out_address TEXT, in_device_info TEXT, out_device_info TEXT, punch_in_photo TEXT, punch_out_photo TEXT, punch_method_in TEXT, punch_method_out TEXT, device_in TEXT, device_out TEXT, verification_in TEXT, verification_out TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, work_date))`,
      `CREATE INDEX IF NOT EXISTS idx_att_user_date ON attendance_records(user_id, work_date)`,
      `CREATE INDEX IF NOT EXISTS idx_att_work_date ON attendance_records(work_date)`,
      `CREATE INDEX IF NOT EXISTS idx_att_status ON attendance_records(status, work_date)`,
      `CREATE INDEX IF NOT EXISTS idx_att_open_punch ON attendance_records(work_date, punch_in_at) WHERE punch_out_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS integration_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS notices (id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), active INTEGER NOT NULL DEFAULT 1, visible_from TIMESTAMPTZ, visible_until TIMESTAMPTZ, repeat_rule TEXT, show_on_punch INTEGER DEFAULT 1, notice_type TEXT DEFAULT 'announcement', target_branch_id INTEGER, target_role TEXT, allow_replies INTEGER DEFAULT 1, admin_replies_only INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS notice_reads (notice_id INTEGER NOT NULL REFERENCES notices(id), user_id INTEGER NOT NULL REFERENCES users(id), read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (notice_id, user_id))`,
      `CREATE INDEX IF NOT EXISTS idx_notice_reads_user ON notice_reads(user_id)`,
      `CREATE TABLE IF NOT EXISTS notice_replies (id SERIAL PRIMARY KEY, notice_id INTEGER NOT NULL REFERENCES notices(id), user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, is_admin_reply INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_notice_replies_notice ON notice_replies(notice_id)`,
      `CREATE TABLE IF NOT EXISTS leave_requests (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT NOT NULL, leave_type TEXT NOT NULL DEFAULT 'casual', final_status TEXT NOT NULL DEFAULT 'PENDING', manager_review TEXT, admin_review TEXT, manager_comment TEXT, admin_comment TEXT, manager_action_at TIMESTAMPTZ, admin_action_at TIMESTAMPTZ, manager_action_by INTEGER REFERENCES users(id), admin_action_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(final_status)`,
      `CREATE TABLE IF NOT EXISTS leave_threads (id SERIAL PRIMARY KEY, leave_id INTEGER NOT NULL REFERENCES leave_requests(id), author_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_leave_threads_leave ON leave_threads(leave_id, id)`,
      `CREATE TABLE IF NOT EXISTS employee_documents (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), doc_type TEXT NOT NULL, file_name TEXT NOT NULL, file_path TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, doc_status TEXT NOT NULL DEFAULT 'pending', verified_by INTEGER REFERENCES users(id), verified_at TIMESTAMPTZ, verifier_notes TEXT, account_number TEXT, ifsc TEXT, bank_name TEXT, deleted_at TIMESTAMPTZ, deleted_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_employee_documents_user ON employee_documents(user_id)`,
      `CREATE TABLE IF NOT EXISTS payroll_entries (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), period TEXT NOT NULL, gross_inr REAL NOT NULL DEFAULT 0, deductions_inr REAL NOT NULL DEFAULT 0, net_inr REAL NOT NULL DEFAULT 0, notes TEXT, delivery_amount REAL NOT NULL DEFAULT 0, total_leaves REAL NOT NULL DEFAULT 0, leave_type TEXT NOT NULL DEFAULT 'paid', late_minutes INTEGER NOT NULL DEFAULT 0, incentive_inr REAL NOT NULL DEFAULT 0, leave_deduction_inr REAL NOT NULL DEFAULT 0, late_deduction_inr REAL NOT NULL DEFAULT 0, no_leave_bonus_inr REAL NOT NULL DEFAULT 0, base_salary_snapshot REAL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, period))`,
      `CREATE INDEX IF NOT EXISTS idx_payroll_entries_period ON payroll_entries(period)`,
      `CREATE TABLE IF NOT EXISTS payroll_special_holidays (id SERIAL PRIMARY KEY, holiday_date TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS payroll_delivery_daily (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), work_date TEXT NOT NULL, amount_inr REAL NOT NULL DEFAULT 0, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, work_date))`,
      `CREATE TABLE IF NOT EXISTS user_face_profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id), phash TEXT NOT NULL, reference_path TEXT, embedding_json TEXT, descriptor_count INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS push_subscriptions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)`,
      `CREATE TABLE IF NOT EXISTS hr_chat_messages (id SERIAL PRIMARY KEY, thread_user_id INTEGER NOT NULL REFERENCES users(id), author_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, read_by_other INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_hr_chat_thread ON hr_chat_messages(thread_user_id)`,
      `CREATE TABLE IF NOT EXISTS hr_alerts (id SERIAL PRIMARY KEY, type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'warning', message TEXT NOT NULL, user_id INTEGER REFERENCES users(id), actor_id INTEGER REFERENCES users(id), meta TEXT, read_by_admin INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_hr_alerts_created ON hr_alerts(created_at)`,
      `CREATE TABLE IF NOT EXISTS login_otps (id SERIAL PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS password_reset_otps (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), otp_code TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_pwreset_otp_user ON password_reset_otps(user_id)`,
      `CREATE TABLE IF NOT EXISTS visibility_settings (role TEXT NOT NULL, feature TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (role, feature))`,
      `CREATE TABLE IF NOT EXISTS branch_access_rules (role TEXT NOT NULL, branch_id INTEGER NOT NULL, accessible INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (role, branch_id))`,
      `CREATE TABLE IF NOT EXISTS audit_logs (id SERIAL PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, actor_id INTEGER REFERENCES users(id), details TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)`,
      `CREATE TABLE IF NOT EXISTS custom_roles (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, permissions_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS user_role_assignments (user_id INTEGER PRIMARY KEY REFERENCES users(id), custom_role_id INTEGER NOT NULL REFERENCES custom_roles(id), assigned_by INTEGER REFERENCES users(id), assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS webauthn_credentials (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), credential_id TEXT NOT NULL UNIQUE, public_key_b64 TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, device_label TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_used_at TIMESTAMPTZ)`,
      `CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id)`,
      `CREATE TABLE IF NOT EXISTS biometric_update_requests (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), requester_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, reject_reason TEXT, resolved_at TIMESTAMPTZ, resolved_by_id INTEGER REFERENCES users(id), approval_expires_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_bio_req_user_kind_status ON biometric_update_requests(user_id, kind, status)`,
      `CREATE TABLE IF NOT EXISTS biometric_update_verifications (id SERIAL PRIMARY KEY, request_user_id INTEGER REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS profile_update_requests (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), requested_changes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, reject_reason TEXT, resolved_by_id INTEGER REFERENCES users(id), resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_profile_req_user_status ON profile_update_requests(user_id, status)`,
      `CREATE TABLE IF NOT EXISTS system_guides (id SERIAL PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, body TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS apps_script_sync_log (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), tab TEXT, ok INTEGER NOT NULL DEFAULT 0, response_snippet TEXT, error TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_apps_script_log_created ON apps_script_sync_log(created_at)`,
      `CREATE TABLE IF NOT EXISTS apps_script_sync_queue (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), tab TEXT NOT NULL, payload_json TEXT NOT NULL, match_key TEXT, dedupe_key TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), dead INTEGER NOT NULL DEFAULT 0, UNIQUE(tab, dedupe_key))`,
      `CREATE INDEX IF NOT EXISTS idx_apps_script_queue_next ON apps_script_sync_queue(dead, next_attempt_at)`,
      `CREATE TABLE IF NOT EXISTS crm_leads (id SERIAL PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT, email TEXT, company TEXT, status TEXT NOT NULL DEFAULT 'new', notes TEXT, created_by INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_crm_leads_created ON crm_leads(created_at)`,
    ];

    for (const stmt of stmts) {
      try {
        await client.query(stmt);
      } catch (e) {
        if (e.code !== "42P07" && e.code !== "42710" && e.code !== "42P16") {
          console.warn("[db] Migration warning:", e.message.slice(0, 150));
        }
      }
    }

    console.log("[db] ✓ Schema ready");
  } finally {
    client.release();
  }
}

async function ensureBootstrapData(pool) {
  const branches = [
    { name: "Jaipur", lat: 26.99334, lng: 75.73716, radius_meters: 400 },
    { name: "Amritsar", lat: 31.66749, lng: 74.87296, radius_meters: 400 },
    { name: "Meerut", lat: 28.96237, lng: 77.69552, radius_meters: 400 },
  ];
  for (const b of branches) {
    const ex = await pool.query("SELECT id FROM branches WHERE lower(name) = lower($1)", [b.name]);
    if (!ex.rows[0]) {
      await pool.query(
        "INSERT INTO branches (name, lat, lng, radius_meters) VALUES ($1, $2, $3, $4)",
        [b.name, b.lat, b.lng, b.radius_meters]
      ).catch(() => {});
    }
  }

  const depts = ["Sales Executive", "Courier Department", "IT", "Sales Employee", "Courier", "Sales", "Support", "Packing"];
  for (const d of depts) {
    await pool.query("INSERT INTO departments (name, active) VALUES ($1, 1) ON CONFLICT (name) DO NOTHING", [d]);
  }

  const row = await pool.query("SELECT v FROM integration_kv WHERE k = 'company_profile'");
  if (!row.rows[0]) {
    await pool.query(
      "INSERT INTO integration_kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING",
      ["company_profile", JSON.stringify({
        company_name: "HRMS Portal",
        legal_name: "HRMS PORTAL",
        address: "", city: "", state: "", pincode: "", email: "",
      })]
    );
  }
}

async function ensureSuperAdmin(pool) {
  const superEmail = String(process.env.SUPER_ADMIN_EMAIL || "").trim() || "superadmin@hrms.local";
  const envOverridePw = String(process.env.SUPER_ADMIN_PASSWORD || "").trim();

  const byLogin = await pool.query("SELECT id FROM users WHERE login_id = $1", ["prakritiherbs"]);
  if (byLogin.rows[0]) {
    const id = byLogin.rows[0].id;
    await pool.query(
      "UPDATE users SET full_name=$1, role=$2, active=1, deleted_at=NULL, account_status='ACTIVE' WHERE id=$3",
      ["Mandeep Kumar", ROLES.SUPER_ADMIN, id]
    );
    if (envOverridePw) {
      await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [bcrypt.hashSync(envOverridePw, 10), id]);
      console.log("[ensureSuperAdmin] Password updated from env");
    }
    return;
  }

  const branchRow = await pool.query("SELECT id FROM branches ORDER BY id LIMIT 1");
  const branchId = branchRow.rows[0]?.id;
  const actualPw = envOverridePw || crypto.randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO users (email, login_id, password_hash, full_name, role, branch_id, shift_start, shift_end, grace_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, '09:00', '18:00', 15) ON CONFLICT (email) DO NOTHING`,
    [superEmail, "prakritiherbs", bcrypt.hashSync(actualPw, 10), "Mandeep Kumar", ROLES.SUPER_ADMIN, branchId]
  );
}

let _dbInstance = null;

async function openDb() {
  if (_dbInstance) return _dbInstance;
  const pool = getPool();
  await runMigrations(pool);
  await pool.query("SELECT 1");
  await pool.query(`CREATE TABLE IF NOT EXISTS integration_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`).catch(() => {});
  await hydrateRuntimeSecrets(pool);
  await ensureBootstrapData(pool);
  await ensureSuperAdmin(pool);
  const db = makeDb(pool);
  _dbInstance = db;
  return db;
}

module.exports = { openDb, getPool, hydrateRuntimeSecrets, dbPath: null };
