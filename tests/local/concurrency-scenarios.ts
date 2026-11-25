/**
 * Regression scenarios for "another tab changed the class while this tab was
 * about to delete, replace or undo it".
 *
 * This file has no test-runner imports on purpose. The same scenarios run:
 *  - in Vitest, against MemoryStore and IndexedDbStore on a test double
 *    (tests/local/concurrency.test.ts), and
 *  - inside real Chromium, against the browser's real IndexedDB
 *    (e2e/smoke.mjs loads this file through the dev server).
 *
 * Every name and address is invented.
 */
import type { BackupFile, LocalSpin, WorkspaceBundle } from '../../src/data/local/schema';
import { StoreConflictError, StoreMissingError, stampOf, type WorkspaceStore } from '../../src/data/local/store';
import {
  DEFAULT_WORKSPACE_ID,
  addStudents,
  applyRecoveryPoint,
  clearAllData,
  deleteWorkspace,
  ensureWorkspace,
  exportBackup,
  restoreBackup,
  seenClasses,
} from '../../src/data/local/workspaces';
import { sampleBundle, sampleSpins } from './fixtures';

/** Two connections to the same storage: this tab (a) and another tab (b). */
export interface Tabs {
  a: WorkspaceStore;
  b: WorkspaceStore;
}

export interface Scenario {
  name: string;
  run(open: () => Promise<Tabs>): Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

/** Everything in storage, as one comparable string. */
async function snapshot(store: WorkspaceStore): Promise<string> {
  const bundles: (WorkspaceBundle | null)[] = [];
  for (const workspace of await store.listWorkspaces()) bundles.push(await store.getBundle(workspace.id));
  return JSON.stringify({ bundles, recovery: await store.listRecoveryPoints() });
}

async function refused(action: Promise<unknown>, what: string): Promise<StoreConflictError> {
  const outcome = await action.then(
    () => null,
    (err: unknown) => err
  );
  check(outcome !== null, `${what} was accepted, but it should have been refused`);
  check(outcome instanceof StoreConflictError, `${what} failed with the wrong kind of error: ${String(outcome)}`);
  return outcome;
}

const newSpin = (bundle: WorkspaceBundle, at = '2026-11-25T15:00:00.000Z'): LocalSpin => sampleSpins(bundle.workspace, 1, at)[0];

const hasSpin = async (store: WorkspaceStore, classId: string, spinId: string): Promise<boolean> =>
  (await store.listSpins(classId)).some((spin) => spin.id === spinId);

const spinInRecovery = async (store: WorkspaceStore, spinId: string): Promise<boolean> =>
  (await store.listRecoveryPoints()).some((point) => point.bundles.some((bundle) => bundle.spins.some((spin) => spin.id === spinId)));

/**
 * The worst possible timing: the other tab's write lands after this tab has
 * finished every preparation read, immediately before its destructive change
 * reaches storage.
 */
function atTheLastMoment(store: WorkspaceStore, otherTab: () => Promise<unknown>): WorkspaceStore {
  let done = false;
  const first = async () => {
    if (done) return;
    done = true;
    await otherTab();
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === 'replaceClasses') {
        return async (...args: Parameters<WorkspaceStore['replaceClasses']>) => {
          await first();
          return target.replaceClasses(...args);
        };
      }
      if (property === 'clearAll') {
        return async (...args: Parameters<WorkspaceStore['clearAll']>) => {
          await first();
          return target.clearAll(...args);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function seeded(open: () => Promise<Tabs>) {
  const tabs = await open();
  const p3 = sampleBundle('Period 3', ['Ada Sample', 'Ben Placeholder', 'Cy Demo'], 5);
  const p5 = sampleBundle('Period 5', ['Dee Fixture'], 2);
  await tabs.a.putBundles([p3, p5]);
  return { ...tabs, p3, p5 };
}

export const scenarios: Scenario[] = [
  {
    name: 'the fingerprint of a class changes when a spin is added, although the revision does not',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const before = (await a.getBundle(p3.workspace.id))!;
      await b.appendSpin(newSpin(p3));
      const after = (await a.getBundle(p3.workspace.id))!;
      check(after.workspace.rev === before.workspace.rev, 'logging a spin must not move the revision');
      check(after.workspace.updatedAt === before.workspace.updatedAt, 'logging a spin must not move the edit time');
      check(stampOf(after) !== stampOf(before), 'the fingerprint must change when a spin is added');
    },
  },
  {
    name: 'delete is refused when another tab logged a spin after this tab showed the class; the class and the spin survive',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const seen = await seenClasses(a);
      const spin = newSpin(p3);
      await b.appendSpin(spin);
      const expected = await snapshot(a);

      const err = await refused(deleteWorkspace(a, p3.workspace.id, seen[p3.workspace.id]), 'the stale delete');
      check(/another tab or window/.test(err.message) && /Nothing was deleted/.test(err.message), `unclear message: ${err.message}`);
      check((await snapshot(a)) === expected, 'a refused delete must change nothing');
      check(await hasSpin(a, p3.workspace.id, spin.id), 'the spin from the other tab must still be in the class');
      check((await a.listRecoveryPoints()).length === 0, 'a refused delete must not leave a recovery point');
    },
  },
  {
    name: 'delete is refused when another tab edited the roster after this tab showed the class',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const seen = await seenClasses(a);
      await addStudents(b, (await b.getWorkspace(p3.workspace.id))!, [{ name: 'Fay Example', email: '' }]);
      const expected = await snapshot(a);

      await refused(deleteWorkspace(a, p3.workspace.id, seen[p3.workspace.id]), 'the stale delete');
      check((await snapshot(a)) === expected, 'a refused delete must change nothing');
      check((await a.getWorkspace(p3.workspace.id))!.students.some((student) => student.name === 'Fay Example'), 'the roster edit must survive');
    },
  },
  {
    name: 'an accepted delete takes its recovery copy from the class as it is at that instant, newest spin included',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const spin = newSpin(p3);
      await b.appendSpin(spin);
      const current = (await a.getBundle(p3.workspace.id))!;

      const point = await deleteWorkspace(a, p3.workspace.id, stampOf(current));
      check(point !== null, 'a delete must return its recovery point');
      check(JSON.stringify(point.bundles) === JSON.stringify([current]), 'the recovery copy must be the class exactly as deleted');
      check(await spinInRecovery(a, spin.id), 'the newest spin must be in the recovery copy');

      await applyRecoveryPoint(a, point, await seenClasses(a));
      check(JSON.stringify(await a.getBundle(p3.workspace.id)) === JSON.stringify(current), 'undo must bring the class back exactly');
    },
  },
  {
    name: 'replace-restore is refused when a spin lands at the last moment; no class is replaced or added and no recovery point is written',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const backup = await exportBackup(a, [p3.workspace.id], new Date('2026-11-24T18:00:00.000Z'));
      // The file also holds a class that is not in this browser. It must not be added if the restore is refused.
      const extra = sampleBundle('Only in the file', ['Gus Madeup'], 1);
      const file: BackupFile = { ...backup, workspaces: [...backup.workspaces, extra] };
      const seen = await seenClasses(a);
      const spin = newSpin(p3);

      const racing = atTheLastMoment(a, () => b.appendSpin(spin));
      await refused(restoreBackup(racing, file, 'replace', seen), 'the restore');

      check(await hasSpin(a, p3.workspace.id, spin.id), 'the spin from the other tab must still be in the class');
      check((await a.getBundle(p3.workspace.id))!.spins.length === 6, 'the class must keep all six spins');
      check((await a.getWorkspace(extra.workspace.id)) === null, 'a refused restore must not add the other class from the file');
      check((await a.listRecoveryPoints()).length === 0, 'a refused restore must not leave a recovery point');
    },
  },
  {
    name: 'replace-restore is refused when another tab edits the roster at the last moment',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const backup = await exportBackup(a, [p3.workspace.id], new Date('2026-11-24T18:00:00.000Z'));
      const seen = await seenClasses(a);

      const racing = atTheLastMoment(a, async () => addStudents(b, (await b.getWorkspace(p3.workspace.id))!, [{ name: 'Fay Example', email: '' }]));
      await refused(restoreBackup(racing, backup, 'replace', seen), 'the restore');

      check((await a.getWorkspace(p3.workspace.id))!.students.length === 4, 'the roster edit must survive');
      check((await a.listRecoveryPoints()).length === 0, 'a refused restore must not leave a recovery point');
    },
  },
  {
    name: 'an accepted replace-restore keeps the replaced class, newest spin included, and a tab still holding the old version cannot edit over it',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const backup = await exportBackup(a, [p3.workspace.id], new Date('2026-11-24T18:00:00.000Z'));
      const staleInB = (await b.getWorkspace(p3.workspace.id))!;
      const spin = newSpin(p3);
      await b.appendSpin(spin);
      const replaced = (await a.getBundle(p3.workspace.id))!;

      const summary = await restoreBackup(a, backup, 'replace', await seenClasses(a));
      check(summary.replaced.length === 1 && summary.recoveryPointId !== null, 'the restore must report what it replaced');
      const points = await a.listRecoveryPoints();
      check(JSON.stringify(points[0].bundles) === JSON.stringify([replaced]), 'the recovery copy must be the class exactly as replaced');
      check(await spinInRecovery(a, spin.id), 'the newest spin must be in the recovery copy');

      await refused(addStudents(b, staleInB, [{ name: 'Fay Example', email: '' }]), 'the stale roster edit from the other tab');
      check((await a.getWorkspace(p3.workspace.id))!.students.length === 3, 'the restored roster must not be edited over');
    },
  },
  {
    name: 'undo is refused when a spin lands at the last moment; the recovery copy is kept; a retry on the current version keeps the spin',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const backup = await exportBackup(a, [p3.workspace.id], new Date('2026-11-24T18:00:00.000Z'));
      await restoreBackup(a, backup, 'replace', await seenClasses(a));
      const [point] = await a.listRecoveryPoints();
      const seen = await seenClasses(a);
      const spin = newSpin(p3);
      const expectedPoints = JSON.stringify(await a.listRecoveryPoints());

      const racing = atTheLastMoment(a, () => b.appendSpin(spin));
      await refused(applyRecoveryPoint(racing, point, seen), 'the undo');
      check(await hasSpin(a, p3.workspace.id, spin.id), 'the spin from the other tab must still be in the class');
      check(JSON.stringify(await a.listRecoveryPoints()) === expectedPoints, 'a refused undo must leave the recovery points exactly as they were');

      await applyRecoveryPoint(a, point, await seenClasses(a));
      check(await spinInRecovery(a, spin.id), 'after the retry, the spin must be in the new recovery copy');
      check((await a.listRecoveryPoints()).length === 1, 'the used recovery point must be gone and one new one stored');
    },
  },
  {
    name: 'undo is refused when the recovery copy was already used in another tab',
    async run(open) {
      const { a, b, p3 } = await seeded(open);
      const point = (await deleteWorkspace(a, p3.workspace.id, (await seenClasses(a))[p3.workspace.id]))!;
      const seen = await seenClasses(a);
      await applyRecoveryPoint(b, point, await seenClasses(b));
      const expected = await snapshot(a);

      await refused(applyRecoveryPoint(a, point, seen), 'the second undo');
      check((await snapshot(a)) === expected, 'a refused undo must change nothing');
    },
  },
  {
    name: 'a restore into a new browser does not drop the starter class if a spin was logged in it at the last moment',
    async run(open) {
      for (const mode of ['add', 'replace'] as const) {
        const { a, b } = await open();
        const [starter] = await ensureWorkspace(a);
        const file: BackupFile = {
          format: 'ringwheel-backup',
          formatVersion: 1,
          exportedAt: '2026-11-24T18:00:00.000Z',
          workspaces: [sampleBundle('From a backup', ['Dee Fixture'], 1)],
        };
        const seen = await seenClasses(a);
        const spin = newSpin({ workspace: starter, spins: [] });

        const racing = atTheLastMoment(a, () => b.appendSpin(spin));
        await refused(restoreBackup(racing, file, mode, seen), `the ${mode} restore`);
        check(await hasSpin(a, DEFAULT_WORKSPACE_ID, spin.id), 'the spin logged in the starter class must survive');
        check((await a.listWorkspaces()).length === 1, 'a refused restore must add nothing');

        // Looked at again, the starter is now real data: it stays, and the file's class is added beside it.
        await restoreBackup(a, file, mode, await seenClasses(a));
        check((await a.listWorkspaces()).length === 2, 'the retry must keep the used starter class and add the class from the file');
        check(await hasSpin(a, DEFAULT_WORKSPACE_ID, spin.id), 'the spin must still be there after the retry');
      }
    },
  },
  {
    name: 'delete-everything is refused when another tab logged a spin or added a class after this tab showed the list',
    async run(open) {
      const first = await seeded(open);
      const seen = await seenClasses(first.a);
      const spin = newSpin(first.p3);
      await refused(clearAllData(atTheLastMoment(first.a, () => first.b.appendSpin(spin)), seen), 'delete-everything');
      check((await first.a.listWorkspaces()).length === 2, 'both classes must survive');
      check(await hasSpin(first.a, first.p3.workspace.id, spin.id), 'the spin must survive');

      const second = await seeded(open);
      const seenSecond = await seenClasses(second.a);
      const added = sampleBundle('Added elsewhere', ['Hal Nobody'], 1);
      await refused(clearAllData(atTheLastMoment(second.a, () => second.b.putBundles([added])), seenSecond), 'delete-everything');
      check((await second.a.listWorkspaces()).length === 3, 'all three classes must survive');

      await clearAllData(second.a, await seenClasses(second.a));
      check((await second.a.listWorkspaces()).length === 0, 'with the current list confirmed, everything is deleted');
    },
  },
  {
    name: 'a change that fails part way removes nothing and stores no recovery point',
    async run(open) {
      const { a, p3, p5 } = await seeded(open);
      const expected = await snapshot(a);
      // The incoming class reuses a spin id that belongs to a class that is staying, so the write must fail.
      const bad = sampleBundle('Will not fit', ['Ivy Pretend'], 2);
      bad.spins[1] = { ...bad.spins[1], id: p5.spins[0].id };

      const outcome = await a
        .replaceClasses({
          remove: [{ id: p3.workspace.id, expected: stampOf(p3), recover: true }],
          put: [bad],
          recovery: { id: 'point-1', takenAt: '2026-11-25T16:00:00.000Z', describe: () => 'should never be stored' },
        })
        .then(
          () => 'accepted',
          () => 'failed'
        );
      check(outcome === 'failed', 'the change must fail');
      check((await snapshot(a)) === expected, 'a failed change must leave classes, spins and recovery points exactly as they were');
    },
  },
  {
    name: 'racing a delete against a spin from another tab, in both orders, never loses the spin silently',
    async run(open) {
      for (let round = 0; round < 12; round++) {
        const { a, b, p3 } = await seeded(open);
        const id = p3.workspace.id;
        const seen = await seenClasses(a);
        const spin = newSpin(p3);
        const [removal, append] =
          round % 2 === 0
            ? await Promise.allSettled([deleteWorkspace(a, id, seen[id]), b.appendSpin(spin)])
            : (await Promise.allSettled([b.appendSpin(spin), deleteWorkspace(a, id, seen[id])])).reverse();

        const inClass = await hasSpin(a, id, spin.id);
        const inRecovery = await spinInRecovery(a, spin.id);
        if (append.status === 'fulfilled') {
          check(inClass || inRecovery, `round ${round}: the spin was reported saved but is in neither the class nor a recovery copy`);
        } else {
          check(append.reason instanceof StoreMissingError, `round ${round}: the spin failed for the wrong reason: ${String(append.reason)}`);
          check(removal.status === 'fulfilled', `round ${round}: the spin was turned away although the class was not deleted`);
        }
        if (removal.status === 'rejected') {
          check(removal.reason instanceof StoreConflictError, `round ${round}: the delete failed for the wrong reason: ${String(removal.reason)}`);
          check(inClass, `round ${round}: the delete was refused, so the spin must be in the class`);
          check((await a.listRecoveryPoints()).length === 0, `round ${round}: a refused delete left a recovery point`);
        } else {
          check((await a.getWorkspace(id)) === null, `round ${round}: the delete was accepted but the class is still there`);
          check((await a.listRecoveryPoints()).length === 1, `round ${round}: an accepted delete must leave exactly one recovery point`);
        }
      }
    },
  },
  {
    name: 'racing a replace-restore against a roster edit from another tab, in both orders, never loses the edit silently',
    async run(open) {
      for (let round = 0; round < 12; round++) {
        const { a, b, p3 } = await seeded(open);
        const id = p3.workspace.id;
        const backup = await exportBackup(a, [id], new Date('2026-11-24T18:00:00.000Z'));
        const seen = await seenClasses(a);
        const inB = (await b.getWorkspace(id))!;
        const edit = () => addStudents(b, inB, [{ name: 'Fay Example', email: '' }]);
        const restore = () => restoreBackup(a, backup, 'replace', seen);
        const [restored, edited] =
          round % 2 === 0 ? await Promise.allSettled([restore(), edit()]) : (await Promise.allSettled([edit(), restore()])).reverse();

        const inClass = (await a.getWorkspace(id))!.students.some((student) => student.name === 'Fay Example');
        const inRecovery = (await a.listRecoveryPoints()).some((point) =>
          point.bundles.some((bundle) => bundle.workspace.students.some((student) => student.name === 'Fay Example'))
        );
        if (edited.status === 'fulfilled') {
          check(inClass || inRecovery, `round ${round}: the roster edit was reported saved but is in neither the class nor a recovery copy`);
        } else {
          check(edited.reason instanceof StoreConflictError, `round ${round}: the edit failed for the wrong reason: ${String(edited.reason)}`);
          check(restored.status === 'fulfilled', `round ${round}: the edit was turned away although nothing was restored`);
        }
        if (restored.status === 'rejected') {
          check(restored.reason instanceof StoreConflictError, `round ${round}: the restore failed for the wrong reason: ${String(restored.reason)}`);
          check(inClass, `round ${round}: the restore was refused, so the edit must be in the class`);
        }
      }
    },
  },
];
