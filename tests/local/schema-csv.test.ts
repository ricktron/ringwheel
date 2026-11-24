import { describe, expect, it } from 'vitest';
import { parseCsv, parseRosterCsv, planRosterImport, rosterToCsv, sameStudent, spinsToCsv, toCsv } from '../../src/data/local/csv';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  WORKSPACE_SCHEMA_VERSION,
  buildBackup,
  createStudent,
  createWorkspace,
  parseBackupText,
  validateBackup,
} from '../../src/data/local/schema';
import { sampleBundle } from './fixtures';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('workspace schema', () => {
  it('new classes and students get distinct stable ids and the current schema version', () => {
    const a = createWorkspace('  Period 3  ');
    const b = createWorkspace('Period 3');
    expect(a.name).toBe('Period 3');
    expect(a.id).not.toBe(b.id);
    expect(a.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(a).toMatchObject({ rev: 1, students: [], settings: [], rings: [], lastBackupAt: null });
    expect(createWorkspace('   ').name).toBe('My class');

    const s1 = createStudent('  Ada   Sample ', ' ada.sample@example.com ');
    const s2 = createStudent('Ada Sample');
    expect(s1).toMatchObject({ name: 'Ada Sample', email: 'ada.sample@example.com', active: true });
    // The id never depends on the name, so renaming a student keeps their history attached.
    expect(s1.id).not.toBe(s2.id);
  });
});

describe('backup files', () => {
  const good = () => buildBackup([sampleBundle('Period 3'), sampleBundle('Period 5', ['Dee Fixture'], 2)], new Date('2026-11-24T18:00:00.000Z'));

  it('a backup survives being written to text and read back, unchanged', () => {
    const backup = good();
    const text = JSON.stringify(backup);
    const parsed = parseBackupText(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.backup).toEqual(backup);
      // Reading it again gives the same thing: nothing drifts on repeated export and import.
      expect(parseBackupText(JSON.stringify(parsed.backup))).toEqual(parsed);
    }
  });

  it('keeps every selection, timestamp, flag and seed of the spin history', () => {
    const backup = good();
    const parsed = parseBackupText(JSON.stringify(backup));
    if (!parsed.ok) throw new Error(parsed.errors.join(' '));
    const before = backup.workspaces[0].spins;
    const after = parsed.backup.workspaces[0].spins;
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      for (const field of ['id', 'studentId', 'timestamp_iso', 'student_name', 'result_A', 'result_B', 'result_C', 'seed', 'rule_flags_json', 'plantae_mercy', 'veto_used', 'is_test', 'session_id'] as const) {
        expect(after[i][field]).toStrictEqual(before[i][field]);
      }
    }
  });

  it.each([
    ['text that is not JSON', 'not json at all', /not valid JSON/],
    ['a file cut off half way', JSON.stringify(good()).slice(0, 400), /not valid JSON/],
    ['an empty file', '', /not valid JSON/],
    ['some other JSON file', '{"hello":"world"}', /not a RingWheel backup/],
    ['a JSON list', '[1,2,3]', /not a RingWheel backup/],
    ['JSON null', 'null', /not a RingWheel backup/],
  ])('rejects %s', (_name, text, message) => {
    const result = parseBackupText(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(message);
  });

  const broken: [string, (b: ReturnType<typeof good>) => unknown, RegExp][] = [
    ['a backup from a newer version', (b) => ({ ...b, formatVersion: BACKUP_FORMAT_VERSION + 1 }), /newer version/],
    ['a class saved by a newer schema', (b) => { (b.workspaces[0].workspace as { schemaVersion: number }).schemaVersion = WORKSPACE_SCHEMA_VERSION + 1; return b; }, /newer version/],
    ['no version', (b) => ({ ...b, formatVersion: undefined }), /which version/],
    ['no classes', (b) => ({ ...b, workspaces: [] }), /no classes/],
    ['classes that are not a list', (b) => ({ ...b, workspaces: 'lots' }), /no classes/],
    ['a class without a name', (b) => { b.workspaces[0].workspace.name = '  '; return b; }, /Class 1 has no name/],
    ['a class without an id', (b) => { (b.workspaces[0].workspace as { id: unknown }).id = 42; return b; }, /no valid id/],
    ['the same class twice', (b) => { b.workspaces[1] = clone(b.workspaces[0]); return b; }, /appears twice/],
    ['a student without a name', (b) => { b.workspaces[0].workspace.students[1].name = ''; return b; }, /student 2 has no name/],
    ['two students with the same id', (b) => { b.workspaces[0].workspace.students[1].id = b.workspaces[0].workspace.students[0].id; return b; }, /student id .* twice/],
    ['a student list that is not a list', (b) => { (b.workspaces[0].workspace as { students: unknown }).students = {}; return b; }, /no student list/],
    ['a spin without a result', (b) => { b.workspaces[0].spins[0].result_B = ''; return b; }, /spin 1 has an empty result_B/],
    ['a spin with a bad timestamp', (b) => { b.workspaces[0].spins[0].timestamp_iso = 'yesterday'; return b; }, /invalid timestamp/],
    ['a spin with a text flag where true or false belongs', (b) => { (b.workspaces[0].spins[0] as { is_test: unknown }).is_test = 'false'; return b; }, /invalid is_test/],
    ['a spin that belongs to another class', (b) => { b.workspaces[0].spins[0].workspaceId = b.workspaces[1].workspace.id; return b; }, /different class/],
    ['two spins with the same id', (b) => { b.workspaces[0].spins[1].id = b.workspaces[0].spins[0].id; return b; }, /spin id .* twice/],
    ['unreadable rule flags', (b) => { b.workspaces[0].spins[0].rule_flags_json = '{oops'; return b; }, /unreadable rule flags/],
    ['a bad revision number', (b) => { (b.workspaces[0].workspace as { rev: unknown }).rev = 0; return b; }, /invalid revision/],
    ['settings that are not rows', (b) => { (b.workspaces[0].workspace as { settings: unknown }).settings = ['x']; return b; }, /settings is not a list of rows/],
    ['an id built to break out of a key', (b) => { b.workspaces[0].workspace.id = '../../etc'; return b; }, /no valid id/],
  ];

  it.each(broken)('rejects %s, and rejects the whole file', (_name, damage, message) => {
    const result = validateBackup(damage(clone(good())));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(message);
  });

  it('caps the error list so a badly damaged file still gives a readable message', () => {
    const backup = clone(good());
    backup.workspaces[0].spins = Array.from({ length: 200 }, () => ({}) as never);
    const result = validateBackup(backup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeLessThanOrEqual(20);
  });

  it('refuses an oversized file before trying to read it', () => {
    const result = parseBackupText('x'.repeat(26 * 1024 * 1024));
    expect(result).toEqual({ ok: false, errors: ['The file is too large to be a RingWheel backup.'] });
  });

  it('ignores unknown extra fields instead of storing them', () => {
    const backup = clone(good()) as unknown as Record<string, unknown>;
    backup.injected = '<script>alert(1)</script>';
    ((backup.workspaces as { workspace: Record<string, unknown> }[])[0].workspace).__proto__ = { polluted: true };
    ((backup.workspaces as { workspace: Record<string, unknown> }[])[0].workspace).extra = 'dropped';
    const result = validateBackup(backup);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.backup).not.toHaveProperty('injected');
      expect(result.backup.workspaces[0].workspace).not.toHaveProperty('extra');
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      expect(result.backup.format).toBe(BACKUP_FORMAT);
    }
  });

  it('accepts a spin whose student was later removed from the roster', () => {
    const backup = clone(good());
    backup.workspaces[0].workspace.students = backup.workspaces[0].workspace.students.slice(1);
    expect(validateBackup(backup).ok).toBe(true);
  });
});

