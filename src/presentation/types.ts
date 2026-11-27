/**
 * Presentation Draw: data shapes and limits.
 *
 * Everything under src/presentation/ is pure: no storage, no React, no network,
 * no clock. Callers pass in the roster, the time and the date.
 *
 * All of this lives in one optional field on a class record
 * (`Workspace.presentation`). A class that has never used presentations has no
 * such field and is stored exactly as before.
 */

/** A calendar day on the teacher's computer: 'YYYY-MM-DD'. Never a time zone, never a clock time. */
export type DateKey = string;

export const PRESENTATION_LIMITS = {
  studentsPerDraw: 500,
  redraws: 5,
  meetingsPerDraw: 400,
  passedPairsPerReveal: 50,
  titleLength: 200,
  nameLength: 200,
  /**
   * The one capacity limit. It is measured as what the class's presentation
   * data adds to a backup file, byte for byte, so the backup guarantee is exact.
   */
  budgetBytes: 2 * 1024 * 1024,
  /** Kept free so "continued in another class" can always be recorded. */
  reserveBytes: 16 * 1024,
  warnFraction: 0.75,
  newWorkFraction: 0.9,
  /**
   * The most a continuation may weigh in the worst case. Half the budget, so a
   * continued class always starts with at least half its space free.
   */
  carryBytes: 1024 * 1024,
} as const;

export const INACTIVE_REASONS = ['left_the_class', 'presents_another_way', 'teacher_choice'] as const;
export const EXCLUSION_REASONS = ['excused', 'presents_another_way', 'teacher_choice'] as const;
export const SKIP_REASONS = ['will_not_present', 'presented_another_way', 'other'] as const;
export type InactiveReason = (typeof INACTIVE_REASONS)[number];
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export type SkipReason = (typeof SKIP_REASONS)[number];

/** The only two things this module needs to know about a roster student. */
export interface RosterEntry {
  id: string;
  name: string;
}

export interface Timing {
  minutesPerPresentation: number;
  changeoverMinutes: number;
  minutesAvailable: number;
  breakMinutes: number;
}

export interface Meeting {
  date: DateKey;
  state: 'planned' | 'skipped';
  /** Null: use the draw's usual minutes. */
  minutesAvailable: number | null;
  /** A count typed by the teacher. Wins over the calculation. */
  fixedCount: number | null;
}

export interface DrawExclusion {
  studentId: string;
  reason: ExclusionReason;
  /** Null: excluded until the teacher lifts it. Otherwise the first day they may present again. */
  backOn: DateKey | null;
}

export interface Absence {
  entry: number;
  date: DateKey;
}

export type EntryStatus = 'waiting' | 'presenting' | 'on_deck' | 'done' | 'skipped';
export type EntryOrigin = 'drawn' | 'added_later';

export interface DrawEntry {
  studentId: string;
  /** Keeps the record readable if the student is later renamed or removed. */
  nameAtDraw: string;
  origin: EntryOrigin;
  /** 1-based place in the random order. Null for a student added afterwards. */
  drawnPosition: number | null;
  status: EntryStatus;
  /** Null: students have not been shown this name. */
  revealedAt: string | null;
  completedOn: DateKey | null;
  /** "Next meeting" hold: not before this day. */
  notBefore: DateKey | null;
  skipReason: SkipReason | null;
}

export interface SupersededOrder {
  seed: string;
  inputIds: string[];
  drawn: number[];
  drawnAt: string;
}

export interface DrawnOrder {
  rule: 'ringwheel-shuffle-v1' | 'carried-over';
  /** Null only for a carried-over order, which was never shuffled here. */
  seed: string | null;
  /** The student ids the order was made from, sorted. */
  inputIds: string[];
  /** The order, as positions in `inputIds`. Never changes. */
  drawn: number[];
  drawnAt: string;
  /** Orders replaced by a redraw before the first reveal. At most five. */
  superseded: SupersededOrder[];
  /** For a carried-over order: where the original random order and its seed are recorded. */
  carriedFrom: { classId: string; drawId: string; atEvent: number; seed: string | null } | null;
}

/** What one student arrives with in a carried-over draw. */
export interface CarriedState {
  origin: EntryOrigin;
  drawnPosition: number | null;
  status: Exclude<EntryStatus, 'done'>;
  revealedAt: string | null;
  notBefore: DateKey | null;
  skipReason: SkipReason | null;
}

/**
 * The snapshot replay starts from. Written once at "Draw the order" and
 * replaced only by a redraw, which is only possible before the first reveal.
 */
export interface DrawBase {
  /** The number of the 'drawn' or 'redrawn' event this snapshot belongs to. */
  at: number;
  /** Name at that moment, aligned with `order.inputIds`. */
  names: string[];
  /** Who was on the roster but not placed in the order, and why. */
  leftOut: { studentId: string; name: string; why: 'not_presenting' | 'excluded' }[];
  exclusions: DrawExclusion[];
  timing: Timing;
  meetings: Meeting[];
  absences: Absence[];
  archived: boolean;
  /** Only for a carried-over order: one item per `inputIds` entry. */
  carried: CarriedState[] | null;
}

