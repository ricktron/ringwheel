/**
 * How many can present per meeting, and on which dates.
 *
 * Meetings are a plain list of dates the teacher entered. There are no
 * recurrence rules. Estimated dates are calculated here every time they are
 * shown and are never stored, so they cannot go stale.
 */
import { type EligibilityContext } from './eligibility';
import { PRESENTATION_LIMITS, isDateKey, nextDay, type DateKey, type Meeting, type PresentationDraw, type Timing } from './types';

/**
 * usable  = minutes available - break minutes
 * perSlot = minutes per presentation + changeover minutes
 * count   = floor((usable + changeover) / perSlot)      (no changeover after the last one)
 * A count typed by the teacher for that date wins. Never below zero.
 */
export function slotsFor(timing: Timing, meeting?: Meeting): number {
  if (meeting && meeting.fixedCount !== null) return Math.max(0, Math.min(PRESENTATION_LIMITS.studentsPerDraw, meeting.fixedCount));
  const available = meeting && meeting.minutesAvailable !== null ? meeting.minutesAvailable : timing.minutesAvailable;
  const usable = available - timing.breakMinutes;
  const perSlot = timing.minutesPerPresentation + timing.changeoverMinutes;
  if (perSlot <= 0 || usable <= 0 || timing.minutesPerPresentation <= 0) return 0;
  return Math.max(0, Math.min(PRESENTATION_LIMITS.studentsPerDraw, Math.floor((usable + timing.changeoverMinutes) / perSlot)));
}

/** Plain dates for "add several": every chosen weekday from `start`, `count` dates in all. Written once into the list; no rule is kept. */
export function datesFrom(start: DateKey, weekdays: number[], count: number): DateKey[] {
  if (!isDateKey(start) || weekdays.length === 0) return [];
  const wanted = new Set(weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  const out: DateKey[] = [];
  let date = start;
  // Day of the week by Zeller-style arithmetic, so no time zone can shift a date.
  const weekday = (key: DateKey): number => {
    const [y, m, d] = key.split('-').map(Number);
    const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    const yy = m < 3 ? y - 1 : y;
    return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
  };
  for (let guard = 0; out.length < Math.min(count, PRESENTATION_LIMITS.meetingsPerDraw) && wanted.size > 0 && guard < 4000; guard++) {
    if (wanted.has(weekday(date))) out.push(date);
    date = nextDay(date);
  }
  return out;
}

export interface SchedulePlan {
  /** Planned meetings from today on, each with the presenters estimated for it, in order. */
  meetings: { date: DateKey; slots: number; entries: number[] }[];
  /** Waiting presenters who do not fit in the meetings entered so far. */
  unscheduled: number[];
  /** Waiting presenters who cannot be given a date at all right now (not on the roster, not presenting, excluded with no end date). */
  blocked: number[];
  /** How many more meetings of the usual size the unscheduled presenters need. */
  meetingsNeeded: number;
}

/** Walk the waiting presenters, in order, across the planned meetings from today forward. */
export function planSchedule(draw: PresentationDraw, ctx: EligibilityContext): SchedulePlan {
  const rosterIds = new Set(ctx.roster.map((s) => s.id));
  const inactiveIds = new Set(ctx.inactive.map((s) => s.studentId));
  const blocked: number[] = [];
  let remaining: number[] = [];
  for (const index of draw.sequence) {
    const entry = draw.entries[index];
    if (entry.status !== 'waiting' && entry.status !== 'on_deck' && entry.status !== 'presenting') continue;
    const exclusion = draw.exclusions.find((x) => x.studentId === entry.studentId);
    if (!rosterIds.has(entry.studentId) || inactiveIds.has(entry.studentId) || (exclusion && exclusion.backOn === null)) blocked.push(index);
    else remaining.push(index);
  }

  const availableOn = (index: number, date: DateKey): boolean => {
    const entry = draw.entries[index];
    if (entry.notBefore !== null && entry.notBefore > date) return false;
    const exclusion = draw.exclusions.find((x) => x.studentId === entry.studentId);
    if (exclusion && exclusion.backOn !== null && exclusion.backOn > date) return false;
    if (date === ctx.today && draw.absences.some((a) => a.entry === index && a.date === date)) return false;
    return true;
  };

  const meetings: SchedulePlan['meetings'] = [];
  for (const meeting of draw.meetings) {
    if (meeting.state !== 'planned' || meeting.date < ctx.today) continue;
    const slots = slotsFor(draw.timing, meeting);
    const chosen: number[] = [];
    for (const index of remaining) {
      if (chosen.length >= slots) break;
      if (availableOn(index, meeting.date)) chosen.push(index);
    }
    remaining = remaining.filter((index) => !chosen.includes(index));
    meetings.push({ date: meeting.date, slots, entries: chosen });
  }
  const usual = slotsFor(draw.timing);
  return {
    meetings,
    unscheduled: remaining,
    blocked,
    meetingsNeeded: remaining.length === 0 ? 0 : usual > 0 ? Math.ceil(remaining.length / usual) : remaining.length,
  };
}
