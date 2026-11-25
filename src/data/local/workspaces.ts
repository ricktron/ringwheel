/**
 * Operations on Local Mode data: classes, rosters, backups, restores.
 *
 * Every destructive operation here keeps a recovery point, so it can be undone
 * from the Classes page. The recovery point is taken by the store in the same
 * all-or-nothing step as the deletion or replacement itself, and only after
 * the store has confirmed the class is still what the teacher was looking at.
 * The one exception is `clearAllData`, which is the explicit "delete
 * everything" action and removes recovery points too.
 */
import type { RosterCandidate } from './csv';
import {
  LIMITS,
  WORKSPACE_SCHEMA_VERSION,
  buildBackup,
  createStudent,
  createWorkspace,
  newId,
  type BackupFile,
  type LocalStudent,
  type Workspace,
  type WorkspaceBundle,
} from './schema';
import { stampOf, type ClassRemoval, type RecoveryPoint, type WorkspaceStore } from './store';

export const DEFAULT_WORKSPACE_NAME = 'My class';

/** The first class always gets this id, so two tabs starting at once cannot each create one. */
export const DEFAULT_WORKSPACE_ID = 'default-class';

/** Make sure at least one class exists so the app is usable on first visit. */
export async function ensureWorkspace(store: WorkspaceStore): Promise<Workspace[]> {
  const existing = await store.listWorkspaces();
  if (existing.length > 0) return existing;
  try {
    await store.createWorkspace({ ...createWorkspace(DEFAULT_WORKSPACE_NAME), id: DEFAULT_WORKSPACE_ID });
  } catch {
    // Another tab, or a second start-up pass, created it a moment ago. That one is used.
  }
  return store.listWorkspaces();
}

/** The fields a class record had before any later feature added to it. */
const ORIGINAL_FIELDS: ReadonlySet<string> = new Set([
  'id', 'schemaVersion', 'name', 'createdAt', 'updatedAt', 'rev', 'students', 'settings', 'rings', 'lastBackupAt',
]);

/**
 * True for the automatically created first class while nobody has used it:
 * no students, no spins, no settings, never renamed. Such a class holds no
 * teacher data, so a restore may take its place without asking.
 *
 * A class that holds anything beyond the original fields is never "untouched",
 * however empty its roster and history are. That covers presentation data
 * (even an empty record of it) and any field written by a newer version that
 * this one does not recognize.
 */
export function isUntouchedStarter(workspace: Workspace, spinCount: number): boolean {
  return (
    Object.keys(workspace).every((key) => ORIGINAL_FIELDS.has(key)) &&
    workspace.schemaVersion === WORKSPACE_SCHEMA_VERSION &&
    workspace.id === DEFAULT_WORKSPACE_ID &&
    workspace.rev === 1 &&
    workspace.name === DEFAULT_WORKSPACE_NAME &&
    workspace.students.length === 0 &&
    workspace.settings.length === 0 &&
    workspace.rings.length === 0 &&
    spinCount === 0
  );
}

export async function addWorkspace(store: WorkspaceStore, name: string): Promise<Workspace> {
  const workspace = createWorkspace(name);
  await store.createWorkspace(workspace);
  return workspace;
}

export async function renameWorkspace(store: WorkspaceStore, workspace: Workspace, name: string): Promise<Workspace> {
  const clean = name.trim();
  if (!clean) throw new Error('A class needs a name.');
  return store.updateWorkspace(workspace.id, workspace.rev, (current) => ({ ...current, name: clean.slice(0, 200) }));
}

export async function addStudents(store: WorkspaceStore, workspace: Workspace, entries: Pick<RosterCandidate, 'name' | 'email'>[]): Promise<Workspace> {
  const students = entries.map((entry) => createStudent(entry.name, entry.email)).filter((student) => student.name !== '');
  if (students.length === 0) throw new Error('A student needs a name.');
  return store.updateWorkspace(workspace.id, workspace.rev, (current) => ({
    ...current,
    students: [...current.students, ...students],
  }));
}

export async function updateStudent(
  store: WorkspaceStore,
  workspace: Workspace,
  studentId: string,
  changes: Partial<Pick<LocalStudent, 'name' | 'email' | 'active'>>
): Promise<Workspace> {
  if (changes.name !== undefined && changes.name.trim() === '') throw new Error('A student needs a name.');
  return store.updateWorkspace(workspace.id, workspace.rev, (current) => ({
    ...current,
    students: current.students.map((student) =>
      student.id === studentId
        ? {
            ...student,
            ...changes,
            ...(changes.name !== undefined ? { name: changes.name.trim().replace(/\s+/g, ' ') } : {}),
            ...(changes.email !== undefined ? { email: changes.email.trim() } : {}),
          }
        : student
    ),
  }));
}

