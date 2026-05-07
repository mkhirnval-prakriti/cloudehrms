const { sendMail } = require("./emailService");

function readDailyReportConfig(db) {
  try {
    const row = db.prepare("SELECT v FROM integration_kv WHERE k = ?").get("app_runtime_settings");
    if (!row?.v) return null;
    const parsed = JSON.parse(row.v);
    return parsed?.daily_report || null;
  } catch {
    return null;
  }
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
  } catch {
    return "—";
  }
}

function fmtHours(mins) {
  if (!mins || mins <= 0) return "—";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function statusLabel(s) {
  if (s === "present") return "Present";
  if (s === "late") return "Late";
  if (s === "half" || s === "half_day") return "Half Day";
  if (s === "absent") return "Absent";
  return s || "Absent";
}

function statusColor(s) {
  if (s === "present") return { bg: "#d1fae5", fg: "#065f46" };
  if (s === "late") return { bg: "#fef3c7", fg: "#92400e" };
  if (s === "half" || s === "half_day") return { bg: "#dbeafe", fg: "#1e40af" };
  if (s === "absent") return { bg: "#fee2e2", fg: "#991b1b" };
  return { bg: "#f3f4f6", fg: "#374151" };
}

/**
 * Build the full daily attendance report data structure.
 * Returns { date, summary, byBranch, rows } — used by both the email
 * and the API endpoint that powers the Settings UI preview.
 */
function buildDailyReportData(db, date) {
  const workDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const users = db.prepare(`
    SELECT u.id, u.full_name, u.login_id, u.email, u.role,
           u.shift_start, u.shift_end,
           u.branch_id, b.name AS branch_name
    FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id
    WHERE u.active = 1 AND u.deleted_at IS NULL
    ORDER BY b.name COLLATE NOCASE, u.full_name COLLATE NOCASE
  `).all();

  const attRows = db.prepare(`
    SELECT user_id, work_date, punch_in_at, punch_out_at, status,
           half_period, source, notes
    FROM attendance_records
    WHERE work_date = ?
  `).all(workDate);
  const attMap = new Map(attRows.map((r) => [r.user_id, r]));

  const rows = users.map((u) => {
    const a = attMap.get(u.id);
    let workMins = 0;
    if (a?.punch_in_at && a?.punch_out_at) {
      const inMs = new Date(a.punch_in_at).getTime();
      const outMs = new Date(a.punch_out_at).getTime();
      if (Number.isFinite(inMs) && Number.isFinite(outMs) && outMs > inMs) {
        workMins = (outMs - inMs) / 60000;
      }
    }
    const status = a?.status || "absent";
    return {
      userId: u.id,
      name: u.full_name,
      loginId: u.login_id,
      email: u.email,
      branch: u.branch_name || "—",
      role: u.role,
      shift: `${u.shift_start || "09:00"}–${u.shift_end || "18:00"}`,
      status,
      statusLabel: statusLabel(status),
      punchIn: a?.punch_in_at || null,
      punchOut: a?.punch_out_at || null,
      punchInTime: fmtTime(a?.punch_in_at),
      punchOutTime: fmtTime(a?.punch_out_at),
      workMinutes: Math.round(workMins),
      workHours: fmtHours(workMins),
      missedPunchOut: !!(a?.punch_in_at && !a?.punch_out_at),
      source: a?.source || null,
      notes: a?.notes || null,
    };
  });

  const summary = {
    total: rows.length,
    present: rows.filter((r) => r.status === "present").length,
    late: rows.filter((r) => r.status === "late").length,
    halfDay: rows.filter((r) => r.status === "half" || r.status === "half_day").length,
    absent: rows.filter((r) => r.status === "absent").length,
    missedPunchOut: rows.filter((r) => r.missedPunchOut).length,
    totalWorkHours: Math.round(rows.reduce((s, r) => s + r.workMinutes, 0) / 60 * 10) / 10,
    avgWorkHours: rows.length
      ? Math.round((rows.reduce((s, r) => s + r.workMinutes, 0) / rows.length) / 60 * 10) / 10
      : 0,
  };

  // Branch-wise breakdown
  const branchAgg = new Map();
  rows.forEach((r) => {
    const key = r.branch;
    if (!branchAgg.has(key)) {
      branchAgg.set(key, { branch: key, total: 0, present: 0, late: 0, halfDay: 0, absent: 0 });
    }
    const b = branchAgg.get(key);
    b.total++;
    if (r.status === "present") b.present++;
    else if (r.status === "late") b.late++;
    else if (r.status === "half" || r.status === "half_day") b.halfDay++;
    else b.absent++;
  });
  const byBranch = Array.from(branchAgg.values()).sort((a, b) => a.branch.localeCompare(b.branch));

  // Leave info
  let leavePending = 0;
  let leaveApproved = 0;
  try {
    leavePending = Number(
      db.prepare("SELECT COUNT(*) AS c FROM leave_requests WHERE final_status = 'PENDING'").get().c
    );
    leaveApproved = Number(
      db.prepare("SELECT COUNT(*) AS c FROM leave_requests WHERE final_status = 'APPROVED' AND from_date <= ? AND to_date >= ?")
        .get(workDate, workDate).c
    );
  } catch {}
  summary.leavePending = leavePending;
  summary.leaveApprovedToday = leaveApproved;

  return { date: workDate, summary, byBranch, rows };
}

function pct(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

function renderHtmlEmail(data) {
  const { date, summary, byBranch, rows } = data;
  const presentPct = pct(summary.present, summary.total);
  const latePct = pct(summary.late, summary.total);
  const halfPct = pct(summary.halfDay, summary.total);
  const absentPct = pct(summary.absent, summary.total);

  const branchRowsHtml = byBranch.map((b) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${b.branch}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${b.total}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#065f46;font-weight:600;">${b.present}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#92400e;font-weight:600;">${b.late}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#1e40af;font-weight:600;">${b.halfDay}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#991b1b;font-weight:600;">${b.absent}</td>
    </tr>
  `).join("");

  const userRowsHtml = rows.map((r) => {
    const c = statusColor(r.status);
    return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${r.name || "—"}<br><span style="color:#9ca3af;font-size:11px;">${r.loginId || ""}</span></td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;">${r.branch}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;">
        <span style="display:inline-block;padding:3px 10px;border-radius:12px;background:${c.bg};color:${c.fg};font-size:11px;font-weight:600;">${r.statusLabel}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;font-family:ui-monospace,monospace;font-size:12px;">${r.punchInTime}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;font-family:ui-monospace,monospace;font-size:12px;">${r.punchOutTime}${r.missedPunchOut ? ' <span style="color:#dc2626;">⚠</span>' : ""}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:600;color:#1f5e3b;">${r.workHours}</td>
    </tr>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;">
<div style="max-width:760px;margin:0 auto;padding:24px;">

  <div style="background:linear-gradient(135deg,#1f5e3b,#2d8856);color:white;padding:24px;border-radius:14px 14px 0 0;">
    <h1 style="margin:0;font-size:22px;font-weight:700;">📊 Prakriti HRMS — Daily Attendance Report</h1>
    <p style="margin:6px 0 0;font-size:14px;opacity:.92;">Date: <strong>${date}</strong> · Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</p>
  </div>

  <div style="background:white;padding:24px;border:1px solid #e5e7eb;border-top:none;">

    <!-- Summary cards -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;">
      <div style="background:#f0fdf4;padding:14px;border-radius:10px;border-left:4px solid #10b981;">
        <div style="font-size:11px;color:#065f46;text-transform:uppercase;font-weight:600;">Present</div>
        <div style="font-size:26px;font-weight:700;color:#065f46;margin-top:4px;">${summary.present}</div>
        <div style="font-size:11px;color:#10b981;">${presentPct}% of ${summary.total}</div>
      </div>
      <div style="background:#fffbeb;padding:14px;border-radius:10px;border-left:4px solid #f59e0b;">
        <div style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:600;">Late</div>
        <div style="font-size:26px;font-weight:700;color:#92400e;margin-top:4px;">${summary.late}</div>
        <div style="font-size:11px;color:#f59e0b;">${latePct}%</div>
      </div>
      <div style="background:#eff6ff;padding:14px;border-radius:10px;border-left:4px solid #3b82f6;">
        <div style="font-size:11px;color:#1e40af;text-transform:uppercase;font-weight:600;">Half Day</div>
        <div style="font-size:26px;font-weight:700;color:#1e40af;margin-top:4px;">${summary.halfDay}</div>
        <div style="font-size:11px;color:#3b82f6;">${halfPct}%</div>
      </div>
      <div style="background:#fef2f2;padding:14px;border-radius:10px;border-left:4px solid #ef4444;">
        <div style="font-size:11px;color:#991b1b;text-transform:uppercase;font-weight:600;">Absent</div>
        <div style="font-size:26px;font-weight:700;color:#991b1b;margin-top:4px;">${summary.absent}</div>
        <div style="font-size:11px;color:#ef4444;">${absentPct}%</div>
      </div>
    </div>

    <!-- Bar chart (HTML/CSS) -->
    <div style="margin:18px 0;padding:14px;background:#f9fafb;border-radius:10px;">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;">Attendance Distribution (${summary.total} staff)</div>
      <div style="display:flex;height:24px;border-radius:6px;overflow:hidden;background:#e5e7eb;">
        ${summary.present ? `<div style="width:${presentPct}%;background:#10b981;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:600;">${summary.present}</div>` : ""}
        ${summary.late ? `<div style="width:${latePct}%;background:#f59e0b;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:600;">${summary.late}</div>` : ""}
        ${summary.halfDay ? `<div style="width:${halfPct}%;background:#3b82f6;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:600;">${summary.halfDay}</div>` : ""}
        ${summary.absent ? `<div style="width:${absentPct}%;background:#ef4444;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:600;">${summary.absent}</div>` : ""}
      </div>
    </div>

    <!-- Quick stats -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;">
      <div style="padding:12px;background:#f3f4f6;border-radius:8px;">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;font-weight:600;">Total Hours</div>
        <div style="font-size:18px;font-weight:700;color:#111827;">${summary.totalWorkHours}h</div>
      </div>
      <div style="padding:12px;background:#f3f4f6;border-radius:8px;">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;font-weight:600;">Avg / Staff</div>
        <div style="font-size:18px;font-weight:700;color:#111827;">${summary.avgWorkHours}h</div>
      </div>
      <div style="padding:12px;background:#fff7ed;border-radius:8px;">
        <div style="font-size:10px;color:#9a3412;text-transform:uppercase;font-weight:600;">Missed Punch-out</div>
        <div style="font-size:18px;font-weight:700;color:#9a3412;">${summary.missedPunchOut}</div>
      </div>
      <div style="padding:12px;background:#faf5ff;border-radius:8px;">
        <div style="font-size:10px;color:#6b21a8;text-transform:uppercase;font-weight:600;">Leaves Today</div>
        <div style="font-size:18px;font-weight:700;color:#6b21a8;">${summary.leaveApprovedToday}<span style="font-size:11px;color:#9ca3af;font-weight:400;"> / ${summary.leavePending} pending</span></div>
      </div>
    </div>

    ${byBranch.length > 1 ? `
    <h2 style="font-size:14px;color:#1f5e3b;margin:24px 0 8px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">🏢 Branch-wise Breakdown</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px;">
      <thead><tr style="background:#f9fafb;">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Branch</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Total</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Present</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Late</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Half</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Absent</th>
      </tr></thead>
      <tbody>${branchRowsHtml}</tbody>
    </table>
    ` : ""}

    <h2 style="font-size:14px;color:#1f5e3b;margin:24px 0 8px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">👥 Staff Detail (${rows.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#f9fafb;">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Name / ID</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Branch</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Status</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Punch In</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Punch Out</th>
        <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;font-weight:600;color:#374151;">Hours</th>
      </tr></thead>
      <tbody>${userRowsHtml}</tbody>
    </table>

    <p style="margin-top:24px;padding:12px;background:#f9fafb;border-radius:8px;font-size:11px;color:#6b7280;line-height:1.5;">
      ⚠ = missed punch-out · Times shown in IST · This is an auto-generated report from Prakriti HRMS.
      To change recipients or disable, log in to HRMS Settings → Notification Settings.
    </p>
  </div>
</div>
</body></html>`;
}

function renderTextEmail(data) {
  const { date, summary, byBranch, rows } = data;
  const lines = [
    "Prakriti HRMS — Daily Attendance Report",
    `Date: ${date}`,
    "",
    "── SUMMARY ──",
    `Total staff:          ${summary.total}`,
    `Present:              ${summary.present} (${pct(summary.present, summary.total)}%)`,
    `Late:                 ${summary.late} (${pct(summary.late, summary.total)}%)`,
    `Half Day:             ${summary.halfDay} (${pct(summary.halfDay, summary.total)}%)`,
    `Absent:               ${summary.absent} (${pct(summary.absent, summary.total)}%)`,
    `Missed punch-out:     ${summary.missedPunchOut}`,
    `Total work hours:     ${summary.totalWorkHours}h  (avg ${summary.avgWorkHours}h/staff)`,
    `Leave pending:        ${summary.leavePending}`,
    `Leave approved today: ${summary.leaveApprovedToday}`,
    "",
  ];
  if (byBranch.length > 1) {
    lines.push("── BRANCH BREAKDOWN ──");
    lines.push("Branch                 Total  Pres  Late  Half  Abs");
    byBranch.forEach((b) => {
      lines.push(
        `${(b.branch || "—").padEnd(22).slice(0, 22)} ${String(b.total).padStart(5)} ${String(b.present).padStart(5)} ${String(b.late).padStart(5)} ${String(b.halfDay).padStart(5)} ${String(b.absent).padStart(4)}`
      );
    });
    lines.push("");
  }
  lines.push("── STAFF DETAIL ──");
  lines.push("Name                         Status     In     Out    Hours");
  rows.forEach((r) => {
    lines.push(
      `${(r.name || "—").padEnd(28).slice(0, 28)} ${r.statusLabel.padEnd(9)} ${r.punchInTime.padEnd(6)} ${r.punchOutTime.padEnd(6)} ${r.workHours}`
    );
  });
  lines.push("");
  lines.push("— Auto-generated by Prakriti HRMS");
  return lines.join("\n");
}

async function sendDailyHrmsReport(db) {
  const cfg = readDailyReportConfig(db);
  const enabled = cfg?.enabled != null ? !!cfg.enabled : process.env.DAILY_EMAIL_REPORT === "1";
  if (!enabled) return { skipped: true, reason: "disabled" };
  const defaultRecipients = (process.env.REPORT_RECIPIENTS || process.env.ALERT_EMAIL_TO || "").split(",").map(e => e.trim()).filter(Boolean);
  const recipients = Array.isArray(cfg?.recipients) && cfg.recipients.length > 0
    ? cfg.recipients
    : (process.env.SUPER_ADMIN_EMAIL || process.env.ALERT_EMAIL_TO
        ? [process.env.SUPER_ADMIN_EMAIL || process.env.ALERT_EMAIL_TO]
        : defaultRecipients);
  if (!recipients.length) return { skipped: true, reason: "no-recipients" };

  const data = buildDailyReportData(db);
  const html = renderHtmlEmail(data);
  const text = renderTextEmail(data);

  await sendMail({
    to: recipients.join(","),
    subject: `HRMS daily report — ${data.date} · ${data.summary.present}P/${data.summary.late}L/${data.summary.halfDay}H/${data.summary.absent}A`,
    text,
    html,
  });
  return { ok: true, date: data.date, recipients: recipients.length, summary: data.summary };
}

module.exports = { sendDailyHrmsReport, buildDailyReportData, renderHtmlEmail, renderTextEmail };
