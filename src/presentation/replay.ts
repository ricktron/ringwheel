/**
 * Replay: rebuild a draw's state from its order, its snapshot and its events.
 *
 * `replay(order, base, events)` reads nothing else. It does not look at the
 * roster, class-level eligibility, other draws, the clock, or the draw's own
 * saved state. That is what lets the saved state be checked against its log.
 *
 * The same `applyEvent` is used when the teacher acts and when a log is
 * replayed, so the two can never disagree.
 */
import {
  EXCLUSION_REASONS,
  PRESENTATION_LIMITS,
  PresentationError,
  SKIP_REASONS,
  isDateKey,
  makeAbsence,
  makeEntry,
  makeExclusion,
  makeMeeting,
  makeTiming,
  type Absence,
  type DrawBase,
  type DrawEntry,
  type DrawEvent,
  type DrawExclusion,
  type DrawStatus,
  type DrawnOrder,
  type EventKind,
  type Meeting,
  type Timing,
} from './types';

/** The part of a draw that replay reconstructs. */
export interface DrawState {
  entries: DrawEntry[];
  sequence: number[];
  exclusions: DrawExclusion[];
  absences: Absence[];
  timing: Timing;
  meetings: Meeting[];
  archived: boolean;
}

export interface ReplayResult extends Omit<DrawState, 'archived'> {
  status: Exclude<DrawStatus, 'draft'>;
}

const UNDOABLE: ReadonlySet<EventKind> = new Set<EventKind>([
  'revealed', 'on_deck', 'done', 'deferred', 'absent', 'present', 'skipped', 'restored',
  'added_later', 'excluded', 'included', 'schedule', 'archived', 'unarchived',
]);

const fail = (message: string): never => {
  throw new PresentationError(message);
};

const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const isMinutes = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1440;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= PRESENTATION_LIMITS.studentsPerDraw;

export function checkTiming(value: unknown): Timing {
  const t = value as Timing;
  if (!t || typeof t !== 'object') return fail('The timing is missing.');
  for (const key of ['minutesPerPresentation', 'changeoverMinutes', 'minutesAvailable', 'breakMinutes'] as const) {
    if (!isMinutes(t[key])) return fail(`The timing has an invalid ${key}.`);
  }
  return makeTiming(t);
}

export function checkMeeting(value: unknown): Meeting {
  const m = value as Meeting;
  if (!m || typeof m !== 'object' || !isDateKey(m.date)) return fail('A meeting has no valid date.');
  if (m.state !== 'planned' && m.state !== 'skipped') return fail('A meeting has an invalid state.');
  if (m.minutesAvailable !== null && m.minutesAvailable !== undefined && !isMinutes(m.minutesAvailable)) return fail('A meeting has invalid minutes.');
  if (m.fixedCount !== null && m.fixedCount !== undefined && !isCount(m.fixedCount)) return fail('A meeting has an invalid fixed count.');
  return makeMeeting(m);
}

export function checkExclusion(value: unknown): DrawExclusion {
  const x = value as DrawExclusion;
  if (!x || typeof x !== 'object' || !isId(x.studentId)) return fail('An exclusion has no valid student.');
  if (!EXCLUSION_REASONS.includes(x.reason)) return fail('An exclusion has an invalid reason.');
  if (x.backOn !== null && x.backOn !== undefined && !isDateKey(x.backOn)) return fail('An exclusion has an invalid date.');
  return makeExclusion(x);
}

/** The state right after the draw, built only from the order and its snapshot. */
export function initialState(order: DrawnOrder, base: DrawBase): DrawState {
  const count = order.inputIds.length;
  if (base.names.length !== count) fail('The snapshot does not match the order it belongs to.');
  if (base.carried !== null && base.carried.length !== count) fail('The carried-over snapshot does not match its order.');
  const placeOf = new Map<number, number>();
  order.drawn.forEach((position, place) => placeOf.set(position, place + 1));

  const entries: DrawEntry[] = order.inputIds.map((studentId, i) => {
    const carried = base.carried ? base.carried[i] : null;
    return makeEntry({
      studentId,
      nameAtDraw: base.names[i],
      origin: carried ? carried.origin : 'drawn',
      drawnPosition: carried ? carried.drawnPosition : (placeOf.get(i) ?? null),
      status: carried ? carried.status : 'waiting',
      revealedAt: carried ? carried.revealedAt : null,
      completedOn: null,
      notBefore: carried ? carried.notBefore : null,
      skipReason: carried ? carried.skipReason : null,
    });
  });
  return {
    entries,
    sequence: [...order.drawn],
    exclusions: base.exclusions.map(makeExclusion),
    absences: base.absences.map(makeAbsence),
    timing: makeTiming(base.timing),
    meetings: base.meetings.map(makeMeeting),
    archived: base.archived,
  };
}

export function statusOf(state: DrawState): Exclude<DrawStatus, 'draft'> {
  if (state.archived) return 'archived';
  const open = state.entries.some((e) => e.status === 'waiting' || e.status === 'presenting' || e.status === 'on_deck');
  if (!open) return 'finished';
  const started = state.entries.some((e) => e.revealedAt !== null || e.status === 'done' || e.status === 'skipped');
  return started ? 'in_progress' : 'ready';
}

