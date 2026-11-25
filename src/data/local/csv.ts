/**
 * CSV reading and writing for Local Mode. Pure functions, no storage, no network.
 */
import { LIMITS, type LocalSpin, type LocalStudent } from './schema';

/** Parse CSV text into rows of cells. Handles quotes, embedded commas and newlines, CRLF, and a BOM. */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Write one CSV cell. Text that a spreadsheet would run as a formula is
 * prefixed with an apostrophe so opening the export can never execute anything.
 */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Roster import
// ---------------------------------------------------------------------------

export interface RosterCandidate {
  /** Line in the file, counting the header as line 1. */
  line: number;
  name: string;
  email: string;
}

export interface RosterParse {
  candidates: RosterCandidate[];
  /** Reasons the file as a whole cannot be used. When non-empty there are no candidates. */
  errors: string[];
}

const HEADER_ALIASES: Record<string, 'name' | 'first' | 'last' | 'email'> = {
  name: 'name',
  student: 'name',
  'student name': 'name',
  'full name': 'name',
  first: 'first',
  'first name': 'first',
  firstname: 'first',
  last: 'last',
  'last name': 'last',
  lastname: 'last',
  email: 'email',
  'e-mail': 'email',
  'email address': 'email',
};

const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ');

/**
 * Read a roster from CSV text.
 *
 * Accepted layouts:
 * - a header row with `name`, or `first` and `last`, and optionally `email`
 * - no header and a single column of names
 * Other columns are ignored. Nothing is read unless the layout is understood.
 */
export function parseRosterCsv(text: string): RosterParse {
  if (text.length > 1024 * 1024) return { candidates: [], errors: ['The file is larger than 1 MB. A class roster should be much smaller.'] };
  if (text.indexOf(String.fromCharCode(0)) !== -1) return { candidates: [], errors: ['This does not look like a text file.'] };

  const rows = parseCsv(text);
  if (rows.length === 0) return { candidates: [], errors: ['The file is empty.'] };
  if (rows.length > LIMITS.studentsPerWorkspace + 1) {
    return { candidates: [], errors: [`The file has more than ${LIMITS.studentsPerWorkspace} rows.`] };
  }

  const header = rows[0].map((cell) => HEADER_ALIASES[tidy(cell).toLowerCase()]);
  const column = (kind: 'name' | 'first' | 'last' | 'email') => header.indexOf(kind);
  const hasHeader = header.some(Boolean);

  let read: (row: string[]) => { name: string; email: string };
  if (hasHeader) {
    if (column('name') === -1 && column('first') === -1 && column('last') === -1) {
      return { candidates: [], errors: ['The header row has no "name" column (or "first" and "last" columns).'] };
    }
    read = (row) => ({
      name:
        column('name') !== -1
          ? tidy(row[column('name')] ?? '')
          : tidy(`${row[column('first')] ?? ''} ${row[column('last')] ?? ''}`),
      email: column('email') !== -1 ? tidy(row[column('email')] ?? '') : '',
    });
  } else if (rows.every((row) => row.length === 1)) {
    read = (row) => ({ name: tidy(row[0]), email: '' });
  } else {
    return {
      candidates: [],
      errors: ['The file has several columns but no header row. Add a first row such as: name,email'],
    };
  }

  const candidates: RosterCandidate[] = [];
  rows.slice(hasHeader ? 1 : 0).forEach((row, index) => {
    const { name, email } = read(row);
    candidates.push({
      line: index + (hasHeader ? 2 : 1),
      name: name.slice(0, LIMITS.nameLength),
      email: email.slice(0, LIMITS.nameLength),
    });
  });
  if (candidates.length === 0) return { candidates: [], errors: ['The file has a header row but no students.'] };
  return { candidates, errors: [] };
}

export interface RosterImportPlan {
  toAdd: RosterCandidate[];
  skipped: { candidate: RosterCandidate; reason: string }[];
}

const nameKey = (name: string): string => tidy(name).toLowerCase();
const emailKey = (email: string): string => email.trim().toLowerCase();

/**
 * Whether two roster entries are the same student.
 * When both have an email address, the addresses decide: two students who
 * share a name but have different addresses are different people. When either
 * has no address, the name decides.
 */
export function sameStudent(a: { name: string; email: string }, b: { name: string; email: string }): boolean {
  if (emailKey(a.email) && emailKey(b.email)) return emailKey(a.email) === emailKey(b.email);
  return nameKey(a.name) === nameKey(b.name);
}

/**
 * Decide what an import would do, without doing it.
 * A student already on the roster, or listed twice in the file, is skipped
 * and reported so the teacher sees exactly what will change before confirming.
 */
export function planRosterImport(existing: LocalStudent[], candidates: RosterCandidate[]): RosterImportPlan {
  const plan: RosterImportPlan = { toAdd: [], skipped: [] };
  for (const candidate of candidates) {
    if (!candidate.name) {
      plan.skipped.push({ candidate, reason: 'no name' });
    } else if (candidate.email && !/^[^\s@]+@[^\s@]+$/.test(candidate.email)) {
      plan.skipped.push({ candidate, reason: 'the email address is not valid' });
    } else if (existing.some((student) => sameStudent(student, candidate))) {
      plan.skipped.push({ candidate, reason: 'already on the roster' });
    } else if (plan.toAdd.some((earlier) => sameStudent(earlier, candidate))) {
      plan.skipped.push({ candidate, reason: 'listed twice in the file' });
    } else {
      plan.toAdd.push(candidate);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const flagsOf = (spin: LocalSpin): string => {
  try {
    const flags = JSON.parse(spin.rule_flags_json);
    return Array.isArray(flags) ? flags.join(' ') : '';
  } catch {
    return '';
  }
};

/** Spin history as an ordinary spreadsheet. Test spins are left out unless asked for. */
export function spinsToCsv(spins: LocalSpin[], { includeTests = false }: { includeTests?: boolean } = {}): string {
  const rows: unknown[][] = [
    ['timestamp', 'local_date', 'local_time', 'student', 'email', 'region', 'taxon', 'iucn', 'plantae_mercy', 'veto', 'flags', 'seed', 'is_test'],
  ];
  const ordered = [...spins].sort((a, b) => a.timestamp_iso.localeCompare(b.timestamp_iso));
  for (const spin of ordered) {
    if (spin.is_test && !includeTests) continue;
    const when = new Date(spin.timestamp_iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    rows.push([
      spin.timestamp_iso,
      `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
      `${pad(when.getHours())}:${pad(when.getMinutes())}`,
      spin.student_name,
      spin.email,
      spin.result_A,
      spin.result_B,
      spin.result_C,
      spin.plantae_mercy ? 'yes' : 'no',
      spin.veto_used ? 'yes' : 'no',
      flagsOf(spin),
      spin.seed,
      spin.is_test ? 'yes' : 'no',
    ]);
  }
  return toCsv(rows);
}

export function rosterToCsv(students: LocalStudent[]): string {
  return toCsv([['name', 'email', 'active'], ...students.map((s) => [s.name, s.email, s.active ? 'yes' : 'no'])]);
}
