/**
 * IndexedDB implementation of the Local Mode store.
 *
 * Data stays in this browser. Nothing here makes a network request.
 *
 * Object stores:
 * - workspaces  key: id          one record per class (roster and settings inside)
 * - spins       key: id          one record per spin, indexed by workspaceId
 * - recovery    key: id          copies taken before destructive actions
 *
 * Bump DB_VERSION and extend `upgrade` when a store or index is added. Record
 * shapes are versioned separately by WORKSPACE_SCHEMA_VERSION in schema.ts.
 */
import type { LocalSpin, Workspace, WorkspaceBundle } from './schema';
import { migrateWorkspace } from './schema';
import {
  MAX_RECOVERY_POINTS,
  StoreMissingError,
  applyWorkspaceChange,
  byName,
  type RecoveryPoint,
  type WorkspaceStore,
} from './store';

export const DB_NAME = 'ringwheel';
export const DB_VERSION = 1;

type StoreName = 'workspaces' | 'spins' | 'recovery';

function upgrade(db: IDBDatabase) {
  if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('spins')) {
    db.createObjectStore('spins', { keyPath: 'id' }).createIndex('workspaceId', 'workspaceId');
  }
  if (!db.objectStoreNames.contains('recovery')) db.createObjectStore('recovery', { keyPath: 'id' });
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('The browser could not read its storage.'));
  });

const asWorkspace = (raw: unknown): Workspace => migrateWorkspace(raw as Record<string, unknown>) as unknown as Workspace;

