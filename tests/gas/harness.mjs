/**
 * Local test harness for gas/Code.gs.
 *
 * Loads the real Apps Script source into a Node `vm` sandbox with in-memory
 * fakes for SpreadsheetApp, PropertiesService, ContentService, LockService and
 * MailApp. Nothing here talks to Google: no network, no real Sheets, no email.
 *
 * Used by:
 * - tests/gas/*.test.ts      (backend contract tests)
 * - e2e/mock-server.mjs      (HTTP wrapper so the real frontend can talk to
 *                             the real backend code against fake sheets)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Set RINGWHEEL_GAS_PATH to run the same tests against another copy of the
// backend source, for example a file pasted from the deployed Apps Script project.
const DEFAULT_CODE_PATH =
  process.env.RINGWHEEL_GAS_PATH || fileURLToPath(new URL('../../gas/Code.gs', import.meta.url));

/** In-memory stand-in for a single Sheet tab. Rows are plain 2D arrays. */
class FakeSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((r) => [...r]);
  }

  getName() {
    return this.name;
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((max, r) => Math.max(max, r.length), 0);
  }

  getMaxRows() {
    return Math.max(this.rows.length, 1000);
  }

  getMaxColumns() {
    return Math.max(this.getLastColumn(), 26);
  }

  /** Real Sheets returns a 1x1 range holding '' for a completely empty tab. */
  getDataRange() {
    const numRows = Math.max(this.getLastRow(), 1);
    const numCols = Math.max(this.getLastColumn(), 1);
    return this.getRange(1, 1, numRows, numCols);
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    return {
      getValues: () => {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const src = this.rows[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) {
            const v = src[col - 1 + c];
            line.push(v === undefined ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      setValues: (values) => {
        if (values.length !== numRows || values.some((v) => v.length !== numCols)) {
          throw new Error('The number of rows or columns in the data does not match the range.');
        }
        for (let r = 0; r < numRows; r++) {
          const target = row - 1 + r;
          while (this.rows.length <= target) this.rows.push([]);
          for (let c = 0; c < numCols; c++) {
            this.rows[target][col - 1 + c] = values[r][c];
          }
        }
      },
      clearContent: () => {
        for (let r = 0; r < numRows; r++) {
          const line = this.rows[row - 1 + r];
          if (!line) continue;
          for (let c = 0; c < numCols; c++) {
            if (col - 1 + c < line.length) line[col - 1 + c] = '';
          }
        }
        this.trim();
      },
    };
  }

  appendRow(values) {
    if (this.failAppend) throw new Error('Simulated Sheets failure');
    this.rows.push([...values]);
  }

  clear() {
    this.rows = [];
  }

  clearContents() {
    this.rows = [];
  }

  /** Drop trailing rows that are entirely empty, the way getLastRow behaves. */
  trim() {
    while (this.rows.length && this.rows[this.rows.length - 1].every((v) => v === '' || v === undefined)) {
      this.rows.pop();
    }
  }
}

class FakeSpreadsheet {
  constructor(sheets) {
    this.sheets = new Map();
    for (const [name, rows] of Object.entries(sheets)) {
      this.sheets.set(name, new FakeSheet(name, rows));
    }
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    if (this.sheets.has(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }

  deleteSheet(sheet) {
    this.sheets.delete(sheet.getName());
  }
}

/**
 * Build a sandbox with the backend loaded.
 *
 * @param {object} opts
 * @param {Record<string, unknown[][]>} [opts.sheets]     tab name -> 2D rows (row 0 = headers)
 * @param {Record<string, string>} [opts.properties]      Script Properties
 * @param {string} [opts.codePath]                        override for baseline comparisons
 */
export function createGasRuntime({ sheets = {}, properties = {}, codePath = DEFAULT_CODE_PATH } = {}) {
  const spreadsheet = new FakeSpreadsheet(sheets);
  const sentEmails = [];
  const props = { SPREADSHEET_ID: 'fake-spreadsheet-id', ...properties };

  const sandbox = {
    console,
    JSON,
    Date,
    Math,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in props ? props[key] : null),
      }),
    },
    SpreadsheetApp: {
      openById: (id) => {
        if (id !== props.SPREADSHEET_ID) throw new Error('Unexpected spreadsheet id');
        return spreadsheet;
      },
      getActiveSpreadsheet: () => spreadsheet,
    },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: (text) => {
        const out = {
          content: String(text),
          mimeType: 'text/plain',
          setMimeType(m) {
            out.mimeType = m;
            return out;
          },
          getContent: () => out.content,
          getMimeType: () => out.mimeType,
        };
        return out;
      },
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {},
        tryLock: () => true,
        releaseLock: () => {},
      }),
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }),
    },
    MailApp: {
      // Records instead of sending. The harness can never deliver mail.
      sendEmail: (...args) => {
        sentEmails.push(args);
      },
    },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(codePath, 'utf8'), context, { filename: 'Code.gs' });

  const toResponse = (out) => {
    const content = out.getContent();
    const mimeType = out.getMimeType();
    let json;
    if (mimeType === 'application/json') {
      try {
        json = JSON.parse(content);
      } catch {
        json = undefined;
      }
    }
    return { content, mimeType, json };
  };

  return {
    spreadsheet,
    sentEmails,
    sheet: (name) => spreadsheet.getSheetByName(name),
    rows: (name) => {
      const sheet = spreadsheet.getSheetByName(name);
      return sheet ? sheet.rows.map((r) => [...r]) : null;
    },
    /** Simulate GET {WEB_APP_URL}?key=value */
    get: (params = {}) => toResponse(context.doGet({ parameter: { ...params } })),
    /** Simulate POST with a raw body string (what the browser actually sends). */
    postRaw: (contents, params = {}) =>
      toResponse(context.doPost({ parameter: { ...params }, postData: { contents, type: 'text/plain' } })),
    /** Simulate POST with a JSON body. */
    post: (body, params = {}) =>
      toResponse(
        context.doPost({ parameter: { ...params }, postData: { contents: JSON.stringify(body), type: 'text/plain' } })
      ),
  };
}

