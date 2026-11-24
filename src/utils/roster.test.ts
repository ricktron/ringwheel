import { describe, expect, it } from 'vitest';
import type { RosterStudent } from '../types';
import { buildQueue, periodsForSemester } from './roster';
import { createRng } from './spin-engine';

const student = (first: string, last: string, s1: string | null, s2: string | null, email?: string): RosterStudent => ({
  email: email ?? `${first}.${last}@example.com`.toLowerCase(),
  first,
  last,
  class: 'Environmental Science',
  s1Period: s1,
  s2Period: s2,
});

// Synthetic roster. No real students.
const roster: RosterStudent[] = [
  student('Cy', 'Demo', 'A', null),
  student('Ada', 'Sample', 'A', 'B'),
  student('Ben', 'Placeholder', 'A', 'B'),
  student('Dee', 'Fixture', 'B', 'A'),
  student('Eli', 'Testcase', 'B', 'A'),
  student('Fay', 'Mock', null, '10'),
  student('Gus', 'Stub', null, '2'),
];

const rng = () => createRng('roster-test');

describe('periodsForSemester', () => {
  it('lists the distinct periods that have students, in natural order', () => {
    expect(periodsForSemester(roster, 'S1')).toEqual(['A', 'B']);
    expect(periodsForSemester(roster, 'S2')).toEqual(['2', '10', 'A', 'B']);
    expect(periodsForSemester([], 'S1')).toEqual([]);
  });
});

describe('buildQueue', () => {
  it('includes exactly the students in the chosen period of the chosen semester', () => {
    const s1a = buildQueue(roster, 'S1', 'A', 'alphabetical', rng());
    expect(s1a.queue.map((q) => q.name)).toEqual(['Ada Sample', 'Ben Placeholder', 'Cy Demo']);
    expect(s1a.queue.every((q) => q.period === 'A' && q.hasSpun === false)).toBe(true);

    const s2a = buildQueue(roster, 'S2', 'A', 'alphabetical', rng());
    expect(s2a.queue.map((q) => q.name)).toEqual(['Dee Fixture', 'Eli Testcase']);
  });

  it('never includes a student who has no period that semester', () => {
    const s2 = ['A', 'B', '2', '10'].flatMap((p) => buildQueue(roster, 'S2', p, 'alphabetical', rng()).queue);
    expect(s2.map((q) => q.name)).not.toContain('Cy Demo');
    expect(buildQueue(roster, 'S1', '', 'alphabetical', rng()).queue).toEqual([]);
  });

  it('returns an empty queue for a period that does not exist', () => {
    expect(buildQueue(roster, 'S1', 'Z', 'alphabetical', rng())).toEqual({ queue: [], duplicatesIgnored: 0 });
  });

  it('matches the period without regard to case or stray spaces', () => {
    expect(buildQueue(roster, 'S1', ' a ', 'alphabetical', rng()).queue).toHaveLength(3);
  });

  it('gives each student one place even when the roster row is duplicated', () => {
    const duplicated = [...roster, student('Ada', 'Sample', 'A', 'B', 'ADA.SAMPLE@example.com')];
    const built = buildQueue(duplicated, 'S1', 'A', 'alphabetical', rng());
    expect(built.queue.filter((q) => q.name === 'Ada Sample')).toHaveLength(1);
    expect(built.duplicatesIgnored).toBe(1);
  });

  it('random order keeps the same students, and each lands first about equally often', () => {
    const first: Record<string, number> = {};
    const n = 9000;
    for (let i = 0; i < n; i++) {
      const built = buildQueue(roster, 'S1', 'A', 'random', createRng(`order-${i}`));
      expect(built.queue.map((q) => q.name).sort()).toEqual(['Ada Sample', 'Ben Placeholder', 'Cy Demo']);
      first[built.queue[0].name] = (first[built.queue[0].name] ?? 0) + 1;
    }
    for (const name of ['Ada Sample', 'Ben Placeholder', 'Cy Demo']) {
      expect(Math.abs(first[name] - n / 3) / (n / 3)).toBeLessThan(0.06);
    }
  });
});
