/**
 * Google Apps Script Web App for the Ringwheel backend.
 *
 * This is the only backend implementation. The frontend client is src/api.ts.
 *
 * Script Properties (Project Settings > Script Properties):
 * - API_TOKEN       required. Every request must carry it.
 * - SPREADSHEET_ID  required. The spreadsheet holding the four tabs below.
 * - ADMIN_TOKEN     optional. When set, writerings / writesettings / email must
 *                   also send `admin_token` with this value. When not set, those
 *                   routes behave as before and accept the API token alone.
 * - EMAIL_ALLOWED_RECIPIENTS  optional. Comma-separated addresses the email
 *                   route may send to. When not set, email can only be sent to
 *                   the account that owns this script.
 *
 * API contract:
 * - GET:  query params `token=...` and `type=...`
 * - POST: JSON body with `token` and `type` (or `mode`)
 *
 * GET types (lowercase):
 * - health   -> { status: "ok" }, or { status: "degraded", missing: [tab names] }
 * - roster   -> array of { email, first, last, class, s1Period, s2Period }
 * - rings    -> array of row objects from the Rings sheet
 * - settings -> array of row objects from the Settings sheet
 *
 * POST types (lowercase):
 * - getspins      -> array of spin rows for one date (default today), optional period / email filter
 * - logspin       -> append one row to SpinsLog          -> { ok: true }
 * - writerings    -> replace the Rings sheet contents    -> { ok: true }
 * - writesettings -> replace the Settings sheet contents -> { ok: true }
 * - email         -> MailApp.sendEmail(to, subject, text) to an allowed recipient
 *
 * Responses:
 * - Apps Script always answers HTTP 200. A bad or missing token returns the
 *   plain text "Forbidden". An unknown type returns the plain text "Not Found".
 * - A write that could not be completed returns { ok: false, error: "..." }.
 *   `ok: true` is only returned after the data was actually written.
 */

const SheetHeaders = {
  ROSTER: ['email','first','last','class','S1 Period','S2 Period'],
  RINGS: ['ring_name','label','color_hex','weight','order_index','active'],
  SETTINGS: ['key','value','notes'],
  SPINS_LOG: ['timestamp_iso','session_id','period','student_name','email','result_A','result_B','result_C','plantae_mercy','veto_used','seed','is_test','rule_flags_json']
};

/** Most rows a single writerings / writesettings call may carry. */
const MAX_WRITE_ROWS = 500;