/**
 * Apply one event. Changes `state` in place and returns it.
 * Throws if the event does not fit the state, which is how an inconsistent
 * history is caught.
 */
export function applyEvent(state: DrawState, event: DrawEvent): DrawState {
  const f = (event.f ?? {}) as Record<string, unknown>;
  if (state.archived && event.t !== 'unarchived') fail(`Event ${event.n} changes an archived draw.`);

  const entryOf = (): DrawEntry => {
    const index = event.e;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= state.entries.length) {
      return fail(`Event ${event.n} names a presenter that is not in this draw.`);
    }
    return state.entries[index];
  };

  switch (event.t) {
    case 'revealed': {
      const entry = entryOf();
      if (entry.status !== 'waiting' && entry.status !== 'on_deck') fail(`Event ${event.n} reveals someone who was not waiting.`);
      if (state.entries.some((e) => e.status === 'presenting')) fail(`Event ${event.n} reveals a presenter while another is presenting.`);
      if (f.passed !== undefined) {
        if (typeof f.passed !== 'string' || !/^\d+:[1-5]( \d+:[1-5])*$/.test(f.passed)) fail(`Event ${event.n} has an unreadable pass-over list.`);
        if ((f.passed as string).split(' ').length > PRESENTATION_LIMITS.passedPairsPerReveal) fail(`Event ${event.n} lists too many passed-over presenters.`);
      }
      if (f.more !== undefined && !(typeof f.more === 'number' && Number.isInteger(f.more) && f.more > 0)) fail(`Event ${event.n} has an invalid pass-over count.`);
      entry.status = 'presenting';
      entry.revealedAt = entry.revealedAt ?? event.at;
      break;
    }
    case 'on_deck': {
      const entry = entryOf();
      if (entry.status !== 'waiting') fail(`Event ${event.n} puts someone on deck who was not waiting.`);
      if (state.entries.some((e) => e.status === 'on_deck')) fail(`Event ${event.n} puts a second presenter on deck.`);
      entry.status = 'on_deck';
      entry.revealedAt = entry.revealedAt ?? event.at;
      break;
    }
    case 'done': {
      const entry = entryOf();
      if (entry.status !== 'presenting') fail(`Event ${event.n} completes someone who was not presenting.`);
      if (!isDateKey(f.on)) fail(`Event ${event.n} has no valid date.`);
      entry.status = 'done';
      entry.completedOn = f.on as string;
      break;
    }
    case 'deferred': {
      const entry = entryOf();
      if (entry.status !== 'waiting' && entry.status !== 'on_deck' && entry.status !== 'presenting') fail(`Event ${event.n} defers someone who is not waiting to present.`);
      const hasTo = f.to !== undefined;
      const hasHold = f.notBefore !== undefined;
      if (!hasTo && !hasHold) fail(`Event ${event.n} is a deferral with no outcome.`);
      if (hasTo) {
        const to = f.to;
        if (typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to >= state.sequence.length) fail(`Event ${event.n} moves a presenter to a place that does not exist.`);
        const from = state.sequence.indexOf(event.e as number);
        state.sequence.splice(from, 1);
        state.sequence.splice(to as number, 0, event.e as number);
      }
      if (hasHold) {
        if (!isDateKey(f.notBefore)) fail(`Event ${event.n} has an invalid hold date.`);
        entry.notBefore = f.notBefore as string;
      }
      entry.status = 'waiting';
      break;
    }
    case 'absent': {
      const entry = entryOf();
      if (entry.status === 'done' || entry.status === 'skipped') fail(`Event ${event.n} marks someone absent who is no longer waiting.`);
      if (!isDateKey(f.on)) fail(`Event ${event.n} has no valid date.`);
      if (state.absences.some((a) => a.entry === event.e && a.date === f.on)) fail(`Event ${event.n} marks the same absence twice.`);
      state.absences.push(makeAbsence({ entry: event.e as number, date: f.on as string }));
      if (entry.status === 'presenting' || entry.status === 'on_deck') entry.status = 'waiting';
      break;
    }
    case 'present': {
      entryOf();
      const at = state.absences.findIndex((a) => a.entry === event.e && a.date === f.on);
      if (at < 0) fail(`Event ${event.n} clears an absence that was not recorded.`);
      state.absences.splice(at, 1);
      break;
    }
    case 'skipped': {
      const entry = entryOf();
      if (entry.status === 'done' || entry.status === 'skipped') fail(`Event ${event.n} skips someone who is not waiting to present.`);
      if (!SKIP_REASONS.includes(f.why as (typeof SKIP_REASONS)[number])) fail(`Event ${event.n} has an invalid reason.`);
      entry.status = 'skipped';
      entry.skipReason = f.why as (typeof SKIP_REASONS)[number];
      break;
    }
    case 'restored': {
      const entry = entryOf();
      if (entry.status !== 'skipped') fail(`Event ${event.n} restores someone who was not skipped.`);
      entry.status = 'waiting';
      entry.skipReason = null;
      break;
    }
    case 'added_later': {
      if (!isId(f.studentId)) fail(`Event ${event.n} adds a student with no valid id.`);
      if (typeof f.name !== 'string' || f.name.trim() === '' || f.name.length > PRESENTATION_LIMITS.nameLength) fail(`Event ${event.n} adds a student with no name.`);
      if (state.entries.some((e) => e.studentId === f.studentId)) fail(`Event ${event.n} adds a student who is already in the draw.`);
      if (state.entries.length >= PRESENTATION_LIMITS.studentsPerDraw) fail(`Event ${event.n} adds more students than a draw can hold.`);
      state.entries.push(makeEntry({
        studentId: f.studentId as string,
        nameAtDraw: f.name as string,
        origin: 'added_later',
        drawnPosition: null,
        status: 'waiting',
        revealedAt: null,
        completedOn: null,
        notBefore: null,
        skipReason: null,
      }));
      state.sequence.push(state.entries.length - 1);
      break;
    }
    case 'excluded': {
      const exclusion = checkExclusion({ studentId: f.studentId, reason: f.why, backOn: f.backOn ?? null });
      if (state.exclusions.some((x) => x.studentId === exclusion.studentId)) fail(`Event ${event.n} excludes a student who is already excluded.`);
      state.exclusions.push(exclusion);
      break;
    }
    case 'included': {
      const at = state.exclusions.findIndex((x) => x.studentId === f.studentId);
      if (at < 0) fail(`Event ${event.n} lifts an exclusion that was not recorded.`);
      state.exclusions.splice(at, 1);
      break;
    }
    case 'schedule': {
      let changed = false;
      if (f.timing !== undefined) {
        const patch = f.timing as Partial<Timing>;
        const keys = Object.keys(patch ?? {});
        if (!patch || typeof patch !== 'object' || keys.length === 0) fail(`Event ${event.n} has an empty timing change.`);
        state.timing = checkTiming({ ...state.timing, ...patch });
        if (keys.some((key) => !(key in state.timing))) fail(`Event ${event.n} changes a timing value that does not exist.`);
        changed = true;
      }
      if (f.meeting !== undefined) {
        const meeting = checkMeeting(f.meeting);
        const at = state.meetings.findIndex((m) => m.date === meeting.date);
        if (at >= 0) state.meetings[at] = meeting;
        else {
          if (state.meetings.length >= PRESENTATION_LIMITS.meetingsPerDraw) fail(`Event ${event.n} adds more meeting dates than a draw can hold.`);
          state.meetings.push(meeting);
          state.meetings.sort((a, b) => a.date.localeCompare(b.date));
        }
        changed = true;
      }
      if (f.remove !== undefined) {
        const at = state.meetings.findIndex((m) => m.date === f.remove);
        if (at < 0) fail(`Event ${event.n} removes a meeting date that was not there.`);
        state.meetings.splice(at, 1);
        changed = true;
      }
      if (!changed) fail(`Event ${event.n} is a schedule change with no outcome.`);
      break;
    }
    case 'archived':
      state.archived = true;
      break;
    case 'unarchived':
      if (!state.archived) fail(`Event ${event.n} restores a draw that was not archived.`);
      state.archived = false;
      break;
    default:
      fail(`Event ${event.n} is of a kind that cannot be applied.`);
  }
  return state;
}

