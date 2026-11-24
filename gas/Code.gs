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
 * - health   -> { status: "ok", contract: 2, warnings: [...] }
 *               or { status: "degraded", contract: 2, missing: [tab names], problems: [...], warnings: [...] }
 *               "ok" means every tab exists and has the columns the app cannot work without.
 * - roster   -> array of { email, first, last, class, s1Period, s2Period }
 * - rings    -> array of row objects from the Rings sheet
 * - settings -> array of row objects from the Settings sheet
 *
 * POST types (lowercase):
 * - getspins      -> array of spin rows for one date (default today), optional period / email filter
 * - logspin       -> append one row to SpinsLog
 *                    -> { ok: true, complete: true }                       every field was stored
 *                    -> { ok: true, complete: false, missing_optional }    stored, but the sheet has no column for some optional fields
 *                    -> { ok: false, error, missing_required }             nothing stored: a required column is absent
 * - writerings    -> replace the Rings sheet contents    -> { ok: true }
 * - writesettings -> replace the Settings sheet contents -> { ok: true }
 *                    Both accept `base_rows`: the rows exactly as the client read them. When sent,
 *                    the write is refused with { ok: false, conflict: true } if the sheet has
 *                    changed since, so somebody else's edit is never silently overwritten.
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

/**
 * Columns a tab must have for the app to work. Everything else in SheetHeaders
 * is optional: useful, but its absence does not make a record wrong.
 *
 * SpinsLog: a row has to say when, who, which period and what was spun.
 * Without those it is not a usable record, so the write is refused.
 * The remaining columns (session_id, plantae_mercy, veto_used, seed, is_test,
 * rule_flags_json) are extra detail. A row is still written without them, but
 * it is reported as incomplete, never as fully saved.
 * One exception: a test spin is only written when the is_test column exists,
 * so a test row can never pass for a real one.
 */
const RequiredHeaders = {
  ROSTER: ['email', 'first', 'last'],
  RINGS: ['ring_name', 'label'],
  SETTINGS: ['key', 'value'],
  SPINS_LOG: ['timestamp_iso', 'period', 'student_name', 'email', 'result_A', 'result_B', 'result_C']
};

/** Bumped when the response shapes gain fields a client can rely on. */
const CONTRACT_VERSION = 2;

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
        return json(writeRows(openSpreadsheet(), 'Rings', body.rows, body.base_rows));
      case 'writesettings':
        if (!adminOk(body)) return forbidden();
        return json(writeRows(openSpreadsheet(), 'Settings', body.rows, body.base_rows));
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
 * Compare a tab's header row with what the app needs.
 * A tab with no header row at all reports nothing missing only where the
 * backend can create the header itself (SpinsLog).
 */
function missingColumns(sheet, required, all, canInitialize) {
  const headers = headerRow(sheet);
  if (headers.length === 0 && canInitialize) {
    return { required: [], optional: [] };
  }
  const absent = function (name) { return headers.indexOf(name) === -1; };
  return {
    required: required.filter(absent),
    optional: all.filter(function (name) { return required.indexOf(name) === -1; }).filter(absent)
  };
}

/**
 * Health check. Reports "ok" only when the spreadsheet opens, all four tabs
 * exist, and each has the columns the app cannot work without, so a green
 * status means spins can actually be read and logged in full.
 */
