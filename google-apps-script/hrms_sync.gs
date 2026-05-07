/**
 * Prakriti Herbs HRMS — Google Apps Script Sync Handler
 * ======================================================
 * Deploy as a Web App: Execute as "Me", Access "Anyone".
 * Paste this entire file into the Apps Script editor (script.google.com).
 *
 * HOW IT WORKS
 * ─────────────
 * The HRMS server POSTs JSON to this Web App URL.
 * Each payload has:
 *   __tab       — sheet tab name (e.g. "Attendance", "Users", "Leave Requests")
 *   __matchKey  — field name used to find existing rows and upsert (e.g. "unique_key", "id")
 *   records[]   — array of objects (bulk push), OR individual fields (single push)
 *
 * ATTENDANCE TAB
 *   matchKey = "unique_key"  (format: "PH-AMR-103_2025-04-22")
 *   Columns: unique_key, employee_name, employee_id, branch, role, date,
 *            attendance_mode, punch_in, punch_out, total_hours, status, notes,
 *            _hrms_id, _synced_at
 *
 * ALL OTHER TABS
 *   matchKey = "id"  (numeric DB primary key)
 *   Columns: auto-detected from incoming JSON keys
 *
 * SETUP
 * ──────
 * 1. Open script.google.com → New Project
 * 2. Replace all code with this file
 * 3. Save (Ctrl+S)
 * 4. Deploy → New Deployment → Web App
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the Web App URL
 * 6. In HRMS Settings → Integrations → Google Apps Script, paste the URL
 *    (or set env var GOOGLE_APPS_SCRIPT_WEBAPP_URL)
 */

// ── Config ────────────────────────────────────────────────────────────────────

var SPREADSHEET_ID = ""; // Set to your spreadsheet ID (from the URL) if you want a fixed sheet.
                          // Leave "" to auto-create a new spreadsheet.
var SPREADSHEET_NAME = "Prakriti Herbs HRMS";

// Reverse sync (Sheet edit → HRMS). Leave HRMS_API_URL empty to disable.
// HRMS_API_URL example: "https://YOUR-BACKEND.onrender.com/api/attendance/sheet-sync"
// HRMS_SHEET_SYNC_SECRET must match the SHEET_SYNC_SECRET env var on the server.
//
// ★ RECOMMENDED: Don't edit these constants. Instead, open Apps Script
//   editor → ⚙ Project Settings → Script properties → Add property:
//      HRMS_API_URL              = https://YOUR-BACKEND.onrender.com/api/attendance/sheet-sync
//      HRMS_SHEET_SYNC_SECRET    = (paste the SHEET_SYNC_SECRET value)
//   The script reads these automatically, so you can re-paste new code
//   versions without losing the configuration.
var HRMS_API_URL = "";
var HRMS_SHEET_SYNC_SECRET = "";

// ★★★ KILL SWITCH ★★★
// Sheet → Portal direction is OFF BY DEFAULT after the one-time backfill.
// The HRMS server also enforces this server-side (sheet_to_portal_enabled flag);
// this constant is a second line of defense so onSheetEdit + bulkSyncAllData
// don't even try to POST when the admin has not explicitly armed the flow.
//
// To re-enable: change to `true` AND turn ON "Allow Sheet → Portal sync" in
// HRMS Settings → Sheet Integration. Both must be true for any data to flow.
var ENABLE_SHEET_TO_PORTAL_AUTOSYNC = true;

// Resolve config from constants OR Script Properties (preferred).
function _hrmsCfg_() {
  var props = null;
  try { props = PropertiesService.getScriptProperties(); } catch (e) { props = null; }
  var url = HRMS_API_URL || (props ? (props.getProperty("HRMS_API_URL") || "") : "");
  var secret = HRMS_SHEET_SYNC_SECRET || (props ? (props.getProperty("HRMS_SHEET_SYNC_SECRET") || "") : "");
  return { url: String(url || "").trim(), secret: String(secret || "").trim() };
}

