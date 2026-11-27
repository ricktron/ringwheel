// FROZEN COPY. Do not edit.
// This is src/data/local/store.ts exactly as it was at main a7858559f2878a27534115176d6303583f7380bb,
// the build that shipped before Presentation Draw. It is used only by tests, to prove that the
// older site still handles data written by the newer one. The app never imports it.
/**
 * Storage contract for Local Mode, plus an in-memory implementation.
 *
 * The real storage is IndexedDB (see idb-store.ts). The in-memory store is
 * used by tests and as a visible fallback when a browser refuses to store
 * data (some private windows do). Both must behave identically; the same
 * contract tests run against each.
 *
 * Rules every store follows:
 * - Spin history is append-only. There is no call that edits a spin.
 * - A workspace edit only succeeds on top of the revision it was based on.
 * - Multi-record operations (import, replace, delete, clear) are all-or-nothing.
 * - Anything that removes or replaces a class goes through `replaceClasses`.
 *   It checks that the class is still exactly what the teacher was looking at
 *   (roster, settings AND spin history), takes the recovery copy, and makes
 *   the change, all in one step. There is no moment in between in which
 *   another tab's spin or roster edit could be lost.
 */
import { LIMITS, type LocalSpin, type Workspace, type WorkspaceBundle } from './schema';

export class StoreConflictError extends Error {
  constructor(message = 'This class was changed in another tab or window. Reload to see the current version, then try again.') {
    super(message);
    this.name = 'StoreConflictError';
  }
}

const STALE =
  'changed in another tab or window after this page last showed it. Nothing was deleted or replaced. The page now shows the current version: check it, then try again.';

export class StoreMissingError extends Error {
  constructor(what = 'That class') {
    super(`${what} no longer exists in this browser.`);
    this.name = 'StoreMissingError';
  }
}

/** A copy of data taken just before a destructive action, so the action can be undone. */
export interface RecoveryPoint {
  id: string;
  takenAt: string;
  /** Plain description shown to the teacher, for example: Before restoring a backup over "Period 3". */
  reason: string;
  bundles: WorkspaceBundle[];
}

export const MAX_RECOVERY_POINTS = 5;

/** cyrb53: a fast, well-distributed 53-bit string hash. Not for security, only to notice change. */
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A short fingerprint of everything in a class that a destructive action could lose.
 *
 * It changes when the roster, settings or name change (the revision moves) AND
 * when a spin is added (the count and the set of spin ids move). The revision
 * alone would miss a spin logged from another tab, which is why it is not used
 * on its own.
 */
export function stampOf(bundle: WorkspaceBundle): string {
  const ids = bundle.spins.map((spin) => spin.id).sort();
  return `${bundle.workspace.rev}|${bundle.workspace.updatedAt}|${ids.length}|${digest(ids.join(','))}`;
}

export interface ClassRemoval {
  id: string;
  /** `stampOf` the class as the teacher last saw it. The removal is refused if the class no longer matches. */
  expected: string;
  /** Keep a copy of the removed class in the recovery point. */
  recover: boolean;
}

/** One all-or-nothing change that removes and/or writes whole classes. */
export interface ClassChange {
  remove: ClassRemoval[];
  /** Classes to write. An id listed under `remove` replaces that class; any other id must be free. */
  put: WorkspaceBundle[];
  /** When given, the removed classes marked `recover` are stored as a recovery point as part of the same change. */
  recovery?: { id: string; takenAt: string; describe: (recovered: WorkspaceBundle[]) => string };
  /** A recovery point this change uses up (undo). It must still exist, and is deleted as part of the change. */
  consumeRecoveryPointId?: string;
}

export interface ClassChangeResult {
  /** The classes exactly as they were at the moment they were removed. */
  removed: WorkspaceBundle[];
  recoveryPoint: RecoveryPoint | null;
}

export interface ClassChangePlan extends ClassChangeResult {
  /** `change.put`, with the revision moved above the replaced class's wherever it was not already. */
  put: WorkspaceBundle[];
}

