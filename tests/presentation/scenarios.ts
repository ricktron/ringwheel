/**
 * Presentation Draw at the storage level: compatibility (C), concurrency (K),
 * the starter class (S), replay at the gate (R) and capacity (Q).
 *
 * No test-runner imports. The same scenarios run in Vitest against the
 * in-memory store and the IndexedDB code, and inside real Chromium against the
 * browser's real IndexedDB (e2e/smoke.mjs).
 *
 * Every name and address is invented.
 */
import { publicView } from '../../src/presentation/public-view';
import { presentationFileBytes, presentationUsage, PresentationCapacityError } from '../../src/presentation/capacity';
import { buildContinuation } from '../../src/presentation/carry-over';
import { verifyOrder } from '../../src/presentation/draw';
import { markMoved, nextUp } from '../../src/presentation/eligibility';
import { PRESENTATION_LIMITS, PresentationError, type PresentationData, type PresentationDraw } from '../../src/presentation/types';
import { PresentationInvalidError, PresentationMovedError, drawIsConsistent, validatePresentation } from '../../src/presentation/validate';
import type { DrawAction } from '../../src/presentation/actions';
import {
  ContinuationConflictError,
  changeDraft,
  continueInNewClass,
  createDraw,
  discardDraft,
  drawTheOrder,
  finishMoving,
  performAction,
  presentationTokenOf,
  reopenPresentations,
  restoreImpact,
  setStudentPresenting,
  usageOf,
} from '../../src/data/local/presentations';
import { LIMITS, createWorkspace, parseBackupText, type BackupFile, type Workspace, type WorkspaceBundle } from '../../src/data/local/schema';
import { StoreConflictError, StoreMissingError, stampOf, type WorkspaceStore } from '../../src/data/local/store';
import {
  BackupTooLargeError,
  DEFAULT_WORKSPACE_ID,
  addStudents,
  applyRecoveryPoint,
  backupStatus,
  clearAllData,
  confirmBackup,
  deleteWorkspace,
  describeBackup,
  ensureWorkspace,
  exportBackup,
  exportBackupChecked,
  isUntouchedStarter,
  measureBackup,
  removeStudent,
  renameWorkspace,
  restoreBackup,
  seenClasses,
  serializeBackup,
  updateStudent,
} from '../../src/data/local/workspaces';
import { act } from '../../src/presentation/actions';
import { sampleSpins } from '../local/fixtures';
import { FAULTS, dataWith, drawnDraw, richDraw } from './faults';
import { DAY, SEED, T0, pickAction, rosterOf, validActions } from './random-actions';
import { createRng } from '../../src/utils/spin-engine';

/** Two connections to the same storage: this tab (a) and another tab (b). */
export interface Tabs {
  a: WorkspaceStore;
  b: WorkspaceStore;
}

export interface Scenario {
  id: string;
  name: string;
  /** Builds megabytes of data: run in Vitest only, not in the browser pass. */
  heavy?: boolean;
  /** Does not depend on which store is used: run once. */
  memoryOnly?: boolean;
  run(open: () => Promise<Tabs>): Promise<void>;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

/** JSON with object keys in a fixed order: storage keeps values, not the order their fields were written in. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v
  );
}
export const same = (x: unknown, y: unknown): boolean => stable(x) === stable(y);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export async function refused(action: Promise<unknown>, kind: Function, what: string): Promise<Error> {
  const outcome = await action.then(
    () => null,
    (err: unknown) => err
  );
  check(outcome !== null, `${what} was accepted, but it should have been refused`);
  check(outcome instanceof kind, `${what} failed with the wrong kind of error: ${String(outcome)}`);
  return outcome as Error;
}

/** Everything in storage, as one comparable string. */
export async function snapshot(store: WorkspaceStore): Promise<string> {
  const bundles: (WorkspaceBundle | null)[] = [];
  for (const workspace of await store.listWorkspaces()) bundles.push(await store.getBundle(workspace.id));
  return stable({ bundles, recovery: await store.listRecoveryPoints() });
}

/** The same, with the things a restore is allowed to change taken out: lineage ids and backup times. */
function comparable(text: string): string {
  return text.replace(/"epoch":"[^"]*"/g, '"epoch":""').replace(/"lastBackupAt":(null|"[^"]*")/g, '"lastBackupAt":null');
}

export async function makeClass(store: WorkspaceStore, options: { id?: string; name?: string; count?: number } = {}): Promise<Workspace> {
  const base = createWorkspace(options.name ?? 'Period 3 Ecology', new Date('2026-11-01T14:00:00.000Z'));
  const workspace: Workspace = {
    ...base,
    id: options.id ?? base.id,
    students: rosterOf(options.count ?? 6).map((s) => ({ id: s.id, name: s.name, email: '', active: true, createdAt: T0 })),
  };
  await store.createWorkspace(workspace);
  return workspace;
}

export const now = async (store: WorkspaceStore, id: string): Promise<Workspace> => {
  const workspace = await store.getWorkspace(id);
  check(workspace, 'the class should exist');
  return workspace;
};
export const tokenNow = async (store: WorkspaceStore, id: string) => presentationTokenOf(await now(store, id));
export const drawIn = (workspace: Workspace, drawId: string): PresentationDraw => {
  const draw = workspace.presentation?.draws.find((d) => d.id === drawId);
  check(draw, 'the draw should exist');
  return draw;
};

/** Create a draw and draw its order, with a fixed seed. Returns the draw id. */
export async function startDraw(store: WorkspaceStore, classId: string, title = 'Biome talks', seed = SEED): Promise<string> {
  const { drawId } = await createDraw(store, classId, await tokenNow(store, classId), title, { now: new Date(T0) });
  await changeDraft(store, classId, await tokenNow(store, classId), drawId, {
    meetings: [
      { date: '2026-12-01', state: 'planned', minutesAvailable: null, fixedCount: null },
      { date: '2026-12-08', state: 'planned', minutesAvailable: null, fixedCount: null },
    ],
  });
  await drawTheOrder(store, classId, await tokenNow(store, classId), drawId, { now: new Date(T0), seed });
  return drawId;
}

/** One action, with the token read fresh. */
async function doAct(store: WorkspaceStore, classId: string, drawId: string, action: DrawAction, today = DAY): Promise<Workspace> {
  return performAction(store, classId, await tokenNow(store, classId), drawId, action, { today, now: new Date(T0) });
}
export const revealNext = async (store: WorkspaceStore, classId: string, drawId: string): Promise<Workspace> => {
  const workspace = await now(store, classId);
  const draw = drawIn(workspace, drawId);
  const next = nextUp(draw, { roster: workspace.students, inactive: workspace.presentation!.inactive, today: DAY });
  check(next.entry !== null, 'somebody should be available to reveal');
  return performAction(store, classId, presentationTokenOf(workspace), drawId, { type: 'reveal', entry: next.entry }, { today: DAY, now: new Date(T0) });
};
export const revealedCount = (workspace: Workspace, drawId: string): number => drawIn(workspace, drawId).events.filter((e) => e.t === 'revealed').length;

async function seeded(open: () => Promise<Tabs>) {
  const tabs = await open();
  const cls = await makeClass(tabs.a);
  const drawId = await startDraw(tabs.a, cls.id);
  return { ...tabs, id: cls.id, drawId };
}

/** The other tab's write lands after this tab has finished preparing, immediately before its storage step. */
function atTheLastMoment(store: WorkspaceStore, otherTab: () => Promise<unknown>, methods: (keyof WorkspaceStore)[] = ['replaceClasses', 'clearAll']): WorkspaceStore {
  let done = false;
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (!methods.includes(property as keyof WorkspaceStore)) return bound;
      return async (...args: unknown[]) => {
        if (!done) {
          done = true;
          await otherTab();
        }
        return bound(...args);
      };
    },
  });
}

const oldFormatFile = (bundles: WorkspaceBundle[]): BackupFile => ({ format: 'ringwheel-backup', formatVersion: 1, exportedAt: '2026-11-20T00:00:00.000Z', workspaces: bundles });
export const plainClass = (name: string, id?: string): WorkspaceBundle => {
  const base = createWorkspace(name, new Date('2026-11-01T00:00:00.000Z'));
  return { workspace: { ...base, id: id ?? base.id, rev: 3, students: rosterOf(2).map((s) => ({ id: s.id, name: s.name, email: '', active: true, createdAt: T0 })) }, spins: [] };
};

/** A presentation record close to the capacity limit, built without storage. Valid, with a long honest log. */
export function nearlyFull(targetBytes: number): PresentationData {
  let draw = drawnDraw(4);
  const first = draw.sequence[0];
  const context = { roster: rosterOf(8), inactive: [], today: DAY, at: T0 };
  const size = () => presentationFileBytes(dataWith(draw));
  const step = (count: number) => {
    for (let i = 0; i < count; i++) {
      const absent = draw.absences.some((a) => a.entry === first && a.date === DAY);
      draw = act(draw, { type: absent ? 'present' : 'absent', entry: first }, context);
    }
  };
  while (size() < targetBytes - 60000) step(200);
  while (size() < targetBytes - 2500) step(4);
  return dataWith(draw);
}

/** Put a class with ready-made presentation data straight into storage (as a restore would), without the long way round. */
async function plant(store: WorkspaceStore, data: PresentationData, id = 'big-class'): Promise<Workspace> {
  const base = createWorkspace('Period 3 Ecology', new Date('2026-11-01T14:00:00.000Z'));
  const workspace: Workspace = {
    ...base,
    id,
    schemaVersion: 2,
    rev: 2,
    students: rosterOf(8).map((s) => ({ id: s.id, name: s.name, email: '', active: true, createdAt: T0 })),
    presentation: data,
  };
  await store.putBundles([{ workspace, spins: [] }]);
  return now(store, id);
}

