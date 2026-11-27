/**
 * Checking presentation data.
 *
 * `validatePresentation` rebuilds the data field by field, so nothing
 * unexpected is carried along, and then checks three things that go beyond
 * shape:
 *
 * 1. Each drawn order is what its seed and inputs produce.
 * 2. Replaying each draw's log from its snapshot gives exactly the saved state.
 * 3. The class-level lists are exactly what the class log adds up to.
 *
 * `checkTransition` then checks a write against what was stored before it:
 * history may only grow, a drawn order may never change or disappear, and a
 * class whose presentations were continued elsewhere may not change at all.
 *
 * `commitPresentation` is the single gate every write goes through.
 */
import { checkCapacity, carryBound, presentationFileBytes, type CapacityLimits } from './capacity';
import { verifyOrder } from './draw';
import { foldClassLog } from './eligibility';
import { checkExclusion, checkMeeting, checkTiming, replay } from './replay';
import {
  INACTIVE_REASONS,
  PRESENTATION_LIMITS,
  PresentationError,
  SKIP_REASONS,
  isDateKey,
  makeAbsence,
  makeEntry,
  makeEvent,
  type CarriedState,
  type ClassLogEntry,
  type DrawBase,
  type DrawEntry,
  type DrawEvent,
  type DrawnOrder,
  type EventKind,
  type PresentationData,
  type PresentationDraw,
  type SupersededOrder,
} from './types';

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const isIso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= PRESENTATION_LIMITS.nameLength;
const isIndex = (value: unknown, below: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < below;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>([
  'drawn', 'redrawn', 'revealed', 'on_deck', 'done', 'deferred', 'absent', 'present', 'skipped', 'restored',
  'added_later', 'excluded', 'included', 'schedule', 'archived', 'unarchived', 'undo',
]);
const ENTRY_STATUS: ReadonlySet<string> = new Set(['waiting', 'presenting', 'on_deck', 'done', 'skipped']);
const DRAW_STATUS: ReadonlySet<string> = new Set(['draft', 'ready', 'in_progress', 'finished', 'archived']);

/** Thrown by the gate when a write would store something inconsistent. Nothing has been stored. */
export class PresentationInvalidError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The presentation record would not be consistent, so nothing was saved. ${problems.slice(0, 3).join(' ')}`);
    this.name = 'PresentationInvalidError';
    this.problems = problems;
  }
}

/** Thrown when a class whose presentations were continued in another class is written to. */
export class PresentationMovedError extends Error {
  constructor() {
    super('Presentations for this class were continued in another class. Nothing here can be changed. Open the other class, or reopen presentations here.');
    this.name = 'PresentationMovedError';
  }
}

function isPermutation(values: unknown, count: number): values is number[] {
  if (!Array.isArray(values) || values.length !== count) return false;
  const seen = new Set<number>();
  for (const v of values) {
    if (!isIndex(v, count) || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

function checkIds(values: unknown, what: string): string[] {
  if (!Array.isArray(values) || values.length > PRESENTATION_LIMITS.studentsPerDraw) throw new PresentationError(`${what} is not a list of students.`);
  const seen = new Set<string>();
  for (const v of values) {
    if (!isId(v)) throw new PresentationError(`${what} has an invalid student id.`);
    if (seen.has(v)) throw new PresentationError(`${what} lists a student twice.`);
    seen.add(v);
  }
  return [...(values as string[])];
}

function checkSuperseded(value: unknown): SupersededOrder {
  if (!isRecord(value) || typeof value.seed !== 'string' || !/^[0-9a-f]{16}$/.test(value.seed) || !isIso(value.drawnAt)) throw new PresentationError('A superseded order is unreadable.');
  const inputIds = checkIds(value.inputIds, 'A superseded order');
  if (!isPermutation(value.drawn, inputIds.length)) throw new PresentationError('A superseded order is not a complete order.');
  const order = { seed: value.seed, inputIds, drawn: [...value.drawn], drawnAt: value.drawnAt };
  if (!verifyOrder({ rule: 'ringwheel-shuffle-v1', ...order })) throw new PresentationError('A superseded order does not match its seed.');
  return order;
}

function checkOrder(value: unknown): DrawnOrder {
  if (!isRecord(value)) throw new PresentationError('The order is missing.');
  if (value.rule !== 'ringwheel-shuffle-v1' && value.rule !== 'carried-over') throw new PresentationError('The order names a rule this version does not know.');
  const inputIds = checkIds(value.inputIds, 'The order');
  if (inputIds.length === 0) throw new PresentationError('The order has no presenters.');
  if (!isPermutation(value.drawn, inputIds.length)) throw new PresentationError('The order does not hold each presenter exactly once.');
  if (!isIso(value.drawnAt)) throw new PresentationError('The order has no valid date.');
  if (!Array.isArray(value.superseded) || value.superseded.length > PRESENTATION_LIMITS.redraws) throw new PresentationError('The order has too many superseded orders.');
  const carried = value.rule === 'carried-over';
  if (carried ? value.seed !== null : typeof value.seed !== 'string' || !/^[0-9a-f]{16}$/.test(value.seed)) throw new PresentationError('The order has no valid seed.');
  let carriedFrom: DrawnOrder['carriedFrom'] = null;
  if (carried) {
    const from = value.carriedFrom;
    if (!isRecord(from) || !isId(from.classId) || !isId(from.drawId) || typeof from.atEvent !== 'number' || !Number.isInteger(from.atEvent) || from.atEvent < 0) {
      throw new PresentationError('A carried-over order does not say where it came from.');
    }
    if (from.seed !== null && (typeof from.seed !== 'string' || !/^[0-9a-f]{16}$/.test(from.seed))) throw new PresentationError('A carried-over order has an invalid original seed.');
    if (value.superseded.length > 0) throw new PresentationError('A carried-over order cannot have superseded orders.');
    carriedFrom = { classId: from.classId, drawId: from.drawId, atEvent: from.atEvent, seed: from.seed as string | null };
  } else if (value.carriedFrom !== null && value.carriedFrom !== undefined) {
    throw new PresentationError('A drawn order cannot also be carried over.');
  }
  const order: DrawnOrder = {
    rule: value.rule,
    seed: value.seed as string | null,
    inputIds,
    drawn: [...value.drawn],
    drawnAt: value.drawnAt,
    superseded: value.superseded.map(checkSuperseded),
    carriedFrom,
  };
  if (!verifyOrder(order)) throw new PresentationError(carried ? 'A carried-over order was rearranged.' : 'The order does not match its seed.');
  return order;
}

function checkCarried(value: unknown): CarriedState {
  if (!isRecord(value)) throw new PresentationError('A carried-over presenter is unreadable.');
  if (value.origin !== 'drawn' && value.origin !== 'added_later') throw new PresentationError('A carried-over presenter has an invalid origin.');
  if (value.drawnPosition !== null && !(typeof value.drawnPosition === 'number' && Number.isInteger(value.drawnPosition) && value.drawnPosition >= 1)) throw new PresentationError('A carried-over presenter has an invalid place.');
  if (typeof value.status !== 'string' || !ENTRY_STATUS.has(value.status) || value.status === 'done') throw new PresentationError('A carried-over presenter has an invalid state.');
  if (value.revealedAt !== null && !isIso(value.revealedAt)) throw new PresentationError('A carried-over presenter has an invalid reveal time.');
  if (value.notBefore !== null && !isDateKey(value.notBefore)) throw new PresentationError('A carried-over presenter has an invalid hold date.');
  if (value.skipReason !== null && !SKIP_REASONS.includes(value.skipReason as (typeof SKIP_REASONS)[number])) throw new PresentationError('A carried-over presenter has an invalid reason.');
  if ((value.status === 'skipped') !== (value.skipReason !== null)) throw new PresentationError('A carried-over presenter has a skip reason that does not match their state.');
  return {
    origin: value.origin,
    drawnPosition: value.drawnPosition as number | null,
    status: value.status as CarriedState['status'],
    revealedAt: value.revealedAt as string | null,
    notBefore: value.notBefore as string | null,
    skipReason: value.skipReason as CarriedState['skipReason'],
  };
}

function checkBase(value: unknown, order: DrawnOrder): DrawBase {
  if (!isRecord(value)) throw new PresentationError('The snapshot taken at the draw is missing.');
  const count = order.inputIds.length;
  if (!(typeof value.at === 'number' && Number.isInteger(value.at) && value.at >= 1)) throw new PresentationError('The snapshot does not say which draw it belongs to.');
  if (!Array.isArray(value.names) || value.names.length !== count || !value.names.every(isName)) throw new PresentationError('The snapshot names do not match the order.');
  if (!Array.isArray(value.leftOut) || value.leftOut.length > 5000) throw new PresentationError('The snapshot has an unreadable left-out list.');
  const leftOut = value.leftOut.map((item) => {
    if (!isRecord(item) || !isId(item.studentId) || !isName(item.name) || (item.why !== 'not_presenting' && item.why !== 'excluded')) throw new PresentationError('The snapshot has an unreadable left-out entry.');
    return { studentId: item.studentId, name: item.name, why: item.why as 'not_presenting' | 'excluded' };
  });
  if (!Array.isArray(value.exclusions) || !Array.isArray(value.meetings) || !Array.isArray(value.absences)) throw new PresentationError('The snapshot is incomplete.');
  if (value.meetings.length > PRESENTATION_LIMITS.meetingsPerDraw) throw new PresentationError('The snapshot has too many meeting dates.');
  if (typeof value.archived !== 'boolean') throw new PresentationError('The snapshot does not say whether the draw was archived.');
  const carriedOver = order.rule === 'carried-over';
  if (carriedOver !== Array.isArray(value.carried)) throw new PresentationError('The snapshot does not match the kind of order.');
  const carried = carriedOver ? (value.carried as unknown[]).map(checkCarried) : null;
  if (carried && carried.length !== count) throw new PresentationError('The carried-over snapshot does not match its order.');
  const absences = value.absences.map((a) => {
    if (!isRecord(a) || !isIndex(a.entry, count) || !isDateKey(a.date)) throw new PresentationError('The snapshot has an unreadable absence.');
    return makeAbsence({ entry: a.entry, date: a.date });
  });
  if (!carriedOver && (absences.length > 0 || value.archived)) throw new PresentationError('A snapshot taken at a draw cannot already hold absences or be archived.');
  return {
    at: value.at,
    names: [...(value.names as string[])],
    leftOut,
    exclusions: value.exclusions.map(checkExclusion),
    timing: checkTiming(value.timing),
    meetings: value.meetings.map(checkMeeting),
    absences,
    archived: value.archived,
    carried,
  };
}

function checkEvent(value: unknown, n: number): DrawEvent {
  if (!isRecord(value) || value.n !== n) throw new PresentationError(`The log is not numbered 1, 2, 3 with no gaps (at ${n}).`);
  if (!isIso(value.at)) throw new PresentationError(`Event ${n} has no valid time.`);
  if (typeof value.t !== 'string' || !EVENT_KINDS.has(value.t)) throw new PresentationError(`Event ${n} is of a kind this version does not know.`);
  if (value.e !== undefined && !(typeof value.e === 'number' && Number.isInteger(value.e) && value.e >= 0)) throw new PresentationError(`Event ${n} names an invalid presenter.`);
  if (value.f !== undefined && !isRecord(value.f)) throw new PresentationError(`Event ${n} has an unreadable outcome.`);
  if (value.u !== undefined && !(typeof value.u === 'number' && Number.isInteger(value.u) && value.u >= 1 && value.u < n)) throw new PresentationError(`Event ${n} undoes an event that does not come before it.`);
  if ((value.t === 'undo') !== (value.u !== undefined)) throw new PresentationError(`Event ${n} is not a well-formed undo.`);
  return makeEvent({ n, at: value.at, t: value.t as EventKind, e: value.e as number | undefined, f: value.f === undefined ? undefined : (JSON.parse(JSON.stringify(value.f)) as Rec), u: value.u as number | undefined });
}

function checkEntry(value: unknown): DrawEntry {
  if (!isRecord(value) || !isId(value.studentId) || !isName(value.nameAtDraw)) throw new PresentationError('A presenter record is unreadable.');
  if (typeof value.status !== 'string' || !ENTRY_STATUS.has(value.status)) throw new PresentationError('A presenter has an invalid state.');
  return makeEntry(value as unknown as DrawEntry);
}

function checkDraw(value: unknown): PresentationDraw {
  if (!isRecord(value) || !isId(value.id)) throw new PresentationError('A draw has no valid id.');
  const where = `Draw "${typeof value.title === 'string' ? value.title.slice(0, 40) : value.id}"`;
  try {
    if (typeof value.title !== 'string' || value.title.trim() === '' || value.title.length > PRESENTATION_LIMITS.titleLength) throw new PresentationError('has no valid title.');
    if (!isIso(value.createdAt)) throw new PresentationError('has no valid creation date.');
    if (typeof value.status !== 'string' || !DRAW_STATUS.has(value.status)) throw new PresentationError('has an invalid status.');
    for (const key of ['entries', 'sequence', 'exclusions', 'absences', 'meetings', 'events'] as const) {
      if (!Array.isArray(value[key])) throw new PresentationError(`has no ${key} list.`);
    }
    const rawEvents = value.events as unknown[];
    const events = rawEvents.map((event, i) => checkEvent(event, i + 1));
    const timing = checkTiming(value.timing);
    const meetings = (value.meetings as unknown[]).map(checkMeeting);
    if (meetings.length > PRESENTATION_LIMITS.meetingsPerDraw) throw new PresentationError('has too many meeting dates.');
    if (new Set(meetings.map((m) => m.date)).size !== meetings.length) throw new PresentationError('lists a meeting date twice.');
    const exclusions = (value.exclusions as unknown[]).map(checkExclusion);
    if (new Set(exclusions.map((x) => x.studentId)).size !== exclusions.length) throw new PresentationError('excludes a student twice.');
    const head = { id: value.id, title: value.title, createdAt: value.createdAt };

    if (value.status === 'draft') {
      if (value.order !== null || value.base !== null) throw new PresentationError('is a draft but already has an order.');
      if ((value.entries as unknown[]).length || (value.sequence as unknown[]).length || (value.absences as unknown[]).length || events.length) throw new PresentationError('is a draft but already has history.');
      return { ...head, status: 'draft', order: null, base: null, entries: [], sequence: [], exclusions, absences: [], timing, meetings: [...meetings].sort((a, b) => a.date.localeCompare(b.date)), events: [] };
    }

    const order = checkOrder(value.order);
    const base = checkBase(value.base, order);
    const marker = events[base.at - 1];
    if (!marker || (marker.t !== 'drawn' && marker.t !== 'redrawn')) throw new PresentationError('has a snapshot that does not belong to a draw.');
    const drawsSoFar = events.filter((e) => e.t === 'drawn' || e.t === 'redrawn');
    if (drawsSoFar.length !== order.superseded.length + 1 || drawsSoFar[drawsSoFar.length - 1].n !== base.at) throw new PresentationError('has a different number of draws in its log than in its record.');
    if ((value.entries as unknown[]).length > PRESENTATION_LIMITS.studentsPerDraw) throw new PresentationError('has too many presenters.');

    // The saved state, in canonical form, must be exactly what the log replays to.
    const saved = {
      entries: (value.entries as unknown[]).map(checkEntry),
      sequence: value.sequence as number[],
      exclusions,
      absences: (value.absences as unknown[]).map((a) => makeAbsence(a as { entry: number; date: string })),
      timing,
      meetings,
      status: value.status,
    };
    let replayed;
    try {
      replayed = replay(order, base, events);
    } catch (err) {
      throw new PresentationError(`has a log that cannot be replayed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const key of ['entries', 'sequence', 'exclusions', 'absences', 'timing', 'meetings', 'status'] as const) {
      if (!same(saved[key], replayed[key])) throw new PresentationError(`has saved ${key} that do not match its log.`);
    }
    return { ...head, status: replayed.status, order, base, entries: replayed.entries, sequence: replayed.sequence, exclusions: replayed.exclusions, absences: replayed.absences, timing: replayed.timing, meetings: replayed.meetings, events };
  } catch (err) {
    throw new PresentationError(`${where} ${err instanceof Error ? err.message : String(err)}`);
  }
}