/**
 * Decide whether a class change may go ahead and exactly what it writes.
 * Both stores call this from inside their atomic section, with what the
 * storage holds at that instant, so the rules cannot drift between them.
 *
 * @param current   the classes named in `change.remove` that exist right now
 * @param occupied  ids from `change.put` that exist right now
 * @param recoveryPointExists  whether `consumeRecoveryPointId` still exists
 */
export function planClassChange(
  change: ClassChange,
  current: Map<string, WorkspaceBundle>,
  occupied: Set<string>,
  recoveryPointExists: boolean
): ClassChangePlan {
  const removing = new Set<string>();
  const removed: WorkspaceBundle[] = [];
  for (const removal of change.remove) {
    if (removing.has(removal.id)) throw new Error('The same class is listed twice.');
    removing.add(removal.id);
    const bundle = current.get(removal.id);
    if (!bundle) {
      throw new StoreConflictError(`A class was deleted in another tab or window after this page last showed it. Nothing was changed. The page now shows the current version.`);
    }
    if (stampOf(bundle) !== removal.expected) {
      throw new StoreConflictError(`"${bundle.workspace.name}" ${STALE}`);
    }
    removed.push(bundle);
  }

  if (change.consumeRecoveryPointId && !recoveryPointExists) {
    throw new StoreConflictError('That recovery copy was already used or discarded in another tab or window. Nothing was changed.');
  }

  const putting = new Set<string>();
  const put = change.put.map((bundle) => {
    const { id } = bundle.workspace;
    if (putting.has(id)) throw new Error('The same class appears twice.');
    putting.add(id);
    if (!removing.has(id)) {
      if (occupied.has(id)) {
        throw new StoreConflictError(`A class named "${bundle.workspace.name}" appeared in another tab or window after this page last showed your classes. Nothing was changed. The page now shows the current version: check it, then try again.`);
      }
      return bundle;
    }
    // A class that takes the place of another is a new state of that class. Its revision must
    // end up above the one it replaces, so a tab that still holds the old state cannot edit over
    // it. A revision that is already higher is kept as it is, so a restore stays an exact copy.
    const replaced = current.get(id) as WorkspaceBundle;
    const rev = bundle.workspace.rev > replaced.workspace.rev ? bundle.workspace.rev : replaced.workspace.rev + 1;
    return { ...bundle, workspace: { ...bundle.workspace, rev } };
  });

  const recovered = removed.filter((bundle) => change.remove.find((removal) => removal.id === bundle.workspace.id)?.recover);
  const recoveryPoint: RecoveryPoint | null =
    change.recovery && recovered.length > 0
      ? { id: change.recovery.id, takenAt: change.recovery.takenAt, reason: change.recovery.describe(recovered), bundles: recovered }
      : null;

  return { removed, put, recoveryPoint };
}

/** Check a "delete everything" request against what the storage holds right now. */
export function checkClearAll(expected: Record<string, string> | undefined, current: WorkspaceBundle[]): void {
  if (!expected) return;
  const stale =
    current.length !== Object.keys(expected).length ||
    current.some((bundle) => expected[bundle.workspace.id] !== stampOf(bundle));
  if (stale) {
    throw new StoreConflictError(
      'Your classes changed in another tab or window after this page last showed them. Nothing was deleted. The page now shows the current version: check it, then confirm again.'
    );
  }
}

export interface WorkspaceStore {
  /** False when data lives only in memory and will be gone when the tab closes. */
  readonly persistent: boolean;

  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(id: string): Promise<Workspace | null>;
  /** Fails if the id is already in use. */
  createWorkspace(workspace: Workspace): Promise<void>;
  /**
   * Apply `change` to the workspace, but only if it is still at `expectedRev`.
   * The revision and update time are advanced by the store.
   */
  updateWorkspace(id: string, expectedRev: number, change: (current: Workspace) => Workspace): Promise<Workspace>;
  /** Record a backup time without counting as an edit. A class's backup time never moves backwards. */
  markBackedUp(ids: string[], at: string): Promise<void>;

