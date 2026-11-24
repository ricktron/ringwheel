/**
 * Local Mode data model.
 *
 * Everything a class needs lives in a "workspace" stored in this browser. One
 * workspace is one class. Workspaces never share students or history.
 *
 * The schema is versioned. Any change to these shapes must bump
 * WORKSPACE_SCHEMA_VERSION and add a step to `migrateWorkspace`, so data
 * written by an older version is upgraded instead of lost.
 *
 * Nothing in this file touches storage or the network. It only describes and
 * checks data.
 */
import type { RingSlice, SettingRow, SpinsLogPayload } from '../../types';

export const WORKSPACE_SCHEMA_VERSION = 1;
export const BACKUP_FORMAT = 'ringwheel-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Guards against a mistaken or hostile import filling the browser's storage. */
export const LIMITS = {
  workspacesPerBackup: 200,
  studentsPerWorkspace: 2000,
  spinsPerWorkspace: 100000,
  nameLength: 200,
  backupBytes: 25 * 1024 * 1024,
} as const;

export interface LocalStudent {
  /** Stable within its workspace. Never reused, never derived from the name. */
  id: string;
  name: string;
  /** Optional. Used only to recognize the same student on a later import. */
  email: string;
  /** False keeps the student on the roster but out of the spin queue. */
  active: boolean;
  createdAt: string;
}

/** One logged spin. The same fields as a SpinsLog sheet row, plus local identifiers. */
export interface LocalSpin extends SpinsLogPayload {
  id: string;
  workspaceId: string;
  /** The roster student this spin belongs to, or null when nobody was selected. */
  studentId: string | null;
}

export interface Workspace {
  id: string;
  schemaVersion: number;
  name: string;
  createdAt: string;
  /** Last change to the roster, settings or name. */
  updatedAt: string;
  /** Increases on every roster or settings change. Used to detect a competing edit from another tab. */
  rev: number;
  students: LocalStudent[];
  /** Same row shape as the Settings sheet, so both modes share one settings parser. */
  settings: SettingRow[];
  /** Same row shape as the Rings sheet. */
  rings: RingSlice[];
  /** When this workspace was last written to a backup file, or null if never. */
  lastBackupAt: string | null;
}

export interface WorkspaceBundle {
  workspace: Workspace;
  spins: LocalSpin[];
}

