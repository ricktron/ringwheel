/**
 * One valid presentation history, and 25 ways to make it inconsistent, one
 * fault each. Shared by the unit tests (validation) and the storage tests
 * (restore). No test-runner imports. Every name is invented.
 */
import { act, type DrawAction } from '../../src/presentation/actions';
import { drawOrder, editDraft, newDraft } from '../../src/presentation/draw';
import { emptyPresentation } from '../../src/presentation/eligibility';
import type { DrawEvent, PresentationData, PresentationDraw } from '../../src/presentation/types';
import { DAY, SEED, T0, rosterOf, ticker } from './random-actions';

const roster = rosterOf(8);

export function drawnDraw(count = 6, id = 'd1', title = 'Biome talks'): PresentationDraw {
  const draft = editDraft(newDraft(id, title, T0), {
    meetings: [
      { date: '2026-12-01', state: 'planned', minutesAvailable: null, fixedCount: null },
      { date: '2026-12-08', state: 'planned', minutesAvailable: null, fixedCount: null },
    ],
  });
  return drawOrder(draft, { roster: roster.slice(0, count), inactive: [], seed: SEED, at: T0 });
}

export function runActions(draw: PresentationDraw, actions: DrawAction[], tick = ticker()): PresentationDraw {
  return actions.reduce((d, action) => act(d, action, { roster, inactive: [], today: DAY, at: tick() }), draw);
}

export const dataWith = (...draws: PresentationDraw[]): PresentationData => ({ ...emptyPresentation(), epoch: 'e1', rev: 1, updatedAt: T0, draws });

/** A draw with a bit of everything in its history: an absence, a completion, an undo, a skip, an exclusion, a schedule change, a later addition, and someone presenting. */
export function richDraw(): PresentationDraw {
  const d = drawnDraw(6);
  const [a, b, c, e] = d.sequence;
  return runActions(d, [
    { type: 'absent', entry: a },
    { type: 'reveal', entry: b },
    { type: 'done', entry: b },
    { type: 'reveal', entry: c },
    { type: 'undo', event: 5 },
    { type: 'skip', entry: e, reason: 'will_not_present' },
    { type: 'exclude', studentId: 's08', reason: 'excused', backOn: '2026-12-08' },
    { type: 'schedule', timing: { minutesAvailable: 50 } },
    { type: 'add_later', studentId: 's07' },
    { type: 'reveal', entry: c },
  ]);
}

const renumber = (events: DrawEvent[]) => events.forEach((event, i) => (event.n = i + 1));
const push = (d: PresentationDraw, event: Omit<DrawEvent, 'n' | 'at'>) => d.events.push({ n: d.events.length + 1, at: T0, ...event } as DrawEvent);
const presenting = (d: PresentationDraw) => d.entries.findIndex((e) => e.status === 'presenting');
const waiting = (d: PresentationDraw) => d.entries.findIndex((e) => e.status === 'waiting');

/** [what is wrong, how to make it wrong, whether the fault is at class level rather than inside the draw] */
export const FAULTS: [string, (d: PresentationDraw, data: PresentationData) => void, boolean?][] = [
  ['a gap in the numbering', (d) => { d.events[3].n = 99; }],
  ['a number used twice', (d) => { d.events[3].n = d.events[2].n; }],
  ['an unknown kind of event', (d) => { (d.events[2] as { t: string }).t = 'teleported'; }],
  ['an event about a presenter who does not exist', (d) => { d.events[d.events.length - 1].e = 999; }],
  ['a completion for someone who was not presenting', (d) => { d.events[2].e = waiting(d); }],
  ['two presenters at once', (d) => { const w = waiting(d); push(d, { t: 'revealed', e: w }); d.entries[w].status = 'presenting'; }],
  ['an undo of something other than the latest action', (d) => { push(d, { t: 'undo', u: 2 }); }],
  ['an undo of an undo', (d) => { push(d, { t: 'undo', u: 6 }); }],
  ['an undo of an action that was already undone', (d) => { push(d, { t: 'undo', u: 5 }); }],
  ['a working order changed with no event', (d) => { [d.sequence[0], d.sequence[1]] = [d.sequence[1], d.sequence[0]]; }],
  ['a presenter state changed with no event', (d) => { d.entries[waiting(d)].status = 'done'; }],
  ['an event removed from the middle', (d) => { d.events.splice(2, 1); renumber(d.events); d.events.forEach((e) => { if (e.u !== undefined) e.u -= 1; }); }],
  ['an event added with no change of state', (d) => { push(d, { t: 'on_deck', e: waiting(d) }); }],
  ['snapshot names that do not match the order', (d) => { d.base!.names.pop(); }],
  ['an order that is not a permutation', (d) => { d.order!.drawn[0] = d.order!.drawn[1]; }],
  ['a seed that does not reproduce the order', (d) => { d.order!.seed = 'f'.repeat(16); }],
  ['six superseded orders', (d) => { for (let i = 0; i < 6; i++) d.order!.superseded.push({ seed: SEED, inputIds: [...d.order!.inputIds], drawn: [...d.order!.drawn], drawnAt: T0 }); }],
  ['a snapshot that points at an event that is not a draw', (d) => { d.base!.at = 2; }],
  ['an action after the draw was archived', (d) => { const p = presenting(d); push(d, { t: 'archived' }); push(d, { t: 'done', e: p, f: { on: DAY } }); d.entries[p].status = 'done'; }],
  ['a later addition of a student who is already in the draw', (d) => { push(d, { t: 'added_later', f: { studentId: d.entries[0].studentId, name: 'Twice Listed' } }); }],
  ['a schedule changed with no event', (d) => { d.timing.minutesAvailable = 99; }],
  ['exclusions changed with no event', (d) => { d.exclusions = []; }],
  ['absences changed with no event', (d) => { d.absences = []; }],
  ['a "not presenting" list that does not match the class log', (_d, data) => { data.inactive = [{ studentId: 's01', reason: 'teacher_choice', since: T0 }]; }, true],
  ['more than fifty pass-over pairs on one reveal', (d) => { d.events[d.events.length - 1].f = { passed: Array.from({ length: 51 }, () => '0:5').join(' ') }; }],
];
