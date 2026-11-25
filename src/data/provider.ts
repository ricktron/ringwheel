/**
 * The one interface the pages use to read and write classroom data.
 *
 * There are exactly two implementations:
 * - local:     src/data/local/provider.ts   (this browser, no network)
 * - connected: the Apps Script client in src/api.ts
 *
 * This is deliberately small. It is the set of calls the Sheets backend
 * already offered, so Connected Mode behaves exactly as before, and Local Mode
 * only has to answer the same questions from browser storage.
 */
import {
  api,
  type HealthResult,
  type SheetSnapshot,
  type WriteOptions,
  type WriteResult,
} from '../api';
import type { RingSlice, RosterStudent, SettingRow, SpinLogRow, SpinsLogPayload } from '../types';
import type { StorageMode } from './mode';

export interface SpinLogContext {
  /** Local Mode: the roster id of the student the spin belongs to. Ignored by Connected Mode. */
  studentId?: string | null;
}

export interface DataProvider {
  readonly kind: StorageMode;
  health(): Promise<HealthResult>;
  settings(): Promise<SettingRow[]>;
  rings(): Promise<RingSlice[]>;
  readSettings(): Promise<SheetSnapshot<SettingRow>>;
  readRings(): Promise<SheetSnapshot<RingSlice>>;
  writeSettings(rows: SettingRow[], options?: WriteOptions): Promise<WriteResult>;
  writeRings(rows: RingSlice[], options?: WriteOptions): Promise<WriteResult>;
  getSpins(filters: { date?: string; period?: string; email?: string }): Promise<SpinLogRow[]>;
  logSpin(payload: SpinsLogPayload, context?: SpinLogContext): Promise<WriteResult>;
}

export interface ConnectedProvider extends DataProvider {
  readonly kind: 'connected';
  /** The roster as the Sheet holds it, for every class period. */
  roster(): Promise<RosterStudent[]>;
}

/** Connected Mode: the existing Apps Script client, unchanged. */
export const connectedProvider: ConnectedProvider = {
  kind: 'connected',
  health: api.health,
  settings: api.settings,
  rings: api.rings,
  readSettings: api.readSettings,
  readRings: api.readRings,
  writeSettings: api.writeSettings,
  writeRings: api.writeRings,
  getSpins: api.getSpins,
  // The student id is a Local Mode detail and is never sent to the Sheet.
  logSpin: (payload) => api.logSpin(payload),
  roster: api.roster,
};
