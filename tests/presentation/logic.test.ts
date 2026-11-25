/**
 * Presentation Draw: the order, eligibility, scheduling and the display view.
 * Pure functions only. Every name is invented.
 */
import { describe, expect, it } from 'vitest';
import { DAY, SEED, T0, pickAction, rosterOf, ticker } from './random-actions';
import { createRng } from '../../src/utils/spin-engine';
import { act, type ActionContext } from '../../src/presentation/actions';
import { drawOrder, editDraft, newDraft, shuffledPositions, verifyOrder } from '../../src/presentation/draw';
import { eligibleForDraw, emptyPresentation, foldClassLog, nextUp, passOverReason, setPresenting } from '../../src/presentation/eligibility';
import { publicView } from '../../src/presentation/public-view';
import { datesFrom, planSchedule, slotsFor } from '../../src/presentation/schedule';
import { PRESENTATION_LIMITS, PresentationError, isDateKey, nextDay, type InactiveStudent, type PresentationDraw } from '../../src/presentation/types';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ roster: rosterOf(6), inactive: [], today: DAY, at: T0, ...over });

function drawn(count = 6, seed = SEED, prepare: (draft: PresentationDraw) => PresentationDraw = (d) => d, inactive: InactiveStudent[] = []): PresentationDraw {
  return drawOrder(prepare(newDraft('d1', 'Biome talks', T0)), { roster: rosterOf(count), inactive, seed, at: T0 });
}

