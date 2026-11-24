/**
 * Operations on Local Mode data: classes, rosters, backups, restores.
 *
 * Every destructive operation here first stores a recovery point, so it can be
 * undone from the Classes page. The one exception is `clearAllData`, which is
 * the explicit "delete everything" action and removes recovery points too.
 */
import type { RosterCandidate } from './csv';
import {
  buildBackup,
  createStudent,
  createWorkspace,
  newId,
  type BackupFile,
  type LocalStudent,
  type Workspace,
  type WorkspaceBundle,
} from './schema';
import type { RecoveryPoint, WorkspaceStore } from './store';

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

/**
 * True for the automatically created first class while nobody has used it:
 * no students, no spins, no settings, never renamed. Such a class holds no
 * teacher data, so a restore may take its place without asking.
 */
export function isUntouchedStarter(workspace: Workspace, spinCount: number): boolean {
  return (
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

async function bundlesFor(store: WorkspaceStore, ids: string[]): Promise<WorkspaceBundle[]> {
  const bundles: WorkspaceBundle[] = [];
  for (const id of ids) {
    const bundle = await store.getBundle(id);
    if (bundle) bundles.push(bundle);
  }
  return bundles;
}

/**
 * Build a complete backup of the given classes (all classes when none are named)
 * and record that they were backed up.
 */
export async function exportBackup(store: WorkspaceStore, ids?: string[], now: Date = new Date()): Promise<BackupFile> {
  const wanted = ids ?? (await store.listWorkspaces()).map((workspace) => workspace.id);
  const stamp = now.toISOString();
  await store.markBackedUp(wanted, stamp);
  return buildBackup(await bundlesFor(store, wanted), now);
}

async function saveRecoveryPoint(store: WorkspaceStore, reason: string, bundles: WorkspaceBundle[], now: Date): Promise<RecoveryPoint | null> {
  if (bundles.length === 0) return null;
  const point: RecoveryPoint = { id: newId(), takenAt: now.toISOString(), reason, bundles };
  await store.addRecoveryPoint(point);
  return point;
}

/** Give a class and all of its spins fresh ids, so it can sit beside the original. */
function withNewIds(bundle: WorkspaceBundle, name: string): WorkspaceBundle {
  const workspaceId = newId();
  return {
    workspace: { ...bundle.workspace, id: workspaceId, name, rev: 1 },
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
 * this browser. A recovery point holding the replaced classes is stored first.
 * Classes in the file that do not exist here are added.
 */
export async function restoreBackup(
  store: WorkspaceStore,
  backup: BackupFile,
  mode: 'add' | 'replace',
  now: Date = new Date()
): Promise<RestoreSummary> {
  const all = await store.listWorkspaces();
  // The empty starter class is not teacher data. It steps aside for a restore.
  const starter = all.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID);
  const starterIsUntouched = starter ? isUntouchedStarter(starter, (await store.listSpins(starter.id)).length) : false;
  const existing = starterIsUntouched ? all.filter((workspace) => workspace.id !== DEFAULT_WORKSPACE_ID) : all;
  const drop = starterIsUntouched ? [DEFAULT_WORKSPACE_ID] : [];
  const existingIds = new Set(existing.map((workspace) => workspace.id));
  const names = new Set(existing.map((workspace) => workspace.name));

  if (mode === 'add') {
    const bundles = backup.workspaces.map((bundle) => {
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
    await store.putBundles(bundles, { replace: drop });
    return { added: bundles.map((bundle) => bundle.workspace.name), replaced: [], recoveryPointId: null };
  }

  const replaceIds = backup.workspaces.map((bundle) => bundle.workspace.id).filter((id) => existingIds.has(id));
  const replacedBundles = await bundlesFor(store, replaceIds);
  const point = await saveRecoveryPoint(
    store,
    `Before restoring a backup over ${replacedBundles.map((bundle) => `"${bundle.workspace.name}"`).join(', ')}`,
    replacedBundles,
    now
  );
  await store.putBundles(backup.workspaces, { replace: [...replaceIds, ...drop] });
  return {
    added: backup.workspaces.filter((bundle) => !existingIds.has(bundle.workspace.id)).map((bundle) => bundle.workspace.name),
    replaced: replacedBundles.map((bundle) => bundle.workspace.name),
    recoveryPointId: point?.id ?? null,
  };
}

/** Delete one class. A recovery point is stored first. */
export async function deleteWorkspace(store: WorkspaceStore, id: string, now: Date = new Date()): Promise<RecoveryPoint | null> {
  const bundles = await bundlesFor(store, [id]);
  const point = await saveRecoveryPoint(store, `Before deleting "${bundles[0]?.workspace.name ?? 'a class'}"`, bundles, now);
  await store.deleteWorkspace(id);
  return point;
}

/**
 * Put the classes of a recovery point back. A class that still exists under
 * the same id is itself saved to a new recovery point first, so undoing is
 * also undoable.
 */
export async function applyRecoveryPoint(store: WorkspaceStore, point: RecoveryPoint, now: Date = new Date()): Promise<void> {
  const existingIds = new Set((await store.listWorkspaces()).map((workspace) => workspace.id));
  const replaceIds = point.bundles.map((bundle) => bundle.workspace.id).filter((id) => existingIds.has(id));
  const current = await bundlesFor(store, replaceIds);
  await saveRecoveryPoint(store, `Before undoing: ${point.reason.replace(/^Before /, '')}`, current, now);
  await store.putBundles(point.bundles, { replace: replaceIds });
  await store.deleteRecoveryPoint(point.id);
}

/** The explicit "delete everything in this browser" action. Not undoable. */
export function clearAllData(store: WorkspaceStore): Promise<void> {
  return store.clearAll();
}

// ---------------------------------------------------------------------------
// Backup status
// ---------------------------------------------------------------------------

export interface BackupStatus {
  /** never: no backup exists. current: nothing changed since. stale: there are changes not in any backup. */
  state: 'never' | 'current' | 'stale';
  lastBackupAt: string | null;
  /** Spins logged after the last backup. */
  spinsSince: number;
  rosterChangedSince: boolean;
}

export function backupStatus(bundle: WorkspaceBundle): BackupStatus {
  const { workspace, spins } = bundle;
  if (!workspace.lastBackupAt) {
    return { state: 'never', lastBackupAt: null, spinsSince: spins.length, rosterChangedSince: true };
  }
  const since = workspace.lastBackupAt;
  const spinsSince = spins.filter((spin) => spin.timestamp_iso > since).length;
  const rosterChangedSince = workspace.updatedAt > since;
  return {
    state: spinsSince > 0 || rosterChangedSince ? 'stale' : 'current',
    lastBackupAt: since,
    spinsSince,
    rosterChangedSince,
  };
}

const daysAgo = (iso: string): string => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

/** One-line, plain-language backup status for a class. */
export function describeBackup(status: BackupStatus): string {
  if (status.state === 'never') return 'Never backed up';
  if (status.state === 'current') return `Backed up ${daysAgo(status.lastBackupAt as string)}`;
  const parts = [
    status.spinsSince > 0 ? `${status.spinsSince} spin${status.spinsSince === 1 ? '' : 's'}` : '',
    status.rosterChangedSince ? 'roster or settings changes' : '',
  ].filter(Boolean);
  return `Not in a backup yet: ${parts.join(' and ')}`;
}