function checkClassLog(value: unknown): ClassLogEntry[] {
  if (!Array.isArray(value)) throw new PresentationError('The class log is missing.');
  return value.map((entry, i): ClassLogEntry => {
    const n = i + 1;
    if (!isRecord(entry) || entry.n !== n || !isIso(entry.at)) throw new PresentationError(`The class log is not numbered 1, 2, 3 with no gaps (at ${n}).`);
    const head = { n, at: entry.at };
    switch (entry.t) {
      case 'not_presenting':
        if (!isId(entry.studentId) || !INACTIVE_REASONS.includes(entry.reason as (typeof INACTIVE_REASONS)[number])) throw new PresentationError(`Class log entry ${n} is unreadable.`);
        return { ...head, t: 'not_presenting', studentId: entry.studentId, reason: entry.reason as (typeof INACTIVE_REASONS)[number] };
      case 'presenting':
        if (!isId(entry.studentId)) throw new PresentationError(`Class log entry ${n} is unreadable.`);
        return { ...head, t: 'presenting', studentId: entry.studentId };
      case 'moved':
        // A class that holds presentation data always has a revision of 2 or more.
        if (!isId(entry.classId) || !isDateKey(entry.on) || !(typeof entry.classRev === 'number' && Number.isSafeInteger(entry.classRev) && entry.classRev >= 2)) {
          throw new PresentationError(`Class log entry ${n} is unreadable.`);
        }
        return { ...head, t: 'moved', classId: entry.classId, on: entry.on, classRev: entry.classRev };
      case 'reopened':
        return { ...head, t: 'reopened' };
      default:
        throw new PresentationError(`Class log entry ${n} is of a kind this version does not know.`);
    }
  });
}