describe('the order', () => {
  it('a fixed seed always gives the same pinned order (guards the algorithm against silent change)', () => {
    expect(shuffledPositions(8, '0123456789abcdef')).toEqual([6, 1, 4, 0, 5, 2, 7, 3]);
    expect(shuffledPositions(5, 'fedcba9876543210')).toEqual([3, 4, 1, 0, 2]);
  });

  it('is made from the eligible students sorted by id, holds each exactly once, and verifies against its seed', () => {
    const draw = drawn(8);
    expect(draw.order!.inputIds).toEqual(rosterOf(8).map((s) => s.id));
    expect(draw.order!.drawn).toEqual([6, 1, 4, 0, 5, 2, 7, 3]);
    expect([...draw.sequence].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(draw.status).toBe('ready');
    expect(verifyOrder(draw.order!)).toBe(true);
    expect(draw.entries.map((e) => e.drawnPosition)).toEqual([4, 2, 6, 8, 3, 5, 1, 7]);
    // Editing one position, or the seed, makes verification fail.
    expect(verifyOrder({ ...draw.order!, drawn: [1, 6, 4, 0, 5, 2, 7, 3] })).toBe(false);
    expect(verifyOrder({ ...draw.order!, seed: 'ffffffffffffffff' })).toBe(false);
  });

  it('does not depend on names or roster order: only on ids and the seed', () => {
    const shuffledRoster = [...rosterOf(8)].reverse().map((s) => ({ ...s, name: `${s.name} Renamed` }));
    const other = drawOrder(newDraft('d1', 'Biome talks', T0), { roster: shuffledRoster, inactive: [], seed: SEED, at: T0 });
    expect(other.order!.drawn).toEqual(drawn(8).order!.drawn);
    expect(other.order!.inputIds).toEqual(drawn(8).order!.inputIds);
  });

  it('puts every student in every position at roughly equal rates over many seeds', () => {
    const count = 6;
    const runs = 6000;
    const tally = Array.from({ length: count }, () => new Array<number>(count).fill(0));
    for (let i = 0; i < runs; i++) {
      shuffledPositions(count, (i * 2654435761).toString(16).padStart(16, '0').slice(-16)).forEach((student, place) => tally[student][place]++);
    }
    const expected = runs / count;
    for (const row of tally) for (const seen of row) expect(Math.abs(seen - expected)).toBeLessThan(expected * 0.15);
  });

  it('refuses to draw with nobody eligible, with too many, or with a bad seed', () => {
    expect(() => drawOrder(newDraft('d1', 'x', T0), { roster: [], inactive: [], seed: SEED, at: T0 })).toThrow(/Nobody is eligible/);
    expect(() => drawOrder(newDraft('d1', 'x', T0), { roster: rosterOf(PRESENTATION_LIMITS.studentsPerDraw + 1), inactive: [], seed: SEED, at: T0 })).toThrow(/at most 500/);
    expect(() => drawOrder(newDraft('d1', 'x', T0), { roster: rosterOf(3), inactive: [], seed: 'nope', at: T0 })).toThrow(/valid seed/);
  });

  it('can be redrawn only before anything has happened, at most five times, and every earlier order is kept and still verifies', () => {
    let draw = drawn(6);
    const first = { seed: draw.order!.seed, drawn: draw.order!.drawn };
    for (let i = 1; i <= PRESENTATION_LIMITS.redraws; i++) {
      draw = drawOrder(draw, { roster: rosterOf(6), inactive: [], seed: `${i}`.repeat(16), at: T0 });
      expect(draw.order!.superseded).toHaveLength(i);
      expect(draw.base!.at).toBe(draw.events.length);
    }
    expect(draw.order!.superseded[0]).toMatchObject(first);
    for (const old of draw.order!.superseded) expect(verifyOrder({ rule: 'ringwheel-shuffle-v1', ...old })).toBe(true);
    expect(draw.events.map((e) => e.t)).toEqual(['drawn', 'redrawn', 'redrawn', 'redrawn', 'redrawn', 'redrawn']);
    expect(() => drawOrder(draw, { roster: rosterOf(6), inactive: [], seed: 'a'.repeat(16), at: T0 })).toThrow(/limit/);

    const started = act(drawn(6), { type: 'reveal', entry: drawn(6).sequence[0] }, ctx());
    expect(() => drawOrder(started, { roster: rosterOf(6), inactive: [], seed: 'a'.repeat(16), at: T0 })).toThrow(/before anything has happened/);
  });

  it('never changes on a roster change, a reload or an action that does not move anyone', () => {
    const draw = drawn(6);
    const before = JSON.stringify([draw.order, draw.sequence]);
    const reloaded = JSON.parse(JSON.stringify(draw)) as PresentationDraw;
    const renamed = ctx({ roster: rosterOf(6).map((s) => ({ ...s, name: 'Someone Else' })).slice(1) });
    let next = act(reloaded, { type: 'reveal', entry: nextUp(reloaded, renamed).entry! }, renamed);
    next = act(next, { type: 'done', entry: next.entries.findIndex((e) => e.status === 'presenting') }, renamed);
    expect(JSON.stringify([next.order, next.sequence])).toBe(before);
  });

  it('an action never modifies the draw it was given', () => {
    const draw = drawn(6);
    const frozen = JSON.stringify(draw);
    act(draw, { type: 'reveal', entry: draw.sequence[0] }, ctx());
    act(draw, { type: 'defer', entry: draw.sequence[0], how: 'end' }, ctx());
    expect(JSON.stringify(draw)).toBe(frozen);
  });
});

describe('eligibility', () => {
  const inactive = (studentId: string): InactiveStudent[] => [{ studentId, reason: 'teacher_choice', since: T0 }];

  it('everyone on the roster is eligible by default, and the spin queue switch plays no part', () => {
    // Students whose "In queue" is off are passed in exactly like the rest: the function has no input for it.
    const roster = rosterOf(4).map((s, i) => ({ ...s, active: i % 2 === 0 }));
    const { inputs, leftOut } = eligibleForDraw(roster, [], []);
    expect(inputs.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's04']);
    expect(leftOut).toEqual([]);
    const draw = drawOrder(newDraft('d1', 'x', T0), { roster, inactive: [], seed: SEED, at: T0 });
    expect(draw.entries).toHaveLength(4);
    // And toggling it later changes nothing about who is next.
    const flipped = roster.map((s) => ({ ...s, active: !s.active }));
    expect(nextUp(draw, ctx({ roster: flipped })).entry).toBe(nextUp(draw, ctx({ roster })).entry);
  });

  it('at the draw: "not presenting in this class" and an open-ended exclusion are left out; a dated exclusion is placed', () => {
    const draw = drawn(6, SEED, (d) => editDraft(d, { exclusions: [{ studentId: 's02', reason: 'excused', backOn: null }, { studentId: 's03', reason: 'excused', backOn: '2026-12-05' }] }), inactive('s01'));
    expect(draw.order!.inputIds).toEqual(['s03', 's04', 's05', 's06']);
    expect(draw.base!.leftOut).toEqual([
      { studentId: 's01', name: 'Ada Sample', why: 'not_presenting' },
      { studentId: 's02', name: 'Ben Placeholder', why: 'excluded' },
    ]);
    const cy = draw.entries.findIndex((e) => e.studentId === 's03');
    expect(passOverReason(draw, cy, ctx())).toBe('excluded');
    expect(passOverReason(draw, cy, ctx({ today: '2026-12-04' }))).toBe('excluded');
    expect(passOverReason(draw, cy, ctx({ today: '2026-12-05' }))).toBeNull();
  });

  it('after the draw: each reason passes a presenter over without moving them, and they return to their own place', () => {
    const draw = drawn(6);
    const first = draw.sequence[0];
    const second = draw.sequence[1];
    const firstId = draw.entries[first].studentId;
    const order = JSON.stringify(draw.sequence);

    // Class level.
    expect(nextUp(draw, ctx({ inactive: inactive(firstId) }))).toEqual({ entry: second, passed: [[first, 2]] });
    // Removed from the roster.
    expect(nextUp(draw, ctx({ roster: rosterOf(6).filter((s) => s.id !== firstId) }))).toEqual({ entry: second, passed: [[first, 1]] });
    // Draw level, open-ended, then lifted.
    let excluded = act(draw, { type: 'exclude', studentId: firstId, reason: 'excused', backOn: null }, ctx());
    expect(nextUp(excluded, ctx())).toEqual({ entry: second, passed: [[first, 3]] });
    excluded = act(excluded, { type: 'include', studentId: firstId }, ctx());
    expect(nextUp(excluded, ctx()).entry).toBe(first);
    // Held for the next meeting.
    const held = act(draw, { type: 'defer', entry: first, how: 'next_meeting' }, ctx());
    expect(held.entries[first].notBefore).toBe(nextDay(DAY));
    expect(nextUp(held, ctx())).toEqual({ entry: second, passed: [[first, 4]] });
    expect(nextUp(held, ctx({ today: nextDay(DAY) })).entry).toBe(first);
    // Absent today only.
    const absent = act(draw, { type: 'absent', entry: first }, ctx());
    expect(nextUp(absent, ctx())).toEqual({ entry: second, passed: [[first, 5]] });
    expect(nextUp(absent, ctx({ today: nextDay(DAY) })).entry).toBe(first);
    // None of it rewrote the order.
    for (const d of [excluded, held, absent]) expect(JSON.stringify(d.sequence)).toBe(order);
  });

  it('shows one reason in a fixed order of precedence when several apply', () => {
    let draw = drawn(6);
    const first = draw.sequence[0];
    const id = draw.entries[first].studentId;
    draw = act(draw, { type: 'absent', entry: first }, ctx());
    expect(passOverReason(draw, first, ctx())).toBe('absent');
    draw = act(draw, { type: 'defer', entry: first, how: 'next_meeting' }, ctx());
    expect(passOverReason(draw, first, ctx())).toBe('held');
    draw = act(draw, { type: 'exclude', studentId: id, reason: 'excused', backOn: '2026-12-09' }, ctx());
    expect(passOverReason(draw, first, ctx())).toBe('excluded');
    expect(passOverReason(draw, first, ctx({ inactive: inactive(id) }))).toBe('not_presenting');
    expect(passOverReason(draw, first, ctx({ inactive: inactive(id), roster: [] }))).toBe('not_on_roster');
  });

  it('a reveal names the presenter it expects, records who was passed over, and is refused if that is no longer the next one', () => {
    const draw = act(drawn(6), { type: 'absent', entry: drawn(6).sequence[0] }, ctx());
    const [first, second, third] = draw.sequence;
    expect(() => act(draw, { type: 'reveal', entry: first }, ctx())).toThrow(PresentationError);
    expect(() => act(draw, { type: 'reveal', entry: third }, ctx())).toThrow(/no longer the one this page was showing/);
    const revealed = act(draw, { type: 'reveal', entry: second }, ctx());
    expect(revealed.entries[second].status).toBe('presenting');
    expect(revealed.events[revealed.events.length - 1]).toMatchObject({ t: 'revealed', e: second, f: { passed: `${first}:5` } });
    // Only one presenter at a time.
    expect(() => act(revealed, { type: 'reveal', entry: third }, ctx())).toThrow(PresentationError);
  });

  it('marking the current presenter absent returns them to waiting at their own place', () => {
    let draw = drawn(6);
    const first = draw.sequence[0];
    draw = act(draw, { type: 'reveal', entry: first }, ctx());
    draw = act(draw, { type: 'absent', entry: first }, ctx());
    expect(draw.entries[first]).toMatchObject({ status: 'waiting', revealedAt: T0 });
    expect(draw.sequence[0]).toBe(first);
    expect(nextUp(draw, ctx({ today: nextDay(DAY) })).entry).toBe(first);
  });

  it('a student added after the draw goes to the end as a teacher addition, and nobody else moves', () => {
    const draw = drawn(5);
    const before = [...draw.sequence];
    const added = act(draw, { type: 'add_later', studentId: 's06' }, ctx());
    expect(added.sequence).toEqual([...before, 5]);
    expect(added.entries[5]).toMatchObject({ studentId: 's06', nameAtDraw: 'Fay Example', origin: 'added_later', drawnPosition: null, status: 'waiting' });
    expect(() => act(added, { type: 'add_later', studentId: 's06' }, ctx())).toThrow(/already in this draw/);
    expect(() => act(draw, { type: 'add_later', studentId: 'nobody' }, ctx())).toThrow(/not on the roster/);
  });

  it('defer moves exactly one presenter: after the next one, to the end, or to the next meeting', () => {
    const draw = drawn(6);
    const [a, b, c, d, e, f] = draw.sequence;
    expect(act(draw, { type: 'defer', entry: a, how: 'after_next' }, ctx()).sequence).toEqual([b, a, c, d, e, f]);
    expect(act(draw, { type: 'defer', entry: a, how: 'end' }, ctx()).sequence).toEqual([b, c, d, e, f, a]);
    expect(act(draw, { type: 'defer', entry: c, how: 'after_next' }, ctx()).sequence).toEqual([a, b, d, c, e, f]);
    const planned = act(draw, { type: 'schedule', meeting: { date: '2026-12-08', state: 'planned', minutesAvailable: null, fixedCount: null } }, ctx());
    expect(act(planned, { type: 'defer', entry: a, how: 'next_meeting' }, ctx()).entries[a].notBefore).toBe('2026-12-08');
    expect(() => act(draw, { type: 'defer', entry: f, how: 'after_next' }, ctx())).toThrow(/nobody available/);
  });

  it('class-level eligibility is one log entry per change, and the list is what the log adds up to', () => {
    let data = emptyPresentation();
    data = setPresenting(data, 's01', false, 'left_the_class', T0);
    data = setPresenting(data, 's02', false, 'teacher_choice', T0);
    data = setPresenting(data, 's01', true, 'teacher_choice', T0);
    expect(data.classLog.map((e) => [e.n, e.t])).toEqual([[1, 'not_presenting'], [2, 'not_presenting'], [3, 'presenting']]);
    expect(data.inactive).toEqual([{ studentId: 's02', reason: 'teacher_choice', since: T0 }]);
    expect(foldClassLog(data.classLog)).toEqual({ inactive: data.inactive, movedTo: null });
    expect(() => setPresenting(data, 's02', false, 'teacher_choice', T0)).toThrow(/already marked/);
    expect(() => setPresenting(data, 's01', true, 'teacher_choice', T0)).toThrow(/already presenting/);
  });
});

