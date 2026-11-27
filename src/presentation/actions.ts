/**
 * Teacher actions on a drawn order.
 *
 * Each action names the presenter and the state it expects ("mark entry 7
 * done"). `act` works out the outcome against the draw it is given, checks the
 * expectation, and appends one event that records the outcome. If the
 * expectation does not hold it throws and changes nothing.
 */
import { nextOnDeck, nextUp, passOverReason, type EligibilityContext } from './eligibility';
import { applyEvent, lastUndoable, replay, statusOf, type DrawState } from './replay';
import {
  PRESENTATION_LIMITS,
  PresentationError,
  makeAbsence,
  makeEntry,
  makeEvent,
  makeExclusion,
  makeMeeting,
  makeTiming,
  nextDay,
  type DateKey,
  type DrawEvent,
  type ExclusionReason,
  type Meeting,
  type PresentationDraw,
  type SkipReason,
  type Timing,
} from './types';

export type DrawAction =
  | { type: 'reveal'; entry: number }
  | { type: 'on_deck'; entry: number }
  | { type: 'done'; entry: number }
  | { type: 'defer'; entry: number; how: 'after_next' | 'next_meeting' | 'end' }
  | { type: 'absent'; entry: number }
  | { type: 'present'; entry: number }
  | { type: 'skip'; entry: number; reason: SkipReason }
  | { type: 'restore'; entry: number }
  | { type: 'add_later'; studentId: string }
  | { type: 'exclude'; studentId: string; reason: ExclusionReason; backOn: DateKey | null }
  | { type: 'include'; studentId: string }
  | { type: 'schedule'; timing?: Partial<Timing>; meeting?: Meeting; remove?: DateKey }
  | { type: 'archive' }
  | { type: 'unarchive' }
  /** `event` is the number of the action the teacher is looking at and wants reversed. */
  | { type: 'undo'; event: number };

export interface ActionContext extends EligibilityContext {
  /** ISO time of the action. */
  at: string;
}

const stateOf = (draw: PresentationDraw): DrawState => ({
  entries: draw.entries.map(makeEntry),
  sequence: [...draw.sequence],
  exclusions: draw.exclusions.map(makeExclusion),
  absences: draw.absences.map(makeAbsence),
  timing: makeTiming(draw.timing),
  meetings: draw.meetings.map(makeMeeting),
  archived: draw.status === 'archived',
});

const refuse = (message: string): never => {
  throw new PresentationError(message);
};

/** Encode who was passed over at a reveal: "entry:reason" pairs, at most fifty, plus a count of any more. */
function passedOutcome(passed: [number, number][]): Record<string, unknown> | undefined {
  if (passed.length === 0) return undefined;
  const kept = passed.slice(0, PRESENTATION_LIMITS.passedPairsPerReveal);
  const outcome: Record<string, unknown> = { passed: kept.map(([entry, code]) => `${entry}:${code}`).join(' ') };
  if (passed.length > kept.length) outcome.more = passed.length - kept.length;
  return outcome;
}

