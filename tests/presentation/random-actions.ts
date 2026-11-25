/**
 * Helpers shared by the presentation tests. No test-runner imports, so the
 * same code runs under Vitest and inside a real browser.
 * Every name is invented.
 */
import { nextOnDeck, nextUp, type EligibilityContext } from '../../src/presentation/eligibility';
import { lastUndoable } from '../../src/presentation/replay';
import type { DrawAction } from '../../src/presentation/actions';
import type { PresentationDraw, RosterEntry } from '../../src/presentation/types';

export const NAMES = ['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Dee Fixture', 'Eli Testcase', 'Fay Example', 'Gus Madeup', 'Hal Nobody', 'Ivy Pretend', 'Jo Invented', 'Kit Fictional', 'Lee Imaginary'];
export const T0 = '2026-12-01T15:00:00.000Z';
export const DAY = '2026-12-01';
export const SEED = '0123456789abcdef';

/** A roster with fixed, sortable ids: s01, s02, ... */
export const rosterOf = (count: number): RosterEntry[] =>
  Array.from({ length: count }, (_, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, name: NAMES[i] ?? `Student ${i + 1}` }));

/** Times one minute apart, so every event has its own time. */
export function ticker(start = T0): () => string {
  let t = Date.parse(start);
  return () => new Date((t += 60000)).toISOString();
}

/** Every action that is valid for the draw right now. */
export function validActions(draw: PresentationDraw, ctx: EligibilityContext): DrawAction[] {
  if (!draw.order || !draw.base) return [];
  const actions: DrawAction[] = [];
  const undo = lastUndoable(draw.events, draw.base.at);
  if (undo) actions.push({ type: 'undo', event: undo.n });
  if (draw.status === 'archived') return [...actions, { type: 'unarchive' }];

  const presenting = draw.entries.findIndex((e) => e.status === 'presenting');
  const next = nextUp(draw, ctx);
  if (presenting < 0 && next.entry !== null) actions.push({ type: 'reveal', entry: next.entry });
  const deck = nextOnDeck(draw, ctx);
  if (deck !== null && !draw.entries.some((e) => e.status === 'on_deck')) actions.push({ type: 'on_deck', entry: deck });
  if (presenting >= 0) actions.push({ type: 'done', entry: presenting });

  draw.entries.forEach((entry, index) => {
    const open = entry.status === 'waiting' || entry.status === 'on_deck' || entry.status === 'presenting';
    const absentToday = draw.absences.some((a) => a.entry === index && a.date === ctx.today);
    if (open) {
      actions.push({ type: 'defer', entry: index, how: 'end' }, { type: 'defer', entry: index, how: 'next_meeting' });
      actions.push({ type: 'skip', entry: index, reason: 'will_not_present' });
      if (!absentToday) actions.push({ type: 'absent', entry: index });
    }
    if (absentToday) actions.push({ type: 'present', entry: index });
    if (entry.status === 'skipped') actions.push({ type: 'restore', entry: index });
  });
  for (const student of ctx.roster) {
    const excluded = draw.exclusions.some((x) => x.studentId === student.id);
    if (!draw.entries.some((e) => e.studentId === student.id)) actions.push({ type: 'add_later', studentId: student.id });
    actions.push(excluded ? { type: 'include', studentId: student.id } : { type: 'exclude', studentId: student.id, reason: 'excused', backOn: null });
  }
  actions.push({ type: 'schedule', timing: { minutesAvailable: 40 + (draw.events.length % 7) } });
  actions.push({ type: 'schedule', meeting: { date: `2026-12-${String(10 + (draw.events.length % 15)).padStart(2, '0')}`, state: draw.events.length % 2 ? 'planned' : 'skipped', minutesAvailable: null, fixedCount: null } });
  actions.push({ type: 'archive' });
  return actions;
}

/** Pick one valid action. Weighted towards the everyday ones so runs make progress. */
export function pickAction(draw: PresentationDraw, ctx: EligibilityContext, rng: () => number): DrawAction | null {
  const all = validActions(draw, ctx);
  if (all.length === 0) return null;
  const everyday = all.filter((a) => a.type === 'reveal' || a.type === 'done' || a.type === 'undo' || a.type === 'on_deck');
  const pool = everyday.length > 0 && rng() < 0.6 ? everyday : all;
  return pool[Math.floor(rng() * pool.length)];
}
