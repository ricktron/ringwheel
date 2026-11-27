/**
 * "Continue in a new class": what the new class's presentation data is.
 *
 * Pure. Given the old class's presentation data and the "moved" marker, it
 * always returns the same result, so a retry from any tab builds the same
 * thing.
 *
 * - Every draw with someone still to present is carried over in its current
 *   order. Nothing is reshuffled.
 * - Each unfinished presenter keeps their state: revealed or on deck, holds,
 *   a skip, and an absence recorded for the day of the move.
 * - Exclusions, timing and meeting dates are carried.
 * - Drafts are copied as drafts. Finished draws stay in the old class.
 * - The new class gets its own class log, consistent with the eligibility it
 *   inherits. It is never marked as "moved" itself.
 */
import { replay } from './replay';
import {
  SKIP_REASONS,
  makeEvent,
  makeExclusion,
  makeMeeting,
  makeTiming,
  type CarriedState,
  type ClassLogEntry,
  type DateKey,
  type DrawBase,
  type DrawnOrder,
  type PresentationData,
  type PresentationDraw,
} from './types';

export interface CarryMarker {
  /** The old class. */
  sourceClassId: string;
  /** The number of the 'moved' entry in the old class's log. */
  n: number;
  at: string;
  /** The day of the move. Absences recorded for this day travel with the presenter. */
  on: DateKey;
}

const LONGEST_SKIP_REASON = [...SKIP_REASONS].sort((a, b) => b.length - a.length)[0];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** True when the draw has an order and someone in it has not presented and was not skipped. */
export const hasUnfinishedPresenters = (draw: PresentationDraw): boolean =>
  draw.order !== null && draw.entries.some((e) => e.status === 'waiting' || e.status === 'presenting' || e.status === 'on_deck');

function carryDraw(draw: PresentationDraw, marker: CarryMarker, worstCase: boolean): PresentationDraw {
  const sourceOrder = draw.order as DrawnOrder;
  // Everyone who has not presented, in the current working order. Skipped presenters come too, so a skip can still be reversed.
  const kept = draw.sequence.filter((index) => worstCase || draw.entries[index].status !== 'done');
  const newIndex = new Map(kept.map((index, i) => [index, i]));

  const carried: CarriedState[] = kept.map((index) => {
    const entry = draw.entries[index];
    if (worstCase) {
      // The largest state a presenter could reach through any later action.
      return { origin: entry.origin, drawnPosition: entry.drawnPosition, status: 'presenting', revealedAt: '9999-12-31T23:59:59.999Z', notBefore: '9999-12-31', skipReason: LONGEST_SKIP_REASON };
    }
    return {
      origin: entry.origin,
      drawnPosition: entry.drawnPosition,
      status: entry.status as CarriedState['status'],
      revealedAt: entry.revealedAt,
      notBefore: entry.notBefore,
      skipReason: entry.skipReason,
    };
  });

  const order: DrawnOrder = {
    rule: 'carried-over',
    seed: null,
    inputIds: kept.map((index) => draw.entries[index].studentId),
    drawn: kept.map((_, i) => i),
    drawnAt: marker.at,
    superseded: [],
    carriedFrom: {
      classId: marker.sourceClassId,
      drawId: draw.id,
      // In the worst case this is a fixed large number, so a growing log can never change the size estimate.
      atEvent: worstCase ? 9999999 : draw.events.length,
      // Where the random order really came from, however many times it has been carried.
      seed: sourceOrder.rule === 'carried-over' ? (sourceOrder.carriedFrom?.seed ?? null) : sourceOrder.seed,
    },
  };
  const base: DrawBase = {
    at: 1,
    names: kept.map((index) => draw.entries[index].nameAtDraw),
    leftOut: [],
    exclusions: draw.exclusions.map(makeExclusion),
    timing: makeTiming(draw.timing),
    meetings: draw.meetings.map(makeMeeting),
    absences: worstCase
      ? kept.map((_, i) => ({ entry: i, date: marker.on }))
      : draw.absences.filter((a) => a.date === marker.on && newIndex.has(a.entry)).map((a) => ({ entry: newIndex.get(a.entry) as number, date: a.date })),
    archived: worstCase ? false : draw.status === 'archived',
    carried,
  };
  const events = [makeEvent({ n: 1, at: marker.at, t: 'drawn' })];
  return { id: draw.id, title: draw.title, createdAt: draw.createdAt, order, base, ...replay(order, base, events), events };
}

/**
 * The presentation data for the class that continues `source`.
 *
 * With `worstCase`, every drawn draw is carried with every presenter in the
 * largest state they could ever reach. Nothing a teacher does later can make
 * the real result larger than that, which is what the capacity rule relies on.
 */
export function buildContinuation(source: PresentationData, marker: CarryMarker, worstCase = false): PresentationData {
  const classLog: ClassLogEntry[] = source.inactive.map((item, i) => ({
    n: i + 1,
    at: item.since,
    t: 'not_presenting',
    studentId: item.studentId,
    reason: item.reason,
  }));
  const draws: PresentationDraw[] = [];
  for (const draw of source.draws) {
    if (draw.order === null) draws.push(clone(draw));
    else if (worstCase || hasUnfinishedPresenters(draw)) draws.push(carryDraw(draw, marker, worstCase));
  }
  return {
    epoch: '',
    rev: 0,
    updatedAt: marker.at,
    classLog,
    inactive: source.inactive.map((item) => ({ studentId: item.studentId, reason: item.reason, since: item.since })),
    movedTo: null,
    continuedFrom: { classId: marker.sourceClassId, marker: marker.n },
    draws,
  };
}
