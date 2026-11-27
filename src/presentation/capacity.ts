/**
 * Capacity: one budget, one way out.
 *
 * A class's presentation data may add at most `budgetBytes` to a backup file.
 * The size is measured exactly as the backup file is written, so the number
 * shown to a teacher, the number checked on every write and the number that
 * decides whether a backup can be restored are the same number.
 *
 * Nothing is ever deleted to make room. When a class is full, the work
 * continues in a new class (carry-over.ts). The second rule below guarantees
 * that this is always possible.
 */
import { buildContinuation } from './carry-over';
import { PRESENTATION_LIMITS, type PresentationData } from './types';

/** UTF-8 length of a string, without building a byte array. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The backup file's indentation, and how deep the presentation field sits in it (file > workspaces > class > workspace > presentation). */
export const BACKUP_INDENT = 2;
const PRESENTATION_DEPTH = 4;
/** The comma after the previous field, the line break, the indentation and `"presentation": `. */
const FIELD_OVERHEAD = 1 + 1 + PRESENTATION_DEPTH * BACKUP_INDENT + '"presentation": '.length;

/**
 * Exactly how many bytes this presentation data adds to a backup file.
 * (Checked against the real serializer in the tests.)
 */
export function presentationFileBytes(data: PresentationData | undefined): number {
  if (!data) return 0;
  const pretty = JSON.stringify(data, null, BACKUP_INDENT);
  let lineBreaks = 0;
  for (let i = 0; i < pretty.length; i++) if (pretty.charCodeAt(i) === 10) lineBreaks++;
  return FIELD_OVERHEAD + utf8Length(pretty) + lineBreaks * PRESENTATION_DEPTH * BACKUP_INDENT;
}

const DUMMY_MARKER = { sourceClassId: 'x'.repeat(80), n: 999999, at: '9999-12-31T23:59:59.999Z', on: '9999-12-31' };

/**
 * An upper limit on what a continuation of this class could ever weigh:
 * every drawn draw carried, every presenter in their largest possible state.
 * It depends only on structure (how many draws, presenters, dates, exclusions),
 * so no reveal, completion, deferral, absence, skip or undo can raise it.
 */
export function carryBound(data: PresentationData | undefined): number {
  if (!data) return 0;
  return presentationFileBytes({ ...buildContinuation(data, DUMMY_MARKER, true), epoch: 'x'.repeat(80), rev: 999999 });
}

/** The numbers the capacity rules use. Always PRESENTATION_LIMITS in the app; tests may pass smaller ones. */
export type CapacityLimits = Pick<typeof PRESENTATION_LIMITS, 'budgetBytes' | 'reserveBytes' | 'warnFraction' | 'newWorkFraction' | 'carryBytes'> | {
  budgetBytes: number;
  reserveBytes: number;
  warnFraction: number;
  newWorkFraction: number;
  carryBytes: number;
};

export type UsageLevel = 'ok' | 'warn' | 'new_work_refused' | 'full';

export interface PresentationUsage {
  bytes: number;
  budget: number;
  /** 0 to 1 and beyond. */
  fraction: number;
  level: UsageLevel;
  /** True when adding more draws, presenters, dates or exclusions is refused until the class is continued elsewhere. */
  openWorkLimitReached: boolean;
}

export function presentationUsage(data: PresentationData | undefined, limits: CapacityLimits = PRESENTATION_LIMITS): PresentationUsage {
  const { budgetBytes: budget, reserveBytes, warnFraction, newWorkFraction, carryBytes } = limits;
  const bytes = presentationFileBytes(data);
  const level: UsageLevel =
    bytes > budget - reserveBytes ? 'full' : bytes > budget * newWorkFraction ? 'new_work_refused' : bytes > budget * warnFraction ? 'warn' : 'ok';
  return { bytes, budget, fraction: bytes / budget, level, openWorkLimitReached: carryBound(data) >= carryBytes };
}

export type CapacityRefusal = 'full' | 'new_work' | 'open_work' | 'over_budget';

export class PresentationCapacityError extends Error {
  readonly kind: CapacityRefusal;
  constructor(kind: CapacityRefusal) {
    super(
      kind === 'new_work'
        ? "This class's presentation history is nearly full. New draws and redraws are not available here. Finish the current draws, or continue in a new class."
        : kind === 'open_work'
          ? 'This class is holding as much unfinished presentation work as can be carried into a new class. Nothing more can be added here. Continue in a new class to add more.'
          : "This class's presentation history is full. Nothing was changed. Continue in a new class: every order and record here is kept."
    );
    this.name = 'PresentationCapacityError';
    this.kind = kind;
  }
}

const ordersOf = (data: PresentationData | undefined): Map<string, string> =>
  new Map((data?.draws ?? []).filter((d) => d.order).map((d) => [d.id, d.order!.drawnAt]));

/** True when the only difference is one new 'moved' entry at the end of the class log. */
function isMoveMarkerOnly(before: PresentationData | undefined, after: PresentationData): boolean {
  if (!before || after.classLog.length !== before.classLog.length + 1) return false;
  if (after.classLog[after.classLog.length - 1].t !== 'moved') return false;
  return JSON.stringify(before.draws) === JSON.stringify(after.draws);
}

/**
 * Decide whether a presentation write fits. Throws PresentationCapacityError,
 * before anything is stored, if it does not.
 *
 * 1. Full: a write that makes the data larger is refused once it would pass
 *    the budget minus the reserve. Only the "continued in another class"
 *    marker may use the reserve.
 * 2. New work: a new draw, or a new or redrawn order, is refused above 90%.
 * 3. Open work: a write that would raise `carryBound` above its limit is
 *    refused. Actions on existing presenters never raise it.
 *
 * A write that makes things smaller is never refused by these rules.
 */
export function checkCapacity(before: PresentationData | undefined, after: PresentationData, limits: CapacityLimits = PRESENTATION_LIMITS): void {
  const { budgetBytes, reserveBytes, newWorkFraction, carryBytes } = limits;
  const bytesAfter = presentationFileBytes(after);
  const bytesBefore = presentationFileBytes(before);
  if (bytesAfter > budgetBytes) throw new PresentationCapacityError('over_budget');
  if (bytesAfter > bytesBefore) {
    if (bytesAfter > budgetBytes - reserveBytes && !isMoveMarkerOnly(before, after)) throw new PresentationCapacityError('full');
    const drawsBefore = before?.draws.length ?? 0;
    const ordersBefore = ordersOf(before);
    const newOrder = [...ordersOf(after)].some(([id, drawnAt]) => ordersBefore.get(id) !== drawnAt);
    if ((after.draws.length > drawsBefore || newOrder) && bytesAfter > budgetBytes * newWorkFraction) throw new PresentationCapacityError('new_work');
  }
  const carryAfter = carryBound(after);
  if (carryAfter > carryBytes && carryAfter > carryBound(before)) throw new PresentationCapacityError('open_work');
}
