/**
 * Creating a draw and drawing its order.
 *
 * The order is made once, from a stored seed, with the same seeded shuffle the
 * Ecology engine exports. Nothing in the engine is changed, and nothing here
 * ever recalculates an order that already exists.
 */
import { createRng, shuffle } from '../utils/spin-engine';
import { eligibleForDraw } from './eligibility';
import { checkExclusion, checkMeeting, checkTiming, replay } from './replay';
import {
  DEFAULT_TIMING,
  PRESENTATION_LIMITS,
  PresentationError,
  makeEvent,
  makeExclusion,
  makeMeeting,
  makeTiming,
  type DrawBase,
  type DrawExclusion,
  type DrawnOrder,
  type InactiveStudent,
  type Meeting,
  type PresentationDraw,
  type RosterEntry,
  type Timing,
} from './types';

export const SHUFFLE_RULE = 'ringwheel-shuffle-v1' as const;

/** The order a seed gives for `count` students, as positions. This is the whole algorithm. */
export function shuffledPositions(count: number, seed: string): number[] {
  return shuffle(Array.from({ length: count }, (_, i) => i), createRng(seed));
}

/** True when a stored order is exactly what its seed and inputs produce (or, for a carried-over order, is untouched). */
export function verifyOrder(order: Pick<DrawnOrder, 'rule' | 'seed' | 'inputIds' | 'drawn'>): boolean {
  const count = order.inputIds.length;
  if (order.drawn.length !== count) return false;
  if (order.rule === 'carried-over') return order.seed === null && order.drawn.every((position, i) => position === i);
  if (typeof order.seed !== 'string') return false;
  const expected = shuffledPositions(count, order.seed);
  return expected.every((position, i) => position === order.drawn[i]);
}

export function newDraft(id: string, title: string, at: string, timing: Timing = DEFAULT_TIMING): PresentationDraw {
  const clean = title.trim().replace(/\s+/g, ' ').slice(0, PRESENTATION_LIMITS.titleLength);
  if (clean === '') throw new PresentationError('Give the draw a title.');
  return {
    id,
    title: clean,
    createdAt: at,
    status: 'draft',
    order: null,
    base: null,
    entries: [],
    sequence: [],
    exclusions: [],
    absences: [],
    timing: checkTiming(timing),
    meetings: [],
    events: [],
  };
}

export interface DraftPatch {
  title?: string;
  timing?: Partial<Timing>;
  /** Add or replace these meeting dates. */
  meetings?: Meeting[];
  removeMeetings?: string[];
  /** Add or replace these exclusions. */
  exclusions?: DrawExclusion[];
  removeExclusions?: string[];
}

/** Change a draft before its order is drawn. Nothing fairness-relevant exists yet, so these edits are not logged. */
export function editDraft(draw: PresentationDraw, patch: DraftPatch): PresentationDraw {
  if (draw.status !== 'draft') throw new PresentationError('The order has been drawn. Use the schedule and exclusion actions, which are recorded.');
  const next: PresentationDraw = { ...draw };
  if (patch.title !== undefined) next.title = newDraft(draw.id, patch.title, draw.createdAt).title;
  if (patch.timing) next.timing = checkTiming({ ...draw.timing, ...patch.timing });

  let meetings = draw.meetings.map(makeMeeting);
  for (const meeting of patch.meetings ?? []) {
    const checked = checkMeeting(meeting);
    meetings = [...meetings.filter((m) => m.date !== checked.date), checked];
  }
  if (patch.removeMeetings) meetings = meetings.filter((m) => !patch.removeMeetings!.includes(m.date));
  if (meetings.length > PRESENTATION_LIMITS.meetingsPerDraw) throw new PresentationError(`A draw can hold at most ${PRESENTATION_LIMITS.meetingsPerDraw} meeting dates.`);
  next.meetings = meetings.sort((a, b) => a.date.localeCompare(b.date));

  let exclusions = draw.exclusions.map(makeExclusion);
  for (const exclusion of patch.exclusions ?? []) {
    const checked = checkExclusion(exclusion);
    exclusions = [...exclusions.filter((x) => x.studentId !== checked.studentId), checked];
  }
  if (patch.removeExclusions) exclusions = exclusions.filter((x) => !patch.removeExclusions!.includes(x.studentId));
  next.exclusions = exclusions;
  return next;
}

/** Change the title at any time. The title is a label, not part of the order or its history. */
export function retitle(draw: PresentationDraw, title: string): PresentationDraw {
  return { ...draw, title: newDraft(draw.id, title, draw.createdAt).title };
}

export interface DrawContext {
  roster: RosterEntry[];
  inactive: InactiveStudent[];
  /** 16 hex characters from the browser's secure generator (`randomSeed()`). */
  seed: string;
  at: string;
}

/**
 * Draw the order (for a draft), or redraw it (only while nothing has been
 * revealed, at most five times). The previous order is kept, in full, under
 * `superseded`. A redraw cannot be undone.
 */
export function drawOrder(draw: PresentationDraw, ctx: DrawContext): PresentationDraw {
  const redraw = draw.status !== 'draft';
  if (redraw) {
    if (draw.status !== 'ready') throw new PresentationError('The order can only be redrawn before anything has happened in it.');
    if (!draw.order || draw.order.rule !== SHUFFLE_RULE) throw new PresentationError('A carried-over order keeps its order. It cannot be redrawn.');
    if (draw.order.superseded.length >= PRESENTATION_LIMITS.redraws) {
      throw new PresentationError(`This order has been redrawn ${PRESENTATION_LIMITS.redraws} times, which is the limit. Start a new draw instead.`);
    }
  }
  if (!/^[0-9a-f]{16}$/.test(ctx.seed)) throw new PresentationError('The draw needs a valid seed.');

  const { inputs, leftOut } = eligibleForDraw(ctx.roster, ctx.inactive, draw.exclusions);
  if (inputs.length === 0) throw new PresentationError('Nobody is eligible to present. Check who is excluded or marked as not presenting.');
  if (inputs.length > PRESENTATION_LIMITS.studentsPerDraw) {
    throw new PresentationError(`${inputs.length} students are eligible. A draw can hold at most ${PRESENTATION_LIMITS.studentsPerDraw}.`);
  }

  const n = draw.events.length + 1;
  const order: DrawnOrder = {
    rule: SHUFFLE_RULE,
    seed: ctx.seed,
    inputIds: inputs.map((student) => student.id),
    drawn: shuffledPositions(inputs.length, ctx.seed),
    drawnAt: ctx.at,
    superseded: redraw
      ? [...draw.order!.superseded, { seed: draw.order!.seed as string, inputIds: draw.order!.inputIds, drawn: draw.order!.drawn, drawnAt: draw.order!.drawnAt }]
      : [],
    carriedFrom: null,
  };
  const base: DrawBase = {
    at: n,
    names: inputs.map((student) => student.name),
    leftOut,
    exclusions: draw.exclusions.map(makeExclusion),
    timing: makeTiming(draw.timing),
    meetings: draw.meetings.map(makeMeeting),
    absences: [],
    archived: false,
    carried: null,
  };
  const events = [...draw.events, makeEvent({ n, at: ctx.at, t: redraw ? 'redrawn' : 'drawn' })];
  return { id: draw.id, title: draw.title, createdAt: draw.createdAt, order, base, ...replay(order, base, events), events };
}
