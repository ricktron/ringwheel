/**
 * One storage, two builds: the current code and the frozen baseline (the site
 * as it shipped before Presentation Draw) looking at the same data.
 *
 * With IndexedDB this is literal: both open the same database, exactly as a
 * rolled-back site and a stale tab would. The in-memory store has no database
 * to share, so the baseline's maps are pointed at the current store's maps.
 */
import { IndexedDbStore } from '../../src/data/local/idb-store';
import { MemoryStore, type WorkspaceStore } from '../../src/data/local/store';
import { IndexedDbStore as BaselineIndexedDbStore } from './baseline-a785855/idb-store';
import { MemoryStore as BaselineMemoryStore, type WorkspaceStore as BaselineStore } from './baseline-a785855/store';

export interface Pair {
  /** The current build. */
  fresh: WorkspaceStore;
  /** The baseline build, on the same storage. */
  old: BaselineStore;
}

export function memoryPair(): Pair {
  const fresh = new MemoryStore();
  const old = new BaselineMemoryStore();
  for (const field of ['workspaces', 'spins', 'recovery']) {
    Object.defineProperty(old, field, {
      configurable: true,
      get: () => (fresh as unknown as Record<string, unknown>)[field],
      set: (value: unknown) => {
        (fresh as unknown as Record<string, unknown>)[field] = value;
      },
    });
  }
  return { fresh, old };
}

export interface OpenedPair extends Pair {
  close(): void;
}

export async function indexedDbPair(factory: IDBFactory, name?: string): Promise<OpenedPair> {
  const fresh = await IndexedDbStore.open(factory, name);
  const old = await BaselineIndexedDbStore.open(factory, name);
  return {
    fresh,
    old,
    close: () => {
      fresh.close();
      old.close();
    },
  };
}