  appendSpin(spin: LocalSpin): Promise<void>;
  listSpins(workspaceId: string): Promise<LocalSpin[]>;

  /** A class and its complete spin history, read together as one consistent picture. */
  getBundle(id: string): Promise<WorkspaceBundle | null>;
  /** Add complete classes. Never removes or replaces anything: an id that is already in use is an error and nothing is written. */
  putBundles(bundles: WorkspaceBundle[]): Promise<void>;
  /**
   * Remove and/or replace whole classes as one all-or-nothing step.
   * Inside that single step the store confirms every class to be removed is
   * still what the caller expected, stores the recovery copy, and makes the
   * change. If anything is not as expected nothing at all is changed.
   */
  replaceClasses(change: ClassChange): Promise<ClassChangeResult>;

  listRecoveryPoints(): Promise<RecoveryPoint[]>;
  addRecoveryPoint(point: RecoveryPoint): Promise<void>;
  deleteRecoveryPoint(id: string): Promise<void>;

  /**
   * Remove everything, recovery points included.
   * With `expected` (class id to `stampOf`), nothing is removed unless the
   * classes are still exactly those the teacher was shown.
   */
  clearAll(expected?: Record<string, string>): Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const byName = (a: Workspace, b: Workspace): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true }) || a.createdAt.localeCompare(b.createdAt);

/** Shared by both stores so the revision rule cannot drift between them. */
export function applyWorkspaceChange(current: Workspace, expectedRev: number, change: (current: Workspace) => Workspace, now: Date): Workspace {
  if (current.rev !== expectedRev) throw new StoreConflictError();
  const next = change(clone(current));
  if (next.students.length > LIMITS.studentsPerWorkspace) {
    throw new Error(`A class can hold at most ${LIMITS.studentsPerWorkspace} students.`);
  }
  return { ...next, id: current.id, createdAt: current.createdAt, rev: current.rev + 1, updatedAt: now.toISOString() };
}

export class MemoryStore implements WorkspaceStore {
  readonly persistent = false;
  private workspaces = new Map<string, Workspace>();
  private spins = new Map<string, LocalSpin>();
  private recovery: RecoveryPoint[] = [];

  async listWorkspaces() {
    return [...this.workspaces.values()].map(clone).sort(byName);
  }

  async getWorkspace(id: string) {
    const found = this.workspaces.get(id);
    return found ? clone(found) : null;
  }

  async createWorkspace(workspace: Workspace) {
    if (this.workspaces.has(workspace.id)) throw new Error('A class with that id already exists.');
    this.workspaces.set(workspace.id, clone(workspace));
  }

  async updateWorkspace(id: string, expectedRev: number, change: (current: Workspace) => Workspace) {
    const current = this.workspaces.get(id);
    if (!current) throw new StoreMissingError();
    const next = applyWorkspaceChange(current, expectedRev, change, new Date());
    this.workspaces.set(id, next);
    return clone(next);
  }

  async markBackedUp(ids: string[], at: string) {
    for (const id of ids) {
      const current = this.workspaces.get(id);
      if (current && (!current.lastBackupAt || current.lastBackupAt < at)) {
        this.workspaces.set(id, { ...current, lastBackupAt: at });
      }
    }
  }

  async appendSpin(spin: LocalSpin) {
    if (!this.workspaces.has(spin.workspaceId)) throw new StoreMissingError();
    if (this.spins.has(spin.id)) throw new Error('That spin was already saved.');
    this.spins.set(spin.id, clone(spin));
  }

  async listSpins(workspaceId: string) {
    return [...this.spins.values()]
      .filter((spin) => spin.workspaceId === workspaceId)
      .map(clone)
      .sort((a, b) => a.timestamp_iso.localeCompare(b.timestamp_iso));
  }