export const scenarios: Scenario[] = [
  // -------------------------------------------------------------------------
  // Compatibility
  // -------------------------------------------------------------------------
  {
    id: 'C5',
    name: 'the first presentation change makes the class schema 2 and raises its revision by exactly one; later changes leave the class revision alone',
    async run(open) {
      const { a } = await open();
      const before = await makeClass(a);
      check(before.schemaVersion === 1 && !('presentation' in before), 'a new class starts at schema 1 with no presentation field');
      const { workspace: first, drawId } = await createDraw(a, before.id, presentationTokenOf(before), 'Biome talks', { now: new Date(T0) });
      check(first.schemaVersion === 2 && first.presentation !== undefined, 'the class is schema 2 once it holds presentation data');
      check(first.rev === before.rev + 1, 'creating presentation data raises the class revision by exactly one');
      const untouched = (w: Workspace) => JSON.stringify([w.id, w.name, w.createdAt, w.students, w.settings, w.rings, w.lastBackupAt]);
      check(untouched(first) === untouched(before), 'no other field of the class changed');
      check(first.presentation.rev === 1 && first.presentation.epoch.length > 0, 'the presentation record starts at revision 1 with a lineage id');
      const second = await changeDraft(a, before.id, presentationTokenOf(first), drawId, { title: 'Biome presentations' });
      check(second.rev === first.rev && second.updatedAt === first.updatedAt, 'a later presentation change does not move the class revision or edit time');
      check(second.presentation!.rev === 2 && second.presentation!.epoch === first.presentation.epoch, 'it moves the presentation revision and keeps the lineage id');
    },
  },
  {
    id: 'C6',
    name: 'a backup is format 2 only if a class in it holds presentation data, and a class without any stays schema 1 inside it',
    async run(open) {
      const { a } = await open();
      const plain = await makeClass(a, { name: 'No presentations' });
      const withDraws = await makeClass(a, { name: 'With presentations' });
      const onlyPlain = await exportBackup(a, [plain.id]);
      check(onlyPlain.formatVersion === 1, 'a backup with no presentation data is format 1');
      await startDraw(a, withDraws.id);
      const both = await exportBackup(a);
      check(both.formatVersion === 2, 'a backup holding presentation data is format 2');
      const plainInFile = both.workspaces.find((w) => w.workspace.id === plain.id)!.workspace;
      check(plainInFile.schemaVersion === 1 && !('presentation' in plainInFile), 'the class without presentation data is unchanged inside that file');
      check(JSON.stringify(plainInFile) === JSON.stringify(onlyPlain.workspaces[0].workspace), 'and is identical to its own format 1 backup');
      check((await exportBackup(a, [plain.id])).formatVersion === 1, 'backing up the plain class alone is still format 1');
    },
  },
  {
    id: 'C7',
    name: 'format 2 round trip: back up, delete everything, restore, and get identical data and logs back',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      await revealNext(a, id, drawId);
      await doAct(a, id, drawId, { type: 'done', entry: drawIn(await now(a, id), drawId).entries.findIndex((e) => e.status === 'presenting') });
      await setStudentPresenting(a, id, await tokenNow(a, id), 's06', false, 'left_the_class', new Date(T0));
      await a.appendSpin(sampleSpins(await now(a, id), 1)[0]);
      const expected = comparable(await snapshot(a));
      const text = serializeBackup(await exportBackup(a));

      await clearAllData(a, await seenClasses(a));
      const parsed = parseBackupText(text);
      check(parsed.ok, `the backup should be valid: ${parsed.ok ? '' : parsed.errors.join(' ')}`);
      check(parsed.backup.formatVersion === 2, 'the file is format 2');
      await restoreBackup(a, parsed.backup, 'add', await seenClasses(a));
      check(comparable(await snapshot(a)) === expected, 'everything is back exactly, apart from the lineage id and backup time');
      const restored = await now(a, id);
      check(validatePresentation(restored.presentation).ok, 'the restored presentation data is valid');
      // Work simply continues.
      await revealNext(a, id, drawId);
    },
  },
  {
    id: 'C14',
    name: 'a class or file from a newer version (schema 3, format 3) is refused and nothing is written',
    async run(open) {
      const { a, id } = await seeded(open);
      const before = await snapshot(a);
      const file = await exportBackup(a);
      const newerFile = parseBackupText(JSON.stringify({ ...file, formatVersion: 3 }));
      check(!newerFile.ok && /newer version/.test(newerFile.errors.join(' ')), 'format 3 is refused as a newer version');
      const newerClass = clone(file);
      newerClass.workspaces[0].workspace.schemaVersion = 3;
      const result = parseBackupText(JSON.stringify(newerClass));
      check(!result.ok && /newer version/.test(result.errors.join(' ')), 'schema 3 is refused as a newer version');
      // A file that claims the newer numbers without holding what they stand for is not one any build writes.
      const plain = oldFormatFile([plainClass('Plain')]);
      check(!parseBackupText(JSON.stringify({ ...plain, formatVersion: 2 })).ok, 'format 2 with no presentation data is refused');
      const claims = clone(plain);
      claims.workspaces[0].workspace.schemaVersion = 2;
      check(!parseBackupText(JSON.stringify(claims)).ok, 'schema 2 with no presentation data is refused');
      check((await snapshot(a)) === before && (await now(a, id)) !== null, 'nothing was written');
    },
  },
  {
    id: 'C15',
    name: 'R12, C16: each of the 25 inconsistent histories, placed in a backup file, is rejected whole; the clean file is accepted',
    memoryOnly: true,
    async run() {
      const bundle = (data: PresentationData): WorkspaceBundle => ({ workspace: { ...plainClass('Period 3 Ecology').workspace, schemaVersion: 2, presentation: data }, spins: [] });
      const fileOf = (data: PresentationData) => JSON.stringify({ format: 'ringwheel-backup', formatVersion: 2, exportedAt: T0, workspaces: [bundle(data), plainClass('Other')] });
      const clean = parseBackupText(fileOf(dataWith(richDraw())));
      check(clean.ok, `the clean file should be accepted: ${clean.ok ? '' : clean.errors.join(' ')}`);
      for (const [name, damage] of FAULTS) {
        const data = dataWith(clone(richDraw()));
        damage(data.draws[0], data);
        const result = parseBackupText(fileOf(data));
        check(!result.ok, `a file with ${name} was accepted`);
        check(/Class 1/.test(result.errors.join(' ')), `the rejection for ${name} does not say which class`);
      }
      // A few more kinds of damage that are about the file rather than the history.
      const more: [string, (d: PresentationData) => void][] = [
        ['a class log with a gap', (d) => { d.classLog = [{ n: 2, at: T0, t: 'reopened' }]; }],
        ['two draws with one id', (d) => { d.draws.push(clone(d.draws[0])); }],
        ['a draft that already has an order', (d) => { d.draws[0].status = 'draft'; }],
        ['a "moved" marker that is not in the class log', (d) => { d.movedTo = { classId: 'x', at: T0, on: DAY, classRev: 2 }; }],
        ['an unreadable continuation record', (d) => { (d as { continuedFrom: unknown }).continuedFrom = { classId: '../x', marker: 0 }; }],
        ['a meeting date that is not a date', (d) => { d.draws[0].meetings[0].date = '2026-02-30'; }],
      ];
      for (const [name, damage] of more) {
        const data = dataWith(clone(richDraw()));
        damage(data);
        check(!parseBackupText(fileOf(data)).ok, `a file with ${name} was accepted`);
      }
      // Presentation data with a class revision that says the class was never changed is not something the app writes.
      const neverChanged = bundle(dataWith(richDraw()));
      neverChanged.workspace.rev = 1;
      check(!parseBackupText(JSON.stringify({ format: 'ringwheel-backup', formatVersion: 2, exportedAt: T0, workspaces: [neverChanged] })).ok, 'presentation data on a revision-1 class was accepted');
    },
  },
  {
    id: 'C17',
    name: 'a field this build does not recognize on a class record survives every write path',
    async run(open) {
      const { a } = await open();
      const base = await makeClass(a, { id: 'future-class' });
      await clearAllData(a, await seenClasses(a));
      const future = { ...base, futureThing: { kept: ['exactly', 'as', 'written'], n: 7 } } as Workspace;
      await a.createWorkspace(future);
      const kept = async (where: string, bundle?: WorkspaceBundle) => {
        const workspace = bundle ? bundle.workspace : await now(a, base.id);
        check(same((workspace as unknown as { futureThing: unknown }).futureThing, { kept: ['exactly', 'as', 'written'], n: 7 }), `the unknown field was lost by: ${where}`);
      };
      await renameWorkspace(a, await now(a, base.id), 'Renamed');
      await kept('rename');
      await addStudents(a, await now(a, base.id), [{ name: 'Gus Madeup', email: '' }]);
      await kept('add student');
      await updateStudent(a, await now(a, base.id), 's01', { name: 'Ada S. Sample' });
      await kept('edit student');
      await removeStudent(a, await now(a, base.id), 's02');
      await kept('remove student');
      await a.appendSpin(sampleSpins(await now(a, base.id), 1)[0]);
      await kept('log a spin');
      await confirmBackup(a, await exportBackup(a));
      await kept('confirm backup');
      const drawId = await startDraw(a, base.id);
      await kept('create and draw');
      await revealNext(a, base.id, drawId);
      await kept('a presentation action');
      const point = await deleteWorkspace(a, base.id, (await seenClasses(a))[base.id]);
      check(point, 'delete returns a recovery point');
      await kept('delete (recovery copy)', point.bundles[0]);
      await applyRecoveryPoint(a, point, await seenClasses(a));
      await kept('put back');
    },
  },
  {
    id: 'C18',
    name: 'restoring a class that already exists as a copy gives the copy its own id and lineage, with its draws intact',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      await revealNext(a, id, drawId);
      const original = await now(a, id);
      const summary = await restoreBackup(a, await exportBackup(a, [id]), 'add', await seenClasses(a));
      check(summary.added.length === 1 && summary.added[0] !== original.name, 'the copy was added under another name');
      const copy = (await a.listWorkspaces()).find((w) => w.id !== id)!;
      check(copy.presentation!.epoch !== original.presentation!.epoch, 'the copy has its own lineage id');
      check(copy.rev >= 2 && copy.schemaVersion === 2, 'the copy is schema 2 with a revision above 1');
      check(validatePresentation(copy.presentation).ok, 'the copy is valid');
      check(same(copy.presentation!.draws, original.presentation!.draws), 'the copy has the same draws, logs included');
      check(same(await now(a, id), original), 'the original was not touched');
      // Each goes its own way from here.
      await doAct(a, copy.id, drawId, { type: 'done', entry: drawIn(copy, drawId).entries.findIndex((e) => e.status === 'presenting') });
      check(same(await now(a, id), original), 'acting on the copy does not affect the original');
    },
  },
  {
    id: 'C19',
    name: 'replacing a class that has draws with a file version that has none: the preview says so, the draws go to the recovery copy, and undo restores them',
    async run(open) {
      const { a } = await open();
      const cls = await makeClass(a);
      const older = oldFormatFile([clone((await a.getBundle(cls.id))!)]);
      const drawId = await startDraw(a, cls.id);
      await revealNext(a, cls.id, drawId);
      const withDraws = await now(a, cls.id);

      const impact = restoreImpact(older, await a.listWorkspaces());
      check(same(impact, [{ id: cls.id, name: cls.name, drawsInFile: 0, drawsHere: 1, drawsLeftOnlyInRecoveryCopy: 1 }]), 'the preview reports one draw that would be left only in the recovery copy');

      const summary = await restoreBackup(a, older, 'replace', await seenClasses(a));
      const replaced = await now(a, cls.id);
      check(replaced.presentation === undefined && replaced.schemaVersion === 1, 'the class is now the file version, which has no presentation data');
      const point = (await a.listRecoveryPoints()).find((p) => p.id === summary.recoveryPointId)!;
      check(same(point.bundles[0].workspace.presentation!.draws, withDraws.presentation!.draws), 'the recovery copy holds the draws');
      await applyRecoveryPoint(a, point, await seenClasses(a));
      const back = await now(a, cls.id);
      check(same(back.presentation!.draws, withDraws.presentation!.draws), 'undo restores the draws exactly');
      check(back.presentation!.epoch !== withDraws.presentation!.epoch, 'with a new lineage id');
    },
  },
  {
    id: 'C20',
    name: 'backup status counts presentation changes, and only for a class that holds presentation data',
    async run(open) {
      const { a } = await open();
      const plain = await makeClass(a, { name: 'Plain' });
      const status = async (id: string) => backupStatus((await a.getBundle(id))!);
      check(!('presentationChangedSince' in (await status(plain.id))), 'a class without presentation data reports exactly what it always did');
      const id = (await makeClass(a, { name: 'With draws' })).id;
      const draw = await startDraw(a, id);
      check((await status(id)).presentationChangedSince === true && (await status(id)).state === 'never', 'never backed up: presentation changes are not in a backup');
      await pause();
      await confirmBackup(a, await exportBackup(a, [id]));
      const covered = await status(id);
      check(covered.state === 'current' && covered.presentationChangedSince === false, 'a confirmed backup covers the presentation data');
      await pause();
      await revealNext(a, id, draw);
      const after = await status(id);
      check(after.state === 'stale' && after.presentationChangedSince === true && after.rosterChangedSince === false, 'an action after the backup shows as a presentation change, not a roster change');
      check(describeBackup(after) === 'Not in a confirmed backup: presentation changes', `unexpected wording: ${describeBackup(after)}`);
    },
  },
  {
    id: 'C21',
    name: 'this build carries presentation data losslessly with no screen for it: read, roster edits, spins, backup (format 2) and restore',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      await revealNext(a, id, drawId);
      const draws = JSON.stringify((await now(a, id)).presentation!.draws);
      await renameWorkspace(a, await now(a, id), 'Period 3 Ecology (renamed)');
      await addStudents(a, await now(a, id), [{ name: 'Gus Madeup', email: '' }]);
      await a.appendSpin(sampleSpins(await now(a, id), 1)[0]);
      check(JSON.stringify((await now(a, id)).presentation!.draws) === draws, 'roster edits and spins leave the draws exactly as they were');
      const file = await exportBackup(a);
      check(file.formatVersion === 2, 'the backup is format 2');
      const expected = comparable(await snapshot(a));
      await clearAllData(a, await seenClasses(a));
      const parsed = parseBackupText(serializeBackup(file));
      check(parsed.ok, 'the backup is valid');
      await restoreBackup(a, parsed.backup, 'replace', await seenClasses(a));
      check(comparable(await snapshot(a)) === expected, 'everything is back');
    },
  },
  {
    id: 'C22',
    name: 'after 80 random actions through storage, alternating tabs, the stored record is valid, replays, and holds each presenter once',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const rng = createRng('storage-random');
      for (let step = 0; step < 80; step++) {
        const store = step % 2 === 0 ? a : b;
        const workspace = await now(store, id);
        const draw = drawIn(workspace, drawId);
        const context = { roster: workspace.students, inactive: workspace.presentation!.inactive, today: DAY, at: T0 };
        const action = pickAction(draw, context, rng);
        if (!action) break;
        await performAction(store, id, presentationTokenOf(workspace), drawId, action, { today: DAY, now: new Date(Date.parse(T0) + step * 60000) });
      }
      const final = drawIn(await now(a, id), drawId);
      check(final.events.length === 81, `expected 81 events, found ${final.events.length}`);
      check(same([...final.sequence].sort((x, y) => x - y), final.entries.map((_, i) => i)), 'the order holds each presenter exactly once');
      check(same(final.events.map((e) => e.n), final.events.map((_, i) => i + 1)), 'the log has no gaps');
      check(drawIsConsistent(final).ok, 'the stored draw replays to its saved state');
      check(validatePresentation((await now(a, id)).presentation).ok, 'the stored presentation data is valid');
    },
  },

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------
  {
    id: 'K1',
    name: 'a reveal from a stale tab is refused; exactly one reveal is recorded',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const stale = await now(a, id);
      const next = nextUp(drawIn(stale, drawId), { roster: stale.students, inactive: [], today: DAY }).entry!;
      await revealNext(b, id, drawId);
      const before = await snapshot(a);
      const err = await refused(performAction(a, id, presentationTokenOf(stale), drawId, { type: 'reveal', entry: next }, { today: DAY }), StoreConflictError, 'the stale reveal');
      check(/another tab or window/.test(err.message) && /Nothing was changed/.test(err.message), `unclear message: ${err.message}`);
      check((await snapshot(a)) === before, 'a refused action changes nothing');
      check(revealedCount(await now(a, id), drawId) === 1, 'exactly one reveal is recorded');
    },
  },
  {
    id: 'K2',
    name: 'two tabs pressing Reveal at the same moment, in both orders, never reveal twice',
    async run(open) {
      for (let round = 0; round < 12; round++) {
        const { a, b, id, drawId } = await seeded(open);
        const seen = await now(a, id);
        const next = nextUp(drawIn(seen, drawId), { roster: seen.students, inactive: [], today: DAY }).entry!;
        const press = (store: WorkspaceStore) => performAction(store, id, presentationTokenOf(seen), drawId, { type: 'reveal', entry: next }, { today: DAY });
        const results = await Promise.allSettled(round % 2 === 0 ? [press(a), press(b)] : [press(b), press(a)]);
        const accepted = results.filter((r) => r.status === 'fulfilled').length;
        check(accepted === 1, `round ${round}: ${accepted} reveals were accepted`);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        check(rejected.reason instanceof StoreConflictError, `round ${round}: the other press failed for the wrong reason: ${String(rejected.reason)}`);
        const final = await now(a, id);
        check(revealedCount(final, drawId) === 1, `round ${round}: more than one reveal was recorded`);
        check(drawIn(final, drawId).entries.filter((e) => e.status === 'presenting').length === 1, `round ${round}: not exactly one presenter`);
      }
    },
  },
  {
    id: 'K3',
    name: 'a roster edit in another tab does not block a presentation action, and both are kept',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      await revealNext(a, id, drawId);
      const seen = await now(a, id);
      const presenting = drawIn(seen, drawId).entries.findIndex((e) => e.status === 'presenting');
      await updateStudent(b, await now(b, id), 's01', { name: 'Ada Corrected' });
      await removeStudent(b, await now(b, id), 's06');
      await performAction(a, id, presentationTokenOf(seen), drawId, { type: 'done', entry: presenting }, { today: DAY });
      const final = await now(a, id);
      check(final.students.some((s) => s.name === 'Ada Corrected') && !final.students.some((s) => s.id === 's06'), 'the roster edits are kept');
      check(drawIn(final, drawId).entries[presenting].status === 'done', 'the presentation action is kept');
    },
  },
  {
    id: 'K4',
    name: 'a presentation action in another tab does not block a roster edit, and both are kept',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const stale = await now(a, id);
      await revealNext(b, id, drawId);
      await addStudents(a, stale, [{ name: 'Gus Madeup', email: '' }]);
      const final = await now(a, id);
      check(final.students.some((s) => s.name === 'Gus Madeup'), 'the roster edit is kept');
      check(revealedCount(final, drawId) === 1, 'the reveal is kept');
    },
  },
  {
    id: 'K5',
    name: 'an action on a class that was deleted in another tab is refused and creates nothing',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const stale = await now(a, id);
      await deleteWorkspace(b, id, (await seenClasses(b))[id]);
      const before = await snapshot(a);
      await refused(performAction(a, id, presentationTokenOf(stale), drawId, { type: 'archive' }, { today: DAY }), StoreMissingError, 'the action on a deleted class');
      check((await snapshot(a)) === before && (await a.getWorkspace(id)) === null, 'nothing was created or changed');
    },
  },
  {
    id: 'K6',
    name: 'an action from a tab that saw the class before it was deleted and put back is refused',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const stale = await now(a, id);
      const point = await deleteWorkspace(b, id, (await seenClasses(b))[id]);
      await applyRecoveryPoint(b, point!, await seenClasses(b));
      const back = await now(a, id);
      check(back.presentation!.rev === stale.presentation!.rev, 'the revision number is the same as the stale tab holds');
      check(back.presentation!.epoch !== stale.presentation!.epoch, 'but the lineage id is new');
      const before = await snapshot(a);
      await refused(performAction(a, id, presentationTokenOf(stale), drawId, { type: 'archive' }, { today: DAY }), StoreConflictError, 'the stale action');
      check((await snapshot(a)) === before, 'nothing changed');
    },
  },
  {
    id: 'K7',
    name: 'an action is refused after the class was restored from an older backup, even when the revision number matches again',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const file = await exportBackup(a, [id]);
      await revealNext(a, id, drawId);
      await doAct(a, id, drawId, { type: 'skip', entry: drawIn(await now(a, id), drawId).sequence[3], reason: 'other' });
      const stale = await now(a, id);

      // The other tab restores the older backup, then acts until the revision number is the one the stale tab holds.
      await restoreBackup(b, file, 'replace', await seenClasses(b));
      while ((await now(b, id)).presentation!.rev < stale.presentation!.rev) {
        const current = drawIn(await now(b, id), drawId);
        await doAct(b, id, drawId, { type: current.status === 'archived' ? 'unarchive' : 'archive' });
      }
      const current = await now(a, id);
      check(current.presentation!.rev === stale.presentation!.rev, 'the revision numbers match');
      check(!same(current.presentation!.draws, stale.presentation!.draws), 'but the content is different');

      const before = await snapshot(a);
      const presenting = drawIn(stale, drawId).entries.findIndex((e) => e.status === 'presenting');
      await refused(performAction(a, id, presentationTokenOf(stale), drawId, { type: 'done', entry: presenting }, { today: DAY }), StoreConflictError, 'the stale action');
      check((await snapshot(a)) === before, 'nothing changed');
    },
  },
  {
    id: 'K8',
    name: 'S14: after "delete everything", an action from a stale tab cannot touch the starter class that reappears under the same id',
    async run(open) {
      const { a, b } = await open();
      const [starter] = await ensureWorkspace(a);
      const drawId = await startDrawInEmpty(a, starter.id);
      const stale = await now(a, starter.id);
      await clearAllData(b, await seenClasses(b));
      await ensureWorkspace(b);
      const reborn = await now(a, DEFAULT_WORKSPACE_ID);
      check(reborn.presentation === undefined, 'the new starter class has no presentation data');
      const before = await snapshot(a);
      await refused(performAction(a, starter.id, presentationTokenOf(stale), drawId, { type: 'archive' }, { today: DAY }), StoreConflictError, 'the stale action');
      await refused(createDraw(a, starter.id, presentationTokenOf(stale), 'Another'), StoreConflictError, 'a stale "new draw"');
      check((await snapshot(a)) === before, 'nothing changed');
    },
  },
  {
    id: 'K9',
    name: 'adding a copy of the class beside it does not disturb the original: its tab can still act',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const seen = await now(a, id);
      await restoreBackup(b, await exportBackup(b, [id]), 'add', await seenClasses(b));
      const copy = (await a.listWorkspaces()).find((w) => w.id !== id)!;
      const copyBefore = JSON.stringify(copy);
      const next = nextUp(drawIn(seen, drawId), { roster: seen.students, inactive: [], today: DAY }).entry!;
      await performAction(a, id, presentationTokenOf(seen), drawId, { type: 'reveal', entry: next }, { today: DAY });
      check(revealedCount(await now(a, id), drawId) === 1, 'the action on the original went through');
      check(JSON.stringify(await now(a, copy.id)) === copyBefore, 'the copy is unaffected');
    },
  },
  {
    id: 'K10',
    name: 'delete, replace, "Put it back" and "delete everything" are each refused after a presentation action in another tab; nothing is lost',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const file = await exportBackup(a, [id]);
      const spare = await makeClass(a, { name: 'Spare' });
      const point = await deleteWorkspace(a, spare.id, (await seenClasses(a))[spare.id]);
      const seen = await seenClasses(a);
      // Logging a spin moves nothing presentation-related; a presentation action must move the fingerprint.
      const stampBefore = stampOf((await a.getBundle(id))!);
      await revealNext(b, id, drawId);
      check(stampOf((await a.getBundle(id))!) !== stampBefore, 'a presentation action changes the class fingerprint');
      const expected = await snapshot(a);

      await refused(deleteWorkspace(a, id, seen[id]), StoreConflictError, 'the stale delete');
      await refused(restoreBackup(a, file, 'replace', seen), StoreConflictError, 'the stale replace');
      await refused(clearAllData(a, seen), StoreConflictError, 'the stale "delete everything"');
      // Undo of something else, with a view of this class that is out of date.
      const replacePoint = { ...point!, bundles: [(await b.getBundle(id))!] };
      await refused(applyRecoveryPoint(a, replacePoint, seen), StoreConflictError, 'the stale "Put it back"');
      check((await snapshot(a)) === expected, 'nothing was deleted, replaced or used up');
      check(revealedCount(await now(a, id), drawId) === 1, 'the action from the other tab is still there');
    },
  },
  {
    id: 'K11',
    name: 'a presentation action landing at the last moment before a class delete, or racing it, is never lost',
    async run(open) {
      const first = await seeded(open);
      const seen = await seenClasses(first.a);
      const racing = atTheLastMoment(first.a, () => revealNext(first.b, first.id, first.drawId));
      await refused(deleteWorkspace(racing, first.id, seen[first.id]), StoreConflictError, 'the delete');
      check(revealedCount(await now(first.a, first.id), first.drawId) === 1, 'the action is in the class');
      check((await first.a.listRecoveryPoints()).length === 0, 'a refused delete leaves no recovery copy');

      for (let round = 0; round < 10; round++) {
        const { a, b, id, drawId } = await seeded(open);
        const view = await seenClasses(a);
        const workspace = await now(b, id);
        const next = nextUp(drawIn(workspace, drawId), { roster: workspace.students, inactive: [], today: DAY }).entry!;
        const action = () => performAction(b, id, presentationTokenOf(workspace), drawId, { type: 'reveal', entry: next }, { today: DAY });
        const remove = () => deleteWorkspace(a, id, view[id]);
        const [removal, acted] = round % 2 === 0 ? await Promise.allSettled([remove(), action()]) : (await Promise.allSettled([action(), remove()])).reverse();
        const inClass = ((await a.getWorkspace(id))?.presentation?.draws[0].events ?? []).some((e) => e.t === 'revealed');
        const inRecovery = (await a.listRecoveryPoints()).some((p) => p.bundles.some((bundle) => (bundle.workspace.presentation?.draws[0].events ?? []).some((e) => e.t === 'revealed')));
        if (acted.status === 'fulfilled') check(inClass || inRecovery, `round ${round}: the action was reported saved but is in neither the class nor a recovery copy`);
        else {
          check(acted.reason instanceof StoreMissingError, `round ${round}: the action failed for the wrong reason: ${String(acted.reason)}`);
          check(removal.status === 'fulfilled', `round ${round}: the action was turned away although the class was not deleted`);
        }
        if (removal.status === 'rejected') check(removal.reason instanceof StoreConflictError && inClass, `round ${round}: the delete was refused, so the action must be in the class`);
      }
    },
  },
  {
    id: 'K12',
    name: 'an action whose expectation does not hold is refused even when the token matches, and nothing is written',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      const workspace = await now(a, id);
      const draw = drawIn(workspace, drawId);
      const before = await snapshot(a);
      // "Mark entry X done", but nobody is presenting.
      await refused(performAction(a, id, presentationTokenOf(workspace), drawId, { type: 'done', entry: draw.sequence[0] }, { today: DAY }), PresentationError, 'a completion with nobody presenting');
      // "Reveal entry Y", but Y is not the next presenter.
      await refused(performAction(a, id, presentationTokenOf(workspace), drawId, { type: 'reveal', entry: draw.sequence[2] }, { today: DAY }), PresentationError, 'a reveal of someone who is not next');
      await refused(performAction(a, id, presentationTokenOf(workspace), 'no-such-draw', { type: 'archive' }, { today: DAY }), PresentationError, 'an action on a draw that is not there');
      check((await snapshot(a)) === before, 'nothing was written');
      check(same(presentationTokenOf(await now(a, id)), presentationTokenOf(workspace)), 'the token did not move');
    },
  },
  {
    id: 'K13',
    name: 'a second window reading storage sees each saved action, shows only revealed names, and writes nothing',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const display = async () => {
        const workspace = await now(b, id);
        return publicView(drawIn(workspace, drawId), workspace.students);
      };
      const order = drawIn(await now(a, id), drawId);
      check((await display()).presenting === null, 'nobody is shown before a reveal');
      const tokenBefore = await tokenNow(a, id);
      await display();
      check(same(await tokenNow(a, id), tokenBefore), 'reading for the display writes nothing');
      await revealNext(a, id, drawId);
      const shown = await display();
      const firstName = order.entries[order.sequence[0]].nameAtDraw;
      check(shown.presenting === firstName, 'the display shows the revealed presenter');
      const text = JSON.stringify(shown);
      for (const index of order.sequence.slice(1)) check(!text.includes(order.entries[index].nameAtDraw), 'the display view holds a name that was not revealed');
    },
  },
  {
    id: 'K15',
    name: 'R11: a write that fails part way, or would store an inconsistent record, stores nothing; the next valid action works',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      const before = JSON.stringify(await now(a, id));
      const token = await tokenNow(a, id);
      const failing = a.updatePresentation(id, token, () => {
        throw new Error('QuotaExceededError');
      });
      const err = await failing.then(() => null, (e: unknown) => e as Error);
      check(err !== null && /QuotaExceededError/.test(err.message), 'the failure surfaces to the caller');
      // A change function that returns a record whose saved state does not match its log.
      await refused(
        a.updatePresentation(id, token, (current) => {
          const broken = clone(current!);
          broken.draws[0].entries[0].status = 'done';
          return broken;
        }),
        PresentationInvalidError,
        'the inconsistent write'
      );
      // One that quietly drops history.
      await refused(a.updatePresentation(id, token, (current) => ({ ...current!, draws: [] })), PresentationInvalidError, 'the write that removes a drawn order');
      check(JSON.stringify(await now(a, id)) === before, 'the stored record is byte-for-byte what it was');
      await revealNext(a, id, drawId);
    },
  },
  {
    id: 'K16',
    name: 'an Undo from a stale tab is refused',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      await revealNext(a, id, drawId);
      const stale = await now(a, id);
      const presenting = drawIn(stale, drawId).entries.findIndex((e) => e.status === 'presenting');
      await doAct(b, id, drawId, { type: 'done', entry: presenting });
      const before = await snapshot(a);
      await refused(performAction(a, id, presentationTokenOf(stale), drawId, { type: 'undo', event: drawIn(stale, drawId).events.length }, { today: DAY }), StoreConflictError, 'the stale undo');
      check((await snapshot(a)) === before, 'nothing changed');
    },
  },
  {
    id: 'K17',
    name: 'two draws in one class share one token: the second tab is refused once, succeeds after a reload, and the other draw is untouched',
    async run(open) {
      const { a, b, id, drawId } = await seeded(open);
      const second = await startDraw(a, id, 'Second assignment', 'a'.repeat(16));
      const seenByB = await now(b, id);
      await revealNext(a, id, drawId);
      const firstDraw = JSON.stringify(drawIn(await now(a, id), drawId));
      const next = nextUp(drawIn(seenByB, second), { roster: seenByB.students, inactive: [], today: DAY }).entry!;
      await refused(performAction(b, id, presentationTokenOf(seenByB), second, { type: 'reveal', entry: next }, { today: DAY }), StoreConflictError, 'the action with the older token');
      await revealNext(b, id, second);
      const final = await now(a, id);
      check(revealedCount(final, second) === 1, 'after a reload the action on the second draw works');
      check(JSON.stringify(drawIn(final, drawId)) === firstDraw, 'the first draw is exactly as it was');
    },
  },

  {
    id: 'K18',
    name: '500 random actions and undos from alternating tabs: each presenter appears once, the log has no gaps, and replay equals the saved state',
    async run(open) {
      const { a, b } = await open();
      const cls = await makeClass(a, { count: 12 });
      const rng = createRng('five-hundred');
      let steps = 0;
      for (let round = 0; steps < 500; round++) {
        check(round < 40, 'the random actions stopped making progress');
        const drawId = await startDraw(a, cls.id, `Assignment ${round + 1}`, `${round}`.padStart(16, 'c'));
        for (; steps < 500; steps++) {
          const store = steps % 2 === 0 ? a : b;
          const workspace = await now(store, cls.id);
          const context = { roster: workspace.students, inactive: workspace.presentation!.inactive, today: DAY, at: T0 };
          const action = pickAction(drawIn(workspace, drawId), context, rng);
          // Leave a finished or archived draw alone after a while, and start another, as a class would.
          if (!action || (drawIn(workspace, drawId).events.length > 60 && rng() < 0.2)) break;
          await performAction(store, cls.id, presentationTokenOf(workspace), drawId, action, { today: DAY, now: new Date(Date.parse(T0) + steps * 60000) });
        }
      }
      const final = await now(a, cls.id);
      check(final.presentation!.draws.reduce((sum, d) => sum + d.events.length - 1, 0) === 500, 'exactly 500 actions were recorded');
      for (const draw of final.presentation!.draws) {
        check(same([...draw.sequence].sort((x, y) => x - y), draw.entries.map((_, i) => i)), `${draw.title}: the order does not hold each presenter exactly once`);
        check(new Set(draw.entries.map((e) => e.studentId)).size === draw.entries.length, `${draw.title}: a student appears twice`);
        check(same(draw.events.map((e) => e.n), draw.events.map((_, i) => i + 1)), `${draw.title}: the log has a gap`);
        check(drawIsConsistent(draw).ok, `${draw.title}: replay does not equal the saved state`);
      }
      check(validatePresentation(final.presentation).ok, 'the stored presentation data is valid');
    },
  },

  // -------------------------------------------------------------------------
  // The starter class
  // -------------------------------------------------------------------------
  {
    id: 'S1',
    name: 'S7, S8: a starter class that holds presentation data, an empty presentation record, or an unrecognized field is never "untouched"',
    async run(open) {
      const { a } = await open();
      const [starter] = await ensureWorkspace(a);
      check(isUntouchedStarter(starter, 0), 'a brand-new starter class is untouched');
      // Even with the class revision still at 1, as it would be without the first-write rule.
      const withDraft = { ...starter, presentation: dataWith() } as Workspace;
      check(!isUntouchedStarter(withDraft, 0), 'a starter with a presentation record is not untouched');
      check(!isUntouchedStarter({ ...starter, presentation: { ...dataWith(), classLog: [{ n: 1, at: T0, t: 'reopened' }] } } as Workspace, 0), 'a starter with only a class-log entry is not untouched');
      check(!isUntouchedStarter({ ...starter, somethingNewer: true } as unknown as Workspace, 0), 'a starter with a field this build does not recognize is not untouched');
      check(!isUntouchedStarter({ ...starter, schemaVersion: 2 }, 0), 'a starter marked as a newer schema is not untouched');
    },
  },
  {
    id: 'S2',
    name: 'S3, S4, S5: a starter class holding only a presentation draft survives every kind of restore, or is kept in a recovery copy',
    async run(open) {
      // Twice: with the draft created the normal way (class revision raised), and planted with the revision still at 1.
      for (const planted of [false, true]) {
        for (const mode of ['add', 'replace'] as const) {
          for (const sameId of [false, true]) {
            const { a } = await open();
            const [starter] = await ensureWorkspace(a);
            if (planted) {
              await clearAllData(a, await seenClasses(a));
              await a.createWorkspace({ ...starter, schemaVersion: 2, presentation: { ...dataWith(), draws: [{ ...drawnDraw(2), id: 'd1' }] } } as Workspace);
            } else {
              await createDraw(a, starter.id, presentationTokenOf(starter), 'Biome talks', { id: 'd1', now: new Date(T0) });
            }
            const withDraft = await now(a, DEFAULT_WORKSPACE_ID);
            check(withDraft.students.length === 0 && (await a.listSpins(starter.id)).length === 0 && withDraft.name === starter.name, 'the starter is otherwise empty');
            const label = `${planted ? 'planted' : 'created'}, ${mode}, ${sameId ? 'same id' : 'other class'}`;
            const file = oldFormatFile([sameId ? plainClass('Older copy', DEFAULT_WORKSPACE_ID) : plainClass('From a backup')]);

            const impact = restoreImpact(file, await a.listWorkspaces());
            const summary = await restoreBackup(a, file, mode, await seenClasses(a));
            const all = await a.listWorkspaces();
            const live = all.find((w) => w.presentation?.draws.some((d) => d.id === 'd1'));

            if (mode === 'replace' && sameId) {
              check(!live, `${label}: the starter should have been replaced`);
              check(impact[0].drawsLeftOnlyInRecoveryCopy === 1, `${label}: the preview should warn about the draft`);
              const point = (await a.listRecoveryPoints()).find((p) => p.id === summary.recoveryPointId);
              check(point && point.bundles[0].workspace.presentation?.draws[0].id === 'd1', `${label}: the draft is not in the recovery copy`);
              await applyRecoveryPoint(a, point, await seenClasses(a));
              const back = await now(a, DEFAULT_WORKSPACE_ID);
              check(same(back.presentation!.draws, withDraft.presentation!.draws), `${label}: "Put it back" did not restore the draft`);
              check(back.presentation!.epoch !== withDraft.presentation!.epoch, `${label}: the restored draft should have a new lineage id`);
            } else {
              check(live && live.id === DEFAULT_WORKSPACE_ID, `${label}: the starter and its draft are gone`);
              check(same(live.presentation, withDraft.presentation), `${label}: the starter's presentation data changed`);
              check(all.length === 2, `${label}: expected the starter and the class from the file, found ${all.length}`);
              check((await a.listRecoveryPoints()).length === 0, `${label}: nothing was replaced, so there should be no recovery copy`);
            }
          }
        }
      }
    },
  },
  {
    id: 'S6',
    name: 'a truly empty starter class still steps aside for a restore exactly as before, with no recovery copy',
    async run(open) {
      for (const mode of ['add', 'replace'] as const) {
        for (const sameId of [false, true]) {
          const { a } = await open();
          await ensureWorkspace(a);
          const file = oldFormatFile([sameId ? plainClass('Older copy', DEFAULT_WORKSPACE_ID) : plainClass('From a backup')]);
          const summary = await restoreBackup(a, file, mode, await seenClasses(a));
          const all = await a.listWorkspaces();
          check(all.length === 1 && all[0].name === file.workspaces[0].workspace.name, `${mode}, ${sameId ? 'same id' : 'other class'}: the empty starter should be gone and the file's class in its place`);
          check(same(summary, { added: [file.workspaces[0].workspace.name], replaced: [], recoveryPointId: null }), 'the summary is what it always was');
          check((await a.listRecoveryPoints()).length === 0, 'an empty starter leaves no recovery copy');
        }
      }
    },
  },
  {
    id: 'S9',
    name: 'a draft created in another tab after this tab showed an empty starter is never dropped by a restore from this tab',
    async run(open) {
      for (const mode of ['add', 'replace'] as const) {
        for (const sameId of [false, true]) {
          const { a, b } = await open();
          const [starter] = await ensureWorkspace(a);
          const seen = await seenClasses(a);
          await createDraw(b, starter.id, presentationTokenOf(starter), 'Biome talks', { id: 'd1', now: new Date(T0) });
          const withDraft = JSON.stringify(await now(a, DEFAULT_WORKSPACE_ID));
          const file = oldFormatFile([sameId ? plainClass('Older copy', DEFAULT_WORKSPACE_ID) : plainClass('From a backup')]);
          const label = `${mode}, ${sameId ? 'same id' : 'other class'}`;
          if (mode === 'replace' && sameId) {
            const before = await snapshot(a);
            await refused(restoreBackup(a, file, mode, seen), StoreConflictError, `${label}: the stale replace`);
            check((await snapshot(a)) === before, `${label}: a refused restore changes nothing`);
          } else {
            await restoreBackup(a, file, mode, seen);
            check((await a.listWorkspaces()).length === 2, `${label}: the starter should be kept and the file's class added`);
          }
          check(JSON.stringify(await now(a, DEFAULT_WORKSPACE_ID)) === withDraft, `${label}: the starter and its draft changed`);
        }
      }
    },
  },
  {
    id: 'S10',
    name: 'a draft written at the last moment, after the restore has read the empty starter, makes the restore refuse and change nothing',
    async run(open) {
      for (const mode of ['add', 'replace'] as const) {
        for (const sameId of [false, true]) {
          const { a, b } = await open();
          const [starter] = await ensureWorkspace(a);
          const seen = await seenClasses(a);
          const file = oldFormatFile([sameId ? plainClass('Older copy', DEFAULT_WORKSPACE_ID) : plainClass('From a backup')]);
          const racing = atTheLastMoment(a, () => createDraw(b, starter.id, presentationTokenOf(starter), 'Biome talks', { id: 'd1', now: new Date(T0) }));
          await refused(restoreBackup(racing, file, mode, seen), StoreConflictError, `${mode}, ${sameId ? 'same id' : 'other class'}: the restore`);
          const all = await a.listWorkspaces();
          check(all.length === 1 && all[0].presentation?.draws[0]?.id === 'd1', 'the starter and its draft are intact, and nothing was added');
          check((await a.listRecoveryPoints()).length === 0, 'no recovery copy was written');
        }
      }
    },
  },
  {
    id: 'S11',
    name: 'deleting a starter that holds a draft keeps it in the recovery copy; "Put it back" restores it over the fresh empty starter',
    async run(open) {
      const { a } = await open();
      const [starter] = await ensureWorkspace(a);
      await createDraw(a, starter.id, presentationTokenOf(starter), 'Biome talks', { id: 'd1', now: new Date(T0) });
      const withDraft = await now(a, DEFAULT_WORKSPACE_ID);
      const point = await deleteWorkspace(a, starter.id, (await seenClasses(a))[starter.id]);
      check(point && point.bundles[0].workspace.presentation?.draws[0].id === 'd1', 'the draft is in the recovery copy');
      const [fresh] = await ensureWorkspace(a);
      check(fresh.id === DEFAULT_WORKSPACE_ID && fresh.presentation === undefined && isUntouchedStarter(fresh, 0), 'the app makes a fresh empty starter');
      await applyRecoveryPoint(a, point, await seenClasses(a));
      const back = await now(a, DEFAULT_WORKSPACE_ID);
      check(same(back.presentation!.draws, withDraft.presentation!.draws), 'the draft is back');
      const points = await a.listRecoveryPoints();
      check(points.length === 1 && points[0].bundles[0].workspace.presentation === undefined, 'the fresh empty starter went into a new recovery copy');
    },
  },
  {
    id: 'S13',
    name: 'the first presentation write raises the class revision by exactly one, on any class; the next five do not',
    async run(open) {
      const { a } = await open();
      const [starter] = await ensureWorkspace(a);
      const other = await makeClass(a, { name: 'Another class' });
      for (const cls of [starter, other]) {
        const { workspace } = await createDraw(a, cls.id, presentationTokenOf(cls), 'Biome talks', { now: new Date(T0) });
        check(workspace.rev === cls.rev + 1, `${cls.name}: the first write should raise the revision from ${cls.rev} to ${cls.rev + 1}, found ${workspace.rev}`);
        let current = workspace;
        for (let i = 0; i < 5; i++) current = await createDraw(a, cls.id, presentationTokenOf(current), `Draw ${i}`, { now: new Date(T0) }).then((r) => r.workspace);
        check(current.rev === workspace.rev, `${cls.name}: later presentation writes should not move the class revision`);
        check(!isUntouchedStarter(current, 0), `${cls.name}: is not an untouched starter`);
      }
    },
  },

  // -------------------------------------------------------------------------
  // Replay at the storage level
  // -------------------------------------------------------------------------
  {
    id: 'R13',
    name: 'a stored draw that was altered outside the app is reported as inconsistent, is not modified by reading it, and cannot be written over',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      await revealNext(a, id, drawId);
      const good = await now(a, id);
      const tampered = clone(good);
      const waiting = tampered.presentation!.draws[0].entries.findIndex((e) => e.status === 'waiting');
      tampered.presentation!.draws[0].entries[waiting].status = 'done';
      await clearAllData(a, await seenClasses(a));
      await a.createWorkspace(tampered);

      const stored = await now(a, id);
      const verdict = drawIsConsistent(drawIn(stored, drawId));
      check(!verdict.ok && /do not match its log/.test(verdict.problem), 'the altered draw is reported as inconsistent');
      check(JSON.stringify(await now(a, id)) === JSON.stringify(tampered), 'reading it does not change it');
      // Any write would have to store the inconsistent draw again, so it is refused and the record stays as it is.
      await refused(performAction(a, id, presentationTokenOf(stored), drawId, { type: 'archive' }, { today: DAY }), PresentationInvalidError, 'an action on the inconsistent draw');
      await refused(createDraw(a, id, presentationTokenOf(stored), 'Another'), PresentationInvalidError, 'a new draw beside the inconsistent one');
      check(JSON.stringify(await now(a, id)) === JSON.stringify(tampered), 'the stored record was not modified');
    },
  },

  // -------------------------------------------------------------------------
  // Continue in a new class, and capacity
  // -------------------------------------------------------------------------
  {
    id: 'Q5',
    name: 'Q6, Q7: "Continue in a new class" carries every unfinished presenter and their state, starts a valid class log, and leaves the old class exactly as it was',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      // A second draw that is finished, and a draft.
      const finished = await startDraw(a, id, 'Finished assignment', 'b'.repeat(16));
      for (const index of drawIn(await now(a, id), finished).sequence) await doAct(a, id, finished, { type: 'skip', entry: index, reason: 'presented_another_way' });
      const { drawId: draft } = await createDraw(a, id, await tokenNow(a, id), 'A draft');
      // State worth carrying: one done, one presenting, one on deck, one held, one skipped, one absent today, an exclusion, class-level eligibility.
      await revealNext(a, id, drawId);
      const order = drawIn(await now(a, id), drawId).sequence;
      await doAct(a, id, drawId, { type: 'done', entry: order[0] });
      await revealNext(a, id, drawId);
      await doAct(a, id, drawId, { type: 'on_deck', entry: order[2] });
      await doAct(a, id, drawId, { type: 'defer', entry: order[3], how: 'next_meeting' });
      await doAct(a, id, drawId, { type: 'skip', entry: order[4], reason: 'will_not_present' });
      await doAct(a, id, drawId, { type: 'absent', entry: order[5] });
      await doAct(a, id, drawId, { type: 'exclude', studentId: 's01', reason: 'excused', backOn: '2026-12-09' });
      await setStudentPresenting(a, id, await tokenNow(a, id), 's06', false, 'left_the_class', new Date(T0));
      await a.appendSpin(sampleSpins(await now(a, id), 1)[0]);

      const source = await now(a, id);
      const sourceDraw = drawIn(source, drawId);
      const result = await continueInNewClass(a, id, presentationTokenOf(source), { today: DAY, now: new Date('2026-12-01T16:00:00.000Z') });
      check(result.created, 'the new class was created');

      const next = await now(a, result.destinationId);
      const old = await now(a, id);
      // The new class.
      check(next.name === `${source.name} (continued)`, `unexpected name: ${next.name}`);
      check(same(next.students, source.students) && same(next.settings, source.settings) && same(next.rings, source.rings), 'same roster with the same ids, same settings and ring weights');
      check((await a.listSpins(next.id)).length === 0, 'no spins are copied');
      check(next.schemaVersion === 2 && next.rev >= 2, 'schema 2, revision above 1');
      const p = next.presentation!;
      check(validatePresentation(p).ok, 'the new class is valid');
      check(p.movedTo === null, 'the new class is not marked as moved');
      check(same(p.continuedFrom, { classId: id, marker: old.presentation!.classLog.length }), 'it records which class and marker it continues');
      check(same(p.inactive, source.presentation!.inactive), 'class-level eligibility is the same');
      check(same(p.classLog, [{ n: 1, at: source.presentation!.inactive[0].since, t: 'not_presenting', studentId: 's06', reason: 'left_the_class' }]), 'its class log starts consistent with that eligibility, with no "moved" entry');
      check(same(p.draws.map((d) => d.id).sort(), [drawId, draft].sort()), 'the unfinished draw and the draft are there; the finished draw is not');
      const carried = drawIn(next, drawId);
      const remaining = sourceDraw.sequence.filter((i) => sourceDraw.entries[i].status !== 'done').map((i) => sourceDraw.entries[i].studentId);
      check(same(carried.sequence.map((i) => carried.entries[i].studentId), remaining), 'the remaining order is the same, student for student, with no reshuffle');
      const stateOf = (d: PresentationDraw, studentId: string) => {
        const e = d.entries.find((x) => x.studentId === studentId)!;
        return [e.status, e.revealedAt, e.notBefore, e.skipReason, e.origin, e.drawnPosition];
      };
      for (const studentId of remaining) check(same(stateOf(carried, studentId), stateOf(sourceDraw, studentId)), `the state of ${studentId} was not carried exactly`);
      check(same(carried.exclusions, sourceDraw.exclusions) && same(carried.timing, sourceDraw.timing) && same(carried.meetings, sourceDraw.meetings), 'exclusions and schedule are carried');
      const absentId = sourceDraw.entries[order[5]].studentId;
      check(same(carried.absences.map((x) => [carried.entries[x.entry].studentId, x.date]), [[absentId, DAY]]), "today's absence is carried");
      check(carried.order!.rule === 'carried-over' && carried.order!.seed === null && verifyOrder(carried.order!), 'the carried order has no seed of its own and is intact');
      check(same(carried.order!.carriedFrom, { classId: id, drawId, atEvent: sourceDraw.events.length, seed: SEED }), 'it names the class, draw, point in the log and original seed');
      check(drawIsConsistent(carried).ok, 'it replays from its own snapshot');
      // The old class.
      check(same(old.presentation!.draws, source.presentation!.draws), 'every draw, order and log in the old class is exactly as it was');
      check(old.presentation!.classLog.length === source.presentation!.classLog.length + 1 && old.presentation!.movedTo?.classId === next.id, 'apart from one "continued" entry in its class log');
      await refused(doAct(a, id, drawId, { type: 'archive' }), PresentationMovedError, 'a presentation action in the old class');
      await refused(createDraw(a, id, await tokenNow(a, id), 'Another'), PresentationMovedError, 'a new draw in the old class');
      // Spins and roster edits in the old class still work.
      await a.appendSpin(sampleSpins(old, 1, '2026-12-02T15:00:00.000Z')[0]);
      await renameWorkspace(a, await now(a, id), 'Period 3 Ecology (last term)');
      // And the work goes on in the new class.
      const presentingNow = carried.entries.findIndex((e) => e.status === 'presenting');
      await doAct(a, next.id, drawId, { type: 'done', entry: presentingNow });
      const after = await now(a, next.id);
      const upNext = nextUp(drawIn(after, drawId), { roster: after.students, inactive: after.presentation!.inactive, today: DAY });
      check(drawIn(after, drawId).entries[upNext.entry!].studentId === sourceDraw.entries[order[2]].studentId, 'the presenter who was on deck is next');
      await refused(drawTheOrder(a, next.id, await tokenNow(a, next.id), drawId), PresentationError, 'redrawing a carried-over order');
    },
  },
  {
    id: 'Q8',
    name: 'continuing across tabs: a stale start is refused, a later action elsewhere is refused, two simultaneous starts make one class, and retries are harmless',
    async run(open) {
      // (i) Another tab acts first: the start is stale and nothing changes.
      const one = await seeded(open);
      const stale = await now(one.a, one.id);
      await revealNext(one.b, one.id, one.drawId);
      const before = await snapshot(one.a);
      await refused(continueInNewClass(one.a, one.id, presentationTokenOf(stale), { today: DAY }), StoreConflictError, 'the stale start');
      check((await snapshot(one.a)) === before, 'a refused start changes nothing: the class is not frozen and no class was created');

      // (ii) After a successful start, an action from another tab is refused, whichever token it holds.
      const seenByB = await now(one.b, one.id);
      const result = await continueInNewClass(one.a, one.id, await tokenNow(one.a, one.id), { today: DAY });
      const frozen = await now(one.a, one.id);
      await refused(performAction(one.b, one.id, presentationTokenOf(seenByB), one.drawId, { type: 'archive' }, { today: DAY }), StoreConflictError, 'an action with the older token');
      await refused(performAction(one.b, one.id, presentationTokenOf(frozen), one.drawId, { type: 'archive' }, { today: DAY }), PresentationMovedError, 'an action with the current token');
      // The new class is exactly the continuation of the old class's final state.
      const marker = { sourceClassId: one.id, n: frozen.presentation!.classLog.length, at: frozen.presentation!.movedTo!.at, on: DAY };
      const expected = buildContinuation(frozen.presentation!, marker);
      const made = (await now(one.a, result.destinationId)).presentation!;
      // (The lineage id, the revision and the storage clock's time are set by the store when the class is written.)
      check(same({ ...made, epoch: '', rev: 0, updatedAt: '' }, { ...expected, epoch: '', rev: 0, updatedAt: '' }), 'the new class matches the old class at the moment it was frozen');

      // (iii) Retrying, from either tab, finds the class already made and changes nothing.
      const settled = await snapshot(one.a);
      check(same(await finishMoving(one.b, one.id), { destinationId: result.destinationId, created: false }), 'a retry from another tab reports the class is already there');
      check(same(await continueInNewClass(one.a, one.id, await tokenNow(one.a, one.id), { today: DAY }), { destinationId: result.destinationId, created: false }), 'starting again is the same as finishing');
      check((await snapshot(one.a)) === settled, 'retries change nothing');

      // (iv) Two tabs start at the same moment: exactly one new class.
      for (let round = 0; round < 6; round++) {
        const two = await seeded(open);
        const seen = await now(two.a, two.id);
        const start = (store: WorkspaceStore) => continueInNewClass(store, two.id, presentationTokenOf(seen), { today: DAY });
        const results = await Promise.allSettled(round % 2 === 0 ? [start(two.a), start(two.b)] : [start(two.b), start(two.a)]);
        check(results.some((r) => r.status === 'fulfilled'), `round ${round}: neither start succeeded`);
        for (const r of results) if (r.status === 'rejected') check(r.reason instanceof StoreConflictError, `round ${round}: a start failed for the wrong reason: ${String(r.reason)}`);
        const all = await two.a.listWorkspaces();
        check(all.length === 2, `round ${round}: expected the old class and one new class, found ${all.length}`);
        const ids = results.filter((r): r is PromiseFulfilledResult<{ destinationId: string; created: boolean }> => r.status === 'fulfilled').map((r) => r.value.destinationId);
        check(new Set(ids).size === 1, `round ${round}: the two tabs disagree about which class is the continuation`);
        // The tab that lost can finish, and gets the same class.
        check((await finishMoving(two.b, two.id)).destinationId === ids[0], `round ${round}: finishing gives a different class`);
      }
    },
  },
  {
    id: 'Q9',
    name: 'a conflicting class is never overwritten and nothing is frozen when the new class cannot be created; reopening is refused once the new class exists',
    async run(open) {
      // The chosen id is already something else: refused, and nothing is frozen.
      const one = await seeded(open);
      const other = await makeClass(one.a, { name: 'Unrelated class' });
      const before = await snapshot(one.a);
      await refused(continueInNewClass(one.a, one.id, await tokenNow(one.a, one.id), { today: DAY, destinationId: other.id }), ContinuationConflictError, 'continuing into an id that is taken');
      check((await snapshot(one.a)) === before, 'nothing was frozen or overwritten');

      // Something else takes that id at the last moment, after this tab has checked: still not overwritten, still nothing frozen.
      const two = await seeded(open);
      const squatter = { ...createWorkspace('Squatter', new Date(T0)), id: 'dest-1' };
      const token = await tokenNow(two.a, two.id);
      const untouched = JSON.stringify(await now(two.a, two.id));
      const racing = atTheLastMoment(two.a, () => two.b.createWorkspace(squatter), ['continuePresentation']);
      await refused(continueInNewClass(racing, two.id, token, { today: DAY, destinationId: 'dest-1' }), ContinuationConflictError, 'continuing when another class took the id');
      check(same(await now(two.a, 'dest-1'), squatter), 'the other class was not overwritten');
      check(JSON.stringify(await now(two.a, two.id)) === untouched, 'the old class was not frozen: it is exactly as it was');
      // So the work simply goes on, and can be continued under another id.
      await revealNext(two.a, two.id, two.drawId);
      const result = await continueInNewClass(two.a, two.id, await tokenNow(two.a, two.id), { today: DAY });
      check(result.created && result.destinationId !== 'dest-1' && (await two.a.listWorkspaces()).length === 3, 'continuing again creates one new class under its own id');

      // Once the new class exists the old class cannot be reopened: the work continues there.
      const frozen = JSON.stringify(await now(two.a, two.id));
      await refused(reopenPresentations(two.a, two.id, await tokenNow(two.a, two.id)), PresentationError, 'reopening after the new class exists');
      check(JSON.stringify(await now(two.a, two.id)) === frozen, 'a refused reopen changes nothing');
    },
  },
  {
    id: 'Q3',
    name: 'Q4, Q10: a class at the real 2 MB limit refuses further actions without changing, can always be continued, and its backup restores',
    heavy: true,
    async run(open) {
      const { a } = await open();
      const { budgetBytes, reserveBytes } = PRESENTATION_LIMITS;
      const planted = await plant(a, nearlyFull(budgetBytes - reserveBytes));
      const drawId = planted.presentation!.draws[0].id;
      check(validatePresentation(planted.presentation).ok, 'the large class is valid');
      check(usageOf(planted).level === 'new_work_refused', `expected the class to be nearly full, found ${usageOf(planted).level}`);

      // New work is refused; work on what exists goes on, until the class is full.
      await refused(createDraw(a, planted.id, presentationTokenOf(planted), 'Another'), PresentationCapacityError, 'a new draw in a nearly full class');
      let actions = 0;
      for (; actions < 60; actions++) {
        const current = await now(a, planted.id);
        const draw = drawIn(current, drawId);
        const first = draw.sequence[0];
        const absent = draw.absences.some((x) => x.entry === first && x.date === DAY);
        try {
          await performAction(a, planted.id, presentationTokenOf(current), drawId, { type: absent ? 'present' : 'absent', entry: first }, { today: DAY, now: new Date(T0) });
        } catch (err) {
          check(err instanceof PresentationCapacityError && err.kind === 'full', `the action failed for the wrong reason: ${String(err)}`);
          break;
        }
      }
      check(actions > 0 && actions < 60, `expected a few more actions to fit before the class was full, got ${actions}`);
      // Smaller actions may still fit. Keep going until every action the teacher could take is refused.
      let full = await now(a, planted.id);
      for (let round = 0; ; round++) {
        check(round < 200, 'the class never became full');
        const context = { roster: full.students, inactive: full.presentation!.inactive, today: DAY, at: T0 };
        let accepted = false;
        for (const action of validActions(drawIn(full, drawId), context)) {
          const before = JSON.stringify(full);
          try {
            await performAction(a, planted.id, presentationTokenOf(full), drawId, action, { today: DAY, now: new Date(T0) });
            accepted = true;
          } catch (err) {
            check(err instanceof PresentationCapacityError && err.kind === 'full', `"${action.type}" failed for the wrong reason: ${String(err)}`);
            check(JSON.stringify(await now(a, planted.id)) === before, `a refused "${action.type}" changed the record`);
          }
          full = await now(a, planted.id);
          if (accepted) break;
        }
        if (!accepted) break;
      }
      const frozen = JSON.stringify(full);
      check(usageOf(full).level === 'full' || presentationFileBytes(full.presentation) > budgetBytes - reserveBytes - 400, 'the class is at the limit');
      check(presentationFileBytes(full.presentation) <= budgetBytes - reserveBytes, 'ordinary writes never use the reserve');
      await refused(revealNext(a, planted.id, drawId), PresentationCapacityError, 'a reveal in a full class');
      await refused(createDraw(a, planted.id, presentationTokenOf(full), 'Another'), PresentationCapacityError, 'a new draw in a full class');
      check(JSON.stringify(await now(a, planted.id)) === frozen, 'a refused action changes nothing, token included');

      // The backup of a full class is far below the restore limit and restores to identical data.
      const checked = await exportBackupChecked(a, [planted.id]);
      check(checked.measure.restorable && checked.measure.bytes < 6 * 1024 * 1024, `a full class makes a backup of ${checked.measure.bytes} bytes`);
      const parsed = parseBackupText(checked.text);
      check(parsed.ok, `the backup of a full class should restore: ${parsed.ok ? '' : parsed.errors.join(' ')}`);
      check(same(parsed.backup.workspaces[0].workspace.presentation!.draws, full.presentation!.draws), 'with every event intact');

      // The way out always works: the marker fits in the reserve, and the new class has room.
      const result = await continueInNewClass(a, planted.id, presentationTokenOf(full), { today: DAY });
      const old = await now(a, planted.id);
      check(presentationFileBytes(old.presentation) <= budgetBytes, 'the marker fitted within the budget');
      check(same(old.presentation!.draws, full.presentation!.draws), 'the full class keeps every event');
      const next = await now(a, result.destinationId);
      check(usageOf(next).fraction < 0.5 && usageOf(next).level === 'ok', `the new class should have room, usage ${usageOf(next).fraction}`);
      await revealNext(a, next.id, drawId);
      await createDraw(a, next.id, await tokenNow(a, next.id), 'A new assignment');
    },
  },
  {
    id: 'Q11',
    name: 'Q12: a backup larger than RingWheel can restore is never produced silently, alone or together; under the limit the file is exactly what it always was',
    heavy: true,
    memoryOnly: true,
    async run(open) {
      const { a } = await open();
      // Three classes with long spin histories. Each backup fits on its own. Together they do not.
      const ids: string[] = [];
      for (let c = 0; c < 3; c++) {
        const cls = await makeClass(a, { name: `Class ${c + 1}` });
        const spins = sampleSpins(cls, 16000).map((spin, i) => ({ ...spin, id: `c${c}-spin-${i}` }));
        await clearClass(a, cls.id);
        await a.putBundles([{ workspace: cls, spins }]);
        ids.push(cls.id);
      }
      const small = await makeClass(a, { name: 'Small class' });
      await startDraw(a, small.id);

      // Under the limit: the checked export is exactly the unchecked one.
      const one = await exportBackupChecked(a, [small.id], new Date(T0));
      check(one.text === JSON.stringify(await exportBackup(a, [small.id], new Date(T0)), null, 2), 'under the limit the file text is exactly what is written today');
      check(one.measure.bytes === new TextEncoder().encode(one.text).length && one.measure.restorable, 'the measured size is the real size of the file');
      for (const id of ids) check((await exportBackupChecked(a, [id])).measure.restorable, 'each long class fits on its own');

      // All together: refused, with each class reported as fitting on its own.
      const err = (await refused(exportBackupChecked(a), BackupTooLargeError, 'the backup of all classes')) as BackupTooLargeError;
      check(err.measure.bytes > err.measure.limit, 'the whole file is over the limit');
      check(err.measure.classes.every((c) => c.restorable), 'every class is reported as fitting alone');
      check(/Back up each class on its own/.test(err.message), `unclear message: ${err.message}`);
      // And a file of that size really would be turned away on restore, which is why it is not produced.
      check(!parseBackupText(serializeBackup(await exportBackup(a))).ok, 'the oversized file would not restore');

      // One class that is too large by itself (possible today through spin history alone): refused and named.
      const huge = await makeClass(a, { name: 'Very long history' });
      await clearClass(a, huge.id);
      await a.putBundles([{ workspace: huge, spins: sampleSpins(huge, 46000).map((spin, i) => ({ ...spin, id: `huge-${i}` })) }]);
      const alone = (await refused(exportBackupChecked(a, [huge.id]), BackupTooLargeError, 'the backup of one oversized class')) as BackupTooLargeError;
      check(/"Very long history"/.test(alone.message) && /could not be restored/.test(alone.message), `unclear message: ${alone.message}`);

      // Presentation data beyond what a class can hold is rejected on restore.
      const over = nearlyFull(PRESENTATION_LIMITS.budgetBytes + 30000);
      check(presentationFileBytes(over) > PRESENTATION_LIMITS.budgetBytes, 'the test data is over the budget');
      const file = { format: 'ringwheel-backup', formatVersion: 2, exportedAt: T0, workspaces: [{ workspace: { ...plainClass('Too much').workspace, schemaVersion: 2, presentation: over }, spins: [] }] };
      const result = parseBackupText(JSON.stringify(file));
      check(!result.ok && /larger than a class can hold/.test(result.errors.join(' ')), 'presentation data over the budget is rejected whole');
    },
  },
  {
    id: 'Q15',
    name: 'the limits fit together: the marker always fits the reserve, a continuation always fits a new class, and a full class with the largest roster is far below the restore limit',
    memoryOnly: true,
    async run() {
      const { budgetBytes, reserveBytes, carryBytes, warnFraction, newWorkFraction } = PRESENTATION_LIMITS;
      check(warnFraction < newWorkFraction && budgetBytes * newWorkFraction < budgetBytes - reserveBytes, 'warn, then no new work, then full, in that order');
      check(carryBytes * 2 <= budgetBytes, 'a continuation takes at most half of a new class');
      // The largest "continued in another class" marker, against the reserve it must fit in.
      const before = dataWith(drawnDraw(4));
      const marked = markMoved(before, 'x'.repeat(200), '9999-12-31T23:59:59.999Z', '9999-12-31', Number.MAX_SAFE_INTEGER);
      const markerBytes = presentationFileBytes({ ...marked, classLog: marked.classLog.map((e) => ({ ...e, n: 99999999 })) }) - presentationFileBytes(before);
      check(markerBytes > 0 && markerBytes * 8 <= reserveBytes, `the reserve (${reserveBytes}) should hold the largest marker (${markerBytes}) many times over`);
      // A class at the budget, with the largest roster a class may hold, every name and address at full length in three-byte characters.
      const students = Array.from({ length: LIMITS.studentsPerWorkspace }, (_, i) => ({
        id: `student-${String(i).padStart(30, '0')}`,
        name: '\u6f22'.repeat(LIMITS.nameLength),
        email: `${'\u6f22'.repeat(LIMITS.nameLength)}@example.com`,
        active: true,
        createdAt: T0,
      }));
      const largest: BackupFile = { format: 'ringwheel-backup', formatVersion: 1, exportedAt: T0, workspaces: [{ workspace: { ...plainClass('Largest roster').workspace, students }, spins: [] }] };
      const rosterBytes = measureBackup(largest).bytes;
      check(rosterBytes + budgetBytes < LIMITS.backupBytes / 4, `a full class with the largest roster (${rosterBytes + budgetBytes} bytes) should be far below the restore limit`);
      check(measureBackup(largest).restorable, 'and is reported as restorable');
    },
  },
  {
    id: 'Q14',
    name: 'no operation removes a drawn order: a draft can be discarded, a drawn draw cannot, and capacity is reported in backup-file bytes',
    async run(open) {
      const { a, id, drawId } = await seeded(open);
      const { drawId: draft } = await createDraw(a, id, await tokenNow(a, id), 'A draft');
      await refused(discardDraft(a, id, await tokenNow(a, id), drawId), PresentationError, 'discarding a drawn draw');
      const after = await discardDraft(a, id, await tokenNow(a, id), draft);
      check(same(after.presentation!.draws.map((d) => d.id), [drawId]), 'the draft is gone and the drawn draw is still there');

      // The size shown is exactly what the presentation data adds to the backup file.
      const bundle = (await a.getBundle(id))!;
      const withIt = serializeBackup({ format: 'ringwheel-backup', formatVersion: 2, exportedAt: T0, workspaces: [bundle] });
      const { presentation, ...rest } = bundle.workspace;
      const without = serializeBackup({ format: 'ringwheel-backup', formatVersion: 2, exportedAt: T0, workspaces: [{ workspace: rest as Workspace, spins: bundle.spins }] });
      const added = new TextEncoder().encode(withIt).length - new TextEncoder().encode(without).length;
      check(added === presentationFileBytes(presentation), `the reported size (${presentationFileBytes(presentation)}) is not what the backup grew by (${added})`);
      check(usageOf(bundle.workspace).bytes === added && presentationUsage(undefined).bytes === 0, 'usage is reported in the same bytes');
    },
  },
];

/** A draw in a class with no students: only a draft is possible, so this returns a draft's id. */
async function startDrawInEmpty(store: WorkspaceStore, classId: string): Promise<string> {
  const { drawId } = await createDraw(store, classId, await tokenNow(store, classId), 'Biome talks', { now: new Date(T0) });
  return drawId;
}

/** Remove one class without a recovery copy, so a test can put a prepared version in its place. */
async function clearClass(store: WorkspaceStore, id: string): Promise<void> {
  await store.replaceClasses({ remove: [{ id, expected: stampOf((await store.getBundle(id))!), recover: false }], put: [] });
}
