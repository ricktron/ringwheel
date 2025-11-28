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
      return json(readSheet(ss, 'Roster'));
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
      appendRow(ss, 'SpinsLog', body.payload || {});
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
      obj[header] = row[index];
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
  
  const headers = Object.keys(rows[0]);
  sheet.appendRow(headers);
  
  for (const row of rows) {
    const values = headers.map(h => row[h] !== undefined ? row[h] : '');
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
  if (data.length === 0) {
    return;
  }
  
  const headers = data[0];
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
