/**
 * The replay contract (R1 to R10, R14, R15) and the capacity rules that can be
 * checked without storage (Q13, Q14 and the carry bound).
 * Every name is invented.
 */
import { describe, expect, it } from 'vitest';
import { FAULTS, dataWith, drawnDraw, richDraw, runActions } from './faults';
import { DAY, SEED, T0, pickAction, rosterOf, ticker, validActions } from './random-actions';
import { createRng } from '../../src/utils/spin-engine';
import { act, type ActionContext, type DrawAction } from '../../src/presentation/actions';
import { carryBound, presentationFileBytes, presentationUsage, PresentationCapacityError, type CapacityLimits } from '../../src/presentation/capacity';
import { buildContinuation, hasUnfinishedPresenters } from '../../src/presentation/carry-over';
import { drawOrder, editDraft, newDraft, verifyOrder } from '../../src/presentation/draw';
import { emptyPresentation, markMoved, nextUp, setPresenting } from '../../src/presentation/eligibility';
import { replay } from '../../src/presentation/replay';
import { nextDay, type DrawEvent, type PresentationData, type PresentationDraw } from '../../src/presentation/types';
import { PresentationInvalidError, PresentationMovedError, commitPresentation, drawIsConsistent, validatePresentation } from '../../src/presentation/validate';

const roster = rosterOf(8);
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ roster, inactive: [], today: DAY, at: T0, ...over });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const covered = (d: PresentationDraw) => ({ entries: d.entries, sequence: d.sequence, exclusions: d.exclusions, absences: d.absences, timing: d.timing, meetings: d.meetings, status: d.status });
const replayOf = (d: PresentationDraw) => replay(d.order!, d.base!, d.events);

const drawn = drawnDraw;
const run = runActions;
const rich = richDraw;