// ── Entry point ───────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // Server-initiated commands (one-click pull from HRMS portal).
    // Auth via shared secret that matches HRMS SHEET_SYNC_SECRET env var.
    if (body && body.__cmd) {
      var _c = _hrmsCfg_();
      if (!_c.secret) {
        return jsonResponse({ ok: false, error: "HRMS_SHEET_SYNC_SECRET not configured. Set it in Apps Script → ⚙ Project Settings → Script properties (key: HRMS_SHEET_SYNC_SECRET)." });
      }
      if (String(body.__secret || "") !== _c.secret) {
        return jsonResponse({ ok: false, error: "Invalid __secret — value in HRMS server does not match Script property HRMS_SHEET_SYNC_SECRET." });
      }
      if (body.__cmd === "ping") {
        return handlePing();
      }
      if (body.__cmd === "fetch_attendance") {
        return handleFetchAttendance(body.from_date || body.from || "", body.to_date || body.to || "");
      }
      return jsonResponse({ ok: false, error: "Unknown command: " + body.__cmd });
    }

    // Handle bulk (records[]) or single payload
    if (Array.isArray(body.records)) {
      return handleBulk(body);
    } else {
      return handleSingle(body);
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ── Server-initiated fetch: return every Attendance row as JSON ─────────────
// Called by HRMS portal's "Run Full Sync" → /integrations/apps-script/pull-from-sheet.
// Returns rows normalized so the HRMS server can upsert directly:
//   { ok: true, total: N, rows: [{unique_key, employee_id, date, status, punch_in, punch_out, notes}, ...] }
function handleFetchAttendance(fromDate, toDate) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var ssId = SPREADSHEET_ID;
    if (!ssId) return jsonResponse({ ok: false, error: "No active spreadsheet — set SPREADSHEET_ID at the top of this script." });
    ss = SpreadsheetApp.openById(ssId);
  }
  var sheet = ss.getSheetByName(BULK_SYNC_TAB);
  if (!sheet) return jsonResponse({ ok: false, error: 'Sheet "' + BULK_SYNC_TAB + '" not found.' });

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return jsonResponse({ ok: true, total: 0, rows: [], filtered: 0 });
  }
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h || "").trim();
  });
  var idx = {};
  for (var i = 0; i < headers.length; i++) idx[headers[i]] = i;

  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var tz = Session.getScriptTimeZone() || "Asia/Kolkata";
  var from = String(fromDate || "").trim(); // expected "YYYY-MM-DD" or empty
  var to   = String(toDate   || "").trim();
  var rows = [];
  var totalScanned = data.length;
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var dateCell = ("date" in idx) ? row[idx.date] : "";
    var dateStr = (Object.prototype.toString.call(dateCell) === "[object Date]")
                    ? Utilities.formatDate(dateCell, tz, "yyyy-MM-dd")
                    : String(dateCell || "").trim();
    // Date-range filter: lexicographic compare works for ISO YYYY-MM-DD
    if (from && dateStr && dateStr < from) continue;
    if (to   && dateStr && dateStr > to)   continue;
    rows.push({
      unique_key:  ("unique_key"  in idx) ? String(row[idx.unique_key]  || "").trim() : "",
      employee_id: ("employee_id" in idx) ? String(row[idx.employee_id] || "").trim() : "",
      date:        dateStr,
      status:      ("status"      in idx) ? (_str_(row[idx.status])     || null) : null,
      punch_in:    ("punch_in"    in idx) ? (_toHHMM_(row[idx.punch_in])  || null) : null,
      punch_out:   ("punch_out"   in idx) ? (_toHHMM_(row[idx.punch_out]) || null) : null,
      notes:       ("notes"       in idx) ? (_str_(row[idx.notes])      || null) : null,
    });
  }
  return jsonResponse({ ok: true, total: rows.length, rows: rows, scanned: totalScanned, from_date: from, to_date: to });
}