function getProp(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function openSpreadsheet() {
  return SpreadsheetApp.openById(getProp('SPREADSHEET_ID'));
}

/**
 * Handle GET requests
 */
function doGet(e) {
  if (!authOk(e)) {
    return forbidden();
  }

  try {
    const type = String(e.parameter.type || '').toLowerCase();

    switch (type) {
      case 'health':
        return json(healthStatus(openSpreadsheet()));
      case 'roster':
        return json(getRosterData(openSpreadsheet()));
      case 'rings':
        return json(readSheet(openSpreadsheet(), 'Rings'));
      case 'settings':
        return json(readSheet(openSpreadsheet(), 'Settings'));
      default:
        return notFound();
    }
  } catch (err) {
    return failure('Internal error: ' + errorMessage(err));
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

  try {
    const type = String(body.mode || body.type || '').toLowerCase();

    switch (type) {
      case 'getspins':
        return json(getSpinsData(openSpreadsheet(), {
          date: body.date,
          period: body.period,
          email: body.email,
        }));
      case 'logspin':
        return json(logSpin(openSpreadsheet(), body.payload));
      case 'writerings':
        if (!adminOk(body)) return forbidden();
        return json(writeRows(openSpreadsheet(), 'Rings', body.rows));
      case 'writesettings':
        if (!adminOk(body)) return forbidden();
        return json(writeRows(openSpreadsheet(), 'Settings', body.rows));
      case 'email':
        if (!adminOk(body)) return forbidden();
        return json(sendEmail(body));
      default:
        return notFound();
    }
  } catch (err) {
    return failure('Internal error: ' + errorMessage(err));
  }
}

/**
 * Health check. Reports "ok" only when the spreadsheet opens and all four tabs
 * exist, so a green status means spins can actually be read and logged.
 */
function healthStatus(ss) {
  const missing = ['Roster', 'Rings', 'Settings', 'SpinsLog'].filter(function (name) {
    return !ss.getSheetByName(name);
  });
  if (missing.length > 0) {
    return { status: 'degraded', missing: missing };
  }
  return { status: 'ok' };
}

/**
 * Validate the API token. Fails closed when API_TOKEN is not configured.
 */
function authOk(e) {
  const token = getProp('API_TOKEN');
  if (!token) return false;
  return !!(e && e.parameter) && e.parameter.token === token;
}

/**
 * Extra check for routes that change configuration or send mail.
 * Only enforced when the ADMIN_TOKEN Script Property is set.
 */
function adminOk(body) {
  const adminToken = getProp('ADMIN_TOKEN');
  if (!adminToken) return true;
  return body.admin_token === adminToken;
}

/**
 * Safely parse JSON body
 */
function parseBody(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      const parsed = JSON.parse(e.postData.contents);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    // Fall through: an unreadable body carries no token and is rejected as Forbidden.
  }
  return {};
}

function errorMessage(err) {
  return err && err.message ? String(err.message) : String(err);
}

function safeParseJSON(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function isBlank(value) {
  return value === '' || value === null || value === undefined;
}

function toBool(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

/**
 * Stop text supplied by a client from being interpreted as a spreadsheet
 * formula. A leading apostrophe makes Sheets store the cell as plain text.
 * Plain numbers such as "-5" are left alone.
 */
function safeCell(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && /^[=+\-@]/.test(value) && !/^[+-]?\d+(\.\d+)?$/.test(value)) {
    return "'" + value;
  }
  return value;
}

/**
 * Header row of a sheet, or [] when the sheet is completely empty.
 * (getDataRange() on an empty sheet still returns one blank cell.)
 */
function headerRow(sheet) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  return headers.every(function (h) { return h === ''; }) ? [] : headers;
}

/**
 * Mirrors the SpinLogRow TypeScript type.
 * Filters by date (default today, UTC), period, and email.
 */
function getSpinsData(ss, filters) {
  const sheet = ss.getSheetByName('SpinsLog');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0];
  const h = (name) => headers.indexOf(name);
  const cell = (row, name) => (h(name) === -1 ? '' : row[h(name)]);

  // Default to today if no date provided
  const filterDate = filters.date || new Date().toISOString().split('T')[0];

  return values.slice(1)
    .filter(row => {
      const rowDate = String(cell(row, 'timestamp_iso') || '').split('T')[0];
      if (rowDate !== filterDate) return false;
      if (filters.period && String(cell(row, 'period') || '') !== filters.period) return false;
      if (filters.email && String(cell(row, 'email') || '') !== filters.email) return false;
      return true;
    })
    .map(row => ({
      timestamp_iso: String(cell(row, 'timestamp_iso') || ''),
      session_id: String(cell(row, 'session_id') || ''),
      student_name: String(cell(row, 'student_name') || ''),
      email: String(cell(row, 'email') || ''),
      period: String(cell(row, 'period') || ''),
      result_region: String(cell(row, 'result_A') || ''),
      result_taxon: String(cell(row, 'result_B') || ''),
      result_iucn: String(cell(row, 'result_C') || ''),
      plantae_mercy: toBool(cell(row, 'plantae_mercy')),
      veto_used: toBool(cell(row, 'veto_used')),
      seed: String(cell(row, 'seed') || ''),
      is_test: toBool(cell(row, 'is_test')),
      rule_flags: safeParseJSON(cell(row, 'rule_flags_json'), []),
    }));
}

/**
 * Canonical roster contract mirrored by the RosterStudent TypeScript type.
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
    if (row.every(isBlank)) {
      continue;
    }

    const obj = {};
    headers.forEach((header, index) => {
      if (isBlank(header)) return;
      let val = row[index];
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
 * Append one spin to SpinsLog. The log is append-only: existing rows are never
 * touched. Returns { ok: false } when nothing was written.
 */
