import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DataContext, type DataState } from './context';
import { IndexedDbStore } from './local/idb-store';
import { createLocalProvider } from './local/provider';
import type { Workspace } from './local/schema';
import { MemoryStore, type WorkspaceStore } from './local/store';
import { ensureWorkspace } from './local/workspaces';
import { getActiveWorkspaceId, getStorageMode, saveActiveWorkspaceId, saveStorageMode, type StorageMode } from './mode';
import { connectedProvider } from './provider';

interface Opened {
  store: WorkspaceStore;
  problem: string | null;
}

async function openStore(): Promise<Opened> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('This browser has no local database.');
    return { store: await IndexedDbStore.open(indexedDB), problem: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown reason';
    return {
      store: new MemoryStore(),
      problem: `This browser would not open its local database (${detail}). Your data is held in memory only and will be lost when this tab closes. Download a backup before you leave.`,
    };
  }
}

/**
 * Opens browser storage, makes sure a class exists, and tells the rest of the
 * app which storage is in charge. No network request is made here.
 */
export function DataRoot({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState(() => getActiveWorkspaceId());
  const [mode, setModeState] = useState<StorageMode>(() => getStorageMode());
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next = await openStore();
      let list: Workspace[];
      try {
        list = await ensureWorkspace(next.store);
      } catch (err) {
        // The database opened but cannot be written to. Fall back to memory rather than a dead page.
        const detail = err instanceof Error ? err.message : 'unknown reason';
        next = {
          store: new MemoryStore(),
          problem: `This browser would not save to its local database (${detail}). Your data is held in memory only and will be lost when this tab closes.`,
        };
        list = await ensureWorkspace(next.store);
      }
      if (cancelled) return;
      setOpened(next);
      setWorkspaces(list);
    })().catch((err) => {
      if (!cancelled) setFatal(err instanceof Error ? err.message : 'RingWheel could not start.');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const store = opened?.store ?? null;

  const refresh = useCallback(async () => {
    if (!store) return;
    setWorkspaces(await ensureWorkspace(store));
  }, [store]);

  const setMode = useCallback((next: StorageMode) => {
    saveStorageMode(next);
    setModeState(next);
  }, []);

  const selectWorkspace = useCallback((id: string) => {
    saveActiveWorkspaceId(id);
    setActiveId(id);
  }, []);

  const workspace = workspaces.find((candidate) => candidate.id === activeId) ?? workspaces[0] ?? null;
  const workspaceId = workspace?.id ?? null;

  const localProvider = useMemo(
    () => (store && workspaceId ? createLocalProvider(store, workspaceId) : null),
    [store, workspaceId]
  );

  if (fatal) {
    return (
      <div className="mx-auto max-w-2xl p-6" role="alert">
        <h1 className="text-2xl font-bold text-bad">RingWheel could not start</h1>
        <p className="mt-2">{fatal}</p>
      </div>
    );
  }

  if (!opened || !store || !workspace || !localProvider) {
    return (
      <p className="p-6 text-ink-dim" role="status" data-testid="app-loading">
        Opening RingWheel…
      </p>
    );
  }

  const state: DataState = {
    mode,
    provider: mode === 'connected' ? connectedProvider : localProvider,
    store,
    workspaces,
    workspace,
    storageProblem: opened.problem,
    setMode,
    selectWorkspace,
    refresh,
  };

  return <DataContext.Provider value={state}>{children}</DataContext.Provider>;
}
