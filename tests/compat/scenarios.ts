/**
 * Rollback and roll-forward, proven with the older build's own code.
 *
 * `old` is the frozen baseline (the site as it shipped before Presentation
 * Draw). `fresh` is the current build. Both look at the same storage, exactly
 * as a rolled-back site, or a tab that was never reloaded, would.
 *
 * No test-runner imports: the same scenarios run in Vitest on both stores and
 * in real Chromium against the browser's own IndexedDB (e2e/smoke.mjs).
 *
 * Every name and address is invented.
 */
import { ContinuationChangedError, continueInNewClass, createDraw, finishMoving, performAction, presentationTokenOf, usageOf } from '../../src/data/local/presentations';
import { createWorkspace, parseBackupText, type Workspace } from '../../src/data/local/schema';
import { StoreConflictError, StoreMissingError, type WorkspaceStore } from '../../src/data/local/store';
import * as current from '../../src/data/local/workspaces';
import { nextUp } from '../../src/presentation/eligibility';
import { validatePresentation } from '../../src/presentation/validate';
import { sampleSpins } from '../local/fixtures';
import { DAY, T0 } from '../presentation/random-actions';
import { check, drawIn, makeClass, now, plainClass, refused, revealNext, revealedCount, same, snapshot, startDraw, tokenNow } from '../presentation/scenarios';
import * as baseSchema from './baseline-a785855/schema';
import type { WorkspaceStore as BaselineStore } from './baseline-a785855/store';
import * as base from './baseline-a785855/workspaces';
import type { Pair } from './pair';

export interface CompatScenario {
  id: string;
  name: string;
  run(open: () => Promise<Pair>): Promise<void>;
}

/** The functions both builds have, so one list of edits can be run through either. */
type Api = Pick<
  typeof base,
  'ensureWorkspace' | 'renameWorkspace' | 'addStudents' | 'updateStudent' | 'removeStudent' | 'exportBackup' | 'confirmBackup' | 'deleteWorkspace' | 'applyRecoveryPoint' | 'seenClasses' | 'restoreBackup'
>;
const currentApi = current as unknown as Api;
const asBaseline = (store: WorkspaceStore): BaselineStore => store as unknown as BaselineStore;

/** The ten fields a class record had before this feature. */
const ORIGINAL_FIELDS = ['createdAt', 'id', 'lastBackupAt', 'name', 'rev', 'rings', 'schemaVersion', 'settings', 'students', 'updatedAt'];
const onlyOriginalFields = (workspace: object): boolean => JSON.stringify(Object.keys(workspace).sort()) === JSON.stringify(ORIGINAL_FIELDS);

/** Times and random ids differ from run to run. Everything else, key order included, must not. */
function normalised(value: unknown): string {
  const ids = new Map<string, string>();
  return JSON.stringify(value)
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<time>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
      if (!ids.has(id)) ids.set(id, `<id ${ids.size + 1}>`);
      return ids.get(id) as string;
    });
}

/** Everything in storage, in the order and shape it is stored. */
async function everything(store: BaselineStore): Promise<unknown> {
  const bundles = [];
  for (const workspace of await store.listWorkspaces()) bundles.push(await store.getBundle(workspace.id));
  return { bundles, recovery: await store.listRecoveryPoints() };
}

const classRecord = (id = 'class-1', name = 'Period 3 Ecology') => ({ ...baseSchema.createWorkspace(name, new Date('2026-11-01T14:00:00.000Z')), id });
const fixedSpins = (workspaceId: string, count: number) =>
  sampleSpins({ ...createWorkspace('x'), id: workspaceId }, count).map((spin, i) => ({ ...spin, id: `${workspaceId}-spin-${i}`, studentId: null }));