describe('replay reproduces the saved state', () => {
  it('R1: after every one of 500 random actions and undos, the saved state equals replay of the log', () => {
    const rng = createRng('replay-r1');
    const tick = ticker();
    let draw = drawn(6);
    const seenKinds = new Set<string>();
    for (let step = 0; step < 500; step++) {
      const context = ctx({ at: tick(), today: step < 250 ? DAY : nextDay(DAY) });
      const action = pickAction(draw, context, rng)!;
      draw = act(draw, action, context);
      seenKinds.add(draw.events[draw.events.length - 1].t);
      expect(covered(draw), `step ${step} (${action.type})`).toEqual(replayOf(draw));
      expect([...draw.sequence].sort((x, y) => x - y)).toEqual(draw.entries.map((_, i) => i));
      expect(draw.entries.filter((e) => e.status === 'presenting').length).toBeLessThanOrEqual(1);
      expect(draw.events.map((e) => e.n)).toEqual(draw.events.map((_, i) => i + 1));
    }
    // Every kind of event took part.
    for (const kind of ['revealed', 'on_deck', 'done', 'deferred', 'absent', 'present', 'skipped', 'restored', 'added_later', 'excluded', 'included', 'schedule', 'archived', 'unarchived', 'undo']) {
      expect(seenKinds.has(kind), `no ${kind} event was generated`).toBe(true);
    }
    expect(drawIsConsistent(draw)).toEqual({ ok: true });
  });

  it('R2: replay takes the order, the snapshot and the events, and nothing else', () => {
    expect(replay.length).toBe(3);
    const draw = rich();
    // The roster that produced this history is gone, the class list changed, the date moved on: none of it is an input.
    const result = replay(clone(draw.order!), clone(draw.base!), clone(draw.events));
    expect(result).toEqual(covered(draw));
    // It does not read the saved state either: a draw whose saved state was wiped replays to the same thing.
    const wiped = { ...draw, entries: [], sequence: [], exclusions: [], absences: [] };
    expect(replay(wiped.order!, wiped.base!, wiped.events)).toEqual(covered(draw));
  });

  it('R3: undo is replay without the undone action, steps back repeatedly, and only ever targets the latest action', () => {
    const d0 = drawn(6);
    const [a, b] = d0.sequence;
    const d1 = act(d0, { type: 'reveal', entry: a }, ctx());
    const d2 = act(d1, { type: 'done', entry: a }, ctx());
    const u1 = act(d2, { type: 'undo', event: d2.events.length }, ctx());
    expect(covered(u1)).toEqual(covered(d1));
    const u2 = act(u1, { type: 'undo', event: d1.events.length }, ctx());
    expect(covered(u2)).toEqual(covered(d0));
    // The log only grew: the mistake and the correction are both there.
    expect(u2.events.map((e) => e.t)).toEqual(['drawn', 'revealed', 'done', 'undo', 'undo']);
    expect(() => act(u2, { type: 'undo', event: 1 }, ctx())).toThrow(/nothing to undo/);
    expect(() => act(d2, { type: 'undo', event: 2 }, ctx())).toThrow(/no longer the one this page was showing/);
    // Acting after an undo continues from the earlier state.
    const again = act(u2, { type: 'reveal', entry: a }, ctx());
    expect(nextUp(act(again, { type: 'done', entry: a }, ctx()), ctx()).entry).toBe(b);
    expect(covered(again)).toEqual(replayOf(again));
  });

  it('R4: a redraw takes a fresh snapshot; earlier events are kept but not replayed; every superseded order verifies', () => {
    let draw = drawn(6);
    draw = act(draw, { type: 'schedule', timing: { minutesAvailable: 30 } }, ctx());
    draw = drawOrder(draw, { roster: roster.slice(0, 7), inactive: [], seed: '1'.repeat(16), at: T0 });
    draw = drawOrder(draw, { roster: roster.slice(0, 7), inactive: [], seed: '2'.repeat(16), at: T0 });
    expect(draw.events.map((e) => e.t)).toEqual(['drawn', 'schedule', 'redrawn', 'redrawn']);
    expect(draw.base!.at).toBe(4);
    expect(draw.base!.timing.minutesAvailable).toBe(30);
    expect(draw.entries).toHaveLength(7);
    expect(draw.order!.superseded.map((o) => o.inputIds.length)).toEqual([6, 7]);
    for (const old of draw.order!.superseded) expect(verifyOrder({ rule: 'ringwheel-shuffle-v1', ...old })).toBe(true);
    draw = run(draw, [{ type: 'reveal', entry: draw.sequence[0] }]);
    expect(covered(draw)).toEqual(replayOf(draw));
    expect(validatePresentation(dataWith(draw)).ok).toBe(true);
  });

  it('R5: ten schedule changes are reconstructed exactly', () => {
    const meeting = (date: string, state: 'planned' | 'skipped' = 'planned', fixedCount: number | null = null) => ({ date, state, minutesAvailable: null, fixedCount });
    const draw = run(drawn(6), [
      { type: 'schedule', timing: { minutesAvailable: 50 } },
      { type: 'schedule', timing: { breakMinutes: 5, changeoverMinutes: 2 } },
      { type: 'schedule', meeting: meeting('2026-12-15') },
      { type: 'schedule', meeting: meeting('2026-12-03') },
      { type: 'schedule', meeting: meeting('2026-12-08', 'skipped') },
      { type: 'schedule', meeting: meeting('2026-12-15', 'planned', 4) },
      { type: 'schedule', remove: '2026-12-03' },
      { type: 'schedule', meeting: { date: '2026-12-17', state: 'planned', minutesAvailable: 90, fixedCount: null } },
      { type: 'schedule', timing: { minutesPerPresentation: 7 } },
      { type: 'schedule', remove: '2026-12-01' },
    ]);
    expect(draw.timing).toEqual({ minutesPerPresentation: 7, changeoverMinutes: 2, minutesAvailable: 50, breakMinutes: 5 });
    expect(draw.meetings).toEqual([meeting('2026-12-08', 'skipped'), meeting('2026-12-15', 'planned', 4), { date: '2026-12-17', state: 'planned', minutesAvailable: 90, fixedCount: null }]);
    expect(covered(draw)).toEqual(replayOf(draw));
    expect(() => act(draw, { type: 'schedule', remove: '2026-12-25' }, ctx())).toThrow(/was not there/);
    expect(() => act(draw, { type: 'schedule', timing: { minutesAvailable: -5 } }, ctx())).toThrow(/invalid/);
  });

  it('R6: a student added later is reconstructed from the event alone, even after they leave the roster', () => {
    const draw = act(drawn(5), { type: 'add_later', studentId: 's06' }, ctx());
    expect(draw.events[1]).toMatchObject({ t: 'added_later', f: { studentId: 's06', name: 'Fay Example' } });
    const result = replayOf(draw);
    expect(result.entries[5]).toMatchObject({ studentId: 's06', nameAtDraw: 'Fay Example', origin: 'added_later' });
    expect(result.sequence[5]).toBe(5);
  });

  it('R7: status follows the entries: ready, in progress, finished, reopened by restoring a skip, archived and back', () => {
    let draw = drawn(2);
    const [a, b] = draw.sequence;
    expect(draw.status).toBe('ready');
    draw = run(draw, [{ type: 'reveal', entry: a }]);
    expect(draw.status).toBe('in_progress');
    draw = run(draw, [{ type: 'done', entry: a }, { type: 'skip', entry: b, reason: 'other' }]);
    expect(draw.status).toBe('finished');
    draw = run(draw, [{ type: 'restore', entry: b }]);
    expect(draw.status).toBe('in_progress');
    draw = run(draw, [{ type: 'archive' }]);
    expect(draw.status).toBe('archived');
    expect(() => act(draw, { type: 'reveal', entry: b }, ctx())).toThrow(/archived/);
    draw = run(draw, [{ type: 'unarchive' }]);
    expect(draw.status).toBe('in_progress');
    expect(covered(draw)).toEqual(replayOf(draw));
  });

  it('R14: event times that go backwards (the clock was changed) are accepted', () => {
    const draw = rich();
    const backwards = clone(draw);
    backwards.events.forEach((event, i) => (event.at = new Date(Date.parse(T0) - i * 86400000).toISOString()));
    // Reveal times come from the events, so replay it to get the matching state.
    const consistent = { ...backwards, ...replay(backwards.order!, backwards.base!, backwards.events) };
    expect(validatePresentation(dataWith(consistent)).ok).toBe(true);
  });

  it('R15: a valid history of 10,000 events replays correctly and quickly', () => {
    let draw = drawn(6);
    const first = draw.sequence[0];
    const events: DrawEvent[] = [...draw.events];
    for (let i = 0; events.length < 10000; i++) {
      events.push({ n: events.length + 1, at: T0, t: i % 2 === 0 ? 'absent' : 'present', e: first, f: { on: DAY } });
    }
    draw = { ...draw, events };
    const started = Date.now();
    const result = replay(draw.order!, draw.base!, draw.events);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.absences).toEqual(events.length % 2 === 0 ? [{ entry: first, date: DAY }] : []);
    expect(result.entries).toHaveLength(6);
  });
});

