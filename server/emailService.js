/**
 * Optional SMTP (nodemailer). Env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */
let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch {
  nodemailer = null;
}

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && nodemailer);
}

function getTransport() {
  if (!smtpConfigured()) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "1",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || "",
    },
  });
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    console.warn("[email] SMTP not configured; skip:", subject);
    return { skipped: true };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await t.sendMail({ from, to, subject, text, html: html || text });
  return { ok: true };
}

async function sendAlertEmailToAdmins(db, { subject, text }) {
  const to = process.env.ALERT_EMAIL_TO || process.env.SUPER_ADMIN_EMAIL;
  if (!to) return { skipped: true };
  return sendMail({ to, subject: `[HRMS Alert] ${subject}`, text });
}

module.exports = { sendMail, sendAlertEmailToAdmins, smtpConfigured };
