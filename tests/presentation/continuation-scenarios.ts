/**
 * "Continue in a new class": the new class must be one coherent snapshot.
 *
 * Roster, settings, ring weights, presentation state and the current day's
 * absences in the new class all have to come from the same moment of the old
 * class. These scenarios put another tab's edit at exact points around the
 * step that freezes the old class, interrupt it, repeat it and race it.
 *
 * No test-runner imports. The same scenarios run in Vitest against the
 * in-memory store and the IndexedDB code, and inside real Chromium against the
 * browser's own IndexedDB (e2e/smoke.mjs).
 *
 * Every name and address is invented.
 */
import {
  ContinuationChangedError,
  ContinuationConflictError,
  continueInNewClass,
  finishMoving,
  performAction,
  presentationTokenOf,
  reopenPresentations,
} from '../../src/data/local/presentations';
import { createWorkspace, type Workspace } from '../../src/data/local/schema';
import { StoreConflictError, type WorkspaceStore } from '../../src/data/local/store';
import { addStudents, applyRecoveryPoint, deleteWorkspace, exportBackup, removeStudent, seenClasses, updateStudent } from '../../src/data/local/workspaces';
import { markMoved } from '../../src/presentation/eligibility';
import { PresentationError } from '../../src/presentation/types';
import { PresentationInvalidError, PresentationMovedError, validatePresentation } from '../../src/presentation/validate';
import { sampleSpins } from '../local/fixtures';
import { DAY, T0 } from './random-actions';
import { check, drawIn, makeClass, now, refused, revealNext, same, snapshot, startDraw, tokenNow, type Scenario, type Tabs } from './scenarios';

/** The step that freezes the old class. (`updatePresentation` is where a two-step version would do it.) */
const FREEZE_STEPS = ['continuePresentation', 'updatePresentation'];

/** Run `otherTab` once, immediately before or immediately after this tab's freezing step. */
export function around(store: WorkspaceStore, when: 'before' | 'after', otherTab: () => Promise<unknown>): WorkspaceStore {
  let done = false;
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (!FREEZE_STEPS.includes(String(property))) return bound;
      return async (...args: unknown[]) => {
        const mine = !done;
        done = true;
        if (mine && when === 'before') await otherTab();
        const result = await bound(...args);
        if (mine && when === 'after') await otherTab();
        return result;
      };
    },
  });
}

/** What the new class copies from the old one besides presentation data. */
export const configOf = (workspace: Workspace) => ({ students: workspace.students, settings: workspace.settings, rings: workspace.rings });

const SETTINGS = [{ key: 'enableConfetti', value: 'false', notes: 'quiet room' }];
const RINGS: Workspace['rings'] = [{ ring_name: 'A', label: 'Africa', color_hex: '#2e7d32', weight: 3, order_index: 0, active: true }];

/** Everything another tab can change about a class without touching presentation data. */
export async function editEverything(store: WorkspaceStore, id: string, drawnStudent: string): Promise<void> {
  await removeStudent(store, await now(store, id), drawnStudent);
  await updateStudent(store, await now(store, id), 's01', { name: 'Ada Renamed', active: false });
  await addStudents(store, await now(store, id), [{ name: 'Gus Madeup', email: '' }]);
  const workspace = await now(store, id);
  await store.updateWorkspace(id, workspace.rev, (current) => ({ ...current, settings: SETTINGS, rings: RINGS }));
}

/** A class part-way through a draw, with one presenter absent today. Returns a presenter who is still waiting. */
export async function midDraw(open: () => Promise<Tabs>) {
  const tabs = await open();
  const cls = await makeClass(tabs.a, { count: 8 });
  const drawId = await startDraw(tabs.a, cls.id);
  await revealNext(tabs.a, cls.id, drawId);
  const order = drawIn(await now(tabs.a, cls.id), drawId);
  const absentEntry = order.sequence[3];
  await performAction(tabs.a, cls.id, await tokenNow(tabs.a, cls.id), drawId, { type: 'absent', entry: absentEntry }, { today: DAY, now: new Date(T0) });
  const waiting = order.entries[order.sequence[5]].studentId;
  return { ...tabs, id: cls.id, drawId, waiting, absent: order.entries[absentEntry].studentId };
}