describe('carried-over draws and the class log', () => {
  const marker = { sourceClassId: 'class-a', n: 3, at: '2026-12-02T15:00:00.000Z', on: '2026-12-02' };

  it('R8: a carried-over draw keeps the remaining order and every unfinished presenter\'s state, and replays on its own', () => {
    let draw = drawn(8);
    const [a, b, c, d, e, f, g, h] = draw.sequence;
    draw = run(draw, [
      { type: 'reveal', entry: a }, { type: 'done', entry: a },
      { type: 'defer', entry: b, how: 'next_meeting' },
      { type: 'skip', entry: c, reason: 'presented_another_way' },
      { type: 'exclude', studentId: draw.entries[d].studentId, reason: 'excused', backOn: '2026-12-09' },
      { type: 'reveal', entry: e },
      { type: 'on_deck', entry: f },
      { type: 'schedule', timing: { minutesAvailable: 30 } },
    ]);
    // Absent on the day of the move, and absent on an earlier day.
    draw = act(draw, { type: 'absent', entry: g }, ctx({ today: marker.on, at: marker.at }));
    draw = act(draw, { type: 'absent', entry: h }, ctx({ today: DAY, at: T0 }));
    const source: PresentationData = { ...setPresenting(dataWith(draw), 's08', false, 'left_the_class', T0) };

    const next = buildContinuation(source, marker);
    const carried = next.draws[0];
    // Same remaining order, student for student. The one who presented is not carried.
    expect(carried.sequence.map((i) => carried.entries[i].studentId)).toEqual(draw.sequence.filter((i) => draw.entries[i].status !== 'done').map((i) => draw.entries[i].studentId));
    expect(carried.order).toMatchObject({ rule: 'carried-over', seed: null, carriedFrom: { classId: 'class-a', drawId: 'd1', atEvent: draw.events.length, seed: SEED } });
    expect(verifyOrder(carried.order!)).toBe(true);
    const of = (index: number) => carried.entries.find((entry) => entry.studentId === draw.entries[index].studentId)!;
    // Hold, skip, revealed and on-deck states all survive.
    expect(of(b)).toMatchObject({ status: 'waiting', notBefore: '2026-12-08' });
    expect(of(c)).toMatchObject({ status: 'skipped', skipReason: 'presented_another_way' });
    expect(of(e)).toMatchObject({ status: 'presenting', revealedAt: draw.entries[e].revealedAt });
    expect(of(f)).toMatchObject({ status: 'on_deck', revealedAt: draw.entries[f].revealedAt });
    expect(of(d).drawnPosition).toBe(draw.entries[d].drawnPosition);
    // Exclusions, schedule and the absence for the day of the move are carried. An older absence is history, not state.
    expect(carried.exclusions).toEqual(draw.exclusions);
    expect(carried.timing).toEqual(draw.timing);
    expect(carried.meetings).toEqual(draw.meetings);
    expect(carried.absences).toEqual([{ entry: carried.entries.indexOf(of(g)), date: marker.on }]);
    expect(carried.status).toBe('in_progress');
    // It replays from its own snapshot, with no reference to the old class.
    expect(covered(carried)).toEqual(replay(carried.order!, carried.base!, carried.events));
    expect(validatePresentation({ ...next, rev: 1 })).toMatchObject({ ok: true });
    // The work can simply go on.
    const after = act(carried, { type: 'done', entry: carried.entries.indexOf(of(e)) }, ctx({ today: marker.on }));
    expect(nextUp(after, ctx({ today: marker.on, inactive: next.inactive })).entry).toBe(carried.entries.indexOf(of(f)));
    expect(() => drawOrder(carried, { roster, inactive: [], seed: SEED, at: T0 })).toThrow(/cannot be redrawn|before anything/);
  });

  it('the new class gets its own class log, consistent with the eligibility it inherits, and is not marked as moved', () => {
    let source = dataWith(drawn(6), newDraft('d2', 'A draft', T0), run(drawn(2, 'd3', 'Finished'), [{ type: 'skip', entry: 0, reason: 'other' }, { type: 'skip', entry: 1, reason: 'other' }]));
    source = setPresenting(source, 's03', false, 'left_the_class', '2026-11-20T10:00:00.000Z');
    source = setPresenting(source, 's04', false, 'teacher_choice', '2026-11-21T10:00:00.000Z');
    source = setPresenting(source, 's03', true, 'teacher_choice', '2026-11-22T10:00:00.000Z');
    const moved = markMoved(source, 'class-b', marker.at, marker.on, 2);
    const next = buildContinuation(moved, { ...marker, n: moved.classLog.length });

    expect(next.movedTo).toBeNull();
    expect(next.classLog).toEqual([{ n: 1, at: '2026-11-21T10:00:00.000Z', t: 'not_presenting', studentId: 's04', reason: 'teacher_choice' }]);
    expect(next.inactive).toEqual(source.inactive);
    expect(next.continuedFrom).toEqual({ classId: 'class-a', marker: 4 });
    // Unfinished draw carried, draft copied, finished draw left behind.
    expect(next.draws.map((d) => [d.id, d.status])).toEqual([['d1', 'ready'], ['d2', 'draft']]);
    expect(hasUnfinishedPresenters(source.draws[2])).toBe(false);
    expect(validatePresentation({ ...next, rev: 1 }).ok).toBe(true);
    // Building it again gives exactly the same thing.
    expect(buildContinuation(moved, { ...marker, n: moved.classLog.length })).toEqual(next);
  });

  it('R9: with three draws open, a class-level change is one class-log entry, copied into no draw; each draw records the pass-over at its next reveal', () => {
    const draws = [drawn(6, 'd1', 'One'), drawn(6, 'd2', 'Two'), drawn(6, 'd3', 'Three')];
    const firstId = draws[0].entries[draws[0].sequence[0]].studentId;
    const before = dataWith(...draws);
    const after = setPresenting(before, firstId, false, 'teacher_choice', T0);
    expect(after.classLog).toHaveLength(1);
    expect(after.draws).toEqual(before.draws);
    for (const draw of after.draws) {
      const next = nextUp(draw, ctx({ inactive: after.inactive }));
      const revealed = act(draw, { type: 'reveal', entry: next.entry! }, ctx({ inactive: after.inactive }));
      expect(revealed.events[revealed.events.length - 1].f).toEqual({ passed: `${draw.sequence[0]}:2` });
    }
    expect(validatePresentation(after).ok).toBe(true);
  });
});