  async getBundle(id: string) {
    const workspace = await this.getWorkspace(id);
    return workspace ? { workspace, spins: await this.listSpins(id) } : null;
  }

  /** Write classes and spins that have already been checked. */
  private write(bundles: WorkspaceBundle[]) {
    for (const { workspace, spins } of bundles) {
      this.workspaces.set(workspace.id, clone(workspace));
      for (const spin of spins) this.spins.set(spin.id, clone(spin));
    }
  }

  /** Throws if any incoming class or spin id is already taken by something that is staying. */
  private assertFree(bundles: WorkspaceBundle[], leaving: Set<string>) {
    const classIds = new Set<string>();
    const spinIds = new Set<string>();
    for (const { workspace, spins } of bundles) {
      if (classIds.has(workspace.id)) throw new Error('The same class appears twice.');
      classIds.add(workspace.id);
      if (this.workspaces.has(workspace.id) && !leaving.has(workspace.id)) throw new Error('A class with that id already exists.');
      for (const spin of spins) {
        const owner = this.spins.get(spin.id);
        if (spinIds.has(spin.id) || (owner && !leaving.has(owner.workspaceId))) throw new Error('A spin with that id already exists.');
        spinIds.add(spin.id);
      }
    }
  }

  async putBundles(bundles: WorkspaceBundle[]) {
    // Check everything first so a failure changes nothing.
    this.assertFree(bundles, new Set());
    this.write(bundles);
  }

  async replaceClasses(change: ClassChange): Promise<ClassChangeResult> {
    // No await below this line until the end: the whole method is one uninterrupted step.
    const current = new Map<string, WorkspaceBundle>();
    for (const { id } of change.remove) {
      const workspace = this.workspaces.get(id);
      if (workspace) {
        const spins = [...this.spins.values()]
          .filter((spin) => spin.workspaceId === id)
          .sort((a, b) => a.timestamp_iso.localeCompare(b.timestamp_iso));
        current.set(id, clone({ workspace, spins }));
      }
    }
    const occupied = new Set(change.put.map((bundle) => bundle.workspace.id).filter((id) => this.workspaces.has(id)));
    const pointExists = this.recovery.some((point) => point.id === change.consumeRecoveryPointId);
    const plan = planClassChange(change, current, occupied, pointExists);
    this.assertFree(plan.put, new Set(change.remove.map((removal) => removal.id)));

    // Everything is checked. From here on nothing can fail.
    if (plan.recoveryPoint) {
      this.recovery.push(clone(plan.recoveryPoint));
      this.recovery.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
      this.recovery = this.recovery.slice(0, MAX_RECOVERY_POINTS);
    }
    for (const { id } of change.remove) this.removeWorkspace(id);
    this.write(plan.put);
    if (change.consumeRecoveryPointId) {
      this.recovery = this.recovery.filter((point) => point.id !== change.consumeRecoveryPointId);
    }
    return { removed: plan.removed, recoveryPoint: plan.recoveryPoint };
  }

  private removeWorkspace(id: string) {
    this.workspaces.delete(id);
    for (const [spinId, spin] of this.spins) {
      if (spin.workspaceId === id) this.spins.delete(spinId);
    }
  }

  async listRecoveryPoints() {
    return this.recovery.map(clone).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }

  async addRecoveryPoint(point: RecoveryPoint) {
    this.recovery.push(clone(point));
    this.recovery.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    this.recovery = this.recovery.slice(0, MAX_RECOVERY_POINTS);
  }

  async deleteRecoveryPoint(id: string) {
    this.recovery = this.recovery.filter((point) => point.id !== id);
  }

  async clearAll(expected?: Record<string, string>) {
    const current: WorkspaceBundle[] = [];
    for (const workspace of this.workspaces.values()) {
      current.push({ workspace, spins: [...this.spins.values()].filter((spin) => spin.workspaceId === workspace.id) });
    }
    checkClearAll(expected, current);
    this.workspaces.clear();
    this.spins.clear();
    this.recovery = [];
  }
}