/** The complete, portable backup file. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  exportedAt: string;
  workspaces: WorkspaceBundle[];
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createWorkspace(name: string, now: Date = new Date()): Workspace {
  const stamp = now.toISOString();
  return {
    id: newId(),
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: name.trim().slice(0, LIMITS.nameLength) || 'My class',
    createdAt: stamp,
    updatedAt: stamp,
    rev: 1,
    students: [],
    settings: [],
    rings: [],
    lastBackupAt: null,
  };
}

export function createStudent(name: string, email = '', now: Date = new Date()): LocalStudent {
  return {
    id: newId(),
    name: name.trim().replace(/\s+/g, ' ').slice(0, LIMITS.nameLength),
    email: email.trim().slice(0, LIMITS.nameLength),
    active: true,
    createdAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown, max = 5000): value is string => typeof value === 'string' && value.length <= max;
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

class Problems {
  readonly list: string[] = [];
  add(message: string) {
    // Keep the report readable even for a badly broken file.
    if (this.list.length < 20) this.list.push(message);
  }
}

function checkStudent(value: unknown, where: string, problems: Problems): LocalStudent | null {
  if (!isRecord(value)) {
    problems.add(`${where} is not an object.`);
    return null;
  }
  if (!isId(value.id)) problems.add(`${where} has no valid id.`);
  if (!isText(value.name, LIMITS.nameLength) || value.name.trim() === '') problems.add(`${where} has no name.`);
  if (value.email !== undefined && !isText(value.email, LIMITS.nameLength)) problems.add(`${where} has an invalid email.`);
  if (value.active !== undefined && typeof value.active !== 'boolean') problems.add(`${where} has an invalid active flag.`);
  if (value.createdAt !== undefined && !isIsoDate(value.createdAt)) problems.add(`${where} has an invalid date.`);
  return {
    id: String(value.id),
    name: String(value.name),
    email: typeof value.email === 'string' ? value.email : '',
    active: value.active !== false,
    createdAt: isIsoDate(value.createdAt) ? value.createdAt : new Date(0).toISOString(),
  };
}

const SPIN_TEXT_FIELDS = [
  'timestamp_iso', 'session_id', 'period', 'student_name', 'email',
  'result_A', 'result_B', 'result_C', 'seed', 'rule_flags_json',
] as const;
const SPIN_BOOLEAN_FIELDS = ['plantae_mercy', 'veto_used', 'is_test'] as const;

function checkSpin(value: unknown, where: string, workspaceId: string, studentIds: Set<string>, problems: Problems): LocalSpin | null {
  if (!isRecord(value)) {
    problems.add(`${where} is not an object.`);
    return null;
  }
  if (!isId(value.id)) problems.add(`${where} has no valid id.`);
  if (value.workspaceId !== workspaceId) problems.add(`${where} belongs to a different class.`);
  for (const field of SPIN_TEXT_FIELDS) {
    if (!isText(value[field])) problems.add(`${where} has an invalid ${field}.`);
  }
  for (const field of SPIN_BOOLEAN_FIELDS) {
    if (typeof value[field] !== 'boolean') problems.add(`${where} has an invalid ${field}.`);
  }
  if (!isIsoDate(value.timestamp_iso)) problems.add(`${where} has an invalid timestamp.`);
  for (const field of ['result_A', 'result_B', 'result_C'] as const) {
    if (value[field] === '') problems.add(`${where} has an empty ${field}.`);
  }
  if (typeof value.rule_flags_json === 'string') {
    try {
      if (!Array.isArray(JSON.parse(value.rule_flags_json))) problems.add(`${where} has rule flags that are not a list.`);
    } catch {
      problems.add(`${where} has unreadable rule flags.`);
    }
  }
  if (value.studentId !== null && !isId(value.studentId)) problems.add(`${where} has an invalid student reference.`);
  // A spin may refer to a student who was later removed from the roster. That is allowed:
  // history outlives roster changes. `studentIds` is accepted for future stricter checks.
  void studentIds;

  const spin = { id: String(value.id), workspaceId, studentId: (value.studentId as string | null) ?? null } as LocalSpin;
  for (const field of SPIN_TEXT_FIELDS) spin[field] = String(value[field] ?? '');
  for (const field of SPIN_BOOLEAN_FIELDS) spin[field] = value[field] === true;
  return spin;
}

function checkRows(value: unknown, where: string, problems: Problems): Rec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000 || value.some((row) => !isRecord(row))) {
    problems.add(`${where} is not a list of rows.`);
    return [];
  }
  return value as Rec[];
}

/**
 * Bring a workspace written by an older schema up to the current one.
 * There is only one version so far, so this is where the next change goes.
 */
export function migrateWorkspace(raw: Rec): Rec {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
  const migrated = { ...raw };
  // if (version < 2) { ...upgrade fields...; }
  migrated.schemaVersion = Math.max(version, WORKSPACE_SCHEMA_VERSION);
  return migrated;
}