describe('scheduling', () => {
  const timing = { minutesPerPresentation: 6, changeoverMinutes: 1, minutesAvailable: 45, breakMinutes: 5 };

  it.each([
    [timing, 5],
    [{ ...timing, breakMinutes: 0 }, 6],
    [{ ...timing, minutesAvailable: 6 + 5 }, 1],
    [{ ...timing, minutesAvailable: 5 + 5 }, 0],
    [{ ...timing, minutesAvailable: 3 }, 0],
    [{ ...timing, minutesPerPresentation: 0 }, 0],
    [{ ...timing, changeoverMinutes: 0, breakMinutes: 0, minutesAvailable: 60, minutesPerPresentation: 10 }, 6],
  ])('how many fit in a meeting: %o gives %i', (t, expected) => {
    expect(slotsFor(t)).toBe(expected);
  });

  it('a count typed for a date wins, and a date can have its own minutes', () => {
    expect(slotsFor(timing, { date: DAY, state: 'planned', minutesAvailable: null, fixedCount: 3 })).toBe(3);
    expect(slotsFor(timing, { date: DAY, state: 'planned', minutesAvailable: 90, fixedCount: null })).toBe(12);
  });

  it('walks the waiting presenters across planned dates, skips skipped dates, honours holds, and says how many more meetings are needed', () => {
    let draw = drawn(6, SEED, (d) =>
      editDraft(d, {
        timing: { minutesPerPresentation: 10, changeoverMinutes: 0, minutesAvailable: 20, breakMinutes: 0 },
        meetings: [
          { date: '2026-12-01', state: 'planned', minutesAvailable: null, fixedCount: null },
          { date: '2026-12-03', state: 'skipped', minutesAvailable: null, fixedCount: null },
          { date: '2026-12-08', state: 'planned', minutesAvailable: null, fixedCount: null },
        ],
      })
    );
    const [a, b, c, d, e, f] = draw.sequence;
    let plan = planSchedule(draw, ctx());
    expect(plan.meetings).toEqual([{ date: '2026-12-01', slots: 2, entries: [a, b] }, { date: '2026-12-08', slots: 2, entries: [c, d] }]);
    expect(plan.unscheduled).toEqual([e, f]);
    expect(plan.meetingsNeeded).toBe(1);

    // The first presenter is absent today: they move to the next planned date, and the order itself is untouched.
    draw = act(draw, { type: 'absent', entry: a }, ctx());
    plan = planSchedule(draw, ctx());
    expect(plan.meetings.map((m) => m.entries)).toEqual([[b, c], [a, d]]);
    // A snow day: the date is skipped, its presenters roll forward, and one more meeting is needed.
    const snow = act(draw, { type: 'schedule', meeting: { date: '2026-12-08', state: 'skipped', minutesAvailable: null, fixedCount: null } }, ctx());
    expect(planSchedule(snow, ctx())).toMatchObject({ meetings: [{ date: '2026-12-01', entries: [b, c] }], unscheduled: [a, d, e, f], meetingsNeeded: 2 });
    expect(snow.sequence).toEqual(draw.sequence);
    // Someone not presenting in the class has no date at all.
    expect(planSchedule(draw, ctx({ inactive: [{ studentId: draw.entries[f].studentId, reason: 'teacher_choice', since: T0 }] })).blocked).toEqual([f]);
  });

  it('dates are plain calendar days: daylight saving and the year end cannot move one', () => {
    // Sunday 14 March 2027 is when clocks change in the United States.
    expect(datesFrom('2027-03-08', [1, 3, 5], 6)).toEqual(['2027-03-08', '2027-03-10', '2027-03-12', '2027-03-15', '2027-03-17', '2027-03-19']);
    expect(datesFrom('2026-12-29', [2, 4], 4)).toEqual(['2026-12-29', '2026-12-31', '2027-01-05', '2027-01-07']);
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(nextDay('2027-02-28')).toBe('2027-03-01');
    expect(isDateKey('2027-02-29')).toBe(false);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(datesFrom('2027-03-08', [], 3)).toEqual([]);
  });
});