/** One ordinary afternoon of edits, through whichever build is given. */
async function ordinaryEdits(api: Api, store: BaselineStore): Promise<void> {
  await api.ensureWorkspace(store);
  const record = classRecord();
  await store.createWorkspace(record);
  let w = await api.addStudents(store, record, [
    { name: 'Ada Sample', email: 'ada.sample@example.com' },
    { name: 'Ben Placeholder', email: '' },
    { name: 'Cy Demo', email: '' },
  ]);
  w = await api.renameWorkspace(store, w, 'Period 3 Ecology (B day)');
  w = await api.updateStudent(store, w, w.students[1].id, { name: 'Ben P. Placeholder', active: false });
  w = await api.removeStudent(store, w, w.students[2].id);
  w = await store.updateWorkspace(w.id, w.rev, (c) => ({ ...c, settings: [{ key: 'enableConfetti', value: 'false', notes: 'quiet room' }] }));
  for (const spin of fixedSpins(w.id, 3)) await store.appendSpin(spin);
  await api.confirmBackup(store, await api.exportBackup(store, undefined, new Date('2026-11-21T00:00:00.000Z')));
  const spare = classRecord('class-2', 'Spare class');
  await store.createWorkspace(spare);
  const point = await api.deleteWorkspace(store, spare.id, (await api.seenClasses(store))[spare.id]);
  check(point, 'delete returns a recovery copy');
  await api.applyRecoveryPoint(store, point, await api.seenClasses(store));
  await api.deleteWorkspace(store, spare.id, (await api.seenClasses(store))[spare.id]);
}

/** A class with a draw in progress, written by the current build. */
async function withDraw(pair: Pair) {
  const cls = await makeClass(pair.fresh);
  // What the older site would have backed up before any presentation data existed.
  const olderFile = await base.exportBackup(pair.old, [cls.id], new Date('2026-11-10T00:00:00.000Z'));
  const drawId = await startDraw(pair.fresh, cls.id);
  await revealNext(pair.fresh, cls.id, drawId);
  return { ...pair, id: cls.id, drawId, olderFile, before: await now(pair.fresh, cls.id) };
}

const baselineClass = async (store: BaselineStore, id: string) => {
  const workspace = await store.getWorkspace(id);
  check(workspace, 'the older build should find the class');
  return workspace;
};