function healthStatus(ss) {
  const tabs = [
    ['Roster', RequiredHeaders.ROSTER, SheetHeaders.ROSTER, false],
    ['Rings', RequiredHeaders.RINGS, SheetHeaders.RINGS, false],
    ['Settings', RequiredHeaders.SETTINGS, SheetHeaders.SETTINGS, false],
    ['SpinsLog', RequiredHeaders.SPINS_LOG, SheetHeaders.SPINS_LOG, true]
  ];
  const missing = [];
  const problems = [];
  const warnings = [];

  tabs.forEach(function (tab) {
    const sheet = ss.getSheetByName(tab[0]);
    if (!sheet) {
      missing.push(tab[0]);
      return;
    }
    const cols = missingColumns(sheet, tab[1], tab[2], tab[3]);
    if (cols.required.length > 0) {
      problems.push(tab[0] + ' is missing required columns: ' + cols.required.join(', '));
    }
    if (cols.optional.length > 0) {
      warnings.push(tab[0] + ' has no column for: ' + cols.optional.join(', '));
    }
  });

  // A roster with no period column cannot place anyone in a class.
  const roster = ss.getSheetByName('Roster');
  if (roster) {
    const rosterHeaders = headerRow(roster);
    if (rosterHeaders.indexOf('S1 Period') === -1 && rosterHeaders.indexOf('S2 Period') === -1) {
      problems.push('Roster has neither an "S1 Period" nor an "S2 Period" column');
    }
  }

  if (missing.length > 0 || problems.length > 0) {
    return { status: 'degraded', contract: CONTRACT_VERSION, missing: missing, problems: problems, warnings: warnings };
  }
  return { status: 'ok', contract: CONTRACT_VERSION, warnings: warnings };
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
 * touched.
 *
 * The answer always says how much was stored:
 * - { ok: true, complete: true }                    every field has a column and was written
 * - { ok: true, complete: false, missing_optional } the row was written, optional fields were not
 * - { ok: false, error, missing_required }          nothing was written
 * A row that lacks a required column is never written, so the log cannot
 * collect records that do not say who spun what.
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

    const absent = function (name) { return headers.indexOf(name) === -1; };

    const required = RequiredHeaders.SPINS_LOG.slice();
    // A test spin must stay recognizable as a test.
    if (toBool(row.is_test)) required.push('is_test');

    const missingRequired = required.filter(absent);
    if (missingRequired.length > 0) {
      const refusal = fail(
        'Nothing was logged. The SpinsLog sheet is missing required columns: ' + missingRequired.join(', ') + '.'
      );
      refusal.missing_required = missingRequired;
      return refusal;
    }

    const missingOptional = SheetHeaders.SPINS_LOG.filter(function (name) {
      return required.indexOf(name) === -1 && absent(name);
    });

    sheet.appendRow(headers.map(function (name) { return safeCell(row[name]); }));

    if (missingOptional.length > 0) {
      return {
        ok: true,
        complete: false,
        missing_optional: missingOptional,
        warnings: ['The spin was logged without these fields because SpinsLog has no column for them: ' + missingOptional.join(', ')]
      };
    }
    return { ok: true, complete: true };
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
 * - When the client sends `baseRows` (the rows exactly as it read them), the
 *   write only happens if the sheet still holds those rows. If someone edited
 *   the sheet in between, nothing is written and the answer says conflict.
 */
function writeRows(ss, name, rows, baseRows) {
  const problem = validateRows(name, rows);
  if (problem) {
    return fail(problem);
  }

  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    return fail('The ' + name + ' sheet was not found. Nothing was saved.');
  }

  const frozen = name === 'Rings' ? SheetHeaders.RINGS : SheetHeaders.SETTINGS;

  if (baseRows !== undefined && baseRows !== null && !Array.isArray(baseRows)) {
    return fail('base_rows must be a list.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (Array.isArray(baseRows) && canonicalRows(readSheet(ss, name)) !== canonicalRows(baseRows)) {
      const conflict = fail(
        'The ' + name + ' sheet was changed by someone else after it was loaded. Nothing was saved. Reload and try again.'
      );
      conflict.conflict = true;
      return conflict;
    }

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
 * Order-independent text form of sheet rows, used to tell whether a sheet
 * still holds what a client read earlier. Goes through JSON so that dates and
 * numbers compare the way they travel to and from the browser.
 */
function canonicalRows(rows) {
  return JSON.stringify(JSON.parse(JSON.stringify(rows)).map(function (row) {
    return Object.keys(row || {}).sort().map(function (key) { return [key, row[key]]; });
  }));
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
