/**
 * WebAuthn (passkeys) for attendance: register platform / roaming authenticators,
 * then verify userVerification-gated assertions before punch when policy requires it.
 *
 * Env:
 * - WEBAUTHN_RP_ID — e.g. localhost or your apex domain (must match the site hostname).
 * - WEBAUTHN_ORIGINS — comma-separated allowed origins (e.g. https://app.example.com,http://localhost:5173).
 * - WEBAUTHN_ATTENDANCE — off | after_register | required
 *     off: no WebAuthn gate on punch (legacy behaviour).
 *     after_register: if the user has ≥1 passkey, every punch must include a valid assertion.
 *     required: punch blocked until at least one passkey is registered; then assertion required.
 */

const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { isoUint8Array, isoBase64URL } = require("@simplewebauthn/server/helpers");
const {
  assertWebAuthnSelfRegistrationAllowed,
  markApprovalRequestCompleted,
  webauthnCredentialCount,
} = require("./biometricPolicy");
const { ROLES, can } = require("./rbac");

const CHALLENGE_TTL_MS = 120000;
/** @type {Map<string, { challenge: string; userId: number; exp: number }>} */
const challenges = new Map();

function pruneChallenges() {
  const now = Date.now();
  for (const [k, v] of challenges) {
    if (v.exp < now) challenges.delete(k);
  }
}

function attendancePolicy() {
  const m = String(process.env.WEBAUTHN_ATTENDANCE || "after_register").toLowerCase();
  if (m === "off" || m === "optional" || m === "0" || m === "false") return "off";
  if (m === "required" || m === "enforce") return "required";
  return "after_register";
}

function getRpId() {
  const fromEnv = String(process.env.WEBAUTHN_RP_ID || "").trim();
  if (fromEnv) return fromEnv;
  const origins = getConfiguredOrigins();
  try {
    const u = new URL(origins[0]);
    return u.hostname || "localhost";
  } catch {
    return "localhost";
  }
}

function getConfiguredOrigins() {
  const raw = String(process.env.WEBAUTHN_ORIGINS || "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
  ];
}

function getExpectedOrigins(req) {
  const list = [...getConfiguredOrigins()];
  const origin = String(req.get("origin") || "").trim();
  if (origin && !list.includes(origin)) list.push(origin);
  return list;
}

function credentialCountForUser(db, userId) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM webauthn_credentials WHERE user_id = ?").get(userId);
  return Number(row?.c || 0);
}

function punchRequiresWebAuthn(db, subjectId) {
  const mode = attendancePolicy();
  const n = credentialCountForUser(db, subjectId);
  if (mode === "off") return { require: false, credCount: n, mode };
  if (mode === "required") return { require: true, credCount: n, mode };
  return { require: n > 0, credCount: n, mode };
}

