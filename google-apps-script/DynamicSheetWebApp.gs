/**
 * Dynamic Sheet Web App — fully data-driven; no hardcoded business fields.
 * Deploy: Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone
 *
 * Optional script properties (File → Project settings → Script properties):
 *   SPREADSHEET_ID — lock to an existing spreadsheet (otherwise auto-creates one on first run)
 *
 * Reserved JSON keys (all start with __ — never written as columns):
 *   __tab, __sheetName     — tab name (default: "Data")
 *   __matchKey, __uniqueKey — column name used to upsert (optional; auto-detected if omitted)
 *   __spreadsheetId        — override spreadsheet (must be accessible to the deployer)
 *   __meta                 — object: { tab, matchKey } (alternative to top-level __ keys)
 *   records, data          — array wrapper for bulk rows
 */

var SCRIPT_PROP_SPREADSHEET = "DYNAMIC_SPREADSHEET_ID";
var DEFAULT_TAB = "Data";
var AUTO_MATCH_KEYS = [
  "id",
  "record_id",
  "employee_id",
  "user_id",
  "mobile",
  "phone",
  "email",
  "lead_id",
  "customer_id",
];
var SERVER_TS_KEY = "_received_at";

function doGet() {
  return jsonOut({
    status: "success",
    message:
      "Dynamic Sheet API ready. POST JSON with any fields. Reserved: __tab, __matchKey, __spreadsheetId, records/data.",
    processed_records: 0,
  });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(30000)) {
      return jsonOut({ status: "failed", message: "Server busy, try again", processed_records: 0 });
    }
    return handlePost(e);
  } catch (err) {
    return jsonOut({
      status: "failed",
      message: String(err.message || err),
      processed_records: 0,
    });
  } finally {
    lock.releaseLock();
  }
}

function handlePost(e) {
  var raw = e.postData && e.postData.contents;
  if (!raw || String(raw).trim() === "") {
    return jsonOut({ status: "failed", message: "Empty request body", processed_records: 0 });
  }

  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (ex) {
    return jsonOut({ status: "failed", message: "Invalid JSON: " + ex.message, processed_records: 0 });
  }

  if (payload === null || typeof payload !== "object") {
    return jsonOut({ status: "failed", message: "JSON must be an object or array", processed_records: 0 });
  }

  var meta = extractMeta(payload);
  var records = normalizeRecords(payload);
  if (records.length === 0) {
    return jsonOut({ status: "failed", message: "No data rows (use object, records[], or data[])", processed_records: 0 });
  }

  var ss = getSpreadsheet(meta.spreadsheetId);
  var tabName = meta.tab || DEFAULT_TAB;
  var sheet = getOrCreateSheet_(ss, tabName);

  var actions = [];
  var processed = 0;
  var matchKey = meta.matchKey || null;

  for (var i = 0; i < records.length; i++) {
    var rowObj = records[i];
    if (!rowObj || typeof rowObj !== "object") continue;
    var row = stripReservedKeys(rowObj);
    if (Object.keys(row).length === 0) continue;

    maybeAddServerTimestamp(row);
    var mk = matchKey || detectMatchKey(row);
    var result = upsertDynamicRow_(sheet, row, mk);
    actions.push(result);
    processed++;
  }

  var msg = summarizeActions(actions);
  return jsonOut({
    status: "success",
    message: msg,
    processed_records: processed,
    spreadsheet_id: ss.getId(),
    spreadsheet_url: ss.getUrl(),
    tab: tabName,
  });
}

function extractMeta(payload) {
  var meta = { tab: null, matchKey: null, spreadsheetId: null };

  function apply(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj.__meta && typeof obj.__meta === "object") {
      meta.tab = obj.__meta.tab || obj.__meta.sheetName || meta.tab;
      meta.matchKey = obj.__meta.matchKey || obj.__meta.uniqueKey || meta.matchKey;
      meta.spreadsheetId = obj.__meta.spreadsheetId || meta.spreadsheetId;
    }
    if (obj.__tab) meta.tab = obj.__tab;
    if (obj.__sheetName) meta.tab = obj.__sheetName;
    if (obj.__matchKey) meta.matchKey = obj.__matchKey;
    if (obj.__uniqueKey) meta.matchKey = obj.__uniqueKey;
    if (obj.__spreadsheetId) meta.spreadsheetId = obj.__spreadsheetId;
  }

  apply(payload);
  if (Array.isArray(payload) && payload.length && payload[0]) apply(payload[0]);

  return meta;
}

function normalizeRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload.records && Array.isArray(payload.records)) return payload.records;
  if (payload.data && Array.isArray(payload.data)) return payload.data;
  return [payload];
}