function logSpin(ss, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('logspin needs a payload object.');
  }
  for (const field of ['timestamp_iso', 'result_A', 'result_B', 'result_C']) {
    if (typeof payload[field] !== 'string' || payload[field] === '') {
      return fail('logspin payload is missing ' + field + '.');
    }
  }

  const sheet = ss.getSheetByName('SpinsLog');
  if (!sheet) {
    return fail('The SpinsLog sheet was not found. Nothing was logged.');
  }

  const row = Object.assign({}, payload);
  row.student_name = row.student_name || '';
  row.email = row.email || '';
  row.period = row.period || '';
  if (row.rule_flags_json !== undefined && typeof row.rule_flags_json !== 'string') {
    row.rule_flags_json = JSON.stringify(row.rule_flags_json);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let headers = headerRow(sheet);
    if (headers.length === 0) {
      // Brand new sheet: start it with the frozen header row.
      headers = SheetHeaders.SPINS_LOG;
      sheet.appendRow(headers);
    }

    const missing = SheetHeaders.SPINS_LOG.filter(function (name) { return headers.indexOf(name) === -1; });
    sheet.appendRow(headers.map(function (name) { return safeCell(row[name]); }));

    const result = { ok: true };
    if (missing.length > 0) {
      result.warnings = ['SpinsLog is missing these columns, so their values were not saved: ' + missing.join(', ')];
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Check rows for writerings / writesettings. Returns an error string or ''.
 */
function validateRows(name, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'No rows were sent. Refusing to empty the ' + name + ' sheet.';
  }
  if (rows.length > MAX_WRITE_ROWS) {
    return 'Too many rows (' + rows.length + ').';
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return 'Row ' + (i + 1) + ' is not an object.';
    }
    if (name === 'Rings') {
      if (['A', 'B', 'C'].indexOf(String(row.ring_name)) === -1) {
        return 'Row ' + (i + 1) + ' has an invalid ring_name.';
      }
      if (isBlank(row.label)) {
        return 'Row ' + (i + 1) + ' has no label.';
      }
      if (!isBlank(row.weight) && (typeof row.weight !== 'number' || !isFinite(row.weight) || row.weight < 0)) {
        return 'Row ' + (i + 1) + ' has an invalid weight.';
      }
    } else if (name === 'Settings') {
      if (isBlank(row.key)) {
        return 'Row ' + (i + 1) + ' has no key.';
      }
    }
  }
  return '';
}

/**
 * Replace the contents of the Rings or Settings sheet.
 *
 * Safety properties:
 * - The rows are validated first. An empty or malformed request changes nothing.
 * - The new contents are written in one call over the old ones. The sheet is
 *   never cleared first, so a failure cannot leave it empty.
 * - Formatting and any extra columns the sheet already has are kept.
 */
function writeRows(ss, name, rows) {
  const problem = validateRows(name, rows);
  if (problem) {
    return fail(problem);
  }

  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    return fail('The ' + name + ' sheet was not found. Nothing was saved.');
  }

  const frozen = name === 'Rings' ? SheetHeaders.RINGS : SheetHeaders.SETTINGS;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Keep the sheet's own column order and extra columns. Add any required column that is missing.
    const existing = headerRow(sheet).filter(function (h) { return h !== ''; });
    const headers = existing.slice();
    frozen.forEach(function (h) {
      if (headers.indexOf(h) === -1) headers.push(h);
    });

    const values = [headers].concat(rows.map(function (row) {
      return headers.map(function (h) {
        let val = row[h];
        if (h === 'rule_flags_json' && val !== undefined && typeof val !== 'string') {
          val = JSON.stringify(val);
        }
        return safeCell(val);
      });
    }));

    const previousRows = sheet.getLastRow();
    const previousCols = sheet.getLastColumn();

    sheet.getRange(1, 1, values.length, headers.length).setValues(values);

    // Blank out anything left over from the previous, larger contents.
    if (previousRows > values.length) {
      sheet.getRange(values.length + 1, 1, previousRows - values.length, Math.max(previousCols, headers.length)).clearContent();
    }
    if (previousCols > headers.length) {
      sheet.getRange(1, headers.length + 1, values.length, previousCols - headers.length).clearContent();
    }

    return { ok: true, rows: rows.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Send an email, but only to an allowed recipient.
 * Without EMAIL_ALLOWED_RECIPIENTS the only allowed recipient is the script owner.
 */
function sendEmail(body) {
  const to = String(body.to || '').trim().toLowerCase();
  if (!to || to.indexOf(',') !== -1 || to.indexOf(';') !== -1) {
    return fail('email needs exactly one recipient.');
  }

  const configured = getProp('EMAIL_ALLOWED_RECIPIENTS');
  let allowed;
  if (configured) {
    allowed = configured.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  } else {
    allowed = [String(Session.getEffectiveUser().getEmail() || '').toLowerCase()].filter(Boolean);
  }
  if (allowed.indexOf(to) === -1) {
    return fail('That recipient is not allowed.');
  }

  MailApp.sendEmail(to, String(body.subject || '').slice(0, 200), String(body.text || '').slice(0, 5000));
  return { ok: true };
}

function fail(message) {
  return { ok: false, error: message };
}

/**
 * Create JSON response
 */
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function failure(message) {
  return json(fail(message));
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