function parseWebAuthnPayload(body) {
  if (!body) return null;
  let raw = body.webAuthn ?? body.webauthn;
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

/**
 * Call from runPunch after geo checks. Returns { ok: true } or { ok, status, error, code }.
 */
async function verifyWebAuthnForAttendancePunch({ db, req, subjectId, actorId }) {
  /** Passkeys are bound to the logged-in user; on-behalf punches skip WebAuthn (manager flows). */
  if (Number(actorId) !== Number(subjectId)) return { ok: true };

  const { require: need, credCount, mode } = punchRequiresWebAuthn(db, subjectId);
  if (!need) return { ok: true };

  if (!credCount) {
    return {
      ok: false,
      status: 403,
      error:
        mode === "required"
          ? "Passkey registration is required before attendance. Use Security → Passkeys to register."
          : "Passkey required.",
      code: "WEBAUTHN_REGISTER_REQUIRED",
    };
  }

  const payload = parseWebAuthnPayload(req.body);
  if (!payload || !payload.challengeId || !payload.response) {
    return {
      ok: false,
      status: 400,
      error: "WebAuthn assertion required for attendance (passkey / biometric).",
      code: "WEBAUTHN_ASSERTION_MISSING",
    };
  }

  pruneChallenges();
  const slot = challenges.get(`auth:${payload.challengeId}`);
  if (!slot || slot.userId !== subjectId || Date.now() > slot.exp) {
    return {
      ok: false,
      status: 400,
      error: "WebAuthn challenge expired or invalid. Request a new assertion from the app.",
      code: "WEBAUTHN_CHALLENGE_INVALID",
    };
  }

  const credIdB64 = String(payload.response.id || "");
  const row = db
    .prepare("SELECT * FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?")
    .get(subjectId, credIdB64);
  if (!row) {
    return {
      ok: false,
      status: 400,
      error: "Unknown passkey for this account.",
      code: "WEBAUTHN_CREDENTIAL_UNKNOWN",
    };
  }

  const rpID = getRpId();
  const expectedOrigins = getExpectedOrigins(req);

  let verified;
  try {
    const result = await verifyAuthenticationResponse({
      response: payload.response,
      expectedChallenge: slot.challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpID,
      authenticator: {
        credentialID: row.credential_id,
        credentialPublicKey: isoBase64URL.toBuffer(row.public_key_b64),
        counter: Number(row.counter || 0),
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
      requireUserVerification: true,
    });
    verified = result.verified;
    if (verified && result.authenticationInfo) {
      db.prepare(
        `UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?`
      ).run(result.authenticationInfo.newCounter, row.id);
    }
  } catch (e) {
    return {
      ok: false,
      status: 400,
      error: e.message || "WebAuthn verification failed",
      code: "WEBAUTHN_VERIFY_FAILED",
    };
  }

  challenges.delete(`auth:${payload.challengeId}`);

  if (!verified) {
    return {
      ok: false,
      status: 400,
      error: "WebAuthn verification failed",
      code: "WEBAUTHN_NOT_VERIFIED",
    };
  }

  return { ok: true };
}

function registerWebAuthnRoutes(router, { db, attachUser, insertAudit }) {
  const rpName = String(process.env.WEBAUTHN_RP_NAME || "HRMS Portal").trim() || "HRMS Portal";

  router.get("/webauthn/status", attachUser, (req, res) => {
    const mode = attendancePolicy();
    const credCount = credentialCountForUser(db, req.currentUser.id);
    const punchGate = punchRequiresWebAuthn(db, req.currentUser.id);
    res.json({
      mode,
      credCount,
      punchRequiresWebAuthn: punchGate.require,
      rpId: getRpId(),
    });
  });

  router.get("/webauthn/credentials", attachUser, (req, res) => {
    const rows = db
      .prepare(
        `SELECT id, device_label, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY id DESC`
      )
      .all(req.currentUser.id);
    res.json({ credentials: rows });
  });

  router.delete("/webauthn/credentials/:id", attachUser, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT id FROM webauthn_credentials WHERE id = ? AND user_id = ?").get(id, req.currentUser.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const cnt = webauthnCredentialCount(db, req.currentUser.id);
    if (req.currentUser.role === ROLES.USER && cnt <= 1 && !can(req.currentUser, "biometric:admin")) {
      return res.status(403).json({
        error:
          "Removing your only passkey is not allowed here. Request a biometric update (Identity page) or ask HR to reset your passkeys.",
      });
    }
    db.prepare("DELETE FROM webauthn_credentials WHERE id = ?").run(id);
    insertAudit(req.currentUser.id, "webauthn_credential_delete", "webauthn", id, {});
    res.json({ ok: true });
  });

  router.post("/webauthn/register/options", attachUser, async (req, res, next) => {
    try {
      pruneChallenges();
      const u = req.currentUser;
      const approvalRaw = req.body?.approvalRequestId;
      const approvalRequestId =
        approvalRaw != null && String(approvalRaw).trim() !== "" ? Number(approvalRaw) : null;
      const gate = assertWebAuthnSelfRegistrationAllowed({
        db,
        actor: u,
        approvalRequestId: Number.isFinite(approvalRequestId) ? approvalRequestId : null,
      });
      if (!gate.ok) {
        return res.status(gate.status).json({ error: gate.error, code: "WEBAUTHN_REGISTER_BLOCKED" });
      }
      const replaceAll = gate.mode === "approval_replace";
      const existing = db
        .prepare("SELECT credential_id AS id, transports FROM webauthn_credentials WHERE user_id = ?")
        .all(u.id);
      const excludeCredentials = replaceAll
        ? []
        : existing.map((r) => ({
            id: r.id,
            transports: r.transports ? JSON.parse(r.transports) : undefined,
          }));

      const options = await generateRegistrationOptions({
        rpName,
        rpID: getRpId(),
        userID: isoUint8Array.fromUTF8String(String(u.id)),
        userName: u.email || String(u.id),
        userDisplayName: u.full_name || u.email || `User ${u.id}`,
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
        excludeCredentials,
      });

      const challengeId = crypto.randomBytes(16).toString("hex");
      challenges.set(`reg:${challengeId}`, {
        challenge: options.challenge,
        userId: u.id,
        exp: Date.now() + CHALLENGE_TTL_MS,
        replaceAll,
        approvalRequestId: gate.approvalRow ? gate.approvalRow.id : null,
      });

      res.json({ challengeId, options, registrationMode: gate.mode });
    } catch (e) {
      next(e);
    }
  });

  router.post("/webauthn/register/verify", attachUser, async (req, res, next) => {
    try {
      pruneChallenges();
      const { challengeId, response, deviceLabel } = req.body || {};
      if (!challengeId || !response) {
        return res.status(400).json({ error: "challengeId and response required" });
      }
      const slot = challenges.get(`reg:${challengeId}`);
      if (!slot || slot.userId !== req.currentUser.id || Date.now() > slot.exp) {
        return res.status(400).json({ error: "Registration challenge expired or invalid" });
      }

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: slot.challenge,
        expectedOrigin: getExpectedOrigins(req),
        expectedRPID: getRpId(),
        requireUserVerification: true,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: "Passkey registration could not be verified" });
      }

      const info = verification.registrationInfo;
      const credentialId = info.credentialID;
      const publicKeyB64 = isoBase64URL.fromBuffer(info.credentialPublicKey);
      const transports = JSON.stringify(Array.isArray(response.transports) ? response.transports : []);

      const uid = req.currentUser.id;
      const beforeIds = db.prepare("SELECT id, credential_id FROM webauthn_credentials WHERE user_id = ?").all(uid);

      try {
        if (slot.replaceAll) {
          db.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?").run(uid);
        }
        db.prepare(
          `INSERT INTO webauthn_credentials (user_id, credential_id, public_key_b64, counter, transports, device_label)
           VALUES (?,?,?,?,?,?)`
        ).run(
          uid,
          credentialId,
          publicKeyB64,
          info.counter,
          transports,
          String(deviceLabel || "Passkey").slice(0, 120)
        );
      } catch (e) {
        if (String(e.message || "").includes("UNIQUE")) {
          return res.status(409).json({ error: "This passkey is already registered" });
        }
        throw e;
      }

      challenges.delete(`reg:${challengeId}`);
      if (slot.approvalRequestId) {
        markApprovalRequestCompleted(db, slot.approvalRequestId);
      }
      insertAudit(req.currentUser.id, "webauthn_register", "webauthn", uid, {
        credentialId,
        replaced_all: !!slot.replaceAll,
        previous_credentials: beforeIds,
      });
      res.json({ ok: true, verified: true });
    } catch (e) {
      next(e);
    }
  });

  router.post("/webauthn/attendance/options", attachUser, async (req, res, next) => {
    try {
      pruneChallenges();
      const u = req.currentUser;
      const rows = db
        .prepare("SELECT credential_id AS id, transports FROM webauthn_credentials WHERE user_id = ?")
        .all(u.id);
      if (!rows.length) {
        return res.status(400).json({ error: "No passkeys registered for this account" });
      }

      const allowCredentials = rows.map((r) => ({
        id: r.id,
        type: "public-key",
        transports: r.transports ? JSON.parse(r.transports) : undefined,
      }));

      const options = await generateAuthenticationOptions({
        rpID: getRpId(),
        allowCredentials,
        userVerification: "required",
        timeout: 120000,
      });

      const challengeId = crypto.randomBytes(16).toString("hex");
      challenges.set(`auth:${challengeId}`, {
        challenge: options.challenge,
        userId: u.id,
        exp: Date.now() + CHALLENGE_TTL_MS,
      });

      res.json({ challengeId, options });
    } catch (e) {
      next(e);
    }
  });
}

module.exports = {
  registerWebAuthnRoutes,
  verifyWebAuthnForAttendancePunch,
  attendancePolicy,
  punchRequiresWebAuthn,
};