export class IndexedDbStore implements WorkspaceStore {
  readonly persistent = true;
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
    // If another tab upgrades the database, let go of it instead of blocking that tab.
    db.onversionchange = () => db.close();
  }

  static open(factory: IDBFactory, name = DB_NAME): Promise<IndexedDbStore> {
    return new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(name, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => upgrade(req.result);
      req.onsuccess = () => resolve(new IndexedDbStore(req.result));
      req.onerror = () => reject(req.error ?? new Error('The browser refused to open its storage.'));
      req.onblocked = () => reject(new Error('RingWheel is open in another tab that is using an older version. Close it and reload.'));
    });
  }

  /**
   * Run `work` in one transaction. The promise resolves only after the
   * transaction has committed, and rejects (with nothing written) if any step
   * fails or `work` throws.
   */
  private transact<T>(stores: StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('The browser could not save the change.'));
      tx.onerror = () => {
        failure = failure ?? tx.error;
      };
      const fail = (err: unknown) => {
        failure = err;
        try {
          tx.abort();
        } catch {
          // The transaction already ended. Report the original problem.
          reject(err);
        }
      };
      // Start the work in the same tick the transaction was created in, while it is active.
      let pending: Promise<T> | T;
      try {
        pending = work(tx);
      } catch (err) {
        fail(err);
        return;
      }
      Promise.resolve(pending).then((value) => {
        result = value;
      }, fail);
    });
  }

  listWorkspaces() {
    return this.transact(['workspaces'], 'readonly', async (tx) => {
      const all = await request(tx.objectStore('workspaces').getAll());
      return all.map(asWorkspace).sort(byName);
    });
  }

  getWorkspace(id: string) {
    return this.transact(['workspaces'], 'readonly', async (tx) => {
      const found = await request(tx.objectStore('workspaces').get(id));
      return found ? asWorkspace(found) : null;
    });
  }

  createWorkspace(workspace: Workspace) {
    return this.transact(['workspaces'], 'readwrite', async (tx) => {
      // add() fails if the key exists, which aborts the transaction.
      await request(tx.objectStore('workspaces').add(workspace));
    });
  }

  updateWorkspace(id: string, expectedRev: number, change: (current: Workspace) => Workspace) {
    return this.transact(['workspaces'], 'readwrite', async (tx) => {
      const store = tx.objectStore('workspaces');
      const current = await request(store.get(id));
      if (!current) throw new StoreMissingError();
      const next = applyWorkspaceChange(asWorkspace(current), expectedRev, change, new Date());
      await request(store.put(next));
      return next;
    });
  }

  markBackedUp(ids: string[], at: string) {
    return this.transact(['workspaces'], 'readwrite', async (tx) => {
      const store = tx.objectStore('workspaces');
      for (const id of ids) {
        const current = await request(store.get(id));
        if (current) await request(store.put({ ...current, lastBackupAt: at }));
      }
    });
  }

  appendSpin(spin: LocalSpin) {
    return this.transact(['workspaces', 'spins'], 'readwrite', async (tx) => {
      const owner = await request(tx.objectStore('workspaces').getKey(spin.workspaceId));
      if (owner === undefined) throw new StoreMissingError();
      await request(tx.objectStore('spins').add(spin));
    });
  }

  listSpins(workspaceId: string) {
    return this.transact(['spins'], 'readonly', async (tx) => {
      const spins = (await request(tx.objectStore('spins').index('workspaceId').getAll(workspaceId))) as LocalSpin[];
      return spins.sort((a, b) => a.timestamp_iso.localeCompare(b.timestamp_iso));
    });
  }

  getBundle(id: string) {
    return this.transact(['workspaces', 'spins'], 'readonly', async (tx) => {
      const workspace = await request(tx.objectStore('workspaces').get(id));
      if (!workspace) return null;
      const spins = (await request(tx.objectStore('spins').index('workspaceId').getAll(id))) as LocalSpin[];
      return { workspace: asWorkspace(workspace), spins: spins.sort((a, b) => a.timestamp_iso.localeCompare(b.timestamp_iso)) };
    });
  }

  private async removeWorkspace(tx: IDBTransaction, id: string) {
    await request(tx.objectStore('workspaces').delete(id));
    const keys = await request(tx.objectStore('spins').index('workspaceId').getAllKeys(id));
    for (const key of keys) await request(tx.objectStore('spins').delete(key));
  }

  putBundles(bundles: WorkspaceBundle[], { replace = [] }: { replace?: string[] } = {}) {
    return this.transact(['workspaces', 'spins'], 'readwrite', async (tx) => {
      const ids = new Set<string>();
      for (const { workspace } of bundles) {
        if (ids.has(workspace.id)) throw new Error('The same class appears twice.');
        ids.add(workspace.id);
      }
      for (const id of replace) await this.removeWorkspace(tx, id);
      // add() rejects any remaining id collision, and a rejection aborts everything above.
      for (const { workspace, spins } of bundles) {
        await request(tx.objectStore('workspaces').add(workspace));
        for (const spin of spins) await request(tx.objectStore('spins').add(spin));
      }
    });
  }

  deleteWorkspace(id: string) {
    return this.transact(['workspaces', 'spins'], 'readwrite', (tx) => this.removeWorkspace(tx, id));
  }

  listRecoveryPoints() {
    return this.transact(['recovery'], 'readonly', async (tx) => {
      const points = (await request(tx.objectStore('recovery').getAll())) as RecoveryPoint[];
      return points.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    });
  }

  addRecoveryPoint(point: RecoveryPoint) {
    return this.transact(['recovery'], 'readwrite', async (tx) => {
      const store = tx.objectStore('recovery');
      await request(store.put(point));
      const points = ((await request(store.getAll())) as RecoveryPoint[]).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
      for (const old of points.slice(MAX_RECOVERY_POINTS)) await request(store.delete(old.id));
    });
  }

  deleteRecoveryPoint(id: string) {
    return this.transact(['recovery'], 'readwrite', async (tx) => {
      await request(tx.objectStore('recovery').delete(id));
    });
  }

  clearAll() {
    return this.transact(['workspaces', 'spins', 'recovery'], 'readwrite', async (tx) => {
      await request(tx.objectStore('workspaces').clear());
      await request(tx.objectStore('spins').clear());
      await request(tx.objectStore('recovery').clear());
    });
  }
}