function outcomeOf(draw: PresentationDraw, action: Exclude<DrawAction, { type: 'undo' }>, ctx: ActionContext): Omit<DrawEvent, 'n' | 'at'> {
  const entryAt = (index: number) => draw.entries[index] ?? refuse('That presenter is not in this draw.');

  switch (action.type) {
    case 'reveal': {
      const next = nextUp(draw, ctx);
      if (next.entry === null) refuse('Nobody is available to present right now.');
      if (next.entry !== action.entry) refuse('The next presenter is no longer the one this page was showing.');
      const f = passedOutcome(next.passed);
      return f ? { t: 'revealed', e: action.entry, f } : { t: 'revealed', e: action.entry };
    }
    case 'on_deck': {
      if (nextOnDeck(draw, ctx) !== action.entry) refuse('The presenter to put on deck is no longer the one this page was showing.');
      return { t: 'on_deck', e: action.entry };
    }
    case 'done':
      if (entryAt(action.entry).status !== 'presenting') refuse('That presenter is not the one presenting now.');
      return { t: 'done', e: action.entry, f: { on: ctx.today } };
    case 'defer': {
      const entry = entryAt(action.entry);
      if (entry.status !== 'waiting' && entry.status !== 'on_deck' && entry.status !== 'presenting') refuse('That presenter is not waiting to present.');
      if (action.how === 'end') return { t: 'deferred', e: action.entry, f: { to: draw.sequence.length - 1 } };
      if (action.how === 'next_meeting') {
        const upcoming = draw.meetings.find((m) => m.state === 'planned' && m.date > ctx.today);
        return { t: 'deferred', e: action.entry, f: { notBefore: upcoming ? upcoming.date : nextDay(ctx.today) } };
      }
      // After the next available presenter: find them in the order with this one taken out.
      const rest = draw.sequence.filter((index) => index !== action.entry);
      const from = draw.sequence.indexOf(action.entry);
      const after = rest.findIndex((index, place) => place >= from && draw.entries[index].status === 'waiting' && passOverReason(draw, index, ctx) === null);
      if (after < 0) refuse('There is nobody available to go ahead of them. Choose "end of the order" or "next meeting".');
      return { t: 'deferred', e: action.entry, f: { to: after + 1 } };
    }
    case 'absent': {
      const entry = entryAt(action.entry);
      if (entry.status === 'done' || entry.status === 'skipped') refuse('That presenter is no longer waiting to present.');
      if (draw.absences.some((a) => a.entry === action.entry && a.date === ctx.today)) refuse('That presenter is already marked absent today.');
      return { t: 'absent', e: action.entry, f: { on: ctx.today } };
    }
    case 'present':
      entryAt(action.entry);
      if (!draw.absences.some((a) => a.entry === action.entry && a.date === ctx.today)) refuse('That presenter is not marked absent today.');
      return { t: 'present', e: action.entry, f: { on: ctx.today } };
    case 'skip': {
      const entry = entryAt(action.entry);
      if (entry.status === 'done' || entry.status === 'skipped') refuse('That presenter is no longer waiting to present.');
      return { t: 'skipped', e: action.entry, f: { why: action.reason } };
    }
    case 'restore':
      if (entryAt(action.entry).status !== 'skipped') refuse('That presenter was not skipped.');
      return { t: 'restored', e: action.entry };
    case 'add_later': {
      const student = ctx.roster.find((s) => s.id === action.studentId) ?? refuse('That student is not on the roster.');
      if (draw.entries.some((e) => e.studentId === action.studentId)) refuse('That student is already in this draw.');
      // Added by the teacher, at the end. Nobody else's place changes.
      return { t: 'added_later', f: { studentId: student.id, name: student.name } };
    }
    case 'exclude':
      if (draw.exclusions.some((x) => x.studentId === action.studentId)) refuse('That student is already excluded from this draw.');
      return { t: 'excluded', f: { studentId: action.studentId, why: action.reason, backOn: action.backOn } };
    case 'include':
      if (!draw.exclusions.some((x) => x.studentId === action.studentId)) refuse('That student is not excluded from this draw.');
      return { t: 'included', f: { studentId: action.studentId } };
    case 'schedule': {
      const f: Record<string, unknown> = {};
      if (action.timing && Object.keys(action.timing).length > 0) f.timing = action.timing;
      if (action.meeting) f.meeting = makeMeeting(action.meeting);
      if (action.remove !== undefined) f.remove = action.remove;
      return { t: 'schedule', f };
    }
    case 'archive':
      if (draw.status === 'archived') refuse('This draw is already archived.');
      return { t: 'archived' };
    case 'unarchive':
      if (draw.status !== 'archived') refuse('This draw is not archived.');
      return { t: 'unarchived' };
  }
}

/**
 * Apply one teacher action to a drawn order and return the new draw.
 * The input is not modified. Throws PresentationError, with nothing changed,
 * if the action does not fit the draw as it is.
 */
export function act(draw: PresentationDraw, action: DrawAction, ctx: ActionContext): PresentationDraw {
  if (!draw.order || !draw.base) return refuse('The order has not been drawn yet.');
  const n = draw.events.length + 1;

  if (action.type === 'undo') {
    const target = lastUndoable(draw.events, draw.base.at);
    if (!target) return refuse('There is nothing to undo.');
    if (target.n !== action.event) return refuse('The most recent action is no longer the one this page was showing.');
    const events = [...draw.events, makeEvent({ n, at: ctx.at, t: 'undo', u: target.n })];
    // Undo is replay without the undone action: the earlier state, exactly.
    return { ...draw, ...replay(draw.order, draw.base, events), events };
  }

  if (draw.status === 'archived' && action.type !== 'unarchive') return refuse('This draw is archived. Restore it from the archive first.');
  const event = makeEvent({ n, at: ctx.at, ...outcomeOf(draw, action, ctx) });
  const state = applyEvent(stateOf(draw), event);
  return {
    ...draw,
    entries: state.entries,
    sequence: state.sequence,
    exclusions: state.exclusions,
    absences: state.absences,
    timing: state.timing,
    meetings: state.meetings,
    status: statusOf(state),
    events: [...draw.events, event],
  };
}