/**
 * The events that count, after the snapshot: every 'undo' and the event it
 * names are left out. An undo is only valid for the most recent event that
 * still counts, and only for kinds that can be undone.
 */
export function effectiveEvents(events: DrawEvent[], baseAt: number): DrawEvent[] {
  const stack: DrawEvent[] = [];
  for (const event of events) {
    if (event.n <= baseAt) continue;
    if (event.t === 'drawn' || event.t === 'redrawn') fail(`Event ${event.n} draws an order after the snapshot was taken.`);
    if (event.t === 'undo') {
      const top = stack[stack.length - 1];
      if (!top || top.n !== event.u) fail(`Event ${event.n} undoes something other than the most recent action.`);
      if (!UNDOABLE.has(top.t)) fail(`Event ${event.n} undoes an action that cannot be undone.`);
      stack.pop();
    } else {
      stack.push(event);
    }
  }
  return stack;
}

/** The most recent action that an Undo would reverse, or null. */
export function lastUndoable(events: DrawEvent[], baseAt: number): DrawEvent | null {
  const stack = effectiveEvents(events, baseAt);
  const top = stack[stack.length - 1];
  return top && UNDOABLE.has(top.t) ? top : null;
}

/** Rebuild the state. Takes the order, the snapshot and the events, and nothing else. */
export function replay(order: DrawnOrder, base: DrawBase, events: DrawEvent[]): ReplayResult {
  const state = initialState(order, base);
  for (const event of effectiveEvents(events, base.at)) applyEvent(state, event);
  return {
    entries: state.entries,
    sequence: state.sequence,
    exclusions: state.exclusions,
    absences: state.absences,
    timing: state.timing,
    meetings: state.meetings,
    status: statusOf(state),
  };
}
