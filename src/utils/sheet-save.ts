import { ApiError, sameRows, type SheetSnapshot, type WriteOptions, type WriteResult } from '../api';

export interface GuardedSaveInput<T> {
  /** Name used in messages, for example "Settings". */
  sheetName: string;
  /** What this page was built from. */
  loaded: SheetSnapshot<T>;
  /** Reads the sheet again. */
  read: () => Promise<SheetSnapshot<T>>;
  write: (rows: T[], options: WriteOptions) => Promise<WriteResult>;
  /** Applies the admin's edits on top of the current sheet rows. */
  buildRows: (current: T[]) => T[];
  /** Stable name for a raw row, used to say what changed. */
  identify: (row: Record<string, unknown>) => string;
  adminToken?: string;
}

const asRecord = (row: unknown): Record<string, unknown> =>
  row && typeof row === 'object' ? (row as Record<string, unknown>) : {};

/** Says which rows differ between two reads of a sheet, by name. */
export function describeSheetChange(
  before: unknown[],
  after: unknown[],
  identify: (row: Record<string, unknown>) => string
): string {
  const index = (rows: unknown[]) => new Map(rows.map((row) => [identify(asRecord(row)), row]));
  const was = index(before);
  const now = index(after);
  const added = [...now.keys()].filter((id) => !was.has(id));
  const removed = [...was.keys()].filter((id) => !now.has(id));
  const changed = [...now.keys()].filter((id) => was.has(id) && !sameRows([was.get(id)], [now.get(id)]));
  const parts = [
    changed.length > 0 ? `changed: ${changed.join(', ')}` : '',
    added.length > 0 ? `added: ${added.join(', ')}` : '',
    removed.length > 0 ? `removed: ${removed.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'rows were reordered or edited';
}

/**
 * Save admin edits without overwriting anyone else's changes.
 *
 * 1. Read the sheet again. If it no longer matches what this page loaded,
 *    stop: nothing is written and the error says what changed.
 * 2. Write, passing along the rows just read so the backend can refuse if the
 *    sheet changes in the moment between this read and the write.
 * 3. Read once more and return that as the new starting point.
 *
 * Step 1 protects even when the deployed backend is an older version that
 * ignores `base_rows`. Step 2 closes the remaining gap on a current backend.
 */
export async function saveGuarded<T>({
  sheetName,
  loaded,
  read,
  write,
  buildRows,
  identify,
  adminToken,
}: GuardedSaveInput<T>): Promise<SheetSnapshot<T>> {
  const current = await read();
  if (!sameRows(current.base, loaded.base)) {
    throw new ApiError(
      'conflict',
      `The ${sheetName} sheet was changed by someone else after this page loaded it (${describeSheetChange(
        loaded.base,
        current.base,
        identify
      )}). Nothing was saved. Reload the current values, then make your change again.`
    );
  }
  await write(buildRows(current.rows), { adminToken, base: current.base });
  return read();
}