/** Remove a student from the roster. Their past spins stay in the history. */
export function removeStudent(store: WorkspaceStore, workspace: Workspace, studentId: string): Promise<Workspace> {
  return store.updateWorkspace(workspace.id, workspace.rev, (current) => ({
    ...current,
    students: current.students.filter((student) => student.id !== studentId),
  }));
}

// ---------------------------------------------------------------------------
// Backup, restore, delete
// ---------------------------------------------------------------------------

/**
 * What the teacher was looking at when they pressed a button: class id to
 * `stampOf` that class. Every destructive action carries this, and the store
 * refuses the action if a class no longer matches (a spin was logged, the
 * roster was edited, the class was deleted, or a new one appeared).
 */
export type SeenClasses = Record<string, string>;

/** Read what is stored right now, in the form the destructive actions expect. */
export async function seenClasses(store: WorkspaceStore): Promise<SeenClasses> {
  const seen: SeenClasses = {};
  for (const workspace of await store.listWorkspaces()) {
    const bundle = await store.getBundle(workspace.id);
    if (bundle) seen[workspace.id] = stampOf(bundle);
  }
  return seen;
}

/**
 * Build a complete backup of the given classes (all classes when none are named).
 *
 * This only reads. It does NOT record that a backup exists: building the file
 * is not the same as the teacher having it. `confirmBackup` records that.
 */
export async function exportBackup(store: WorkspaceStore, ids?: string[], now: Date = new Date()): Promise<BackupFile> {
  // `now` is fixed before anything is read, so a change that lands while the
  // file is being built can only ever count as "not in the backup".
  const wanted = ids ?? (await store.listWorkspaces()).map((workspace) => workspace.id);
  const bundles: WorkspaceBundle[] = [];
  for (const id of wanted) {
    const bundle = await store.getBundle(id);
    if (bundle) bundles.push(bundle);
  }
  return buildBackup(bundles, now);
}

/**
 * Record that the teacher has this backup file. Call it only once they have
 * said so (or the file was read back from their disk).
 *
 * The time recorded is the time the file's contents were read, never the time
 * of confirmation, so anything that happened after the file was built still
 * shows as not backed up. A class's backup time never moves backwards.
 */
export async function confirmBackup(store: WorkspaceStore, backup: BackupFile): Promise<void> {
  for (const saved of backup.workspaces) {
    const current = await store.getBundle(saved.workspace.id);
    if (!current) continue;
    // A spin is stamped when the wheel stops and stored a moment later. One that was
    // stamped before the file was built but stored after it is not in the file, so the
    // backup time is pulled back to just before it.
    const inFile = new Set(saved.spins.map((spin) => spin.id));
    const missed = current.spins.find((spin) => !inFile.has(spin.id) && spin.timestamp_iso <= backup.exportedAt);
    const at = missed ? new Date(Date.parse(missed.timestamp_iso) - 1).toISOString() : backup.exportedAt;
    await store.markBackedUp([saved.workspace.id], at);
  }
}

// ---------------------------------------------------------------------------
// Backup size
// ---------------------------------------------------------------------------

/** The one way a backup file's text is produced. The size checks below measure exactly this. */
export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

export interface BackupMeasure {
  /** The size of the file in bytes, as it would be written. */
  bytes: number;
  /** The largest file RingWheel will restore. */
  limit: number;
  restorable: boolean;
  /** Each class as a backup of its own, so the teacher can be told which fit and which do not. */
  classes: { id: string; name: string; bytes: number; restorable: boolean }[];
}

/**
 * Measure a backup against the restore limit, using the real file text:
 * roster, settings, spin history, presentation data and all.
 */
export function measureBackup(backup: BackupFile, text: string = serializeBackup(backup)): BackupMeasure {
  const limit = LIMITS.backupBytes;
  const bytes = utf8(text);
  const classes = backup.workspaces.map((bundle) => {
    const alone = backup.workspaces.length === 1 ? bytes : utf8(serializeBackup({ ...backup, formatVersion: buildBackup([bundle]).formatVersion, workspaces: [bundle] }));
    return { id: bundle.workspace.id, name: bundle.workspace.name, bytes: alone, restorable: alone <= limit };
  });
  return { bytes, limit, restorable: bytes <= limit, classes };
}

/** Thrown instead of handing over a backup file that RingWheel itself could not restore. Nothing was changed. */
export class BackupTooLargeError extends Error {
  readonly measure: BackupMeasure;
  constructor(measure: BackupMeasure) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    const tooBig = measure.classes.filter((c) => !c.restorable);
    super(
      measure.classes.length > 1 && tooBig.length === 0
        ? `These classes together make a backup of ${mb(measure.bytes)} MB, and RingWheel can restore at most ${mb(measure.limit)} MB in one file. No file was made. Back up each class on its own instead: each one fits.`
        : `The backup of ${tooBig.map((c) => `"${c.name}"`).join(', ')} would be ${mb(tooBig[0]?.bytes ?? measure.bytes)} MB, and RingWheel can restore at most ${mb(measure.limit)} MB in one file. No file was made, because it could not be restored.`
    );
    this.name = 'BackupTooLargeError';
    this.measure = measure;
  }
}

