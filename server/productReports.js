const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

function buildDailyPdfBuffer({ dateStr, totalStaff, smap, title }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor("#1f5e3b").text(title || "HRMS Portal — Daily Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).fillColor("#333333").text(`Date: ${dateStr}`, { align: "center" });
    doc.moveDown(2);

    const present = (smap.present || 0) + (smap.half || 0);
    const rows = [
      ["Total active staff", String(totalStaff)],
      ["Present (incl. half-day)", String(present)],
      ["Present (full day only)", String(smap.present || 0)],
      ["Half-day", String(smap.half || 0)],
      ["Late", String(smap.late || 0)],
      ["Absent", String(smap.absent || 0)],
      ["On leave", String(smap.leave || 0)],
    ];

    doc.fontSize(12).fillColor("#14261a").text("Summary", { underline: true });
    doc.moveDown(0.5);
    rows.forEach(([k, v]) => {
      doc.fontSize(10).fillColor("#444").text(`${k}: `, { continued: true }).fillColor("#1f5e3b").text(v);
      doc.moveDown(0.35);
    });

    doc.end();
  });
}

function buildMonthlyPdfBuffer({ year, month, period, payrollTotals, title }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor("#1f5e3b").text(title || "HRMS Portal — Monthly Summary", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).fillColor("#333333").text(`Period: ${period} (${year}-${String(month).padStart(2, "0")})`, {
      align: "center",
    });
    doc.moveDown(2);

    if (payrollTotals) {
      doc.fontSize(12).text("Payroll (selected month)", { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(10).text(`Gross total: ₹${Math.round(payrollTotals.gross)}`);
      doc.text(`Deductions: ₹${Math.round(payrollTotals.deductions)}`);
      doc.text(`Net: ₹${Math.round(payrollTotals.net)}`);
      doc.text(`Rows: ${payrollTotals.count}`);
    }

    doc.end();
  });
}

async function buildDailyXlsxBuffer({ dateStr, totalStaff, smap }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Daily");
  ws.addRow(["HRMS Portal Daily Report", dateStr]);
  ws.addRow([]);
  ws.addRow(["Metric", "Count"]);
  ws.addRow(["Total active staff", totalStaff]);
  ws.addRow(["Present (incl half)", (smap.present || 0) + (smap.half || 0)]);
  ws.addRow(["Present full", smap.present || 0]);
  ws.addRow(["Half-day", smap.half || 0]);
  ws.addRow(["Late", smap.late || 0]);
  ws.addRow(["Absent", smap.absent || 0]);
  ws.addRow(["On leave", smap.leave || 0]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function buildMonthlyAttendanceXlsxBuffer(rows, sheetName) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || "Monthly");
  if (rows.length === 0) {
    ws.addRow(["No data"]);
  } else {
    const headers = Object.keys(rows[0]);
    ws.addRow(headers);
    for (const r of rows) ws.addRow(headers.map((h) => r[h]));
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = {
  buildDailyPdfBuffer,
  buildMonthlyPdfBuffer,
  buildDailyXlsxBuffer,
  buildMonthlyAttendanceXlsxBuffer,
};
