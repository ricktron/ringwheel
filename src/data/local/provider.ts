/**
 * Local Mode data provider: answers every data question from browser storage.
 *
 * This file, and everything else under src/data/local/, must never make a
 * network request or import the backend client. tests/repo/hygiene.test.ts
 * checks that.
 */
import { ApiError, sameRows, type HealthResult, type SheetSnapshot, type WriteOptions, type WriteResult } from '../../api';
import type { RingSlice, SettingRow, SpinLogRow, SpinsLogPayload } from '../../types';
import type { DataProvider, SpinLogContext } from '../provider';
import { newId, type LocalSpin, type Workspace } from './schema';
import { StoreConflictError, StoreMissingError, type WorkspaceStore } from './store';

export interface LocalProvider extends DataProvider {
  readonly kind: 'local';
  readonly workspaceId: string;
}

/** Calendar day in the browser's own time zone, as YYYY-MM-DD. */
export function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const SAVED: WriteResult = { ok: true, complete: true, missing: [], warnings: [] };

function toLogRow(spin: LocalSpin): SpinLogRow {
  let flags: string[] = [];
  try {
    const parsed = JSON.parse(spin.rule_flags_json);
    if (Array.isArray(parsed)) flags = parsed.map(String);
  } catch {
    // An unreadable flag list is shown as no flags.
  }
  return {
    timestamp_iso: spin.timestamp_iso,
    student_name: spin.student_name,
    email: spin.email,
    period: spin.period,
    result_region: spin.result_A,
    result_taxon: spin.result_B,
    result_iucn: spin.result_C,
    plantae_mercy: spin.plantae_mercy,
    veto_used: spin.veto_used,
    rule_flags: flags,
    is_test: spin.is_test,
    student_id: spin.studentId,
  };
}

/** Turn storage errors into the same error kinds the pages already handle. */
function translate(err: unknown): never {
  if (err instanceof StoreConflictError) throw new ApiError('conflict', err.message);
  if (err instanceof StoreMissingError) throw new ApiError('rejected', err.message);
  if (err instanceof ApiError) throw err;
  const detail = err instanceof Error ? err.message : 'unknown problem';
  throw new ApiError('rejected', `The browser could not save the change (${detail}).`);
}

export function createLocalProvider(store: WorkspaceStore, workspaceId: string): LocalProvider {
  const workspace = async (): Promise<Workspace> => {
    const found = await store.getWorkspace(workspaceId);
    if (!found) throw new ApiError('rejected', 'This class no longer exists in this browser.');
    return found;
  };

  const snapshot = <T>(rows: T[]): SheetSnapshot<T> => ({
    rows: JSON.parse(JSON.stringify(rows)) as T[],
    base: JSON.parse(JSON.stringify(rows)) as unknown[],
  });

  async function writeRows(field: 'settings' | 'rings', rows: unknown[], options?: WriteOptions): Promise<WriteResult> {
    try {
      const current = await workspace();
      await store.updateWorkspace(current.id, current.rev, (ws) => {
        // Same rule as the Sheets backend: refuse if the data changed since it was read.
        if (options?.base && !sameRows(ws[field] as unknown[], options.base)) {
          throw new StoreConflictError();
        }
        return { ...ws, [field]: JSON.parse(JSON.stringify(rows)) };
      });
      return SAVED;
    } catch (err) {
      return translate(err);
    }
  }

  return {
    kind: 'local',
    workspaceId,

    async health(): Promise<HealthResult> {
      await workspace();
      return {
        status: 'ok',
        contract: null,
        warnings: store.persistent
          ? []
          : ['This browser is not keeping data after the tab closes. Download a backup before you leave.'],
      };
    },

    settings: async () => snapshot((await workspace()).settings).rows,
    rings: async () => snapshot((await workspace()).rings).rows,
    readSettings: async () => snapshot<SettingRow>((await workspace()).settings),
    readRings: async () => snapshot<RingSlice>((await workspace()).rings),
    writeSettings: (rows, options) => writeRows('settings', rows, options),
    writeRings: (rows, options) => writeRows('rings', rows, options),

    async getSpins(filters) {
      const spins = await store.listSpins(workspaceId);
      return spins
        .filter((spin) => !filters.date || localDateKey(new Date(spin.timestamp_iso)) === filters.date)
        .filter((spin) => !filters.email || spin.email === filters.email)
        .map(toLogRow);
    },

    async logSpin(payload: SpinsLogPayload, context?: SpinLogContext): Promise<WriteResult> {
      try {
        await store.appendSpin({ ...payload, id: newId(), workspaceId, studentId: context?.studentId ?? null });
        return SAVED;
      } catch (err) {
        return translate(err);
      }
    },
  };
}