describe('R10: an inconsistent history fails validation', () => {
  it('the unaltered history is valid, so each failure below is caused by its one fault', () => {
    expect(FAULTS).toHaveLength(25);
    expect(validatePresentation(dataWith(clone(richDraw())))).toMatchObject({ ok: true });
    expect(richDraw().entries.some((e) => e.status === 'presenting')).toBe(true);
  });

  it.each(FAULTS)('%s', (name, damage, classLevel) => {
    const data = dataWith(clone(richDraw()));
    damage(data.draws[0], data);
    const result = validatePresentation(data);
    expect(result.ok, `"${name}" was accepted`).toBe(false);
    if (classLevel) return;
    // A problem inside a draw names the draw, and the same fault is caught when that one draw is opened.
    if (!result.ok) expect(result.problems.join(' ')).toMatch(/Draw "Biome talks"/);
    expect(drawIsConsistent(data.draws[0]).ok).toBe(false);
  });
});

describe('the gate every write passes through', () => {
  const at = '2026-12-01T16:00:00.000Z';
  const epoch = () => 'epoch-1';
  const stored = commitPresentation(undefined, dataWith(rich()), at, epoch);

  it('sets the lineage id on the first write, raises the revision by one, and returns canonical data', () => {
    expect(stored).toMatchObject({ epoch: 'epoch-1', rev: 1, updatedAt: at });
    const again = commitPresentation(stored, { ...stored, draws: [act(stored.draws[0], { type: 'archive' }, ctx())] }, at, () => 'never-used');
    expect(again).toMatchObject({ epoch: 'epoch-1', rev: 2 });
  });

  it('R11: refuses a change that would store an inconsistent record', () => {
    const broken = clone(stored);
    broken.draws[0].entries[broken.draws[0].entries.findIndex((e) => e.status === 'waiting')].status = 'done';
    expect(() => commitPresentation(stored, broken, at, epoch)).toThrow(PresentationInvalidError);
  });

  it('Q14: history can only grow. No write may remove or alter a drawn order, a superseded order, an earlier event or a class-log entry', () => {
    const attempts: [string, (d: PresentationData) => void][] = [
      ['remove a drawn draw', (d) => { d.draws = []; }],
      ['drop the last event', (d) => { const draw = d.draws[0]; Object.assign(draw, replay(draw.order!, draw.base!, draw.events.slice(0, -1)), { events: draw.events.slice(0, -1) }); }],
      ['change an earlier event', (d) => { d.draws[0].events[0].at = '2020-01-01T00:00:00.000Z'; }],
      ['replace the order with another valid one', (d) => { const fresh = drawOrder(editDraft(newDraft('d1', 'Biome talks', T0), {}), { roster: roster.slice(0, 6), inactive: [], seed: '9'.repeat(16), at: T0 }); d.draws[0] = fresh; }],
      ['clear the class log', (d) => { d.classLog = []; d.inactive = []; }],
    ];
    const withLog = commitPresentation(stored, setPresenting(stored, 's01', false, 'teacher_choice', at), at, epoch);
    for (const [name, damage] of attempts) {
      const next = clone(withLog);
      damage(next);
      expect(() => commitPresentation(withLog, next, at, epoch), name).toThrow(PresentationInvalidError);
    }
    // A redraw is the one way an order changes, and the old one moves, whole, to the superseded list.
    const ready = commitPresentation(undefined, dataWith(drawn(6)), at, epoch);
    const redrawn = { ...ready, draws: [drawOrder(ready.draws[0], { roster: roster.slice(0, 6), inactive: [], seed: '7'.repeat(16), at })] };
    expect(commitPresentation(ready, redrawn, at, epoch).draws[0].order!.superseded).toHaveLength(1);
    // A draft has no order and no history, so it may be discarded.
    const withDraft = commitPresentation(ready, { ...ready, draws: [...ready.draws, newDraft('d9', 'Draft', at)] }, at, epoch);
    expect(commitPresentation(withDraft, { ...withDraft, draws: [withDraft.draws[0]] }, at, epoch).draws).toHaveLength(1);
  });

  it('a class whose presentations were continued elsewhere cannot change, except to be reopened', () => {
    const moved = commitPresentation(stored, markMoved(stored, 'class-b', at, DAY, 2), at, epoch);
    expect(moved.movedTo).toEqual({ classId: 'class-b', at, on: DAY, classRev: 2 });
    expect(() => commitPresentation(moved, { ...moved, draws: [act(moved.draws[0], { type: 'archive' }, ctx())] }, at, epoch)).toThrow(PresentationMovedError);
    expect(() => commitPresentation(moved, setPresenting(moved, 's02', false, 'teacher_choice', at), at, epoch)).toThrow(PresentationMovedError);
  });
});

