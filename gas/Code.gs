/**
 * Google Apps Script Web App for Ringwheel Backend
 * 
 * API Contract:
 * - All requests must include a `token` that matches API_TOKEN in Script Properties
 * - GET: query param `token=...` and `type=...`
 * - POST: JSON body property `token: "..."` and `type: "..."`
 * 
 * GET types (lowercase):
 * - health   → { status: "ok" }
 * - roster   → array of objects from Roster sheet
 * - rings    → array of objects from Rings sheet
 * - settings → array of objects from Settings sheet
 * 
 * POST types (lowercase):
 * - logspin       → append row to SpinsLog sheet
 * - writerings    → overwrite Rings sheet with new rows
 * - writesettings → overwrite Settings sheet with new rows
 * - email         → send MailApp.sendEmail(to, subject, text)
 */

const TOKEN = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
const SHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');

// A1: Freeze sheet schemas
const SheetHeaders = {
  ROSTER: ['email','first','last','class','S1 Period','S2 Period'],
  RINGS: ['ring_name','label','color_hex','weight','order_index','active'],
  SETTINGS: ['key','value','notes'],
  SPINS_LOG: ['timestamp_iso','session_id','period','student_name','email','result_A','result_B','result_C','plantae_mercy','veto_used','seed','is_test','rule_flags_json']
};

/**
 * Handle GET requests
 */
function doGet(e) {
  if (!authOk(e)) {
    return forbidden();
  }
  
  const type = (e.parameter.type || '').toLowerCase();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  
  switch (type) {
    case 'health':
      return json({ status: 'ok' });
    case 'roster':
      return json(getRosterData(ss));
    case 'rings':
      return json(readSheet(ss, 'Rings'));
    case 'settings':
      return json(readSheet(ss, 'Settings'));
    default:
      return notFound();
  }
}

/**
 * Handle POST requests
 */
function doPost(e) {
  const body = parseBody(e);
  
  if (!authOk({ parameter: body })) {
    return forbidden();
  }
  
  const type = (body.type || '').toLowerCase();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  
  switch (type) {
    case 'logspin':
      // A2: Ensure student info and period are mapped
      // Expected payload: { student_name, email, period, ... }
      const logPayload = body.payload || {};
      
      // Ensure defaults for A2 fields
      logPayload.student_name = logPayload.student_name || '';
      logPayload.email = logPayload.email || '';
      logPayload.period = logPayload.period || '';

      // Ensure rule_flags_json is stringified
      if (logPayload.rule_flags_json && typeof logPayload.rule_flags_json !== 'string') {
        logPayload.rule_flags_json = JSON.stringify(logPayload.rule_flags_json);
      }

      appendRow(ss, 'SpinsLog', logPayload);
      return json({ ok: true });
    case 'writerings':
      writeRows(ss, 'Rings', body.rows || []);
      return json({ ok: true });
    case 'writesettings':
      writeRows(ss, 'Settings', body.rows || []);
      return json({ ok: true });
    case 'email':
      MailApp.sendEmail(body.to, body.subject, body.text || '');
      return json({ ok: true });
    default:
      return notFound();
  }
}

/**
 * Validate API token
 */
function authOk(e) {
  return e.parameter && e.parameter.token === TOKEN;
}

/**
 * Safely parse JSON body
 */
function parseBody(e) {
  try {
    if (e.postData && e.postData.contents) {
      return JSON.parse(e.postData.contents);
    }
  } catch (err) {
    // Ignore parse errors
  }
  return {};
}

// A1: Helper to get headers
function getHeaders(sheet) {
  const data = sheet.getDataRange().getValues();
  return data.length > 0 ? data[0] : [];
}

// A1: Helper to get header index
function getHeaderIndex(headers, name) {
  const index = headers.indexOf(name);
  if (index === -1) throw new Error('Header not found: ' + name);
  return index;
}

// A1: Helper to safely parse JSON
function safeParseJSON(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

/**
 * Canonical roster contract mirrored by RosterStudent TypeScript type.
 */
function getRosterData(ss) {
  const sheet = ss.getSheetByName('Roster');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0];
  const idx = (name) => headers.indexOf(name);

  return values.slice(1)
    .filter(row => row[idx('email')]) // skip empty rows
    .map(row => ({
      email: String(row[idx('email')] || ''),
      first: String(row[idx('first')] || ''),
      last: String(row[idx('last')] || ''),
      class: String(row[idx('class')] || ''),
      s1Period: row[idx('S1 Period')] ? String(row[idx('S1 Period')]) : null,
      s2Period: row[idx('S2 Period')] ? String(row[idx('S2 Period')]) : null,
    }));
}

/**
 * Read sheet data as array of objects
 * First row is headers; subsequent rows map to objects
 * Skips completely blank rows
 */
function readSheet(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    return [];
  }
  
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return [];
  }
  
  const headers = data[0];
  const rows = data.slice(1);
  const result = [];
  
  for (const row of rows) {
    // Skip blank rows
    if (row.every(cell => cell === '' || cell === null || cell === undefined)) {
      continue;
    }
    
    const obj = {};
    headers.forEach((header, index) => {
      let val = row[index];
      // A1: Parse rule_flags_json
      if (header === 'rule_flags_json') {
        val = safeParseJSON(val, []);
      }
      obj[header] = val;
    });
    result.push(obj);
  }
  
  return result;
}

/**
 * Write rows to sheet (clears existing content)
 * Uses keys of first row object as headers
 * NOTE: This will wipe formatting; acceptable for MVP
 */
function writeRows(ss, name, rows) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    return;
  }
  
  sheet.clear();
  
  if (!rows || rows.length === 0) {
    return;
  }
  
  // A1: Use frozen headers if available
  let headers = [];
  if (name === 'Rings') headers = SheetHeaders.RINGS;
  else if (name === 'Settings') headers = SheetHeaders.SETTINGS;
  else headers = Object.keys(rows[0]);
  
  sheet.appendRow(headers);
  
  for (const row of rows) {
    const values = headers.map(h => {
      let val = row[h];
      // A1: Ensure rule_flags_json is stringified
      if (h === 'rule_flags_json' && val !== undefined && typeof val !== 'string') {
        val = JSON.stringify(val);
      }
      return val !== undefined ? val : '';
    });
    sheet.appendRow(values);
  }
}

/**
 * Append a single row to sheet
 * Reads headers from first row and appends values in header order
 */
function appendRow(ss, name, payload) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    return;
  }
  
  const data = sheet.getDataRange().getValues();
  let headers = [];
  
  if (data.length > 0) {
    headers = data[0];
  } else if (name === 'SpinsLog') {
    // If empty, initialize with frozen headers
    headers = SheetHeaders.SPINS_LOG;
    sheet.appendRow(headers);
  } else {
    return;
  }
  
  const values = headers.map(h => payload[h] !== undefined ? payload[h] : '');
  sheet.appendRow(values);
}

/**
 * Create JSON response
 */
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Create forbidden response
 */
function forbidden() {
  return ContentService
    .createTextOutput('Forbidden')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Create not found response
 */
function notFound() {
  return ContentService
    .createTextOutput('Not Found')
    .setMimeType(ContentService.MimeType.TEXT);
}