function stripReservedKeys(obj) {
  var out = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k.indexOf("__") === 0) continue;
    if (k === "records" || k === "data") continue;
    out[k] = obj[k];
  }
  return out;
}

function maybeAddServerTimestamp(row) {
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) {
    var low = keys[i].toLowerCase();
    if (low === SERVER_TS_KEY.toLowerCase()) return;
    if (low.indexOf("timestamp") !== -1) return;
    if (low.indexOf("time") !== -1) return;
    if (low.length >= 3 && low.slice(-3) === "_at") return;
  }
  row[SERVER_TS_KEY] = new Date().toISOString();
}

function detectMatchKey(row) {
  var keys = Object.keys(row);
  var lowerMap = {};
  for (var i = 0; i < keys.length; i++) {
    lowerMap[keys[i].toLowerCase()] = keys[i];
  }
  for (var a = 0; a < AUTO_MATCH_KEYS.length; a++) {
    var cand = AUTO_MATCH_KEYS[a].toLowerCase();
    if (lowerMap[cand]) return lowerMap[cand];
  }
  for (var k = 0; k < keys.length; k++) {
    var kk = keys[k].toLowerCase();
    if (kk === "id" || kk.slice(-3) === "_id") return keys[k];
  }
  return null;
}

function getSpreadsheet(overrideId) {
  var props = PropertiesService.getScriptProperties();
  var id = overrideId || props.getProperty(SCRIPT_PROP_SPREADSHEET);

  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      throw new Error("Cannot open spreadsheet " + id + ": " + e.message);
    }
  }

  var ss = SpreadsheetApp.create("Dynamic HRMS / CRM Data");
  props.setProperty(SCRIPT_PROP_SPREADSHEET, ss.getId());
  return ss;
}

function getOrCreateSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  return ss.insertSheet(name);
}

function readHeaders_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  if (sheet.getLastRow() < 1) return [];
  var row = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var headers = [];
  for (var c = 0; c < row.length; c++) {
    var v = row[c];
    if (v !== null && v !== "") headers.push(String(v).trim());
  }
  return headers;
}

function mergeHeaders_(existing, keys) {
  var merged = existing.slice();
  var seen = {};
  for (var i = 0; i < merged.length; i++) seen[merged[i]] = true;
  for (var j = 0; j < keys.length; j++) {
    var k = keys[j];
    if (!seen[k]) {
      merged.push(k);
      seen[k] = true;
    }
  }
  return merged;
}

function upsertDynamicRow_(sheet, row, matchKey) {
  var keys = Object.keys(row);
  if (keys.length === 0) return "skip_empty";

  var headers = readHeaders_(sheet);
  var merged = mergeHeaders_(headers, keys);

  if (merged.length > 0) {
    var headerRange = sheet.getRange(1, 1, 1, merged.length);
    headerRange.setValues([merged]);
  }

  var colIndex = matchKey ? merged.indexOf(matchKey) : -1;
  var matchVal =
    matchKey && colIndex >= 0 && row[matchKey] !== undefined && row[matchKey] !== null
      ? String(row[matchKey])
      : null;

  var targetRow = -1;
  if (matchVal !== null && matchVal !== "") {
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var col = colIndex + 1;
      var data = sheet.getRange(2, col, lastRow, col).getValues();
      for (var r = 0; r < data.length; r++) {
        var cell = data[r][0];
        if (cell !== null && cell !== undefined && String(cell) === matchVal) {
          targetRow = r + 2;
          break;
        }
      }
    }
  }

  var values = [];
  for (var m = 0; m < merged.length; m++) {
    var hk = merged[m];
    values.push(row[hk] !== undefined ? row[hk] : "");
  }

  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, targetRow, merged.length).setValues([values]);
    return "updated";
  }

  sheet.appendRow(values);
  return "inserted";
}

function summarizeActions(actions) {
  var ins = 0,
    upd = 0,
    sk = 0;
  for (var i = 0; i < actions.length; i++) {
    if (actions[i] === "inserted") ins++;
    else if (actions[i] === "updated") upd++;
    else sk++;
  }
  var parts = [];
  if (ins) parts.push("inserted " + ins);
  if (upd) parts.push("updated " + upd);
  if (sk) parts.push("skipped " + sk);
  return parts.length ? parts.join(", ") : "no changes";
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Manual test in editor */
function testInsert() {
  var mock = {
    postData: {
      contents: JSON.stringify({
        __tab: "Attendance",
        employee_id: "E001",
        check_in: "2025-04-11T09:00:00Z",
        check_out: "2025-04-11T18:00:00Z",
      }),
    },
  };
  var out = doPost(mock);
  Logger.log(out.getContent());
}