describe('capacity', () => {
  /** Small numbers so long runs are quick. The rules are the same as with the real ones. */
  const small: CapacityLimits = { budgetBytes: 60000, reserveBytes: 2000, warnFraction: 0.75, newWorkFraction: 0.9, carryBytes: 30000 };
  const at = T0;
  const commit = (before: PresentationData | undefined, next: PresentationData, limits = small) => commitPresentation(before, next, at, () => 'e1', limits);
  const marker = { sourceClassId: 'class-a', n: 1, at, on: DAY };

  it('the carry bound depends only on structure: no reveal, completion, deferral, absence, skip, undo or archive can raise it', () => {
    const rng = createRng('carry-bound');
    const tick = ticker();
    let draw = drawn(8);
    let bound = carryBound(dataWith(draw));
    for (let step = 0; step < 300; step++) {
      const context = ctx({ at: tick() });
      const everyday = validActions(draw, context).filter((a) => !['add_later', 'exclude', 'include', 'schedule'].includes(a.type));
      const action = everyday[Math.floor(rng() * everyday.length)];
      draw = act(draw, action, context);
      const now = carryBound(dataWith(draw));
      // Undoing a structural action can only happen if one was done, and none was.
      expect(now, `step ${step} (${action.type})`).toBe(bound);
      bound = now;
      // And whatever state the class is in, the real continuation is never larger than the bound.
      expect(presentationFileBytes({ ...buildContinuation(dataWith(draw), marker), rev: 1 })).toBeLessThanOrEqual(now);
    }
    // Adding structure does raise it.
    expect(carryBound(dataWith(act(draw.status === 'archived' ? act(draw, { type: 'unarchive' }, ctx()) : draw, { type: 'exclude', studentId: 's08', reason: 'excused', backOn: null }, ctx())))).toBeGreaterThan(bound);
  });

  it('Q1 to Q3: warned at 75%, new draws and redraws refused at 90%, everything refused when full, and nothing stored on a refusal', () => {
    let data = commit(undefined, dataWith(drawn(4)));
    const first = data.draws[0].sequence[0];
    const toggle = (d: PresentationData): PresentationData => {
      const draw = d.draws[0];
      const absent = draw.absences.some((a) => a.entry === first && a.date === DAY);
      return { ...d, draws: [act(draw, { type: absent ? 'present' : 'absent', entry: first }, ctx()), ...d.draws.slice(1)] };
    };
    const levels = new Set<string>();
    let refusedNewWork = false;
    for (let i = 0; i < 2000; i++) {
      const level = presentationUsage(data, small).level;
      levels.add(level);
      if (level === 'new_work_refused' && !refusedNewWork) {
        // New draws and redraws are refused...
        expect(() => commit(data, { ...data, draws: [...data.draws, newDraft('d2', 'Another', at)] })).toThrow(/nearly full/);
        // ...but work on what exists goes on.
        refusedNewWork = true;
      }
      try {
        data = commit(data, toggle(data));
      } catch (err) {
        expect(err).toBeInstanceOf(PresentationCapacityError);
        expect((err as PresentationCapacityError).kind).toBe('full');
        break;
      }
    }
    expect([...levels]).toEqual(['ok', 'warn', 'new_work_refused']);
    expect(refusedNewWork).toBe(true);
    expect(presentationUsage(data, small).bytes).toBeLessThanOrEqual(small.budgetBytes - small.reserveBytes);
    // Use up the last few bytes with the smallest events there are, until even those are refused.
    for (let i = 0; i < 200; i++) {
      const draw = data.draws[0];
      try {
        data = commit(data, { ...data, draws: [act(draw, { type: draw.status === 'archived' ? 'unarchive' : 'archive' }, ctx())] });
      } catch (err) {
        expect((err as PresentationCapacityError).kind).toBe('full');
        break;
      }
    }
    // Full: nothing more is accepted, whatever it is, and the data is exactly as it was.
    const frozen = JSON.stringify(data);
    const last = data.draws[0];
    const attempts: DrawAction[] = last.status === 'archived' ? [{ type: 'unarchive' }] : [{ type: 'archive' }, { type: 'reveal', entry: nextUp(last, ctx()).entry! }, { type: 'skip', entry: last.sequence[1], reason: 'other' }];
    for (const action of attempts) {
      expect(() => commit(data, { ...data, draws: [act(data.draws[0], action, ctx())] })).toThrow(/is full/);
    }
    expect(() => commit(data, { ...data, draws: [act(data.draws[0], { type: 'undo', event: data.draws[0].events.length }, ctx())] })).toThrow(/is full/);
    expect(JSON.stringify(data)).toBe(frozen);
    // Q4: the "continued in another class" marker still fits, because the reserve is kept for it.
    const moved = commit(data, markMoved(data, 'class-b', at, DAY, 2));
    expect(moved.movedTo?.classId).toBe('class-b');
    expect(presentationFileBytes(moved)).toBeLessThanOrEqual(small.budgetBytes);
  });

  it('at the open-work limit, adding more is refused but every action on existing presenters still works', () => {
    let data = commit(undefined, dataWith(drawn(8)));
    let added = 0;
    for (; added < 400; added++) {
      try {
        data = commit(data, { ...data, draws: [...data.draws, editDraft(newDraft(`x${added}`, `Draft ${added}`, at), { meetings: [{ date: '2026-12-08', state: 'planned', minutesAvailable: null, fixedCount: null }] })] });
      } catch (err) {
        expect((err as PresentationCapacityError).kind).toBe('open_work');
        break;
      }
    }
    expect(added).toBeGreaterThan(3);
    expect(added).toBeLessThan(400);
    expect(presentationUsage(data, small).openWorkLimitReached || carryBound(data) > small.carryBytes * 0.9).toBe(true);
    // Existing presenters: reveal and complete, as normal.
    const draw = data.draws[0];
    const revealed = commit(data, { ...data, draws: [act(draw, { type: 'reveal', entry: draw.sequence[0] }, ctx()), ...data.draws.slice(1)] });
    expect(revealed.draws[0].entries[draw.sequence[0]].status).toBe('presenting');
    // Removing something is always allowed.
    expect(commit(data, { ...data, draws: data.draws.slice(0, -1) }).draws.length).toBe(data.draws.length - 1);
  });

  it('Q13: over 5,000 random presses on a small budget there is never a state where neither an action nor "Continue in a new class" is possible', () => {
    const rng = createRng('no-dead-end');
    const tick = ticker();
    let data = commit(undefined, dataWith(drawn(8, 'd1', 'One'), drawn(6, 'd2', 'Two')));
    let classes = 1;
    let refusals = 0;
    let accepted = 0;
    for (let press = 0; press < 5000; press++) {
      const context = ctx({ at: tick(), inactive: data.inactive });
      const open = data.draws.filter((d) => d.order !== null);
      const draw = open[Math.floor(rng() * open.length)];
      // Long undo runs on purpose: they grow the log without finishing anything.
      const undoable = validActions(draw, context).find((a) => a.type === 'undo');
      const action = undoable && rng() < 0.35 ? undoable : pickAction(draw, context, rng);
      let next: PresentationData | null = null;
      if (action) {
        try {
          next = commit(data, { ...data, draws: data.draws.map((d) => (d.id === draw.id ? act(d, action, context) : d)) });
        } catch (err) {
          expect(err, String(err)).toBeInstanceOf(PresentationCapacityError);
          refusals++;
        }
      }
      if (next) {
        data = next;
        accepted++;
        continue;
      }
      // The action was refused (or nothing was possible). Then continuing in a new class must work, every time.
      const moved = commit(data, markMoved(data, `class-${classes + 1}`, context.at, DAY, 2));
      const continued = buildContinuation(moved, { sourceClassId: `class-${classes}`, n: moved.classLog.length, at: context.at, on: DAY });
      const check = validatePresentation({ ...continued, rev: 1 }, small);
      expect(check, `press ${press}: the continuation was not valid`).toMatchObject({ ok: true });
      // It leaves real room: at least half the budget is free.
      expect(presentationFileBytes(continued)).toBeLessThanOrEqual(small.carryBytes);
      data = commitPresentation(undefined, continued, context.at, () => `e${classes + 1}`, small);
      classes++;
      if (data.draws.every((d) => !d.order)) data = commit(data, { ...data, draws: [...data.draws, drawn(6, `n${classes}`, 'New')] });
    }
    expect(accepted).toBeGreaterThan(3000);
    expect(refusals).toBeGreaterThan(0);
    expect(classes).toBeGreaterThan(1);
  });

  it('the largest valid classes can always be continued, with the real limits', () => {
    // (a) As much unfinished structure as the rules allow: many draws of long-named students, with dates and exclusions.
    const longRoster = Array.from({ length: 120 }, (_, i) => ({ id: `s${String(i).padStart(3, '0')}`, name: `Student ${i} ${'x'.repeat(180)}` }));
    let big: PresentationData = { ...emptyPresentation(), epoch: 'e1', rev: 1, updatedAt: at, draws: [] };
    let count = 0;
    for (; count < 400; count++) {
      const meetings = Array.from({ length: 40 }, (_, m) => ({ date: `2027-${String(1 + (m % 12)).padStart(2, '0')}-${String(1 + (m % 28)).padStart(2, '0')}`, state: 'planned' as const, minutesAvailable: null, fixedCount: null }));
      const draft = editDraft(newDraft(`big${count}`, `Draw ${count} ${'t'.repeat(150)}`, at), { meetings, exclusions: [{ studentId: 's000', reason: 'excused', backOn: '2027-06-01' }] });
      const draw = drawOrder(draft, { roster: longRoster, inactive: [], seed: SEED, at });
      try {
        big = commitPresentation(big, { ...big, draws: [...big.draws, draw] }, at, () => 'e1');
      } catch (err) {
        expect(err).toBeInstanceOf(PresentationCapacityError);
        break;
      }
    }
    expect(count).toBeGreaterThan(2);
    expect(count).toBeLessThan(400);
    const movedBig = commitPresentation(big, markMoved(big, 'class-b', at, DAY, 2), at, () => 'e1');
    const next = buildContinuation(movedBig, { sourceClassId: 'class-a', n: movedBig.classLog.length, at, on: DAY });
    expect(validatePresentation({ ...next, rev: 1 })).toMatchObject({ ok: true });
    expect(presentationUsage({ ...next, rev: 1 }).fraction).toBeLessThanOrEqual(0.5);
    // Work continues in the new class.
    const started = commitPresentation(undefined, next, at, () => 'e2');
    const firstDraw = started.draws[0];
    expect(commitPresentation(started, { ...started, draws: [act(firstDraw, { type: 'reveal', entry: firstDraw.sequence[0] }, ctx({ roster: longRoster })), ...started.draws.slice(1)] }, at, () => 'e2').rev).toBe(2);
  });
});