export type EventKind =
  | 'drawn'
  | 'redrawn'
  | 'revealed'
  | 'on_deck'
  | 'done'
  | 'deferred'
  | 'absent'
  | 'present'
  | 'skipped'
  | 'restored'
  | 'added_later'
  | 'excluded'
  | 'included'
  | 'schedule'
  | 'archived'
  | 'unarchived'
  | 'undo';

/**
 * One thing that happened. It records the outcome ("entry 7 was revealed"),
 * never the request ("reveal next"), so replay never has to look anything up.
 */
export interface DrawEvent {
  n: number;
  at: string;
  t: EventKind;
  /** Entry index, when the event is about one student. */
  e?: number;
  /** The outcome, complete enough to apply on its own. */
  f?: Record<string, unknown>;
  /** For 'undo': the number of the event it reversed. */
  u?: number;
}

export type DrawStatus = 'draft' | 'ready' | 'in_progress' | 'finished' | 'archived';

export interface PresentationDraw {
  id: string;
  title: string;
  createdAt: string;
  status: DrawStatus;
  order: DrawnOrder | null;
  base: DrawBase | null;
  // Everything from here to `meetings` is reconstructed by replay and must match it exactly.
  entries: DrawEntry[];
  /** The working order, as indexes into `entries`. */
  sequence: number[];
  exclusions: DrawExclusion[];
  absences: Absence[];
  timing: Timing;
  meetings: Meeting[];
  /** Append-only. */
  events: DrawEvent[];
}

export interface InactiveStudent {
  studentId: string;
  reason: InactiveReason;
  since: string;
}

export type ClassLogEntry =
  | { n: number; at: string; t: 'not_presenting'; studentId: string; reason: InactiveReason }
  | { n: number; at: string; t: 'presenting'; studentId: string }
  | { n: number; at: string; t: 'moved'; classId: string; on: DateKey; classRev: number }
  | { n: number; at: string; t: 'reopened' };

export interface PresentationData {
  /** Lineage id. Assigned by the store. Changes whenever this data is put wholesale (restore, replace, put back, copy). */
  epoch: string;
  /** +1 on every presentation change. */
  rev: number;
  updatedAt: string;
  /** Class-level record: eligibility changes and "continued in another class". Append-only. */
  classLog: ClassLogEntry[];
  /** Stored for speed. Must always equal what `classLog` adds up to. */
  inactive: InactiveStudent[];
  /**
   * Set while this class's presentations have been continued in another class. Nothing here can change until reopened.
   * `classRev` is the class's own revision at that moment: the roster, settings and ring weights the
   * new class was given are the ones the class had at that revision.
   */
  movedTo: { classId: string; at: string; on: DateKey; classRev: number } | null;
  /** Set on a class that was created by a continuation. Never a "moved" marker of its own. */
  continuedFrom: { classId: string; marker: number } | null;
  draws: PresentationDraw[];
}

/** What a tab last saw. Every presentation write carries it. */
export interface PresentationToken {
  epoch: string | null;
  rev: number;
}

/** Thrown by the pure functions when a request does not fit the current state. Nothing has been changed. */
export class PresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresentationError';
  }
}

export const DEFAULT_TIMING: Timing = {
  minutesPerPresentation: 5,
  changeoverMinutes: 1,
  minutesAvailable: 45,
  breakMinutes: 0,
};

// ---------------------------------------------------------------------------
// Canonical constructors. Validation and replay both build records with these,
// so two records that mean the same thing always serialize identically.
// ---------------------------------------------------------------------------

export const makeTiming = (t: Timing): Timing => ({
  minutesPerPresentation: t.minutesPerPresentation,
  changeoverMinutes: t.changeoverMinutes,
  minutesAvailable: t.minutesAvailable,
  breakMinutes: t.breakMinutes,
});

export const makeMeeting = (m: Meeting): Meeting => ({
  date: m.date,
  state: m.state,
  minutesAvailable: m.minutesAvailable ?? null,
  fixedCount: m.fixedCount ?? null,
});

export const makeExclusion = (x: DrawExclusion): DrawExclusion => ({
  studentId: x.studentId,
  reason: x.reason,
  backOn: x.backOn ?? null,
});

export const makeAbsence = (a: Absence): Absence => ({ entry: a.entry, date: a.date });

export const makeEntry = (e: DrawEntry): DrawEntry => ({
  studentId: e.studentId,
  nameAtDraw: e.nameAtDraw,
  origin: e.origin,
  drawnPosition: e.drawnPosition ?? null,
  status: e.status,
  revealedAt: e.revealedAt ?? null,
  completedOn: e.completedOn ?? null,
  notBefore: e.notBefore ?? null,
  skipReason: e.skipReason ?? null,
});

export const makeEvent = (ev: DrawEvent): DrawEvent => {
  const out: DrawEvent = { n: ev.n, at: ev.at, t: ev.t };
  if (ev.e !== undefined) out.e = ev.e;
  if (ev.f !== undefined) out.f = ev.f;
  if (ev.u !== undefined) out.u = ev.u;
  return out;
};

/** A valid 'YYYY-MM-DD' that is a real calendar day. */
export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysIn = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= daysIn[m - 1];
}

/** The day after `date`, by the calendar. No Date object, so no time zone or daylight-saving effect. */
export function nextDay(date: DateKey): DateKey {
  let [y, m, d] = date.split('-').map(Number);
  const daysIn = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  d += 1;
  if (d > daysIn[m - 1]) {
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}