function checkBundle(value: unknown, index: number, problems: Problems): WorkspaceBundle | null {
  const where = `Class ${index + 1}`;
  if (!isRecord(value) || !isRecord(value.workspace)) {
    problems.add(`${where} is missing its class record.`);
    return null;
  }
  if (typeof value.workspace.schemaVersion === 'number' && value.workspace.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    problems.add(`${where} was saved by a newer version of RingWheel and cannot be opened by this one.`);
    return null;
  }
  const raw = migrateWorkspace(value.workspace);

  if (!isId(raw.id)) problems.add(`${where} has no valid id.`);
  if (!isText(raw.name, LIMITS.nameLength) || raw.name.trim() === '') problems.add(`${where} has no name.`);
  if (!isIsoDate(raw.createdAt)) problems.add(`${where} has an invalid creation date.`);
  if (!isIsoDate(raw.updatedAt)) problems.add(`${where} has an invalid update date.`);
  if (typeof raw.rev !== 'number' || !Number.isInteger(raw.rev) || raw.rev < 1) problems.add(`${where} has an invalid revision.`);
  if (raw.lastBackupAt !== null && raw.lastBackupAt !== undefined && !isIsoDate(raw.lastBackupAt)) {
    problems.add(`${where} has an invalid backup date.`);
  }

  const rawStudents = Array.isArray(raw.students) ? raw.students : null;
  if (!rawStudents) problems.add(`${where} has no student list.`);
  if (rawStudents && rawStudents.length > LIMITS.studentsPerWorkspace) problems.add(`${where} has too many students.`);
  const students: LocalStudent[] = [];
  const studentIds = new Set<string>();
  (rawStudents ?? []).slice(0, LIMITS.studentsPerWorkspace).forEach((student, i) => {
    const checked = checkStudent(student, `${where}, student ${i + 1}`, problems);
    if (!checked) return;
    if (studentIds.has(checked.id)) problems.add(`${where} lists the student id ${checked.id} twice.`);
    studentIds.add(checked.id);
    students.push(checked);
  });

  const rawSpins = Array.isArray(value.spins) ? value.spins : null;
  if (!rawSpins) problems.add(`${where} has no spin history list.`);
  if (rawSpins && rawSpins.length > LIMITS.spinsPerWorkspace) problems.add(`${where} has too many spins.`);
  const spins: LocalSpin[] = [];
  const spinIds = new Set<string>();
  (rawSpins ?? []).slice(0, LIMITS.spinsPerWorkspace).forEach((spin, i) => {
    const checked = checkSpin(spin, `${where}, spin ${i + 1}`, String(raw.id), studentIds, problems);
    if (!checked) return;
    if (spinIds.has(checked.id)) problems.add(`${where} lists the spin id ${checked.id} twice.`);
    spinIds.add(checked.id);
    spins.push(checked);
  });

  const workspace: Workspace = {
    id: String(raw.id),
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: String(raw.name ?? ''),
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
    rev: typeof raw.rev === 'number' ? raw.rev : 1,
    students,
    settings: checkRows(raw.settings, `${where} settings`, problems) as unknown as SettingRow[],
    rings: checkRows(raw.rings, `${where} ring weights`, problems) as unknown as RingSlice[],
    lastBackupAt: isIsoDate(raw.lastBackupAt) ? raw.lastBackupAt : null,
  };
  return { workspace, spins };
}

export type BackupCheck = { ok: true; backup: BackupFile } | { ok: false; errors: string[] };

/**
 * Check a parsed backup file from top to bottom.
 * Nothing is accepted in part: one problem anywhere rejects the whole file,
 * so a restore can never leave a class half imported.
 */
export function validateBackup(data: unknown): BackupCheck {
  const problems = new Problems();
  if (!isRecord(data) || data.format !== BACKUP_FORMAT) {
    return { ok: false, errors: ['This is not a RingWheel backup file.'] };
  }
  if (typeof data.formatVersion !== 'number' || data.formatVersion < 1) {
    return { ok: false, errors: ['The backup file does not say which version it is.'] };
  }
  if (data.formatVersion > BACKUP_FORMAT_VERSION) {
    return { ok: false, errors: ['This backup was made by a newer version of RingWheel and cannot be opened by this one.'] };
  }
  if (!isIsoDate(data.exportedAt)) problems.add('The backup file has no valid export date.');
  if (!Array.isArray(data.workspaces) || data.workspaces.length === 0) {
    return { ok: false, errors: ['The backup file contains no classes.'] };
  }
  if (data.workspaces.length > LIMITS.workspacesPerBackup) {
    return { ok: false, errors: ['The backup file contains too many classes.'] };
  }

  const bundles: WorkspaceBundle[] = [];
  const ids = new Set<string>();
  data.workspaces.forEach((entry, index) => {
    const bundle = checkBundle(entry, index, problems);
    if (!bundle) return;
    if (ids.has(bundle.workspace.id)) problems.add(`The class id ${bundle.workspace.id} appears twice in the file.`);
    ids.add(bundle.workspace.id);
    bundles.push(bundle);
  });

  if (problems.list.length > 0) return { ok: false, errors: problems.list };
  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: String(data.exportedAt),
      workspaces: bundles,
    },
  };
}

/** Parse and check the text of a backup file. Never throws. */
export function parseBackupText(text: string): BackupCheck {
  if (text.length > LIMITS.backupBytes) {
    return { ok: false, errors: ['The file is too large to be a RingWheel backup.'] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['The file is not valid JSON. It may be damaged or cut short.'] };
  }
  return validateBackup(data);
}

export function buildBackup(bundles: WorkspaceBundle[], now: Date = new Date()): BackupFile {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    workspaces: bundles,
  };
}
