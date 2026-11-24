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
 */
import { LIMITS, type LocalSpin, type Workspace, type WorkspaceBundle } from './schema';

export class StoreConflictError extends Error {
  constructor() {
    super('This class was changed in another tab or window. Reload to see the current version, then try again.');
    this.name = 'StoreConflictError';
  }
}

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
  /** Record a backup time without counting as an edit. */
  markBackedUp(ids: string[], at: string): Promise<void>;

  appendSpin(spin: LocalSpin): Promise<void>;
  listSpins(workspaceId: string): Promise<LocalSpin[]>;

  getBundle(id: string): Promise<WorkspaceBundle | null>;
  /**
   * Write complete classes. `replace` lists ids whose existing data (class and
   * all of its spins) is removed first. Any other id collision is an error and
   * nothing is written.
   */
  putBundles(bundles: WorkspaceBundle[], options?: { replace?: string[] }): Promise<void>;
  /** Remove a class and its spins. */
  deleteWorkspace(id: string): Promise<void>;

  listRecoveryPoints(): Promise<RecoveryPoint[]>;
  addRecoveryPoint(point: RecoveryPoint): Promise<void>;
  deleteRecoveryPoint(id: string): Promise<void>;

  /** Remove everything, recovery points included. */
  clearAll(): Promise<void>;
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
      if (current) this.workspaces.set(id, { ...current, lastBackupAt: at });
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

  async putBundles(bundles: WorkspaceBundle[], { replace = [] }: { replace?: string[] } = {}) {
    // Check everything first so a failure changes nothing.
    const incoming = new Set<string>();
    for (const { workspace } of bundles) {
      if (incoming.has(workspace.id)) throw new Error('The same class appears twice.');
      incoming.add(workspace.id);
      if (this.workspaces.has(workspace.id) && !replace.includes(workspace.id)) {
        throw new Error('A class with that id already exists.');
      }
    }
    const spinIds = new Set<string>();
    for (const { spins } of bundles) {
      for (const spin of spins) {
        const owner = this.spins.get(spin.id);
        if (spinIds.has(spin.id) || (owner && !replace.includes(owner.workspaceId))) {
          throw new Error('A spin with that id already exists.');
        }
        spinIds.add(spin.id);
      }
    }

    for (const id of replace) this.removeWorkspace(id);
    for (const { workspace, spins } of bundles) {
      this.workspaces.set(workspace.id, clone(workspace));
      for (const spin of spins) this.spins.set(spin.id, clone(spin));
    }
  }

  private removeWorkspace(id: string) {
    this.workspaces.delete(id);
    for (const [spinId, spin] of this.spins) {
      if (spin.workspaceId === id) this.spins.delete(spinId);
    }
  }

  async deleteWorkspace(id: string) {
    this.removeWorkspace(id);
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

  async clearAll() {
    this.workspaces.clear();
    this.spins.clear();
    this.recovery = [];
  }
}