/** The new class is internally consistent and matches the given moment of the old class. */
export function checkCoherent(destination: Workspace, sourceThen: Workspace, drawId: string, absent: string, label: string): void {
  check(same(configOf(destination), configOf(sourceThen)), `${label}: the new class's roster, settings or ring weights are not the old class's at the moment it was frozen`);
  check(validatePresentation(destination.presentation).ok, `${label}: the new class is not valid`);
  const carried = drawIn(destination, drawId);
  const source = drawIn(sourceThen, drawId);
  const remaining = source.sequence.filter((i) => source.entries[i].status !== 'done').map((i) => source.entries[i].studentId);
  check(same(carried.sequence.map((i) => carried.entries[i].studentId), remaining), `${label}: the remaining order is not the old class's`);
  check(same(carried.absences.map((x) => [carried.entries[x.entry].studentId, x.date]), [[absent, DAY]]), `${label}: today's absence was not carried`);
  // Every presenter who was on the roster when the class was frozen is on the new class's roster, and nobody else is.
  const roster = new Set(destination.students.map((s) => s.id));
  const rosterThen = new Set(sourceThen.students.map((s) => s.id));
  for (const entry of carried.entries) {
    check(roster.has(entry.studentId) === rosterThen.has(entry.studentId), `${label}: ${entry.nameAtDraw} is on one roster and not the other`);
  }
}