export type PresentationCheck = { ok: true; value: PresentationData } | { ok: false; problems: string[] };

/** Shape, orders, replay and the class log. Returns the data in canonical form or throws. No size limits. */
function parsePresentation(raw: unknown): PresentationData {
  if (!isRecord(raw)) throw new PresentationError('The presentation data is not readable.');
  if (typeof raw.epoch !== 'string' || raw.epoch.length > 80) throw new PresentationError('The presentation data has no valid lineage id.');
  if (!(typeof raw.rev === 'number' && Number.isInteger(raw.rev) && raw.rev >= 0)) throw new PresentationError('The presentation data has no valid revision.');
  if (raw.updatedAt !== '' && !isIso(raw.updatedAt)) throw new PresentationError('The presentation data has no valid update time.');
  if (!Array.isArray(raw.draws)) throw new PresentationError('The presentation data has no list of draws.');

  const classLog = checkClassLog(raw.classLog);
  const folded = foldClassLog(classLog);
  if (!same(raw.inactive, folded.inactive)) throw new PresentationError('The list of students not presenting does not match the class log.');
  if (!same(raw.movedTo ?? null, folded.movedTo)) throw new PresentationError('The "continued in another class" marker does not match the class log.');

  let continuedFrom: PresentationData['continuedFrom'] = null;
  if (raw.continuedFrom !== null && raw.continuedFrom !== undefined) {
    const from = raw.continuedFrom;
    if (!isRecord(from) || !isId(from.classId) || !(typeof from.marker === 'number' && Number.isInteger(from.marker) && from.marker >= 1)) {
      throw new PresentationError('The record of which class this continues is unreadable.');
    }
    continuedFrom = { classId: from.classId, marker: from.marker };
  }

  const draws = raw.draws.map(checkDraw);
  if (new Set(draws.map((d) => d.id)).size !== draws.length) throw new PresentationError('Two draws have the same id.');
  return { epoch: raw.epoch, rev: raw.rev, updatedAt: raw.updatedAt as string, classLog, inactive: folded.inactive, movedTo: folded.movedTo, continuedFrom, draws };
}