export interface CheckedBackup {
  backup: BackupFile;
  /** The exact text to hand to the browser. */
  text: string;
  measure: BackupMeasure;
}

/**
 * Build a backup and its file text, and refuse (BackupTooLargeError) if the
 * file would be larger than RingWheel can restore. A backup is never silently
 * produced in a form that could not be brought back. Records nothing.
 */
export async function exportBackupChecked(store: WorkspaceStore, ids?: string[], now: Date = new Date()): Promise<CheckedBackup> {
  const backup = await exportBackup(store, ids, now);
  const text = serializeBackup(backup);
  const measure = measureBackup(backup, text);
  if (!measure.restorable) throw new BackupTooLargeError(measure);
  return { backup, text, measure };
}

/** Give a class and all of its spins fresh ids, so it can sit beside the original. */
function withNewIds(bundle: WorkspaceBundle, name: string): WorkspaceBundle {
  const workspaceId = newId();
  return {
    // A class that holds presentation data always has a revision above 1 (see applyPresentationChange).
    workspace: { ...bundle.workspace, id: workspaceId, name, rev: bundle.workspace.presentation ? 2 : 1 },
    // Student ids are only unique within a class, so they are kept: history keeps pointing at the right students.
    spins: bundle.spins.map((spin) => ({ ...spin, id: newId(), workspaceId })),
  };
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

const quoted = (bundles: WorkspaceBundle[]): string => bundles.map((bundle) => `"${bundle.workspace.name}"`).join(', ');

export interface RestoreSummary {
  added: string[];
  replaced: string[];
  recoveryPointId: string | null;
}

/**
 * Bring classes from a validated backup into this browser.
 *
 * mode "add" (the default, never destructive): every class in the file is
 * added. A class that already exists here is left untouched and the one from
 * the file is added beside it as a copy.
 *
 * mode "replace": a class in the file replaces the class with the same id in
 * this browser. The replaced classes go into a recovery point as part of the
 * same step. Classes in the file that do not exist here are added.
 *
 * `seen` is what the teacher was shown. If any class involved has changed
 * since (including a spin logged from another tab) the restore is refused
 * with a StoreConflictError and nothing at all is changed.
 */
export async function restoreBackup(
  store: WorkspaceStore,
  backup: BackupFile,
  mode: 'add' | 'replace',
  seen: SeenClasses,
  now: Date = new Date()
): Promise<RestoreSummary> {
  // The empty starter class is not teacher data. It steps aside for a restore.
  // Its removal is checked like any other: if it gained a student or a spin
  // since the teacher looked, the stamp no longer matches and nothing happens.
  const starter = seen[DEFAULT_WORKSPACE_ID] ? await store.getBundle(DEFAULT_WORKSPACE_ID) : null;
  const dropStarter = starter !== null && isUntouchedStarter(starter.workspace, starter.spins.length);
  const existingIds = new Set(Object.keys(seen).filter((id) => !(dropStarter && id === DEFAULT_WORKSPACE_ID)));
  const names = new Set((await store.listWorkspaces()).filter((workspace) => existingIds.has(workspace.id)).map((workspace) => workspace.name));
  const starterRemoval: ClassRemoval[] = dropStarter
    ? [{ id: DEFAULT_WORKSPACE_ID, expected: seen[DEFAULT_WORKSPACE_ID], recover: false }]
    : [];

  // The teacher is holding a file with exactly this content, so the restored classes are backed up as of that file.
  const fromFile = backup.workspaces.map((bundle) => ({
    ...bundle,
    workspace: {
      ...bundle.workspace,
      lastBackupAt:
        bundle.workspace.lastBackupAt && bundle.workspace.lastBackupAt > backup.exportedAt
          ? bundle.workspace.lastBackupAt
          : backup.exportedAt,
    },
  }));

  if (mode === 'add') {
    const bundles = fromFile.map((bundle) => {
      // A class that is not in this browser comes back exactly as it was saved.
      // One that is already here is added as a separate copy under new ids.
      if (!existingIds.has(bundle.workspace.id)) {
        names.add(bundle.workspace.name);
        return bundle;
      }
      const name = uniqueName(bundle.workspace.name, names);
      names.add(name);
      return withNewIds(bundle, name);
    });
    await store.replaceClasses({ remove: starterRemoval, put: bundles });
    return { added: bundles.map((bundle) => bundle.workspace.name), replaced: [], recoveryPointId: null };
  }

  const replaceIds = new Set(fromFile.map((bundle) => bundle.workspace.id).filter((id) => existingIds.has(id)));
  const result = await store.replaceClasses({
    remove: [...[...replaceIds].map((id) => ({ id, expected: seen[id], recover: true })), ...starterRemoval],
    put: fromFile,
    recovery: { id: newId(), takenAt: now.toISOString(), describe: (replaced) => `Before restoring a backup over ${quoted(replaced)}` },
  });
  return {
    added: fromFile.filter((bundle) => !replaceIds.has(bundle.workspace.id)).map((bundle) => bundle.workspace.name),
    replaced: (result.recoveryPoint?.bundles ?? []).map((bundle) => bundle.workspace.name),
    recoveryPointId: result.recoveryPoint?.id ?? null,
  };
}

/**
 * Delete one class. The recovery copy is taken in the same step as the
 * deletion, from the class as it is at that instant.
 *
 * `expected` is `stampOf` the class as the teacher last saw it. If the class
 * has changed since, nothing is deleted and a StoreConflictError is thrown.
 */
export async function deleteWorkspace(store: WorkspaceStore, id: string, expected: string, now: Date = new Date()): Promise<RecoveryPoint | null> {
  const result = await store.replaceClasses({
    remove: [{ id, expected, recover: true }],
    put: [],
    recovery: { id: newId(), takenAt: now.toISOString(), describe: (deleted) => `Before deleting ${quoted(deleted)}` },
  });
  return result.recoveryPoint;
}

/**
 * Put the classes of a recovery point back. A class that still exists under
 * the same id goes into a new recovery point in the same step, so undoing is
 * also undoable. Refused, with nothing changed, if any class involved is no
 * longer what the teacher was shown or the recovery point has already been used.
 */
export async function applyRecoveryPoint(store: WorkspaceStore, point: RecoveryPoint, seen: SeenClasses, now: Date = new Date()): Promise<void> {
  const replaceIds = point.bundles.map((bundle) => bundle.workspace.id).filter((id) => id in seen);
  await store.replaceClasses({
    remove: replaceIds.map((id) => ({ id, expected: seen[id], recover: true })),
    put: point.bundles,
    recovery: { id: newId(), takenAt: now.toISOString(), describe: () => `Before undoing: ${point.reason.replace(/^Before /, '')}` },
    consumeRecoveryPointId: point.id,
  });
}

/**
 * The explicit "delete everything in this browser" action. Not undoable, so it
 * is refused if the classes are not exactly those the teacher was shown.
 */
export function clearAllData(store: WorkspaceStore, seen: SeenClasses): Promise<void> {
  return store.clearAll(seen);
}

// ---------------------------------------------------------------------------
// Backup status
// ---------------------------------------------------------------------------

export interface BackupStatus {
  /** never: no confirmed backup. current: nothing changed since the last confirmed one. stale: there are changes not in any confirmed backup. */
  state: 'never' | 'current' | 'stale';
  lastBackupAt: string | null;
  /** Spins logged after the last backup. */
  spinsSince: number;
  rosterChangedSince: boolean;
  /** Present only for a class that holds presentation data: whether it changed after the last backup. */
  presentationChangedSince?: boolean;
}

export function backupStatus(bundle: WorkspaceBundle): BackupStatus {
  const { workspace, spins } = bundle;
  const presentation = workspace.presentation;
  if (!workspace.lastBackupAt) {
    return { state: 'never', lastBackupAt: null, spinsSince: spins.length, rosterChangedSince: true, ...(presentation ? { presentationChangedSince: true } : {}) };
  }
  const since = workspace.lastBackupAt;
  const spinsSince = spins.filter((spin) => spin.timestamp_iso > since).length;
  const rosterChangedSince = workspace.updatedAt > since;
  const presentationChangedSince = presentation ? presentation.updatedAt > since : false;
  return {
    state: spinsSince > 0 || rosterChangedSince || presentationChangedSince ? 'stale' : 'current',
    lastBackupAt: since,
    spinsSince,
    rosterChangedSince,
    ...(presentation ? { presentationChangedSince } : {}),
  };
}

const daysAgo = (iso: string): string => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

/**
 * One-line, plain-language backup status for a class.
 * "Confirmed" means the teacher said they have the file, or the class was
 * restored from one. RingWheel cannot see the downloads folder.
 */
export function describeBackup(status: BackupStatus): string {
  if (status.state === 'never') return 'No confirmed backup';
  if (status.state === 'current') return `Last confirmed backup: ${daysAgo(status.lastBackupAt as string)}`;
  const parts = [
    status.spinsSince > 0 ? `${status.spinsSince} spin${status.spinsSince === 1 ? '' : 's'}` : '',
    status.rosterChangedSince ? 'roster or settings changes' : '',
    status.presentationChangedSince ? 'presentation changes' : '',
  ].filter(Boolean);
  return `Not in a confirmed backup: ${parts.join(' and ')}`;
}