export const continuationScenarios: Scenario[] = [
  {
    id: 'X1',
    name: 'an edit to the roster, settings or ring weights landing immediately after the old class is frozen is not in the new class: the new class is the old class at the moment it was frozen',
    async run(open) {
      const { a, b, id, drawId, waiting, absent } = await midDraw(open);
      const atFreeze = await now(a, id);
      const racing = around(a, 'after', () => editEverything(b, id, waiting));
      const result = await continueInNewClass(racing, id, presentationTokenOf(atFreeze), { today: DAY, now: new Date('2026-12-01T16:00:00.000Z') });
      check(result.created, 'the new class was created');

      const destination = await now(a, result.destinationId);
      checkCoherent(destination, atFreeze, drawId, absent, 'edit after the freeze');
      // The other tab's edits were not lost. They are in the old class, where they were made.
      const source = await now(a, id);
      check(!source.students.some((s) => s.id === waiting) && source.students.some((s) => s.name === 'Gus Madeup'), 'the roster edits are in the old class');
      check(same(source.settings, SETTINGS) && same(source.rings, RINGS), 'the settings and ring weights are in the old class');
      check(same(source.presentation!.draws, atFreeze.presentation!.draws), 'and the old class keeps every draw exactly');
    },
  },
  {
    id: 'X2',
    name: 'an edit landing immediately before the old class is frozen is in both: the new class and the old class agree',
    async run(open) {
      const { a, b, id, drawId, waiting, absent } = await midDraw(open);
      const seen = await now(a, id);
      const racing = around(a, 'before', () => editEverything(b, id, waiting));
      // A roster edit does not move the presentation token, so this tab's Continue is still current.
      const result = await continueInNewClass(racing, id, presentationTokenOf(seen), { today: DAY, now: new Date('2026-12-01T16:00:00.000Z') });
      const source = await now(a, id);
      const destination = await now(a, result.destinationId);
      check(same(configOf(destination), configOf(source)), 'the new class and the old class have the same roster, settings and ring weights');
      check(same(destination.settings, SETTINGS) && destination.students.some((s) => s.name === 'Gus Madeup'), 'and both have the edit');
      check(validatePresentation(destination.presentation).ok, 'the new class is valid');
      // The removed student is still in the carried order, exactly as in the old class, and is passed over as "not on the roster".
      const carried = drawIn(destination, drawId);
      check(carried.entries.some((e) => e.studentId === waiting), 'the removed student stays in the carried order');
      check(same(carried.absences.map((x) => carried.entries[x.entry].studentId), [absent]), "today's absence was carried");
    },
  },
  {
    id: 'X3',
    name: 'interrupted while creating the new class, then the roster is edited, then recovery: the new class matches the old class at the moment recorded as the freeze',
    async run(open) {
      const { a, b, id, drawId, waiting, absent } = await midDraw(open);
      const first = await now(a, id);
      const firstAt = '2026-12-01T16:00:00.000Z';
      const secondAt = '2026-12-03T16:00:00.000Z';

      const failure = await continueInNewClass(interrupted(a), id, presentationTokenOf(first), { today: DAY, now: new Date(firstAt) }).then(
        () => null,
        (err: unknown) => err as Error
      );
      check(failure !== null && /QuotaExceededError/.test(failure.message), `the interruption should surface, got: ${String(failure)}`);
      check((await a.listWorkspaces()).length === 1, 'no new class exists after the interruption');

      // Days pass. The old class is still used: its roster, settings and ring weights change, and spins are logged.
      await editEverything(b, id, waiting);
      await b.appendSpin(sampleSpins(await now(b, id), 1)[0]);
      const later = await now(a, id);

      // Recovery, from the other tab.
      const result = await continueInNewClass(b, id, presentationTokenOf(later), { today: DAY, now: new Date(secondAt) });
      const all = await a.listWorkspaces();
      check(all.length === 2, `expected the old class and one new class, found ${all.length}`);
      const source = await now(a, id);
      const destination = await now(a, result.destinationId);
      const frozenAt = source.presentation!.movedTo!.at;
      check(frozenAt === firstAt || frozenAt === secondAt, 'the old class records when it was frozen');
      // Whichever moment the old class says it was frozen at, the new class must be the old class at that moment.
      checkCoherent(destination, frozenAt === firstAt ? first : later, drawId, absent, `frozen at ${frozenAt}`);
      check(same(source.presentation!.draws, first.presentation!.draws), 'the old class keeps every draw exactly');
    },
  },
  {
    id: 'X4',
    name: 'an interruption while the new class is being written undoes the whole step: the old class is not frozen, no class is created, and the same press works when repeated',
    async run(open) {
      const { a, id, drawId, absent } = await midDraw(open);
      const first = await now(a, id);
      const before = await snapshot(a);
      const failure = await continueInNewClass(interrupted(a), id, presentationTokenOf(first), { today: DAY }).then(
        () => null,
        (err: unknown) => err as Error
      );
      check(failure !== null && /QuotaExceededError/.test(failure.message), `the interruption should surface, got: ${String(failure)}`);
      check((await snapshot(a)) === before, 'storage is exactly as it was: nothing frozen, nothing created, token unchanged');
      // The class is not stuck. An ordinary action still works with the view this tab already had.
      const presenting = drawIn(first, drawId).entries.findIndex((e) => e.status === 'presenting');
      const acted = await performAction(a, id, presentationTokenOf(first), drawId, { type: 'done', entry: presenting }, { today: DAY, now: new Date(T0) });
      // And so does Continue.
      const result = await continueInNewClass(a, id, presentationTokenOf(acted), { today: DAY });
      check(result.created && (await a.listWorkspaces()).length === 2, 'the repeated Continue creates exactly one new class');
      checkCoherent(await now(a, result.destinationId), acted, drawId, absent, 'after an interruption');
    },
  },
  {
    id: 'X5',
    name: 'retries from any tab, with any token, after the new class is in use: no second class, and the new class is never reset or overwritten',
    async run(open) {
      const { a, b, id, drawId, waiting } = await midDraw(open);
      const first = await now(a, id);
      const result = await continueInNewClass(a, id, presentationTokenOf(first), { today: DAY });
      // Work goes on in the new class, and the old class is still used for the wheel.
      const carried = drawIn(await now(a, result.destinationId), drawId);
      await performAction(b, result.destinationId, await tokenNow(b, result.destinationId), drawId, { type: 'done', entry: carried.entries.findIndex((e) => e.status === 'presenting') }, { today: DAY, now: new Date(T0) });
      await updateStudent(b, await now(b, result.destinationId), 's02', { name: 'Ben Corrected' });
      await editEverything(b, id, waiting);
      const settled = await snapshot(a);

      const same_ = { destinationId: result.destinationId, created: false };
      check(same(await continueInNewClass(a, id, presentationTokenOf(first), { today: DAY }), same_), 'pressing Continue again with the old view finds the class that exists');
      check(same(await continueInNewClass(b, id, await tokenNow(b, id), { today: DAY, destinationId: 'somewhere-else' }), same_), 'so does another tab, even naming another id');
      check(same(await finishMoving(a, id), same_), 'so does "Finish moving"');
      check(same(await finishMoving(b, id, { acceptCurrentClass: true }), same_), 'even when told the current class may be used');
      const results = await Promise.all([finishMoving(a, id), finishMoving(b, id), continueInNewClass(a, id, presentationTokenOf(first), { today: DAY })]);
      check(results.every((r) => same(r, same_)), 'and so do three at once');
      check((await snapshot(a)) === settled, 'none of it changed anything: one new class, with the work done in it intact');
      check((await a.listWorkspaces()).length === 2, 'there are exactly two classes');
    },
  },
  {
    id: 'X6',
    name: 'after continuing, the old class is still a working class for the wheel: roster, settings, ring weights, spins, backup, delete and put-back; neither class changes the other',
    async run(open) {
      const { a, b, id, drawId, waiting } = await midDraw(open);
      const result = await continueInNewClass(a, id, await tokenNow(a, id), { today: DAY });
      const destination = JSON.stringify(await a.getBundle(result.destinationId));
      const frozenDraws = JSON.stringify((await now(a, id)).presentation);

      // Everything the wheel needs from the old class still works there.
      await editEverything(b, id, waiting);
      for (const spin of sampleSpins(await now(a, id), 3)) await a.appendSpin(spin);
      const file = await exportBackup(a, [id]);
      check(file.workspaces[0].spins.length === 3 && file.formatVersion === 2, 'the old class backs up, spins and presentation history included');
      const point = await deleteWorkspace(a, id, (await seenClasses(a))[id]);
      check(point, 'the old class can be deleted');
      await applyRecoveryPoint(a, point, await seenClasses(a));
      const source = await now(a, id);
      check(source.students.some((s) => s.name === 'Gus Madeup') && source.settings.length === 1 && source.rings.length === 1 && (await a.listSpins(id)).length === 3, 'and put back, with its roster, settings, ring weights and spins');
      // Its presentation history is still there, still closed, still pointing at the same class.
      check(JSON.stringify({ ...source.presentation, epoch: '' }) === JSON.stringify({ ...JSON.parse(frozenDraws), epoch: '' }), 'its presentation history is unchanged');
      await refused(performAction(a, id, presentationTokenOf(source), drawId, { type: 'archive' }, { today: DAY }), PresentationMovedError, 'a presentation action in the old class');
      check(same(await finishMoving(a, id), { destinationId: result.destinationId, created: false }), 'and it still knows where its presentations continued');
      check(JSON.stringify(await a.getBundle(result.destinationId)) === destination, 'none of that touched the new class');

      // And the other way round.
      const old = JSON.stringify(await a.getBundle(id));
      await updateStudent(a, await now(a, result.destinationId), 's03', { active: false });
      await a.appendSpin(sampleSpins(await now(a, result.destinationId), 1)[0]);
      await revealOrFinish(a, result.destinationId, drawId);
      check(JSON.stringify(await a.getBundle(id)) === old, 'work in the new class does not touch the old class');
    },
  },
  {
    id: 'X7',
    name: 'the new class is deleted and the old class has not changed: it is created again exactly as it was first created, once, from whichever tab asks',
    async run(open) {
      const { a, b, id } = await midDraw(open);
      const result = await continueInNewClass(a, id, await tokenNow(a, id), { today: DAY, now: new Date('2026-12-01T16:00:00.000Z') });
      const original = await now(a, result.destinationId);
      const point = await deleteWorkspace(a, result.destinationId, (await seenClasses(a))[result.destinationId]);
      check(point && (await a.listWorkspaces()).length === 1, 'the new class is gone');

      // Two tabs ask at the same moment, days later.
      const later = { now: new Date('2026-12-09T16:00:00.000Z') };
      const [x, y] = await Promise.all([finishMoving(a, id, later), finishMoving(b, id, later)]);
      check(x.destinationId === result.destinationId && y.destinationId === result.destinationId, 'both are told the same class');
      check([x.created, y.created].filter(Boolean).length === 1, 'exactly one of them created it');
      check((await a.listWorkspaces()).length === 2, 'there is one new class');
      const again = await now(a, result.destinationId);
      check(same(essential(again), essential(original)), 'it is the class as it was first created: same roster, settings, ring weights, presentation state, name and dates');
      check(again.presentation!.epoch !== original.presentation!.epoch, 'under a new lineage id');

      // The other way back: delete it again and use "Put it back" instead. Then there is nothing to create.
      const second = await deleteWorkspace(a, result.destinationId, (await seenClasses(a))[result.destinationId]);
      await applyRecoveryPoint(a, second!, await seenClasses(a));
      check(same(await finishMoving(b, id), { destinationId: result.destinationId, created: false }), 'after "Put it back" the class is simply found');
      // Pressing Continue on the old class does the same, and creates nothing new.
      check(same(await continueInNewClass(a, id, await tokenNow(a, id), { today: DAY }), { destinationId: result.destinationId, created: false }), 'and Continue finds it too');
    },
  },
  {
    id: 'X8',
    name: 'the new class is deleted and the old class HAS changed since: nothing is created silently; the teacher either accepts the class as it is now, in one coherent step, or reopens',
    async run(open) {
      for (const choice of ['accept', 'reopen'] as const) {
        const { a, b, id, drawId, waiting, absent } = await midDraw(open);
        const atFreeze = await now(a, id);
        const result = await continueInNewClass(a, id, presentationTokenOf(atFreeze), { today: DAY, now: new Date('2026-12-01T16:00:00.000Z') });
        await deleteWorkspace(a, result.destinationId, (await seenClasses(a))[result.destinationId]);
        // The recovery copies are gone too (as after five later deletions).
        for (const p of await a.listRecoveryPoints()) await a.deleteRecoveryPoint(p.id);
        // The old class's roster changes: one edit is enough.
        await updateStudent(b, await now(b, id), 's01', { name: 'Ada Renamed' });
        const before = await snapshot(a);

        await refused(finishMoving(a, id), ContinuationChangedError, `${choice}: recreating the class silently`);
        await refused(continueInNewClass(b, id, await tokenNow(b, id), { today: DAY }), ContinuationChangedError, `${choice}: pressing Continue again`);
        check((await snapshot(a)) === before, `${choice}: a refusal changes nothing`);

        if (choice === 'accept') {
          await editEverything(b, id, waiting);
          const current = await now(a, id);
          const made = await finishMoving(a, id, { acceptCurrentClass: true, now: new Date('2026-12-09T16:00:00.000Z') });
          check(made.created && made.destinationId === result.destinationId, 'the class is created under the id the old class names');
          const destination = await now(a, made.destinationId);
          check(same(configOf(destination), configOf(current)), 'with the roster, settings and ring weights the old class has now, all from one reading');
          check(destination.createdAt === '2026-12-09T16:00:00.000Z', 'dated when it was really made, not when the old class was frozen');
          check(validatePresentation(destination.presentation).ok, 'and valid');
          const carried = drawIn(destination, drawId);
          const source = drawIn(atFreeze, drawId);
          check(same(carried.sequence.map((i) => carried.entries[i].studentId), source.sequence.filter((i) => source.entries[i].status !== 'done').map((i) => source.entries[i].studentId)), 'the presentation state is the frozen one');
          check(same(carried.absences.map((x) => carried.entries[x.entry].studentId), [absent]), "including the day's absence");
          check((await a.listWorkspaces()).length === 2, 'one new class');
        } else {
          const reopened = await reopenPresentations(a, id, await tokenNow(a, id));
          check(reopened.presentation!.movedTo === null && (await a.listWorkspaces()).length === 1, 'the old class is open again and no class was created');
          await refused(finishMoving(b, id), PresentationError, 'recreating after the old class was reopened');
          // A new Continue is a new continuation, coherent with the class as it is at that moment.
          const current = await now(a, id);
          const next = await continueInNewClass(a, id, presentationTokenOf(current), { today: DAY });
          check(next.created && next.destinationId !== result.destinationId, 'continuing again makes a new class under a new id');
          checkCoherent(await now(a, next.destinationId), current, drawId, absent, 'continued again');
        }
      }
    },
  },
  {
    id: 'X9',
    name: 'a class under the destination id that is not this continuation (unrelated, or claiming another marker or another class) is never accepted and never overwritten',
    async run(open) {
      for (const kind of ['unrelated', 'another marker', 'another class'] as const) {
        const { a, b, id } = await midDraw(open);
        const result = await continueInNewClass(a, id, await tokenNow(a, id), { today: DAY });
        const original = await now(a, result.destinationId);
        await a.replaceClasses({ remove: [{ id: result.destinationId, expected: (await seenClasses(a))[result.destinationId], recover: false }], put: [] });

        const marker = original.presentation!.continuedFrom!;
        const impostor: Workspace =
          kind === 'unrelated'
            ? { ...createWorkspace('Unrelated class', new Date(T0)), id: result.destinationId }
            : { ...original, name: 'Looks like the continuation', presentation: { ...original.presentation!, continuedFrom: kind === 'another marker' ? { ...marker, marker: marker.marker + 2 } : { ...marker, classId: 'some-other-class' } } };
        await b.createWorkspace(impostor);
        const before = await snapshot(a);

        await refused(finishMoving(a, id), ContinuationConflictError, `${kind}: accepting it as the continuation`);
        await refused(finishMoving(b, id, { acceptCurrentClass: true }), ContinuationConflictError, `${kind}: accepting it when told the current class may be used`);
        await refused(continueInNewClass(a, id, await tokenNow(a, id), { today: DAY }), ContinuationConflictError, `${kind}: pressing Continue again`);
        check((await snapshot(a)) === before, `${kind}: nothing was overwritten or changed`);
        // It is not this class's continuation, so it does not hold the old class shut either.
        const reopened = await reopenPresentations(a, id, await tokenNow(a, id));
        check(reopened.presentation!.movedTo === null, `${kind}: the old class can be reopened`);
        check(same(await now(a, result.destinationId), impostor), `${kind}: and the other class is still untouched`);
      }
    },
  },
  {
    id: 'X10',
    name: 'reopening the old class and recreating the new class can never both happen, whichever tab is first',
    async run(open) {
      for (const first of ['recreate', 'reopen'] as const) {
        const { a, b, id } = await midDraw(open);
        const result = await continueInNewClass(a, id, await tokenNow(a, id), { today: DAY });
        await a.replaceClasses({ remove: [{ id: result.destinationId, expected: (await seenClasses(a))[result.destinationId], recover: false }], put: [] });
        const token = await tokenNow(a, id);

        if (first === 'recreate') {
          // The other tab recreates the class after this tab has decided to reopen, immediately before its storage step.
          const racing = around(a, 'before', () => finishMoving(b, id));
          await refused(reopenPresentations(racing, id, token), PresentationError, 'the reopen');
          check((await now(a, id)).presentation!.movedTo?.classId === result.destinationId && (await a.getWorkspace(result.destinationId)) !== null, 'the class was recreated and the old class stays closed');
        } else {
          const racing = around(b, 'before', () => reopenPresentations(a, id, token));
          await refused(finishMoving(racing, id), PresentationError, 'the recreation');
          check((await now(a, id)).presentation!.movedTo === null && (await a.getWorkspace(result.destinationId)) === null, 'the old class was reopened and no class was created');
        }
        check((await a.listWorkspaces()).length === (first === 'recreate' ? 2 : 1), 'never both');
      }
    },
  },
  {
    id: 'X11',
    name: 'the storage step itself: a stale view, an id in use, an invalid new class or an error while building it each leave storage exactly as it was',
    async run(open) {
      const { a, b, id, drawId } = await midDraw(open);
      const seen = await now(a, id);
      const freeze = { expected: presentationTokenOf(seen), change: (current: Workspace['presentation']) => markMoved(current!, 'new-class', T0, DAY, seen.rev) };
      const good = (source: Workspace): Workspace => ({ ...createWorkspace('New class', new Date(T0)), id: 'new-class', rev: 2, students: source.students });
      const before = await snapshot(a);

      // An id that is already a class, checked by the store whatever the caller did.
      await refused(a.continuePresentation(id, freeze, (source) => ({ ...good(source), id })), StoreConflictError, 'a new class under the old class\'s own id');
      const other = await makeClass(b, { name: 'Another class' });
      const withOther = await snapshot(a);
      await refused(a.continuePresentation(id, freeze, (source) => ({ ...good(source), id: other.id })), StoreConflictError, 'a new class under an id in use');
      // A new class whose presentation data does not replay.
      const broken = JSON.parse(JSON.stringify(seen.presentation)) as NonNullable<Workspace['presentation']>;
      broken.draws[0].entries[0].status = broken.draws[0].entries[0].status === 'done' ? 'waiting' : 'done';
      await refused(a.continuePresentation(id, freeze, (source) => ({ ...good(source), presentation: broken })), PresentationInvalidError, 'a new class with an inconsistent history');
      // The builder gives up.
      const gaveUp = await a.continuePresentation(id, freeze, () => { throw new Error('changed my mind'); }).then(() => null, (err: unknown) => err as Error);
      check(gaveUp !== null && /changed my mind/.test(gaveUp.message), 'an error from the builder surfaces');
      check((await snapshot(a)) === withOther, 'none of these froze the old class or created anything');

      // A stale view: refused before the builder is even asked.
      await revealOrFinish(b, id, drawId);
      const moved = await snapshot(a);
      let asked = false;
      await refused(a.continuePresentation(id, freeze, (source) => { asked = true; return good(source); }), StoreConflictError, 'a stale freeze');
      check(!asked && (await snapshot(a)) === moved, 'nothing was built or stored');
      check(before !== moved, 'the scenario did change something in between');

      // And when everything is in order, both parts are stored, and the new class is given what the gate gives every write.
      const current = await now(a, id);
      const done = await a.continuePresentation(
        id,
        { ...freeze, expected: presentationTokenOf(current) },
        (source) => ({ ...good(source), presentation: { ...current.presentation!, epoch: '', rev: 0, classLog: [], inactive: [], movedTo: null, draws: [] } })
      );
      check(done.source.presentation!.movedTo?.classId === 'new-class' && same(await now(b, id), done.source), 'the old class is stored as returned');
      check(done.created !== null && same(await now(b, 'new-class'), done.created), 'the new class is stored as returned');
      check(done.created.schemaVersion === 2 && done.created.presentation!.rev === 1 && done.created.presentation!.epoch.length > 0 && done.created.presentation!.epoch !== current.presentation!.epoch, 'with schema 2, revision 1 and a lineage id of its own');
    },
  },
];