/**
 * Check presentation data from top to bottom, size limits included, and
 * return it in canonical form. One problem anywhere fails the whole thing.
 * Used for data arriving from a backup file.
 */
export function validatePresentation(raw: unknown, limits: CapacityLimits = PRESENTATION_LIMITS): PresentationCheck {
  try {
    const value = parsePresentation(raw);
    const { budgetBytes, reserveBytes, carryBytes } = limits;
    // Only the "continued in another class" marker may use the reserve.
    if (presentationFileBytes(value) > (value.movedTo ? budgetBytes : budgetBytes - reserveBytes)) {
      throw new PresentationError('The presentation history is larger than a class can hold.');
    }
    if (carryBound(value) > carryBytes) throw new PresentationError('The class holds more unfinished presentation work than can be carried into a new class.');
    return { ok: true, value };
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
  }
}

/** True when a single stored draw still replays to its saved state. Used when a draw is opened. */
export function drawIsConsistent(draw: unknown): { ok: true } | { ok: false; problem: string } {
  try {
    checkDraw(draw);
    return { ok: true };
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check a write against what was stored before it. History only grows:
 * no drawn order, superseded order, earlier event or class-log entry may be
 * removed or changed, and a class that was continued elsewhere may only be reopened.
 */
export function checkTransition(before: PresentationData | undefined, after: PresentationData): void {
  if (!before) return;
  const grewBy = <T>(was: T[], now: T[]): boolean => now.length >= was.length && same(now.slice(0, was.length), was);

  if (!grewBy(before.classLog, after.classLog)) throw new PresentationInvalidError(['The class log can only be added to.']);
  if (!same(before.continuedFrom, after.continuedFrom)) throw new PresentationInvalidError(['The record of which class this continues cannot change.']);

  if (before.movedTo) {
    const added = after.classLog.slice(before.classLog.length);
    const reopenOnly = added.length === 1 && added[0].t === 'reopened' && same(before.draws, after.draws);
    if (!reopenOnly) throw new PresentationMovedError();
  }

  for (const was of before.draws) {
    const now = after.draws.find((d) => d.id === was.id);
    if (!now) {
      // A draft that was never drawn holds no order and no history, so it may be discarded.
      if (was.order === null) continue;
      throw new PresentationInvalidError([`Draw "${was.title}" has a drawn order and cannot be removed.`]);
    }
    if (was.createdAt !== now.createdAt) throw new PresentationInvalidError([`Draw "${was.title}" cannot change its creation date.`]);
    if (!grewBy(was.events, now.events)) throw new PresentationInvalidError([`The log of draw "${was.title}" can only be added to.`]);
    if (was.order === null) continue;
    if (now.order === null) throw new PresentationInvalidError([`Draw "${was.title}" cannot lose its order.`]);
    const { superseded: wasSuperseded, ...wasOrder } = was.order;
    const { superseded: nowSuperseded, ...nowOrder } = now.order;
    if (same(wasOrder, nowOrder)) {
      if (!same(wasSuperseded, nowSuperseded) || !same(was.base, now.base)) throw new PresentationInvalidError([`The order of draw "${was.title}" cannot be changed.`]);
    } else {
      // The only way an order changes is a redraw: the old order moves, whole, to the superseded list.
      const kept = { seed: was.order.seed, inputIds: was.order.inputIds, drawn: was.order.drawn, drawnAt: was.order.drawnAt };
      const isRedraw = was.status === 'ready' && same(nowSuperseded, [...wasSuperseded, kept]) && now.events.length === was.events.length + 1 && now.events[now.events.length - 1].t === 'redrawn';
      if (!isRedraw) throw new PresentationInvalidError([`The order of draw "${was.title}" cannot be changed.`]);
    }
  }
}

/**
 * The single gate. Every presentation write passes through here before it is
 * stored: revision and lineage are set, the result is validated and replayed,
 * the change is checked against the previous state, and capacity is checked.
 * Throws, with nothing stored, if any of these fail.
 */
export function commitPresentation(
  before: PresentationData | undefined,
  proposed: PresentationData,
  at: string,
  newEpoch: () => string,
  limits: CapacityLimits = PRESENTATION_LIMITS
): PresentationData {
  let checked: PresentationData;
  try {
    checked = parsePresentation({ ...proposed, epoch: before?.epoch || newEpoch(), rev: (before?.rev ?? 0) + 1, updatedAt: at });
  } catch (err) {
    throw new PresentationInvalidError([err instanceof Error ? err.message : String(err)]);
  }
  checkTransition(before, checked);
  checkCapacity(before, checked, limits);
  return checked;
}
