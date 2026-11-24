/**
 * Which storage is in charge of classroom data.
 *
 * - local (the default): everything stays in this browser. No backend is contacted.
 * - connected: the teacher's own Google Sheet, through the Apps Script backend.
 *
 * The choice is explicit and stored in this browser. It is never inferred from
 * the build, the address the site is served from, or anything a visitor did
 * not do themselves.
 */
import { STORAGE_KEYS, resolveApiConfig } from '../api';

export type StorageMode = 'local' | 'connected';

export const MODE_KEY = 'ringwheel.mode';
export const ACTIVE_WORKSPACE_KEY = 'ringwheel.activeWorkspace';

type ReadableStorage = Pick<Storage, 'getItem'>;

function read(storage: ReadableStorage | undefined, key: string): string {
  try {
    return (storage?.getItem(key) ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * The active storage mode.
 *
 * An explicit choice always wins. With no choice recorded, the mode is local,
 * with one exception: a browser that already holds a complete connection
 * saved by the teacher (from before Local Mode existed) keeps using it, so an
 * existing connected setup is not silently switched off by an update.
 */
export function resolveStorageMode(storage?: ReadableStorage): StorageMode {
  const chosen = read(storage, MODE_KEY);
  if (chosen === 'local' || chosen === 'connected') return chosen;
  const hasSavedConnection = read(storage, STORAGE_KEYS.url) !== '' && resolveApiConfig(storage).problems.length === 0;
  return hasSavedConnection ? 'connected' : 'local';
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function getStorageMode(): StorageMode {
  return resolveStorageMode(browserStorage());
}

export function saveStorageMode(mode: StorageMode): void {
  browserStorage()?.setItem(MODE_KEY, mode);
}

export function getActiveWorkspaceId(): string {
  return read(browserStorage(), ACTIVE_WORKSPACE_KEY);
}

export function saveActiveWorkspaceId(id: string): void {
  browserStorage()?.setItem(ACTIVE_WORKSPACE_KEY, id);
}