/**
 * Make this tab's attempt to create the new class fail once, the way storage
 * running out would. In a two-step version that is the second step. In a
 * one-step version the failure happens inside the step itself, after it has
 * started writing, so the whole step has to roll back.
 */
export function interrupted(store: WorkspaceStore): WorkspaceStore {
  let done = false;
  const fail = () => {
    throw new Error('QuotaExceededError');
  };
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (property === 'putBundles') {
        return async (...args: unknown[]) => {
          if (done) return bound(...args);
          done = true;
          return fail();
        };
      }
      if (property === 'continuePresentation') {
        return (id: unknown, change: unknown, build: (...inner: unknown[]) => Workspace | null) => {
          if (done) return bound(id, change, build);
          done = true;
          // The class to be created cannot be written: reading it for storage fails part-way.
          return bound(id, change, (...inner: unknown[]) => {
            const made = build(...inner);
            return made && Object.defineProperty({ ...made }, 'unwritable', { enumerable: true, get: fail });
          });
        };
      }
      return bound;
    },
  });
}

/** A class without the two things that differ every time it is written: the lineage id and the storage clock. */
function essential(workspace: Workspace): unknown {
  return { ...workspace, presentation: { ...workspace.presentation, epoch: '', updatedAt: '' } };
}

/** One ordinary presentation action: finish whoever is presenting, or reveal the next presenter. */
async function revealOrFinish(store: WorkspaceStore, id: string, drawId: string): Promise<void> {
  const workspace = await now(store, id);
  const presenting = drawIn(workspace, drawId).entries.findIndex((e) => e.status === 'presenting');
  if (presenting >= 0) await performAction(store, id, presentationTokenOf(workspace), drawId, { type: 'done', entry: presenting }, { today: DAY, now: new Date(T0) });
  else await revealNext(store, id, drawId);
}