export const TEST_TOKEN = 'test-token-not-a-real-secret';

/**
 * Synthetic classroom data. Every name and address here is invented; the
 * example.com domain is reserved for documentation and cannot receive mail.
 */
export function syntheticSheets() {
  const regions = ['Palearctic', 'Nearctic', 'Neotropical', 'Afrotropical', 'Indomalayan', 'Australasian', 'Antarctic', 'Oceanic'];
  const taxa = ['Mammalia', 'Aves', 'Reptilia', 'Amphibia', 'Actinopterygii', 'Chondrichthyes', 'Insecta', 'Arachnida', 'Plantae', 'Fungi'];
  const iucn = ['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX'];
  let order = 0;
  const ringRows = [
    ...regions.map((label) => ['A', label, '#4f46e5', 1, order++, true]),
    ...taxa.map((label) => ['B', label, '#16a34a', 1, order++, true]),
    ...iucn.map((label) => ['C', label, '#eab308', 1, order++, true]),
  ];

  return {
    Roster: [
      ['email', 'first', 'last', 'class', 'S1 Period', 'S2 Period'],
      ['ada.sample@example.com', 'Ada', 'Sample', 'Environmental Science', 'A', 'B'],
      ['ben.placeholder@example.com', 'Ben', 'Placeholder', 'Environmental Science', 'A', 'B'],
      ['cy.demo@example.com', 'Cy', 'Demo', 'Environmental Science', 'A', ''],
      ['dee.fixture@example.com', 'Dee', 'Fixture', 'Environmental Science', 'B', 'A'],
      ['eli.testcase@example.com', 'Eli', 'Testcase', 'Environmental Science', 'B', 'A'],
      ['', '', '', '', '', ''],
    ],
    Rings: [['ring_name', 'label', 'color_hex', 'weight', 'order_index', 'active'], ...ringRows],
    Settings: [
      ['key', 'value', 'notes'],
      ['midterm_pair_cap_pct', 12, 'Cap for A|B pairs in midterm mode'],
      ['mode', 'midterm', 'midterm or final'],
      ['enableAudio', false, 'Sheets stores this as a real boolean'],
      ['enableConfetti', false, ''],
    ],
    SpinsLog: [
      ['timestamp_iso', 'session_id', 'period', 'student_name', 'email', 'result_A', 'result_B', 'result_C', 'plantae_mercy', 'veto_used', 'seed', 'is_test', 'rule_flags_json'],
    ],
  };
}