describe('the student display view', () => {
  it('before any reveal it names nobody; after a reveal only that presenter', () => {
    let draw = drawn(6);
    expect(publicView(draw, rosterOf(6))).toEqual({ title: 'Biome talks', state: 'not_started', presenting: null, onDeck: null, done: 0, total: 6 });
    draw = act(draw, { type: 'reveal', entry: draw.sequence[0] }, ctx());
    const view = publicView(draw, rosterOf(6));
    expect(view).toMatchObject({ state: 'presenting', presenting: draw.entries[draw.sequence[0]].nameAtDraw, onDeck: null });
    draw = act(draw, { type: 'on_deck', entry: draw.sequence[1] }, ctx());
    expect(publicView(draw, rosterOf(6)).onDeck).toBe(draw.entries[draw.sequence[1]].nameAtDraw);
  });

  it('never contains a name the teacher has not revealed, in any state reached by random actions', () => {
    const rng = createRng('display-privacy');
    const tick = ticker();
    const roster = rosterOf(10);
    let draw = drawOrder(newDraft('d1', 'Biome talks', T0), { roster: roster.slice(0, 8), inactive: [], seed: SEED, at: T0 });
    for (let step = 0; step < 400; step++) {
      const context = { roster, inactive: [], today: DAY, at: tick() };
      const action = pickAction(draw, context, rng);
      if (!action) break;
      draw = act(draw, action, context);
      const text = JSON.stringify(publicView(draw, roster));
      for (const [index, entry] of draw.entries.entries()) {
        const shown = entry.status === 'presenting' || entry.status === 'on_deck';
        if (!shown) expect(text.includes(entry.nameAtDraw), `step ${step}: ${entry.nameAtDraw} (entry ${index}, ${entry.status}) is in the display view`).toBe(false);
      }
      expect(text).not.toMatch(/s\d\d/);
    }
  });
});