describe('CSV reading and writing', () => {
  it('parses quotes, embedded commas and newlines, CRLF and a byte-order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseCsv(`${bom}name,email\r\n"Sample, Ada",ada@example.com\r\n"Line\nbreak",\n\n"He said ""hi""",x\n`)).toEqual([
      ['name', 'email'],
      ['Sample, Ada', 'ada@example.com'],
      ['Line\nbreak', ''],
      ['He said "hi"', 'x'],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
  });

  it('writes CSV that reads back the same', () => {
    const rows = [['name', 'note'], ['Sample, Ada', 'said "hi"'], ['Ben', 'two\nlines']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('never writes a cell that a spreadsheet would run as a formula', () => {
    const csv = toCsv([['=HYPERLINK("https://evil.test")', '+1', '-5', '@cmd', '-SUM(A1)', 'plain']]);
    const [cells] = parseCsv(csv);
    expect(cells).toEqual([`'=HYPERLINK("https://evil.test")`, '+1', '-5', "'@cmd", "'-SUM(A1)", 'plain']);
  });
});

describe('roster import', () => {
  it('reads a header with name and email, ignoring other columns', () => {
    const parsed = parseRosterCsv('Period,Name,E-mail,Locker\n3,Ada Sample,ada.sample@example.com,12\n3,  Ben   Placeholder ,,14\n');
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toEqual([
      { line: 2, name: 'Ada Sample', email: 'ada.sample@example.com' },
      { line: 3, name: 'Ben Placeholder', email: '' },
    ]);
  });

  it('reads first and last name columns', () => {
    expect(parseRosterCsv('first,last\nAda,Sample\nBen,Placeholder').candidates.map((c) => c.name)).toEqual(['Ada Sample', 'Ben Placeholder']);
  });

  it('reads a plain list with one name per line', () => {
    const parsed = parseRosterCsv('Ada Sample\nBen Placeholder\n\nCy Demo\n');
    expect(parsed.candidates.map((c) => [c.line, c.name])).toEqual([[1, 'Ada Sample'], [2, 'Ben Placeholder'], [3, 'Cy Demo']]);
  });

  it.each([
    ['an empty file', '', /empty/],
    ['only blank lines', '\n\n  \n', /empty/],
    ['several columns and no header', 'Ada,Sample,3\nBen,Placeholder,3', /no header row/],
    ['a header without a name column', 'email,period\nada@example.com,3', /no "name" column/],
    ['a header and nothing else', 'name,email\n', /no students/],
    ['a binary file', `PK${String.fromCharCode(0)}${String.fromCharCode(3)}binary`, /not look like a text file/],
    ['a file over 1 MB', 'name\n' + 'x'.repeat(1024 * 1024), /larger than 1 MB/],
    ['more rows than a class can hold', 'name\n' + Array.from({ length: 2001 }, (_, i) => `Student ${i}`).join('\n'), /more than 2000 rows/],
  ])('rejects %s without producing any students', (_name, text, message) => {
    const parsed = parseRosterCsv(text);
    expect(parsed.candidates).toEqual([]);
    expect(parsed.errors.join(' ')).toMatch(message);
  });

  it('recognizes the same student by email when both have one, otherwise by name', () => {
    expect(sameStudent({ name: 'Sam Lee', email: 'sam1@example.com' }, { name: 'Sam Lee', email: 'sam2@example.com' })).toBe(false);
    expect(sameStudent({ name: 'Samuel Lee', email: 'SAM@example.com' }, { name: 'Sam Lee', email: 'sam@example.com ' })).toBe(true);
    expect(sameStudent({ name: 'Sam  Lee', email: '' }, { name: 'sam lee', email: 'sam@example.com' })).toBe(true);
    expect(sameStudent({ name: 'Sam Lee', email: '' }, { name: 'Sam Leigh', email: '' })).toBe(false);
  });

  it('plans an import without changing anything, and explains every row it would skip', () => {
    const existing = [createStudent('Ada Sample', 'ada.sample@example.com'), createStudent('Ben Placeholder')];
    const before = clone(existing);
    const { candidates } = parseRosterCsv(
      [
        'name,email',
        'ADA SAMPLE,',                      // already here (by name)
        'A. Sample,ada.sample@example.com', // already here (by email)
        'Cy Demo,cy.demo@example.com',      // new
        'cy demo,',                         // twice in the file
        'Dee Fixture,not-an-email',         // invalid email
        ',eli@example.com',                 // no name
        'Sam Lee,sam1@example.com',         // new
        'Sam Lee,sam2@example.com',         // new: same name, different address, different person
      ].join('\n')
    );
    const plan = planRosterImport(existing, candidates);
    expect(plan.toAdd.map((c) => `${c.name}|${c.email}`)).toEqual([
      'Cy Demo|cy.demo@example.com',
      'Sam Lee|sam1@example.com',
      'Sam Lee|sam2@example.com',
    ]);
    expect(plan.skipped.map((s) => [s.candidate.line, s.reason])).toEqual([
      [2, 'already on the roster'],
      [3, 'already on the roster'],
      [5, 'listed twice in the file'],
      [6, 'the email address is not valid'],
      [7, 'no name'],
    ]);
    expect(existing).toEqual(before);
  });

  it('importing the same file twice adds nobody the second time', () => {
    const { candidates } = parseRosterCsv('name\nAda Sample\nBen Placeholder');
    const first = planRosterImport([], candidates);
    const roster = first.toAdd.map((c) => createStudent(c.name, c.email));
    expect(planRosterImport(roster, candidates).toAdd).toEqual([]);
  });
});

describe('exports', () => {
  it('spin history CSV has one row per real spin, in time order, and leaves test spins out', () => {
    const { spins } = sampleBundle('Period 3', ['Ada Sample', 'Ben Placeholder'], 3);
    spins[1] = { ...spins[1], is_test: true };
    const shuffled = [spins[2], spins[0], spins[1]];
    const rows = parseCsv(spinsToCsv(shuffled));
    expect(rows[0]).toEqual(['timestamp', 'local_date', 'local_time', 'student', 'email', 'region', 'taxon', 'iucn', 'plantae_mercy', 'veto', 'flags', 'seed', 'is_test']);
    expect(rows.slice(1).map((r) => r[0])).toEqual([spins[0].timestamp_iso, spins[2].timestamp_iso]);
    expect(rows[1].slice(3, 8)).toEqual([spins[0].student_name, spins[0].email, spins[0].result_A, spins[0].result_B, spins[0].result_C]);
    expect(rows[1][11]).toBe(spins[0].seed);
    expect(parseCsv(spinsToCsv(shuffled, { includeTests: true }))).toHaveLength(4);
  });

  it('roster CSV can be imported back into an empty class', () => {
    const { workspace } = sampleBundle();
    const plan = planRosterImport([], parseRosterCsv(rosterToCsv(workspace.students)).candidates);
    expect(plan.toAdd.map((c) => c.name)).toEqual(workspace.students.map((s) => s.name));
    expect(plan.skipped).toEqual([]);
  });
});
