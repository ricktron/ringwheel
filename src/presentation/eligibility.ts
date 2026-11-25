/**
 * Who may present, and why not.
 *
 * Three separate levels, none of which touches a roster record:
 * - class:  "not presenting in this class"   (PresentationData.inactive)
 * - draw:   "excluded from this draw"        (PresentationDraw.exclusions)
 * - date:   "absent today"                   (PresentationDraw.absences)
 *
 * The Ecology spinner's "In queue" switch is deliberately not an input here.
 * Nothing in this module reads or writes it.
 */
import {
  INACTIVE_REASONS,
  PresentationError,
  type ClassLogEntry,
  type DateKey,
  type DrawExclusion,
  type InactiveReason,
  type InactiveStudent,
  type PresentationData,
  type PresentationDraw,
  type RosterEntry,
} from './types';

export interface EligibilityContext {
  roster: RosterEntry[];
  inactive: InactiveStudent[];
  today: DateKey;
}

/** Why a waiting presenter is being passed over. The number is what the log stores. */
export const PASS_OVER = {
  not_on_roster: 1,
  not_presenting: 2,
  excluded: 3,
  held: 4,
  absent: 5,
} as const;
export type PassOverReason = keyof typeof PASS_OVER;
export const PASS_OVER_BY_CODE: Record<number, PassOverReason> = { 1: 'not_on_roster', 2: 'not_presenting', 3: 'excluded', 4: 'held', 5: 'absent' };

const excludedOn = (exclusion: DrawExclusion | undefined, date: DateKey): boolean =>
  exclusion !== undefined && (exclusion.backOn === null || exclusion.backOn > date);

/**
 * The one reason shown for a presenter who cannot be revealed right now, or
 * null if they can. When several apply the first in this order is given.
 * It is worked out each time and never written into the order.
 */
export function passOverReason(draw: PresentationDraw, entryIndex: number, ctx: EligibilityContext): PassOverReason | null {
  const entry = draw.entries[entryIndex];
  if (!ctx.roster.some((student) => student.id === entry.studentId)) return 'not_on_roster';
  if (ctx.inactive.some((item) => item.studentId === entry.studentId)) return 'not_presenting';
  if (excludedOn(draw.exclusions.find((x) => x.studentId === entry.studentId), ctx.today)) return 'excluded';
  if (entry.notBefore !== null && entry.notBefore > ctx.today) return 'held';
  if (draw.absences.some((a) => a.entry === entryIndex && a.date === ctx.today)) return 'absent';
  return null;
}

export interface NextUp {
  /** The presenter a reveal would show, or null when nobody is available. */
  entry: number | null;
  /** Everyone ahead of them in the order who was passed over, with the reason code. */
  passed: [number, number][];
}

/** Who is revealed next: the presenter on deck if they are still available, otherwise the first waiting presenter who is. */
export function nextUp(draw: PresentationDraw, ctx: EligibilityContext): NextUp {
  const onDeck = draw.entries.findIndex((e) => e.status === 'on_deck');
  const deckReady = onDeck >= 0 && passOverReason(draw, onDeck, ctx) === null;
  const passed: [number, number][] = [];
  for (const index of draw.sequence) {
    const entry = draw.entries[index];
    if (entry.status !== 'waiting' && entry.status !== 'on_deck') continue;
    if (deckReady && index === onDeck) return { entry: index, passed };
    const reason = passOverReason(draw, index, ctx);
    if (reason !== null) {
      passed.push([index, PASS_OVER[reason]]);
      continue;
    }
    if (!deckReady) return { entry: index, passed };
  }
  return { entry: null, passed };
}

/** The first waiting presenter who is available: the one who may be put on deck. */
export function nextOnDeck(draw: PresentationDraw, ctx: EligibilityContext): number | null {
  for (const index of draw.sequence) {
    if (draw.entries[index].status === 'waiting' && passOverReason(draw, index, ctx) === null) return index;
  }
  return null;
}

/** Roster students who would be placed in the order if it were drawn now, and those who would be left out. */
export function eligibleForDraw(roster: RosterEntry[], inactive: InactiveStudent[], exclusions: DrawExclusion[]) {
  const inputs: RosterEntry[] = [];
  const leftOut: { studentId: string; name: string; why: 'not_presenting' | 'excluded' }[] = [];
  for (const student of roster) {
    if (inactive.some((item) => item.studentId === student.id)) leftOut.push({ studentId: student.id, name: student.name, why: 'not_presenting' });
    // An exclusion with a "back on" date still gets a place: the student presents, only later.
    else if (exclusions.some((x) => x.studentId === student.id && x.backOn === null)) leftOut.push({ studentId: student.id, name: student.name, why: 'excluded' });
    else inputs.push(student);
  }
  // Sorted by id, not by name, so correcting a name can never change the input to the shuffle.
  inputs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  leftOut.sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0));
  return { inputs, leftOut };
}

// ---------------------------------------------------------------------------
// Class level
// ---------------------------------------------------------------------------

/** What the class log adds up to. `inactive` and `movedTo` must always equal this. */
export function foldClassLog(log: ClassLogEntry[]): Pick<PresentationData, 'inactive' | 'movedTo'> {
  const inactive = new Map<string, InactiveStudent>();
  let movedTo: PresentationData['movedTo'] = null;
  for (const entry of log) {
    if (entry.t === 'not_presenting') inactive.set(entry.studentId, { studentId: entry.studentId, reason: entry.reason, since: entry.at });
    else if (entry.t === 'presenting') inactive.delete(entry.studentId);
    else if (entry.t === 'moved') movedTo = { classId: entry.classId, at: entry.at, on: entry.on };
    else movedTo = null;
  }
  return { inactive: [...inactive.values()], movedTo };
}

/** A new, empty presentation record. The store fills in `epoch`, `rev` and `updatedAt`. */
export function emptyPresentation(): PresentationData {
  return { epoch: '', rev: 0, updatedAt: '', classLog: [], inactive: [], movedTo: null, continuedFrom: null, draws: [] };
}

function append(data: PresentationData, entry: ClassLogEntry): PresentationData {
  const classLog = [...data.classLog, entry];
  return { ...data, classLog, ...foldClassLog(classLog) };
}

/** Mark a student as presenting or not presenting in this class. One class-log entry, never copied into a draw. */
export function setPresenting(data: PresentationData, studentId: string, presenting: boolean, reason: InactiveReason, at: string): PresentationData {
  const isInactive = data.inactive.some((item) => item.studentId === studentId);
  if (presenting && !isInactive) throw new PresentationError('That student is already presenting in this class.');
  if (!presenting && isInactive) throw new PresentationError('That student is already marked as not presenting in this class.');
  if (!presenting && !INACTIVE_REASONS.includes(reason)) throw new PresentationError('Choose a reason from the list.');
  const n = data.classLog.length + 1;
  return append(data, presenting ? { n, at, t: 'presenting', studentId } : { n, at, t: 'not_presenting', studentId, reason });
}

export function markMoved(data: PresentationData, classId: string, at: string, on: DateKey): PresentationData {
  if (data.movedTo) throw new PresentationError('Presentations for this class were already continued in another class.');
  return append(data, { n: data.classLog.length + 1, at, t: 'moved', classId, on });
}

export function markReopened(data: PresentationData, at: string): PresentationData {
  if (!data.movedTo) throw new PresentationError('Presentations for this class are not marked as continued elsewhere.');
  return append(data, { n: data.classLog.length + 1, at, t: 'reopened' });
}