// ── Server-initiated ping: lightweight roundtrip used by HRMS Test Connection
// Returns sheet meta so admin can verify the right script + spreadsheet are wired up.
function handlePing() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss && SPREADSHEET_ID) ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var info = { ok: true, pong: true, ts: new Date().toISOString(), service: "Prakriti Herbs HRMS Sync" };
    if (ss) {
      info.spreadsheet_id   = ss.getId();
      info.spreadsheet_name = ss.getName();
      var sheet = ss.getSheetByName(BULK_SYNC_TAB);
      info.attendance_tab   = BULK_SYNC_TAB;
      info.attendance_rows  = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
      info.attendance_found = !!sheet;
    } else {
      info.spreadsheet_id   = "";
      info.spreadsheet_name = "(no active spreadsheet)";
    }
    info.autosync_enabled = (typeof ENABLE_SHEET_TO_PORTAL_AUTOSYNC !== "undefined") ? !!ENABLE_SHEET_TO_PORTAL_AUTOSYNC : false;
    return jsonResponse(info);
  } catch (err) {
    return jsonResponse({ ok: false, pong: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, service: "Prakriti Herbs HRMS Sync", ts: new Date().toISOString() })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ── Single record upsert ──────────────────────────────────────────────────────

function handleSingle(body) {
  var tab = body.__tab;
  var matchKey = body.__matchKey || "id";
  if (!tab) return jsonResponse({ ok: false, error: "Missing __tab" });

  // Clone and strip meta keys
  var record = {};
  for (var k in body) {
    if (k !== "__tab" && k !== "__matchKey") record[k] = body[k];
  }

  var ss = getOrCreateSpreadsheet();
  var sheet = getOrCreateSheet(ss, tab);
  upsertRow(sheet, record, matchKey);

  return jsonResponse({ ok: true, tab: tab, action: "upsert" });
}

// ── Bulk records upsert ───────────────────────────────────────────────────────

function handleBulk(body) {
  var tab = body.__tab;
  var matchKey = body.__matchKey || "id";
  var records = body.records;
  if (!tab) return jsonResponse({ ok: false, error: "Missing __tab" });
  if (!Array.isArray(records) || records.length === 0) {
    return jsonResponse({ ok: true, tab: tab, upserted: 0 });
  }

  var ss = getOrCreateSpreadsheet();
  var sheet = getOrCreateSheet(ss, tab);

  var upserted = 0;
  for (var i = 0; i < records.length; i++) {
    upsertRow(sheet, records[i], matchKey);
    upserted++;
  }

  return jsonResponse({ ok: true, tab: tab, upserted: upserted });
}

// ── Core upsert logic ─────────────────────────────────────────────────────────

/**
 * Insert or update a single row in the sheet.
 * - First row is always the header.
 * - Finds existing row by matching the matchKey column value.
 * - If not found, appends a new row.
 * - New columns are auto-added to the header if seen for the first time.
 */
function upsertRow(sheet, record, matchKey) {
  var headers = ensureHeaders(sheet, Object.keys(record));
  var matchColIdx = headers.indexOf(matchKey); // 0-based index in headers array
  var matchValue = String(record[matchKey] !== undefined ? record[matchKey] : "");

  var lastRow = sheet.getLastRow();
  var existingRowNum = -1;

  if (matchColIdx >= 0 && lastRow >= 2) {
    // Search in the match column (1-based col for Sheets = matchColIdx + 1)
    var matchCol = sheet.getRange(2, matchColIdx + 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < matchCol.length; r++) {
      if (String(matchCol[r][0]) === matchValue) {
        existingRowNum = r + 2; // 1-based row number (row 1 = header)
        break;
      }
    }
  }

  // Build the full row array aligned to current headers
  var rowValues = headers.map(function (h) {
    var v = record[h];
    if (v === null || v === undefined) return "";
    return v;
  });

  if (existingRowNum > 0) {
    sheet.getRange(existingRowNum, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

// ── Header management ─────────────────────────────────────────────────────────

/**
 * Ensures the sheet has a header row containing all keys.
 * Appends missing columns to the right. Returns the current headers array.
 */
function ensureHeaders(sheet, keys) {
  var lastCol = sheet.getLastColumn();
  var headers = [];

  if (lastCol === 0) {
    // Fresh sheet — write all keys as header
    sheet.getRange(1, 1, 1, keys.length).setValues([keys]);
    formatHeaderRow(sheet, keys.length);
    return keys.slice();
  }

  // Read existing headers
  headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);

  // Append any new keys
  var newKeys = keys.filter(function (k) { return headers.indexOf(k) < 0; });
  if (newKeys.length > 0) {
    var startCol = lastCol + 1;
    sheet.getRange(1, startCol, 1, newKeys.length).setValues([newKeys]);
    formatHeaderRow(sheet, lastCol + newKeys.length);
    headers = headers.concat(newKeys);
  }

  return headers;
}

// ── Spreadsheet & sheet helpers ───────────────────────────────────────────────

function getOrCreateSpreadsheet() {
  if (SPREADSHEET_ID) {
    try {
      return SpreadsheetApp.openById(SPREADSHEET_ID);
    } catch (e) {
      // Fall through to create
    }
  }

  // Try to find by name in Drive
  var files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    var file = files.next();
    SPREADSHEET_ID = file.getId();
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }

  // Create new spreadsheet
  var ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  SPREADSHEET_ID = ss.getId();
  return ss;
}

function getOrCreateSheet(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }
  return sheet;
}

function formatHeaderRow(sheet, numCols) {
  try {
    var headerRange = sheet.getRange(1, 1, 1, numCols);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#1a73e8");
    headerRange.setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  } catch (e) {
    // Non-critical formatting — ignore
  }
}

// ── Response helper ───────────────────────────────────────────────────────────

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// ── Reverse sync (Sheet → HRMS) ───────────────────────────────────────────────
// Set up a one-time installable trigger (script.google.com → Triggers →
// Add Trigger → choose `onSheetEdit`, event source: "From spreadsheet",
// event type: "On edit"). Then any manual edit in the Attendance tab POSTs
// the changed row back to the HRMS server (which updates its DB and never
// echoes the change back, breaking loops via the 'sheet_sync' source flag).

function onSheetEdit(e) {
  try {
    if (!ENABLE_SHEET_TO_PORTAL_AUTOSYNC) return; // kill switch — Sheet→Portal disabled
    var _cfg = _hrmsCfg_();
    if (!_cfg.url || !_cfg.secret) return; // disabled
    HRMS_API_URL = _cfg.url;
    HRMS_SHEET_SYNC_SECRET = _cfg.secret;
    var range = e.range;
    var sheet = range.getSheet();
    if (sheet.getName() !== "Attendance") return;
    var row = range.getRow();
    if (row < 2) return; // header

    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var values  = sheet.getRange(row, 1, 1, lastCol).getValues()[0];

    var rec = {};
    for (var i = 0; i < headers.length; i++) rec[headers[i]] = values[i];
    if (!rec.unique_key) return;

    // Normalize a cell value into "HH:MM" — handles Date objects (Google Sheets
    // auto-converts time-like cells to Date), numeric serial fractions, and
    // already-string "HH:MM" values.
    function toHHMM(v) {
      if (v === null || v === undefined || v === "") return undefined;
      if (Object.prototype.toString.call(v) === "[object Date]") {
        var d = v;
        return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      }
      if (typeof v === "number") {
        // Sheets time serial: fraction of a day
        var totalMin = Math.round(v * 24 * 60);
        var hh = Math.floor(totalMin / 60) % 24;
        var mm = totalMin % 60;
        return ("0" + hh).slice(-2) + ":" + ("0" + mm).slice(-2);
      }
      var s = String(v).trim();
      var m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)/);
      return m ? m[0] : undefined;
    }

    var payload = {
      unique_key: String(rec.unique_key),
      status:     rec.status     ? String(rec.status).trim() : undefined,
      punch_in:   toHHMM(rec.punch_in),
      punch_out:  toHHMM(rec.punch_out),
      notes:      rec.notes      ? String(rec.notes)     : undefined,
    };

    UrlFetchApp.fetch(HRMS_API_URL, {
      method: "post",
      contentType: "application/json",
      headers: { "x-sheet-sync-secret": HRMS_SHEET_SYNC_SECRET },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    // Swallow — never break the user's edit
    console.error("onSheetEdit:", err);
  }
}

// ── Bulk backfill: push every existing Attendance row to HRMS ─────────────────
//
// One-shot reverse-sync utility. Reads every row from the "Attendance" tab,
// normalizes time cells to "HH:MM", and POSTs each one to /attendance/sheet-sync.
// Backend's UPSERT logic (by unique_key) prevents duplicates and updates rows
// that already exist.
//
// USAGE
//  1. Set HRMS_API_URL + HRMS_SHEET_SYNC_SECRET at the top of this file.
//  2. Open the spreadsheet — you'll see a new "HRMS Sync" menu (added by
//     onOpen). Click "Run Full Sync".
//  3. Or run bulkSyncAllData() directly from the Apps Script editor.
//
// SKIP RULES (per spec)
//  - employee_id column empty → skip
//  - date         column empty → skip
//  - unique_key   column empty → skip (backend would 400 anyway)
//
// LOGGING
//  Every attempt is appended to the "Sync_Log" tab (auto-created):
//    timestamp | employee_id | status (success/failed) | message
//
// PERFORMANCE
//  100 ms delay between requests to stay under Apps Script + HRMS rate limits.

var BULK_SYNC_DELAY_MS  = 150;  // 100–300ms range per spec
var BULK_SYNC_TAB       = "Attendance";
var BULK_SYNC_LOG_TAB   = "Sync_Log";
var BULK_SYNC_TIME_BUDGET_MS = 5 * 60 * 1000; // Stop before Apps Script's 6-min hard cap.
var BULK_SYNC_CURSOR_KEY     = "hrms_bulk_sync_cursor"; // Resume position in PropertiesService.

function bulkSyncAllData() {
  if (!ENABLE_SHEET_TO_PORTAL_AUTOSYNC) {
    throw new Error(
      "Sheet → Portal sync is DISABLED.\n\n" +
      "After the one-time backfill, this direction is intentionally turned off so old/test rows never re-import.\n\n" +
      "To re-enable (rare):\n" +
      "  1. In this Apps Script, change ENABLE_SHEET_TO_PORTAL_AUTOSYNC at the top to true.\n" +
      "  2. In HRMS Settings → Sheet Integration, turn ON 'Allow Sheet → Portal sync' AND click 'Arm Backfill'.\n" +
      "Both must be ON for any row to flow."
    );
  }
  var _cfg = _hrmsCfg_();
  if (!_cfg.url || !_cfg.secret) {
    throw new Error(
      "Set HRMS_API_URL and HRMS_SHEET_SYNC_SECRET first.\n\n" +
      "Easiest way:\n" +
      "  1. In Apps Script editor, click ⚙ Project Settings (left sidebar).\n" +
      "  2. Scroll to 'Script properties' → click 'Add script property'.\n" +
      "  3. Add property: HRMS_API_URL = https://YOUR-BACKEND.onrender.com/api/attendance/sheet-sync\n" +
      "  4. Add property: HRMS_SHEET_SYNC_SECRET = (the SHEET_SYNC_SECRET value from HRMS server env)\n" +
      "  5. Save and re-run."
    );
  }
  // Also export for any helper code below that still reads the bare constants.
  HRMS_API_URL = _cfg.url;
  HRMS_SHEET_SYNC_SECRET = _cfg.secret;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(BULK_SYNC_TAB);
  if (!sheet) throw new Error('Sheet "' + BULK_SYNC_TAB + '" not found.');

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) {
    _bulkLog_(null, "skipped", "No data rows in " + BULK_SYNC_TAB);
    return { total: 0, ok: 0, failed: 0, skipped: 0 };
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h || "").trim();
  });
  var idx = {};
  for (var i = 0; i < headers.length; i++) idx[headers[i]] = i;

  // unique_key, employee_id, date are required for a row to be syncable.
  var hasUnique = ("unique_key" in idx);
  var hasEmpId  = ("employee_id" in idx);
  var hasDate   = ("date" in idx);
  if (!hasUnique || !hasEmpId || !hasDate) {
    throw new Error("Header row must contain unique_key, employee_id, and date columns.");
  }

  // Resume from where the previous run left off (handles datasets > 1,000 rows
  // that would otherwise hit Apps Script's 6-minute execution limit).
  var props  = PropertiesService.getDocumentProperties();
  var cursor = parseInt(props.getProperty(BULK_SYNC_CURSOR_KEY) || "0", 10);
  if (isNaN(cursor) || cursor < 0) cursor = 0;

  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  if (cursor >= data.length) {
    // Wrapped — start over.
    cursor = 0;
    props.deleteProperty(BULK_SYNC_CURSOR_KEY);
  }
  if (cursor > 0) {
    _bulkLog_(null, "resume", "Resuming from row " + (cursor + 2) + " of " + (data.length + 1));
  }

  var startMs = Date.now();
  var ok = 0, failed = 0, skipped = 0;
  var stoppedEarly = false;

  for (var r = cursor; r < data.length; r++) {
    if (Date.now() - startMs > BULK_SYNC_TIME_BUDGET_MS) {
      props.setProperty(BULK_SYNC_CURSOR_KEY, String(r));
      _bulkLog_(null, "paused", "Time budget reached at row " + (r + 2) + " — re-run \"Run Full Sync\" to continue.");
      stoppedEarly = true;
      break;
    }
    var row = data[r];
    var uniqueKey = String(row[idx.unique_key] || "").trim();
    var empId     = String(row[idx.employee_id] || "").trim();
    var dateCell  = row[idx.date];
    var dateStr   = (Object.prototype.toString.call(dateCell) === "[object Date]")
                      ? Utilities.formatDate(dateCell, Session.getScriptTimeZone() || "Asia/Kolkata", "yyyy-MM-dd")
                      : String(dateCell || "").trim();

    if (!empId)     { skipped++; _bulkLog_(empId || "(blank)", "skipped", "employee_id empty (row " + (r + 2) + ")"); continue; }
    if (!dateStr)   { skipped++; _bulkLog_(empId, "skipped", "date empty (row " + (r + 2) + ")"); continue; }
    if (!uniqueKey) { skipped++; _bulkLog_(empId, "skipped", "unique_key empty (row " + (r + 2) + ")"); continue; }

    var payload = {
      unique_key: uniqueKey,
      status:     ("status" in idx)    ? _str_(row[idx.status])      : undefined,
      punch_in:   ("punch_in" in idx)  ? _toHHMM_(row[idx.punch_in]) : undefined,
      punch_out:  ("punch_out" in idx) ? _toHHMM_(row[idx.punch_out]): undefined,
      notes:      ("notes" in idx)     ? _str_(row[idx.notes])       : undefined,
    };

    try {
      var resp = UrlFetchApp.fetch(HRMS_API_URL, {
        method: "post",
        contentType: "application/json",
        headers: { "x-sheet-sync-secret": HRMS_SHEET_SYNC_SECRET },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      var body = resp.getContentText();
      if (code >= 200 && code < 300) {
        ok++;
        _bulkLog_(empId, "success", "HTTP " + code + " uk=" + uniqueKey);
      } else {
        failed++;
        _bulkLog_(empId, "failed", "HTTP " + code + " " + body.substring(0, 200));
      }
    } catch (err) {
      failed++;
      _bulkLog_(empId, "failed", "exception: " + (err && err.message ? err.message : String(err)));
    }

    if (BULK_SYNC_DELAY_MS > 0) Utilities.sleep(BULK_SYNC_DELAY_MS);
  }

  if (!stoppedEarly) {
    // Whole sheet finished — clear the cursor so the next run starts fresh.
    props.deleteProperty(BULK_SYNC_CURSOR_KEY);
  }

  var verb = stoppedEarly ? "paused" : "done";
  var summary = "Bulk sync " + verb + " — processed this run: ok:" + ok + " failed:" + failed + " skipped:" + skipped + " (sheet total: " + data.length + ")";
  _bulkLog_(null, "summary", summary);
  try { SpreadsheetApp.getActive().toast(summary, "HRMS Sync", 8); } catch (e) {}
  return { total: data.length, ok: ok, failed: failed, skipped: skipped, paused: stoppedEarly };
}

// Manual reset — wipe the resume cursor so the next bulk sync starts at row 2.
function resetBulkSyncCursor() {
  PropertiesService.getDocumentProperties().deleteProperty(BULK_SYNC_CURSOR_KEY);
  _bulkLog_(null, "reset", "Bulk sync cursor reset by user.");
  try { SpreadsheetApp.getActive().toast("Cursor reset — next Run Full Sync will start from the top.", "HRMS Sync", 5); } catch (e) {}
}

// Normalize a Sheet cell (Date / serial / string) to "HH:MM" or undefined.
function _toHHMM_(v) {
  if (v === null || v === undefined || v === "") return undefined;
  if (Object.prototype.toString.call(v) === "[object Date]") {
    var d = v;
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  if (typeof v === "number") {
    var totalMin = Math.round(v * 24 * 60);
    var hh = Math.floor(totalMin / 60) % 24;
    var mm = totalMin % 60;
    return ("0" + hh).slice(-2) + ":" + ("0" + mm).slice(-2);
  }
  var s = String(v).trim();
  var m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  return m ? m[0] : undefined;
}

function _str_(v) {
  if (v === null || v === undefined) return undefined;
  var s = String(v).trim();
  return s === "" ? undefined : s;
}

function _bulkLog_(employeeId, status, message) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var log = ss.getSheetByName(BULK_SYNC_LOG_TAB);
    if (!log) {
      log = ss.insertSheet(BULK_SYNC_LOG_TAB);
      log.appendRow(["timestamp", "employee_id", "status", "message"]);
      log.setFrozenRows(1);
    }
    log.appendRow([new Date(), employeeId || "", status || "", message || ""]);
  } catch (err) {
    console.error("_bulkLog_:", err);
  }
}

