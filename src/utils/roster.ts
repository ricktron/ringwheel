import type { RosterStudent, SpinQueueItem } from '../types';
import { shuffle, type Rng } from './spin-engine';

export type Semester = 'S1' | 'S2';
export type QueueOrder = 'alphabetical' | 'random';

const periodOf = (student: RosterStudent, semester: Semester): string =>
  ((semester === 'S1' ? student.s1Period : student.s2Period) ?? '').trim();

const samePeriod = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

/** Distinct periods that have at least one student in the given semester. */
export function periodsForSemester(roster: RosterStudent[], semester: Semester): string[] {
  const seen = new Map<string, string>();
  for (const student of roster) {
    const period = periodOf(student, semester);
    if (period && !seen.has(period.toUpperCase())) seen.set(period.toUpperCase(), period);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export interface QueueBuild {
  queue: SpinQueueItem[];
  /** Roster rows dropped because the same email already appears in this period. */
  duplicatesIgnored: number;
}

/**
 * Build the spin queue for one class period.
 *
 * Only students whose period for the chosen semester matches are eligible.
 * Each student appears once, so nobody gets two turns from a duplicated row.
 */
export function buildQueue(
  roster: RosterStudent[],
  semester: Semester,
  period: string,
  order: QueueOrder,
  rng: Rng
): QueueBuild {
  const seenEmails = new Set<string>();
  let duplicatesIgnored = 0;
  let queue: SpinQueueItem[] = [];

  for (const student of roster) {
    const studentPeriod = periodOf(student, semester);
    if (!studentPeriod || !samePeriod(studentPeriod, period)) continue;
    const emailKey = student.email.trim().toLowerCase();
    if (seenEmails.has(emailKey)) {
      duplicatesIgnored++;
      continue;
    }
    seenEmails.add(emailKey);
    queue.push({
      email: student.email,
      name: `${student.first} ${student.last}`.trim(),
      period: studentPeriod,
      hasSpun: false,
    });
  }

  if (order === 'alphabetical') {
    queue.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    queue = shuffle(queue, rng);
  }

  return { queue, duplicatesIgnored };
}
