import { createContext, useContext } from 'react';
import type { Workspace } from './local/schema';
import type { WorkspaceStore } from './local/store';
import type { StorageMode } from './mode';
import type { DataProvider } from './provider';

export interface DataState {
  /** Which storage is in charge of classroom data right now. */
  mode: StorageMode;
  /** The storage in charge. Pages read and write only through this. */
  provider: DataProvider;
  /** Browser storage. Always available, so local classes can be managed from either mode. */
  store: WorkspaceStore;
  /** Local classes in this browser, sorted by name. */
  workspaces: Workspace[];
  /** The local class currently selected. */
  workspace: Workspace;
  /** Set when the browser refused to open its database and data is only held in memory. */
  storageProblem: string | null;
  setMode(mode: StorageMode): void;
  selectWorkspace(id: string): void;
  /** Re-read the class list after a change made through the store. */
  refresh(): Promise<void>;
}

export const DataContext = createContext<DataState | null>(null);

export function useData(): DataState {
  const state = useContext(DataContext);
  if (!state) throw new Error('useData must be used inside DataRoot.');
  return state;
}