// Custom menu — appears every time the spreadsheet is opened.
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("HRMS Sync")
      .addItem("🔑 Authorize Sync (run once)", "authorizeHrmsSync")
      .addSeparator()
      .addItem("Run Full Sync (Sheet → HRMS)", "bulkSyncAllData")
      .addItem("Reset Sync Cursor", "resetBulkSyncCursor")
      .addSeparator()
      .addItem("View Sync Log", "_openSyncLog_")
      .addToUi();
  } catch (e) {
    console.error("onOpen:", e);
  }
}

/**
 * Run this ONCE from the Apps Script editor (or "HRMS Sync → 🔑 Authorize
 * Sync") after you deploy. Google will prompt for two permissions:
 *
 *   1. "See, edit, create, and delete your spreadsheets in Google Drive"
 *   2. "Connect to an external service"  ← THIS IS THE IMPORTANT ONE
 *
 * Click Allow on both. Without permission #2 onSheetEdit cannot POST back
 * to the HRMS portal and you will see "You do not have permission to call
 * UrlFetchApp.fetch" rows in Sync_Log.
 *
 * The function makes a single harmless ping to the portal to trigger the
 * permission prompt, then writes a row to Sync_Log so you can confirm.
 */
function authorizeHrmsSync() {
  var cfg = _hrmsCfg_();
  if (!cfg.url || !cfg.secret) {
    var msg = "Missing HRMS_API_URL or HRMS_SHEET_SYNC_SECRET. " +
              "Set them at the top of this script (or in Project Settings → " +
              "Script Properties) before authorizing.";
    try { SpreadsheetApp.getUi().alert(msg); } catch (_) { console.error(msg); }
    _bulkLog_(null, "auth_failed", msg);
    return;
  }
  var ok = false;
  var detail = "";
  try {
    var resp = UrlFetchApp.fetch(cfg.url, {
      method: "post",
      contentType: "application/json",
      headers: { "x-sheet-sync-secret": cfg.secret },
      payload: JSON.stringify({ __cmd: "ping", __secret: cfg.secret }),
      muteHttpExceptions: true,
    });
    ok = (resp.getResponseCode() === 200);
    detail = "HTTP " + resp.getResponseCode() + " — "
           + String(resp.getContentText()).slice(0, 200);
  } catch (e) {
    detail = String(e && e.message || e);
  }
  _bulkLog_(null, ok ? "auth_ok" : "auth_failed", detail);
  try {
    SpreadsheetApp.getUi().alert(
      ok
        ? "✅ Authorized!\n\nHRMS Sync can now talk to your portal. " +
          "Sheet → Portal autosync will work on every edit."
        : "❌ Could not reach the HRMS portal yet.\n\n" + detail +
          "\n\nIf Google asked for permissions just now, click Allow on " +
          "both 'spreadsheets' and 'external service', then run this again."
    );
  } catch (_) { /* no UI in trigger context */ }
}

function _openSyncLog_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(BULK_SYNC_LOG_TAB);
  if (!log) {
    log = ss.insertSheet(BULK_SYNC_LOG_TAB);
    log.appendRow(["timestamp", "employee_id", "status", "message"]);
    log.setFrozenRows(1);
  }
  ss.setActiveSheet(log);
}
