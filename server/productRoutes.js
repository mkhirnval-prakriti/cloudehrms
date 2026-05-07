/**
 * PWA/mobile meta, PDF/XLSX reports, module exports, face enrollment.
 */
const fs = require("fs");
const path = require("path");
const { phashFromBuffer } = require("./faceHash");
const {
  buildDailyPdfBuffer,
  buildMonthlyPdfBuffer,
  buildDailyXlsxBuffer,
  buildMonthlyAttendanceXlsxBuffer,
} = require("./productReports");
const { notifyDailySummaryWhatsApp } = require("./whatsapp");
const { assertFaceEnrollmentAllowed, markApprovalRequestCompleted } = require("./biometricPolicy");
const {
  parseEmbeddingPayload,
  serializeEmbedding,
  averageEmbeddingsDetailed,
  tooSimilar,
  EMBEDDING_DIM,
} = require("./faceEmbedding");

function registerProductRoutes(router, ctx) {
  const { db, attachUser, can, ROLES, uploadFace, insertAudit } = ctx;
  const todayLocalDate =
    typeof ctx.todayLocalDate === "function" ? ctx.todayLocalDate : () => new Date().toISOString().slice(0, 10);

  router.get("/meta", (_req, res) => {
    res.json({
      name: "HRMS Portal API",
      version: "1.1",
      auth: ["Authorization: Bearer <jwt>", "Cookie session (legacy)"],
      baseUrl: "/api",
      mobileReady: true,
      endpoints: {
        health: "/api/health",
        login: "POST /api/auth/login",
        me: "GET /api/auth/me",
        attendance: "GET/POST /api/attendance/*",
        reports: "GET /api/reports/*.pdf|xlsx",
      },
      generatedAt: new Date().toISOString(),
    });
  });

  router.get("/reports/daily.pdf", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "export:read") && !can(req.currentUser, "dashboard:read")) {
        return res.status(403).send("Forbidden");
      }
      const workDate = req.query.date ? String(req.query.date).trim() : todayLocalDate();

      const totalStaff = Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE active = 1").get().c);
      const statusRows = db
        .prepare(
          `SELECT ar.status, COUNT(*) AS c FROM attendance_records ar
           JOIN users u ON u.id = ar.user_id AND u.active = 1 WHERE ar.work_date = ? GROUP BY ar.status`
        )
        .all(workDate);
      const smap = Object.fromEntries(statusRows.map((x) => [x.status, x.c]));

      const pdf = await buildDailyPdfBuffer({
        dateStr: workDate,
        totalStaff,
        smap,
        title: "HRMS Portal — Daily Report",
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="daily-report-${workDate}.pdf"`);
      res.send(pdf);
    } catch (e) {
      next(e);
    }
  });

  router.get("/reports/daily.xlsx", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "export:read") && !can(req.currentUser, "dashboard:read")) {
        return res.status(403).send("Forbidden");
      }
      const workDate = req.query.date ? String(req.query.date) : todayLocalDate();

      const totalStaff = Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE active = 1").get().c);
      const statusRows = db
        .prepare(
          `SELECT ar.status, COUNT(*) AS c FROM attendance_records ar
           JOIN users u ON u.id = ar.user_id AND u.active = 1 WHERE ar.work_date = ? GROUP BY ar.status`
        )
        .all(workDate);
      const smap = Object.fromEntries(statusRows.map((x) => [x.status, x.c]));
      const buf = await buildDailyXlsxBuffer({ dateStr: workDate, totalStaff, smap });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="daily-report-${workDate}.xlsx"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  router.get("/reports/monthly.pdf", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "export:read")) {
        return res.status(403).send("Forbidden");
      }
      const now = new Date();
      const y = Number(req.query.year) || now.getFullYear();
      const m = Number(req.query.month) || now.getMonth() + 1;
      const pad = (n) => String(n).padStart(2, "0");
      const period = `${y}-${pad(m)}`;

      let payrollTotals = null;
      try {
        const pr = db
          .prepare(
            `SELECT COALESCE(SUM(gross_inr),0) AS g, COALESCE(SUM(deductions_inr),0) AS d, COUNT(*) AS c FROM payroll_entries WHERE period = ?`
          )
          .get(period);
        payrollTotals = {
          gross: Number(pr.g) || 0,
          deductions: Number(pr.d) || 0,
          net: (Number(pr.g) || 0) - (Number(pr.d) || 0),
          count: Number(pr.c) || 0,
        };
      } catch {
        payrollTotals = { gross: 0, deductions: 0, net: 0, count: 0 };
      }

      const pdf = await buildMonthlyPdfBuffer({
        year: y,
        month: m,
        period,
        payrollTotals,
        title: "HRMS Portal — Monthly Report",
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="monthly-report-${period}.pdf"`);
      res.send(pdf);
    } catch (e) {
      next(e);
    }
  });

  router.get("/reports/monthly-attendance.xlsx", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "export:read")) {
        return res.status(403).send("Forbidden");
      }
      const now = new Date();
      const y = Number(req.query.year) || now.getFullYear();
      const m = Number(req.query.month) || now.getMonth() + 1;
      const pad = (n) => String(n).padStart(2, "0");
      const from = `${y}-${pad(m)}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const to = `${y}-${pad(m)}-${String(lastDay).padStart(2, "0")}`;

      let sql = `
        SELECT ar.work_date, u.full_name, u.email, u.login_id, b.name AS branch_name, ar.status, ar.punch_in_at, ar.punch_out_at
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
      const rows = db.prepare(sql).all(...params);
      const buf = await buildMonthlyAttendanceXlsxBuffer(rows, "Attendance");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="monthly-attendance-${y}-${pad(m)}.xlsx"`
      );
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  router.get("/leave/export.csv", attachUser, (req, res) => {
    if (!can(req.currentUser, "leave:read_all") && !can(req.currentUser, "leave:read_self")) {
      return res.status(403).send("Forbidden");
    }
    let sql = `SELECT lr.id, lr.user_id, u.full_name, u.email, lr.start_date, lr.end_date, lr.reason, lr.final_status,
      lr.manager_review, lr.admin_review, lr.created_at
      FROM leave_requests lr JOIN users u ON u.id = lr.user_id`;
    const params = [];
    if (!can(req.currentUser, "leave:read_all")) {
      sql += " WHERE lr.user_id = ?";
      params.push(req.currentUser.id);
    }
    sql += " ORDER BY lr.created_at DESC LIMIT 5000";
    const rows = db.prepare(sql).all(...params);
    const headers = [
      "id",
      "user_id",
      "full_name",
      "email",
      "start_date",
      "end_date",
      "reason",
      "final_status",
      "manager_review",
      "admin_review",
      "created_at",
    ];
    const esc = (v) => {
      if (v == null) return '""';
      return `"${String(v).replace(/"/g, '""')}"`;
    };
    const lines = [headers.join(",")];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leave-requests.csv"');
    res.send(lines.join("\n"));
  });

  router.get("/documents/export.xlsx", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "documents:read_all") && !can(req.currentUser, "documents:verify")) {
        return res.status(403).send("Forbidden");
      }
      const rows = db
        .prepare(
          `SELECT d.id, d.user_id, u.full_name, u.email, d.doc_type, d.file_name, d.verified, d.created_at
           FROM employee_documents d JOIN users u ON u.id = d.user_id ORDER BY d.id DESC LIMIT 5000`
        )
        .all();
      const buf = await buildMonthlyAttendanceXlsxBuffer(rows, "Documents");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", 'attachment; filename="documents-export.xlsx"');
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  router.get("/payroll/export.xlsx", attachUser, async (req, res, next) => {
    try {
      if (!can(req.currentUser, "payroll:read")) {
        return res.status(403).send("Forbidden");
      }
      const period = String(req.query.period || "").trim().slice(0, 7) || todayLocalDate().slice(0, 7);
      const rows = db
        .prepare(
          `SELECT p.user_id, u.full_name, u.email, p.period, p.gross_inr, p.deductions_inr, p.net_inr, p.notes, p.updated_at
           FROM payroll_entries p JOIN users u ON u.id = p.user_id WHERE p.period = ? ORDER BY u.full_name`
        )
        .all(period);
      const buf = await buildMonthlyAttendanceXlsxBuffer(rows, "Payroll");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="payroll-${period}.xlsx"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  router.post("/reports/send-daily-whatsapp", attachUser, async (req, res, next) => {
    try {
      if (req.currentUser.role !== ROLES.SUPER_ADMIN && !can(req.currentUser, "settings:write")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const dateStr = (req.body && req.body.date) || todayLocalDate();
      await notifyDailySummaryWhatsApp(db, dateStr);
      res.json({ ok: true, date: dateStr });
    } catch (e) {
      next(e);
    }
  });

  router.post("/users/:id/face-enrollment", attachUser, uploadFace.single("photo"), (req, res) => {
    const id = Number(req.params.id);
    const approvalRaw = req.body?.approvalRequestId ?? req.body?.approval_request_id;
    const approvalRequestId = approvalRaw != null && String(approvalRaw).trim() !== "" ? Number(approvalRaw) : null;

    const gate = assertFaceEnrollmentAllowed({
      db,
      actor: req.currentUser,
      subjectId: id,
      approvalRequestId: Number.isFinite(approvalRequestId) ? approvalRequestId : null,
    });
    if (!gate.ok) {
      return res.status(gate.status).json({ error: gate.error });
    }

    if (!req.file) return res.status(400).json({ error: "photo file required (multipart field: photo)" });
    if (req.file.size < 8192) {
      return res.status(400).json({ error: "Photo too small — use live camera capture (min 8KB)" });
    }
    let phash;
    try {
      phash = phashFromBuffer(fs.readFileSync(req.file.path));
    } catch (e) {
      return res.status(400).json({ error: "Invalid image: " + e.message });
    }
    // Multi-pose enrollment: client may send `faceDescriptors` as a JSON
    // string of an array of 128-D arrays (e.g. straight / left / right
    // captures). Server averages them into one descriptor before storing.
    // Falls back to single `faceDescriptor` for backward compatibility.
    const rawDescList = req.body?.faceDescriptors ?? req.body?.face_descriptors;
    let embeddingJson = null;
    let descriptorCount = 0;
    if (rawDescList != null && String(rawDescList).trim() !== "") {
      let listParsed = rawDescList;
      if (typeof listParsed === "string") {
        try {
          listParsed = JSON.parse(listParsed);
        } catch {
          return res.status(400).json({ error: "faceDescriptors must be a JSON array of 128-D arrays" });
        }
      }
      if (!Array.isArray(listParsed) || listParsed.length === 0) {
        return res.status(400).json({ error: "faceDescriptors must be a non-empty array of 128-D arrays" });
      }
      // Reject obviously-duplicate poses: if user pressed capture without
      // moving their head, descriptors will be near-identical and averaging
      // gains nothing. Check every pair (not just consecutive) so e.g.
      // pose1==pose3 with a different pose2 is still caught.
      // Threshold configurable via FACE_DUPLICATE_POSE_THRESHOLD.
      for (let i = 0; i < listParsed.length; i++) {
        for (let j = i + 1; j < listParsed.length; j++) {
          const sim = tooSimilar(listParsed[i], listParsed[j]);
          if (sim.tooSimilar) {
            return res.status(400).json({
              error: `Pose ${j + 1} looks the same as pose ${i + 1} — कृपया सिर थोड़ा घुमाएं और दोबारा capture करें (similarity ${sim.distance.toFixed(3)} < ${sim.threshold}).`,
              code: "FACE_POSE_DUPLICATE",
              duplicateAt: j + 1,
              matchesPose: i + 1,
              distance: sim.distance,
              threshold: sim.threshold,
            });
          }
        }
      }
      const avg = averageEmbeddingsDetailed(listParsed);
      if (!avg) {
        return res.status(400).json({ error: `faceDescriptors must contain valid 128-D arrays of ${EMBEDDING_DIM} numbers` });
      }
      embeddingJson = JSON.stringify(avg.vector);
      // Report the count of valid descriptors actually averaged, not the
      // raw input length (invalid entries are silently skipped above).
      descriptorCount = avg.used;
    } else {
      const rawDesc = req.body?.faceDescriptor ?? req.body?.face_descriptor;
      if (rawDesc != null && String(rawDesc).trim() !== "") {
        const ser = serializeEmbedding(parseEmbeddingPayload(rawDesc));
        if (!ser) {
          return res.status(400).json({ error: `faceDescriptor must be a JSON array of ${EMBEDDING_DIM} numbers` });
        }
        embeddingJson = ser;
        descriptorCount = 1;
      }
    }

    const old = db
      .prepare("SELECT phash, reference_path, embedding_json FROM user_face_profiles WHERE user_id = ?")
      .get(id);
    const rel = `/uploads/faces/${req.file.filename}`;
    // Persist descriptor_count so admins can see at a glance whether a user
    // enrolled with the basic 3 poses or upgraded to 4 (enhanced). null is
    // recorded for the legacy single-blob path where no descriptor was sent.
    const persistedCount = descriptorCount > 0 ? descriptorCount : null;
    db.prepare(
      `INSERT OR REPLACE INTO user_face_profiles (user_id, phash, reference_path, embedding_json, descriptor_count, updated_at)
       VALUES (?,?,?,?,?,datetime('now'))`
    ).run(id, phash, rel, embeddingJson, persistedCount);

    if (typeof insertAudit === "function") {
      insertAudit(req.currentUser.id, "biometric_face_enroll", "user_face_profiles", String(id), {
        mode: gate.mode,
        subject_user_id: id,
        old_reference_path: old?.reference_path || null,
        new_reference_path: rel,
        old_phash_prefix: old?.phash ? String(old.phash).slice(0, 16) : null,
        new_phash_prefix: String(phash).slice(0, 16),
        embedding_saved: !!embeddingJson,
        descriptor_count: descriptorCount,
      });
    }
    if (gate.mode === "approval_self" && gate.approvalRow) {
      markApprovalRequestCompleted(db, gate.approvalRow.id);
    }
    res.json({ ok: true, phash, reference_path: rel, mode: gate.mode, descriptor_count: descriptorCount });
  });
}

module.exports = { registerProductRoutes };