export const compatScenarios: CompatScenario[] = [
  {
    id: 'C1',
    name: 'a class with no presentation data is stored exactly as the older build stores it: same fields, same order, same values, schema 1',
    async run(open) {
      const [one, two] = [await open(), await open()];
      await ordinaryEdits(currentApi, asBaseline(one.fresh));
      await ordinaryEdits(base, two.old);
      const [mine, theirs] = [await everything(asBaseline(one.fresh)), await everything(two.old)];
      check(normalised(mine) === normalised(theirs), 'the two builds stored different records for the same edits');
      for (const workspace of await one.fresh.listWorkspaces()) {
        check(onlyOriginalFields(workspace), `"${workspace.name}" does not have exactly the ten original fields`);
        check(workspace.schemaVersion === 1, `"${workspace.name}" is not schema 1`);
      }
    },
  },
  {
    id: 'C2',
    name: 'a backup with no presentation data is, byte for byte, the file the older build writes',
    async run(open) {
      const [one, two] = [await open(), await open()];
      for (const store of [asBaseline(one.fresh), two.old]) {
        for (const [id, name, spins] of [['class-1', 'Period 3 Ecology', 5], ['class-2', 'Period 5 Ecology', 0]] as const) {
          const record = { ...classRecord(id, name), students: plainClass('x').workspace.students, rev: 4 };
          await store.createWorkspace(record);
          for (const spin of fixedSpins(id, spins)) await store.appendSpin(spin);
        }
      }
      const at = new Date('2026-11-21T00:00:00.000Z');
      const theirs = JSON.stringify(await base.exportBackup(two.old, undefined, at), null, 2);
      const mine = await current.exportBackup(one.fresh, undefined, at);
      check(mine.formatVersion === 1, 'the file is format 1');
      check(JSON.stringify(mine, null, 2) === theirs, 'the backup object differs from the older build\'s');
      check(current.serializeBackup(mine) === theirs, 'the backup text differs from the older build\'s');
      check((await current.exportBackupChecked(one.fresh, undefined, at)).text === theirs, 'the size-checked backup text differs from the older build\'s');
      // One class on its own, too.
      check(current.serializeBackup(await current.exportBackup(one.fresh, ['class-1'], at)) === JSON.stringify(await base.exportBackup(two.old, ['class-1'], at), null, 2), 'the single-class backup differs');
      // And the older build reads the current build's file.
      const read = baseSchema.parseBackupText(current.serializeBackup(mine));
      check(read.ok && read.backup.workspaces.length === 2, 'the older build could not read the file');
    },
  },
  {
    id: 'C3',
    name: 'the current build reads a class written by the older build without writing, and a roster edit leaves it schema 1 with no new field',
    async run(open) {
      const { fresh, old } = await open();
      const record = classRecord();
      await old.createWorkspace(record);
      await base.addStudents(old, record, [{ name: 'Ada Sample', email: '' }, { name: 'Ben Placeholder', email: '' }]);
      for (const spin of fixedSpins(record.id, 2)) await old.appendSpin(spin);
      const raw = JSON.stringify(await everything(old));

      // Everything the current build does when it only looks.
      const listed = await fresh.listWorkspaces();
      const bundle = await fresh.getBundle(record.id);
      check(listed.length === 1 && bundle !== null, 'the current build lists and reads the class');
      await current.seenClasses(fresh);
      current.backupStatus(bundle);
      check(same(presentationTokenOf(bundle.workspace), { epoch: null, rev: 0 }), 'a class with no presentation data has the empty token');
      check(usageOf(bundle.workspace).bytes === 0, 'and uses none of the presentation budget');
      check(JSON.stringify(await everything(old)) === raw, 'reading wrote something');

      const edited = await current.addStudents(fresh, bundle.workspace, [{ name: 'Cy Demo', email: '' }]);
      check(edited.schemaVersion === 1, 'after a roster edit the class is still schema 1');
      check(onlyOriginalFields(edited), 'a roster edit added a field');
      // The older build carries on with it.
      const again = await base.renameWorkspace(old, await baselineClass(old, record.id), 'Renamed by the older build');
      check(again.students.length === 3 && again.rev === edited.rev + 1, 'the older build edits the same record');
    },
  },
  {
    id: 'C4',
    name: 'a backup written by the older build restores, as an addition and as a replacement, to exactly what the older build would restore',
    async run(open) {
      for (const mode of ['add', 'replace'] as const) {
        const [one, two] = [await open(), await open()];
        const results: string[] = [];
        for (const [api, store] of [[currentApi, asBaseline(one.fresh)], [base, two.old]] as const) {
          // The file holds two classes. One of them already exists here in a later version.
          const inFile = { ...classRecord('class-1'), students: plainClass('x').workspace.students, rev: 3 };
          const file = baseSchema.buildBackup(
            [{ workspace: inFile, spins: fixedSpins('class-1', 4) }, { workspace: classRecord('class-9', 'Period 9 Ecology'), spins: [] }],
            new Date('2026-11-15T00:00:00.000Z')
          );
          const text = JSON.stringify(file, null, 2);
          await store.createWorkspace({ ...inFile, name: 'Period 3 Ecology (edited since)', rev: 6 });
          await store.appendSpin(fixedSpins('class-1', 7)[6]);
          const parsed = api === base ? baseSchema.parseBackupText(text) : (parseBackupText(text) as baseSchema.BackupCheck);
          check(parsed.ok, 'the file should be readable');
          const summary = await api.restoreBackup(store, parsed.backup, mode, await api.seenClasses(store));
          results.push(normalised({ summary, stored: await everything(store) }));
        }
        check(results[0] === results[1], `${mode}: the current build restored the older build's file differently`);
      }
    },
  },
  {
    id: 'C8',
    name: 'the older build opens a database that holds presentation data, lists its classes and reads them whole',
    async run(open) {
      const { old, id, before } = await withDraw(await open());
      const listed = await old.listWorkspaces();
      check(listed.length === 1 && listed[0].id === id && listed[0].name === before.name, 'the older build lists the class');
      const bundle = await old.getBundle(id);
      check(bundle !== null && same(bundle.workspace, before), 'the older build reads the record whole, presentation data included');
      check(same(base.backupStatus(bundle), { state: 'never', lastBackupAt: null, spinsSince: 0, rosterChangedSince: true }), 'its backup status works as usual');
      check(!base.isUntouchedStarter(bundle.workspace, 0), 'it does not mistake the class for an empty starter');
    },
  },
  {
    id: 'C9',
    name: 'every ordinary edit by the older build keeps presentation data exactly, and the current build carries on afterwards',
    async run(open) {
      const { fresh, old, id, drawId, before } = await withDraw(await open());
      const waiting = drawIn(before, drawId);
      const removed = waiting.entries[waiting.sequence[1]].studentId;

      const kept = async (after: string) => {
        const seen = await now(fresh, id);
        check(same(seen.presentation, before.presentation), `the presentation data changed after the older build's: ${after}`);
        check(seen.schemaVersion === 2, `the class is no longer marked schema 2 after: ${after}`);
      };
      let w = await base.renameWorkspace(old, await baselineClass(old, id), 'Renamed by the older build');
      await kept('rename');
      w = await base.addStudents(old, w, [{ name: 'Gus Madeup', email: '' }]);
      await kept('add student');
      w = await base.updateStudent(old, w, 's01', { name: 'Ada Corrected' });
      await kept('edit student');
      w = await base.updateStudent(old, w, 's02', { active: false });
      await kept('untick "In queue"');
      w = await base.removeStudent(old, w, removed);
      await kept('remove a drawn student');
      await old.updateWorkspace(w.id, w.rev, (c) => ({ ...c, settings: [{ key: 'enableConfetti', value: 'false', notes: '' }] }));
      await kept('save settings');
      await old.appendSpin(fixedSpins(id, 1)[0]);
      await kept('log a spin');
      await base.confirmBackup(old, await base.exportBackup(old));
      await kept('confirm backup');

      const after = await now(fresh, id);
      check(same(presentationTokenOf(after), presentationTokenOf(before)), 'the token is unchanged, so an open presentation tab is not disturbed');
      check(validatePresentation(after.presentation).ok, 'the presentation data is still valid');
      check(after.name === 'Renamed by the older build' && after.students.length === 6 && after.settings.length === 1 && after.lastBackupAt !== null, 'and the older build\'s edits are all there');
      // The current build carries on: finish the presenter, and the removed student is passed over.
      const presenting = drawIn(after, drawId).entries.findIndex((e) => e.status === 'presenting');
      await performAction(fresh, id, presentationTokenOf(before), drawId, { type: 'done', entry: presenting }, { today: DAY, now: new Date(T0) });
      const next = await revealNext(fresh, id, drawId);
      const nowPresenting = drawIn(next, drawId).entries.find((e) => e.status === 'presenting');
      check(nowPresenting && nowPresenting.studentId !== removed, 'the removed student is passed over, not revealed');
    },
  },
  {
    id: 'C10',
    name: 'the older build deletes the class and puts it back: the presentation data returns intact',
    async run(open) {
      const { fresh, old, id, before } = await withDraw(await open());
      const point = await base.deleteWorkspace(old, id, (await base.seenClasses(old))[id]);
      check(point && (await fresh.getWorkspace(id)) === null, 'the class is deleted');
      check(same((point.bundles[0].workspace as Workspace).presentation, before.presentation), 'the older build\'s recovery copy holds the presentation data');
      await base.applyRecoveryPoint(old, point, await base.seenClasses(old));
      const back = await now(fresh, id);
      check(same(back, before), 'the class is back exactly as it was');
      check(validatePresentation(back.presentation).ok, 'and valid');
    },
  },
  {
    id: 'C11',
    name: 'the older build replaces the class from an older file: the draws move to the recovery copy, and the current build puts them back',
    async run(open) {
      const { fresh, old, id, olderFile, before } = await withDraw(await open());
      const summary = await base.restoreBackup(old, olderFile, 'replace', await base.seenClasses(old));
      const replaced = await now(fresh, id);
      check(replaced.presentation === undefined && replaced.schemaVersion === 1, 'the class is the file version, with no presentation data');
      const point = (await fresh.listRecoveryPoints()).find((p) => p.id === summary.recoveryPointId);
      check(point && same(point.bundles[0].workspace.presentation, before.presentation), 'the recovery copy holds the draws');
      await current.applyRecoveryPoint(fresh, point, await current.seenClasses(fresh));
      const back = await now(fresh, id);
      check(same(back.presentation!.draws, before.presentation!.draws), '"Put it back" restores the draws exactly');
      check(back.presentation!.epoch !== before.presentation!.epoch, 'under a new lineage id, so a stale tab cannot write to it');
      check(validatePresentation(back.presentation).ok, 'and valid');
    },
  },
  {
    id: 'C12',
    name: 'a backup the older build makes of a presentation class is refused by the older build and accepted by the current one',
    async run(open) {
      const { fresh, old, id, before } = await withDraw(await open());
      const file = await base.exportBackup(old, [id]);
      check(file.formatVersion === 1 && file.workspaces[0].workspace.schemaVersion === 2, 'the older build labels the file format 1 although the class is schema 2');
      const text = JSON.stringify(file, null, 2);
      const stored = await snapshot(fresh);

      const theirs = baseSchema.parseBackupText(text);
      check(!theirs.ok && /newer version/.test(theirs.errors.join(' ')), 'the older build refuses its own file as "newer version"');
      check((await snapshot(fresh)) === stored, 'and writes nothing');

      const mine = parseBackupText(text);
      check(mine.ok, `the current build should accept it: ${mine.ok ? '' : mine.errors.join(' ')}`);
      check(mine.backup.formatVersion === 2, 'and treats it as what it is: a file with presentation data');
      check(same(mine.backup.workspaces[0].workspace.presentation, before.presentation), 'with the presentation data whole');
      await current.restoreBackup(fresh, mine.backup, 'add', await current.seenClasses(fresh));
      const copy = (await fresh.listWorkspaces()).find((w) => w.id !== id);
      check(copy && validatePresentation(copy.presentation).ok && same(copy.presentation!.draws, before.presentation!.draws), 'it restores as a valid copy');
    },
  },
  {
    id: 'C13',
    name: 'a format 2 backup from the current build is refused by the older build as "newer version", and nothing is written',
    async run(open) {
      const { fresh, old } = await withDraw(await open());
      const file = await current.exportBackup(fresh);
      check(file.formatVersion === 2, 'the file is format 2');
      const stored = JSON.stringify(await everything(old));
      const result = baseSchema.parseBackupText(current.serializeBackup(file));
      check(!result.ok && /newer version/.test(result.errors.join(' ')), 'the older build refuses it as "newer version"');
      // Relabelled by hand as format 1, the class inside is still refused.
      const relabelled = baseSchema.parseBackupText(JSON.stringify({ ...file, formatVersion: 1 }));
      check(!relabelled.ok && /newer version/.test(relabelled.errors.join(' ')), 'and refuses the class itself if the label is changed');
      check(JSON.stringify(await everything(old)) === stored, 'nothing was written');
    },
  },
  {
    id: 'K14',
    name: 'a tab still running the older build: roster edits and presentation actions are both kept, a put-back leaves identical content, and a replace locks the stale presentation tab out',
    async run(open) {
      const { fresh, old, id, drawId, olderFile } = await withDraw(await open());

      // The older tab edits with a view from before a presentation action. Both are kept.
      const olderView = await baselineClass(old, id);
      const presenting = drawIn(await now(fresh, id), drawId).entries.findIndex((e) => e.status === 'presenting');
      await performAction(fresh, id, await tokenNow(fresh, id), drawId, { type: 'done', entry: presenting }, { today: DAY, now: new Date(T0) });
      await base.updateStudent(old, olderView, 's01', { name: 'Ada Corrected' });
      // The presentation tab acts with a view from before a roster edit. Both are kept.
      const presenterView = await now(fresh, id);
      await base.addStudents(old, await baselineClass(old, id), [{ name: 'Gus Madeup', email: '' }]);
      await revealNextWith(fresh, presenterView, drawId);
      let latest = await now(fresh, id);
      check(latest.students.some((s) => s.name === 'Ada Corrected') && latest.students.some((s) => s.name === 'Gus Madeup'), 'both roster edits are kept');
      check(revealedCount(latest, drawId) === 2 && drawIn(latest, drawId).entries[presenting].status === 'done', 'both presentation actions are kept');

      // The older tab deletes the class with a view that is out of date for presentations: the action is in its recovery copy.
      const staleSeen = await base.seenClasses(old);
      const nowPresenting = drawIn(latest, drawId).entries.findIndex((e) => e.status === 'presenting');
      await performAction(fresh, id, presentationTokenOf(latest), drawId, { type: 'done', entry: nowPresenting }, { today: DAY, now: new Date(T0) });
      latest = await now(fresh, id);
      const point = await base.deleteWorkspace(old, id, staleSeen[id]);
      check(point && same((point.bundles[0].workspace as Workspace).presentation, latest.presentation), 'the recovery copy holds the latest presentation action');
      await refused(performAction(fresh, id, presentationTokenOf(latest), drawId, { type: 'archive' }, { today: DAY }), StoreMissingError, 'an action while the class is deleted');
      // Put back by the older build: the content is exactly what the presentation tab last saw, so it may carry on.
      await base.applyRecoveryPoint(old, point, await base.seenClasses(old));
      check(same((await now(fresh, id)).presentation, latest.presentation), 'after the put-back the presentation data is identical to what the tab last saw');
      await performAction(fresh, id, presentationTokenOf(latest), drawId, { type: 'archive' }, { today: DAY, now: new Date(T0) });

      // Replaced by the older build from an older file: the presentation tab is refused.
      const beforeReplace = await now(fresh, id);
      await base.restoreBackup(old, olderFile, 'replace', await base.seenClasses(old));
      const stored = await snapshot(fresh);
      await refused(performAction(fresh, id, presentationTokenOf(beforeReplace), drawId, { type: 'unarchive' }, { today: DAY }), StoreConflictError, 'the stale presentation action after a replace');
      check((await snapshot(fresh)) === stored, 'nothing changed');
      check((await fresh.listRecoveryPoints()).some((p) => same(p.bundles[0].workspace.presentation, beforeReplace.presentation)), 'and the draws are in the recovery copy');
    },
  },
  {
    id: 'X12',
    name: 'after a continuation the older build keeps using both classes for the wheel: presentation data in both is kept, the continuation is still recognised, and the older build\'s edits count as a change to the old class',
    async run(open) {
      const { fresh, old, id } = await withDraw(await open());
      const result = await continueInNewClass(fresh, id, await tokenNow(fresh, id), { today: DAY, now: new Date(T0) });
      const [source, destination] = [await now(fresh, id), await now(fresh, result.destinationId)];

      // The older build sees two ordinary classes and uses them.
      check((await old.listWorkspaces()).length === 2, 'the older build lists both classes');
      await base.addStudents(old, await baselineClass(old, id), [{ name: 'Gus Madeup', email: '' }]);
      await base.updateStudent(old, await baselineClass(old, id), 's01', { active: false });
      await old.appendSpin(fixedSpins(id, 1)[0]);
      await base.renameWorkspace(old, await baselineClass(old, result.destinationId), 'Period 3 Ecology, spring');
      await old.appendSpin(fixedSpins(result.destinationId, 1)[0]);

      check(same((await now(fresh, id)).presentation, source.presentation), 'the old class keeps its presentation history exactly');
      check(same((await now(fresh, result.destinationId)).presentation, destination.presentation), 'the new class keeps its presentation data exactly');
      check(same(await finishMoving(fresh, id), { destinationId: result.destinationId, created: false }), 'the continuation is still recognised');

      // The older build deletes the new class. The old class has changed since it was frozen (the older build's own edits),
      // so the current build will not quietly rebuild the new class from it.
      const point = await base.deleteWorkspace(old, result.destinationId, (await base.seenClasses(old))[result.destinationId]);
      check(point, 'the older build can delete the new class');
      const stored = await snapshot(fresh);
      await refused(finishMoving(fresh, id), ContinuationChangedError, 'rebuilding the new class from the changed old class');
      check((await snapshot(fresh)) === stored, 'nothing was created');
      // The older build's "Put it back" brings the real one back.
      await base.applyRecoveryPoint(old, point, await base.seenClasses(old));
      check(same(await finishMoving(fresh, id), { destinationId: result.destinationId, created: false }), 'after the older build puts it back, it is found');
      check(same((await now(fresh, result.destinationId)).presentation, destination.presentation), 'with its presentation data intact');
    },
  },
  {
    id: 'S12',
    name: 'the older build never drops a starter class that holds a draft made by the current build: the draft stays in the class or in the recovery copy',
    async run(open) {
      for (const mode of ['add', 'replace'] as const) {
        for (const sameId of [false, true]) {
          const { fresh, old } = await open();
          const [starter] = await current.ensureWorkspace(fresh);
          check(base.isUntouchedStarter(starter, 0), 'the older build sees a brand-new starter as untouched');
          await createDraw(fresh, starter.id, presentationTokenOf(starter), 'Biome talks', { id: 'd1', now: new Date(T0) });
          const withDraft = await now(fresh, starter.id);
          check(withDraft.students.length === 0 && withDraft.name === starter.name, 'the starter is otherwise empty');
          const label = `${mode}, ${sameId ? 'same id' : 'other class'}`;
          check(!base.isUntouchedStarter(await baselineClass(old, starter.id), 0), `${label}: the older build's own test should say "not untouched"`);

          const inFile = sameId ? { ...classRecord(base.DEFAULT_WORKSPACE_ID, 'Older copy'), rev: 3 } : { ...classRecord('class-9', 'From a backup'), rev: 3 };
          const file = baseSchema.buildBackup([{ workspace: inFile, spins: [] }], new Date('2026-11-15T00:00:00.000Z'));
          const summary = await base.restoreBackup(old, file, mode, await base.seenClasses(old));

          const live = (await fresh.listWorkspaces()).find((w) => w.presentation?.draws.some((d) => d.id === 'd1'));
          const inRecovery = (await fresh.listRecoveryPoints()).find((p) => p.bundles.some((b) => b.workspace.presentation?.draws.some((d) => d.id === 'd1')));
          check(live || inRecovery, `${label}: the draft is gone`);
          if (mode === 'replace' && sameId) {
            check(!live && inRecovery && inRecovery.id === summary.recoveryPointId, `${label}: the draft should be in the recovery copy the summary names`);
            await base.applyRecoveryPoint(old, inRecovery, await base.seenClasses(old));
            check(same((await now(fresh, starter.id)).presentation, withDraft.presentation), `${label}: the older build's "Put it back" restores the draft`);
          } else {
            check(live && same(live.presentation, withDraft.presentation), `${label}: the starter and its draft should be untouched`);
            check((await fresh.listWorkspaces()).length === 2, `${label}: the file's class should be beside the starter`);
          }
        }
      }
    },
  },
];

/** Reveal the next presenter using the token from an earlier view of the class. */
async function revealNextWith(store: WorkspaceStore, view: Workspace, drawId: string): Promise<void> {
  const next = nextUp(drawIn(view, drawId), { roster: view.students, inactive: view.presentation!.inactive, today: DAY });
  check(next.entry !== null, 'somebody should be available to reveal');
  await performAction(store, view.id, presentationTokenOf(view), drawId, { type: 'reveal', entry: next.entry }, { today: DAY, now: new Date(T0) });
}
