import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api';
import { IndexedDbStore } from '../../src/data/local/idb-store';
import { createLocalProvider, localDateKey } from '../../src/data/local/provider';
import { parseBackupText } from '../../src/data/local/schema';
import { MemoryStore, type WorkspaceStore } from '../../src/data/local/store';
import {
  DEFAULT_WORKSPACE_NAME,
  addStudents,
  addWorkspace,
  applyRecoveryPoint,
  backupStatus,
  clearAllData,
  deleteWorkspace,
  describeBackup,
  ensureWorkspace,
  exportBackup,
  isUntouchedStarter,
  removeStudent,
  renameWorkspace,
  restoreBackup,
  updateStudent,
} from '../../src/data/local/workspaces';
import { MODE_KEY, resolveStorageMode } from '../../src/data/mode';
import { mergeSettingsRows, parseSettings } from '../../src/utils/settings';
import { saveGuarded } from '../../src/utils/sheet-save';
import { buildLocalQueue } from '../../src/utils/roster';
import { createRng, spin } from '../../src/utils/spin-engine';
import { buildSpinLogPayload } from '../../src/utils/spin-log';
import { sampleBundle } from './fixtures';

const stores: [string, () => Promise<WorkspaceStore>][] = [
  ['MemoryStore', async () => new MemoryStore()],
  ['IndexedDbStore', async () => IndexedDbStore.open(new IDBFactory())],
];

/** Everything in a store, in a form that can be compared. */
async function dump(store: WorkspaceStore) {
  const out = [];
  for (const workspace of await store.listWorkspaces()) out.push(await store.getBundle(workspace.id));
  return out;
}

const payloadFor = (seed: string, student: { name: string; email: string } | null, at: string, isTest = false) =>
  buildSpinLogPayload({
    outcome: spin({ seed }),
    timestamp: new Date(at),
    sessionId: 'session-1',
    student: student ? { ...student, period: '' } : null,
    isTest,
  });

describe.each(stores)('classes and rosters (%s)', (_name, open) => {
  it('creates a first class so the app is usable straight away, once', async () => {
    const store = await open();
    const first = await ensureWorkspace(store);
    expect(first.map((w) => w.name)).toEqual([DEFAULT_WORKSPACE_NAME]);
    expect((await ensureWorkspace(store)).map((w) => w.id)).toEqual([first[0].id]);
  });

  it('starting up twice at the same moment still leaves exactly one first class', async () => {
    const store = await open();
    const [a, b, c] = await Promise.all([ensureWorkspace(store), ensureWorkspace(store), ensureWorkspace(store)]);
    expect((await store.listWorkspaces()).map((w) => w.name)).toEqual([DEFAULT_WORKSPACE_NAME]);
    expect(new Set([...a, ...b, ...c].map((w) => w.id)).size).toBe(1);
  });

  it('adds, edits, deactivates and removes students with stable ids', async () => {
    const store = await open();
    let ws = await addWorkspace(store, 'Period 3');
    ws = await addStudents(store, ws, [{ name: 'Ada Sample', email: 'ada.sample@example.com' }, { name: ' Ben  Placeholder ', email: '' }]);
    expect(ws.students.map((s) => s.name)).toEqual(['Ada Sample', 'Ben Placeholder']);
    const [ada, ben] = ws.students;

    ws = await updateStudent(store, ws, ada.id, { name: 'Ada S. Sample' });
    ws = await updateStudent(store, ws, ben.id, { active: false });
    expect(ws.students.map((s) => [s.id, s.name, s.active])).toEqual([[ada.id, 'Ada S. Sample', true], [ben.id, 'Ben Placeholder', false]]);

    ws = await removeStudent(store, ws, ada.id);
    expect(ws.students.map((s) => s.id)).toEqual([ben.id]);

    await expect(addStudents(store, ws, [{ name: '   ', email: '' }])).rejects.toThrow(/needs a name/);
    await expect(updateStudent(store, ws, ben.id, { name: ' ' })).rejects.toThrow(/needs a name/);
    await expect(renameWorkspace(store, ws, '  ')).rejects.toThrow(/needs a name/);
    // A refused edit leaves the roster as it was.
    expect((await store.getWorkspace(ws.id))!.students.map((s) => s.name)).toEqual(['Ben Placeholder']);
    expect((await renameWorkspace(store, ws, ' Period 3 Honors ')).name).toBe('Period 3 Honors');
  });

  it('keeps classes fully separate', async () => {
    const store = await open();
    let one = await addWorkspace(store, 'Class one');
    let two = await addWorkspace(store, 'Class two');
    one = await addStudents(store, one, [{ name: 'Ada Sample', email: '' }]);
    two = await addStudents(store, two, [{ name: 'Dee Fixture', email: '' }, { name: 'Eli Testcase', email: '' }]);

    const p1 = createLocalProvider(store, one.id);
    const p2 = createLocalProvider(store, two.id);
    await p1.logSpin(payloadFor('a', one.students[0], '2026-11-24T15:00:00.000Z'), { studentId: one.students[0].id });
    await p2.logSpin(payloadFor('b', two.students[0], '2026-11-24T15:01:00.000Z'), { studentId: two.students[0].id });
    await p2.logSpin(payloadFor('c', two.students[1], '2026-11-24T15:02:00.000Z'), { studentId: two.students[1].id });
    await p1.writeSettings([{ key: 'enableAudio', value: 'false', notes: '' }]);

    expect((await store.listSpins(one.id)).map((s) => s.student_name)).toEqual(['Ada Sample']);
    expect((await store.listSpins(two.id)).map((s) => s.student_name)).toEqual(['Dee Fixture', 'Eli Testcase']);
    expect(await p2.settings()).toEqual([]);
    expect((await store.getWorkspace(two.id))!.students.map((s) => s.name)).toEqual(['Dee Fixture', 'Eli Testcase']);
    expect((await store.getWorkspace(one.id))!.students.map((s) => s.name)).toEqual(['Ada Sample']);
  });
});

describe.each(stores)('backup and restore (%s)', (_name, open) => {
  const seeded = async () => {
    const store = await open();
    const a = sampleBundle('Period 3', ['Ada Sample', 'Ben Placeholder', 'Cy Demo'], 5);
    const b = sampleBundle('Period 5', ['Dee Fixture'], 2);
    await store.putBundles([a, b]);
    return { store, a, b };
  };

  it('full round trip: back up, delete everything, restore, and get identical data back', async () => {
    const { store } = await seeded();
    const backup = await exportBackup(store, undefined, new Date('2026-11-24T18:00:00.000Z'));
    const expected = await dump(store);
    const text = JSON.stringify(backup);

    await clearAllData(store);
    expect(await store.listWorkspaces()).toEqual([]);

    const parsed = parseBackupText(text);
    if (!parsed.ok) throw new Error(parsed.errors.join(' '));
    const summary = await restoreBackup(store, parsed.backup, 'replace');
    expect(summary).toEqual({ added: ['Period 3', 'Period 5'], replaced: [], recoveryPointId: null });
    expect(await dump(store)).toEqual(expected);

    // A second backup of the restored data matches the first apart from its own export time.
    const again = await exportBackup(store, undefined, new Date('2026-11-25T09:00:00.000Z'));
    const strip = (b: typeof backup) => b.workspaces.map((w) => ({ ...w, workspace: { ...w.workspace, lastBackupAt: null } }));
    expect(strip(again)).toEqual(strip(backup));
  });

  it('"add" into an empty browser brings every class back exactly, ids included', async () => {
    const { store } = await seeded();
    const backup = await exportBackup(store, undefined, new Date('2026-11-24T18:00:00.000Z'));
    const expected = await dump(store);
    await clearAllData(store);
    const summary = await restoreBackup(store, backup, 'add');
    expect(summary).toEqual({ added: ['Period 3', 'Period 5'], replaced: [], recoveryPointId: null });
    expect(await dump(store)).toEqual(expected);
  });

  it('a restore into a brand-new browser replaces the empty starter class instead of leaving it behind', async () => {
    const { store } = await seeded();
    const backup = await exportBackup(store, undefined, new Date('2026-11-24T18:00:00.000Z'));
    const expected = await dump(store);

    for (const mode of ['add', 'replace'] as const) {
      await clearAllData(store);
      await ensureWorkspace(store); // what the app does on start-up
      const summary = await restoreBackup(store, backup, mode);
      expect(summary).toEqual({ added: ['Period 3', 'Period 5'], replaced: [], recoveryPointId: null });
      expect(await dump(store)).toEqual(expected);
      expect(await store.listRecoveryPoints()).toEqual([]);
    }
  });

  it('a starter class that has been used is real data and is never dropped by a restore', async () => {
    const fresh = await open();
    const [starter] = await ensureWorkspace(fresh);
    await createLocalProvider(fresh, starter.id).logSpin(payloadFor('first', null, '2026-11-24T15:00:00.000Z'));
    const other = sampleBundle('From a backup', ['Dee Fixture'], 1);
    const backup = { format: 'ringwheel-backup' as const, formatVersion: 1, exportedAt: '2026-11-24T18:00:00.000Z', workspaces: [other] };

    await restoreBackup(fresh, backup, 'add');
    expect((await fresh.listWorkspaces()).map((w) => w.name).sort()).toEqual(['From a backup', DEFAULT_WORKSPACE_NAME].sort());
    expect(await fresh.listSpins(starter.id)).toHaveLength(1);

    expect(isUntouchedStarter(starter, 0)).toBe(true);
    expect(isUntouchedStarter(starter, 1)).toBe(false);
    expect(isUntouchedStarter({ ...starter, name: 'Renamed' }, 0)).toBe(false);
    expect(isUntouchedStarter({ ...starter, rev: 2 }, 0)).toBe(false);
    expect(isUntouchedStarter({ ...other.workspace, students: [] }, 0)).toBe(false);
  });

  it('exporting records the backup time and does not otherwise change the class', async () => {
    const { store, a } = await seeded();
    const backup = await exportBackup(store, [a.workspace.id], new Date('2026-11-24T18:00:00.000Z'));
    expect(backup.workspaces).toHaveLength(1);
    expect(backup.workspaces[0].workspace.lastBackupAt).toBe('2026-11-24T18:00:00.000Z');
    const after = await store.getBundle(a.workspace.id);
    expect(after).toEqual({ workspace: { ...a.workspace, lastBackupAt: '2026-11-24T18:00:00.000Z' }, spins: a.spins });
  });

  it('"add" never touches what is already there, even when restoring a backup of the same class', async () => {
    const { store, a } = await seeded();
    const backup = await exportBackup(store, [a.workspace.id]);
    const before = await dump(store);

    const summary = await restoreBackup(store, backup, 'add');
    expect(summary.added).toEqual(['Period 3 (2)']);
    expect(summary.replaced).toEqual([]);

    const after = await dump(store);
    expect(after).toHaveLength(3);
    // The two original classes are byte for byte what they were.
    for (const original of before) expect(after).toContainEqual(original);
    const copy = after.find((bundle) => bundle!.workspace.name === 'Period 3 (2)')!;
    expect(copy.workspace.id).not.toBe(a.workspace.id);
    expect(copy.workspace.students).toEqual(a.workspace.students);
    expect(copy.spins.map((s) => [s.studentId, s.timestamp_iso, s.result_A, s.result_B, s.result_C, s.seed])).toEqual(
      a.spins.map((s) => [s.studentId, s.timestamp_iso, s.result_A, s.result_B, s.result_C, s.seed])
    );
    expect(copy.spins.every((s) => s.workspaceId === copy.workspace.id)).toBe(true);
  });

  it('"replace" swaps the class for the backup, keeps a recovery copy, and can be undone', async () => {
    const { store, a, b } = await seeded();
    const backup = await exportBackup(store, [a.workspace.id], new Date('2026-11-24T18:00:00.000Z'));

    // Work continues after the backup: a student is removed and a spin is logged.
    let current = (await store.getWorkspace(a.workspace.id))!;
    current = await removeStudent(store, current, current.students[2].id);
    await createLocalProvider(store, current.id).logSpin(payloadFor('later', current.students[0], '2026-11-25T15:00:00.000Z'), { studentId: current.students[0].id });
    const afterMoreWork = await store.getBundle(a.workspace.id);

    const summary = await restoreBackup(store, backup, 'replace', new Date('2026-11-25T16:00:00.000Z'));
    expect(summary.replaced).toEqual(['Period 3']);
    expect(summary.added).toEqual([]);
    const restored = (await store.getBundle(a.workspace.id))!;
    expect(restored.workspace.students).toHaveLength(3);
    expect(restored.spins).toHaveLength(5);
    // The other class is untouched.
    expect(await store.getBundle(b.workspace.id)).toEqual(b);

    const points = await store.listRecoveryPoints();
    expect(points).toHaveLength(1);
    expect(points[0].id).toBe(summary.recoveryPointId);
    expect(points[0].reason).toBe('Before restoring a backup over "Period 3"');
    expect(points[0].bundles).toEqual([afterMoreWork]);

    // Undo: the later work is back, and the undo itself left a recovery copy.
    await applyRecoveryPoint(store, points[0], new Date('2026-11-25T17:00:00.000Z'));
    expect(await store.getBundle(a.workspace.id)).toEqual(afterMoreWork);
    const afterUndo = await store.listRecoveryPoints();
    expect(afterUndo).toHaveLength(1);
    expect(afterUndo[0].reason).toBe('Before undoing: restoring a backup over "Period 3"');
    expect(afterUndo[0].bundles[0].spins).toHaveLength(5);
  });

  it('a failed restore changes nothing', async () => {
    const { store, a } = await seeded();
    const backup = await exportBackup(store);
    const before = await dump(store);
    // Corrupt the already-validated object so the write itself fails part way.
    backup.workspaces[1].spins[1] = { ...backup.workspaces[1].spins[1], id: a.spins[0].id };
    backup.workspaces[1].workspace.id = 'brand-new-id';
    backup.workspaces[1].spins.forEach((s) => (s.workspaceId = 'brand-new-id'));
    backup.workspaces = [backup.workspaces[1]];
    await expect(restoreBackup(store, backup, 'replace')).rejects.toThrow();
    expect(await dump(store)).toEqual(before);
  });

  it('deleting a class keeps a recovery copy that restores it exactly', async () => {
    const { store, a, b } = await seeded();
    const point = await deleteWorkspace(store, a.workspace.id, new Date('2026-11-24T19:00:00.000Z'));
    expect((await store.listWorkspaces()).map((w) => w.name)).toEqual(['Period 5']);
    expect(point!.reason).toBe('Before deleting "Period 3"');
    await applyRecoveryPoint(store, point!);
    expect(await store.getBundle(a.workspace.id)).toEqual(a);
    expect(await store.getBundle(b.workspace.id)).toEqual(b);
    expect(await store.listRecoveryPoints()).toEqual([]);
  });

  it('delete-everything really deletes everything, recovery copies included', async () => {
    const { store, a } = await seeded();
    await deleteWorkspace(store, a.workspace.id);
    await clearAllData(store);
    expect(await store.listWorkspaces()).toEqual([]);
    expect(await store.listRecoveryPoints()).toEqual([]);
  });
});

describe('backup status', () => {
  it('is "never" until a backup exists, "current" right after, and "stale" once anything changes', async () => {
    const store = new MemoryStore();
    const bundle = sampleBundle('Period 3', ['Ada Sample'], 2);
    await store.putBundles([bundle]);
    const status = async () => backupStatus((await store.getBundle(bundle.workspace.id))!);

    expect(await status()).toEqual({ state: 'never', lastBackupAt: null, spinsSince: 2, rosterChangedSince: true });
    expect(describeBackup(await status())).toBe('Never backed up');

    await exportBackup(store, undefined, new Date());
    expect((await status()).state).toBe('current');
    expect(describeBackup(await status())).toBe('Backed up today');

    await createLocalProvider(store, bundle.workspace.id).logSpin(payloadFor('new', null, new Date(Date.now() + 1000).toISOString()));
    expect(await status()).toMatchObject({ state: 'stale', spinsSince: 1, rosterChangedSince: false });
    expect(describeBackup(await status())).toBe('Not in a backup yet: 1 spin');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await addStudents(store, (await store.getWorkspace(bundle.workspace.id))!, [{ name: 'Ben Placeholder', email: '' }]);
    expect(describeBackup(await status())).toBe('Not in a backup yet: 1 spin and roster or settings changes');
  });
});

describe('local data provider', () => {
  afterEach(() => vi.restoreAllMocks());

  const setup = async () => {
    const store = new MemoryStore();
    const bundle = sampleBundle('Period 3', ['Ada Sample', 'Ben Placeholder'], 0);
    await store.putBundles([bundle]);
    return { store, workspace: bundle.workspace, provider: createLocalProvider(store, bundle.workspace.id) };
  };

  it('never makes a network request, whatever is asked of it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Local Mode tried to use the network');
    });
    const { provider, workspace } = await setup();
    await provider.health();
    await provider.settings();
    await provider.rings();
    const settings = await provider.readSettings();
    await provider.writeSettings([{ key: 'enableAudio', value: 'false', notes: '' }], { base: settings.base });
    const rings = await provider.readRings();
    await provider.writeRings([{ ring_name: 'A', label: 'Nearctic', color_hex: '#fff', weight: 2, order_index: 0, active: true }], { base: rings.base });
    await provider.logSpin(payloadFor('s1', workspace.students[0], new Date().toISOString()), { studentId: workspace.students[0].id });
    await provider.getSpins({ date: localDateKey(new Date()) });
    await provider.getSpins({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a spin as saved in full, with the student id, and reads it back for today', async () => {
    const { provider, store, workspace } = await setup();
    const now = new Date();
    const payload = payloadFor('s1', workspace.students[0], now.toISOString());
    expect(await provider.logSpin(payload, { studentId: workspace.students[0].id })).toEqual({ ok: true, complete: true, missing: [], warnings: [] });

    const [stored] = await store.listSpins(workspace.id);
    expect(stored).toMatchObject({ ...payload, workspaceId: workspace.id, studentId: workspace.students[0].id });

    const rows = await provider.getSpins({ date: localDateKey(now) });
    expect(rows).toEqual([
      {
        timestamp_iso: payload.timestamp_iso,
        student_name: 'Ada Sample',
        email: 'ada.sample@example.com',
        period: '',
        result_region: payload.result_A,
        result_taxon: payload.result_B,
        result_iucn: payload.result_C,
        plantae_mercy: false,
        veto_used: false,
        rule_flags: [],
        is_test: false,
        student_id: workspace.students[0].id,
      },
    ]);
    expect(await provider.getSpins({ date: '2001-01-01' })).toEqual([]);
  });

  it('"today" follows the calendar on this computer, not UTC', async () => {
    const { provider } = await setup();
    // 11:30 pm local time on the 24th.
    const late = new Date(2026, 10, 24, 23, 30, 0);
    await provider.logSpin(payloadFor('late', null, late.toISOString()));
    expect(localDateKey(late)).toBe('2026-11-24');
    expect(await provider.getSpins({ date: '2026-11-24' })).toHaveLength(1);
    expect(await provider.getSpins({ date: '2026-11-25' })).toHaveLength(0);
  });

  it('keeps test spins marked as tests', async () => {
    const { provider } = await setup();
    await provider.logSpin(payloadFor('t', null, new Date().toISOString(), true));
    const [row] = await provider.getSpins({});
    expect(row.is_test).toBe(true);
    expect(row.rule_flags).toEqual(['auto_test_run']);
  });

  it('settings saved through the admin flow are read back, and unknown rows are kept', async () => {
    const { provider } = await setup();
    const loaded = await provider.readSettings();
    expect(loaded.rows).toEqual([{ key: 'enableConfetti', value: 'false', notes: 'quiet room' }]);
    const wanted = { ...parseSettings(loaded.rows).settings, applyRingWeights: true, enableAudio: false };
    const saved = await saveGuarded({
      sheetName: 'Settings',
      loaded,
      read: provider.readSettings,
      write: provider.writeSettings,
      buildRows: (current) => mergeSettingsRows(current, wanted),
      identify: (row) => String(row.key ?? ''),
    });
    expect(parseSettings(saved.rows).settings).toEqual(wanted);
    expect(saved.rows[0]).toEqual({ key: 'enableConfetti', value: 'false', notes: 'quiet room' });
  });

  it('refuses a settings save when another tab changed them first', async () => {
    const { provider, store, workspace } = await setup();
    const loaded = await provider.readSettings();
    // Another tab saves first.
    await createLocalProvider(store, workspace.id).writeSettings([{ key: 'enableAudio', value: 'false', notes: 'other tab' }]);
    const err = await provider.writeSettings([{ key: 'mode', value: 'x', notes: '' }], { base: loaded.base }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('conflict');
    expect(await provider.settings()).toEqual([{ key: 'enableAudio', value: 'false', notes: 'other tab' }]);
  });

  it('reports a clear failure, not success, when the class is gone or storage fails', async () => {
    const { provider, store, workspace } = await setup();
    await store.deleteWorkspace(workspace.id);
    await expect(provider.logSpin(payloadFor('x', null, new Date().toISOString()))).rejects.toMatchObject({ kind: 'rejected' });
    await expect(provider.health()).rejects.toMatchObject({ kind: 'rejected' });
    await expect(provider.writeSettings([])).rejects.toMatchObject({ kind: 'rejected' });

    const failing = new MemoryStore();
    const bundle = sampleBundle();
    await failing.putBundles([bundle]);
    failing.appendSpin = async () => {
      throw new Error('QuotaExceededError');
    };
    const err = await createLocalProvider(failing, bundle.workspace.id).logSpin(payloadFor('y', null, new Date().toISOString())).catch((e) => e);
    expect(err.kind).toBe('rejected');
    expect(err.message).toMatch(/could not save.*QuotaExceededError/);
  });

  it('warns through the health check when the browser is not keeping data', async () => {
    const { provider } = await setup();
    const health = await provider.health();
    expect(health.status).toBe('ok');
    expect(health.warnings.join(' ')).toMatch(/not keeping data after the tab closes/);

    const idb = await IndexedDbStore.open(new IDBFactory());
    const bundle = sampleBundle();
    await idb.putBundles([bundle]);
    expect((await createLocalProvider(idb, bundle.workspace.id).health()).warnings).toEqual([]);
  });
});

describe('local spin queue', () => {
  it('queues every active student exactly once and leaves inactive students out', () => {
    const students = [
      { id: 's1', name: 'Cy Demo', email: '', active: true },
      { id: 's2', name: 'Ada Sample', email: 'ada.sample@example.com', active: true },
      { id: 's3', name: 'Ben Placeholder', email: '', active: false },
    ];
    const queue = buildLocalQueue(students, 'alphabetical', createRng('q'));
    expect(queue).toEqual([
      { id: 's2', email: 'ada.sample@example.com', name: 'Ada Sample', period: '', hasSpun: false },
      { id: 's1', email: '', name: 'Cy Demo', period: '', hasSpun: false },
    ]);
    const shuffled = buildLocalQueue(students, 'random', createRng('q'));
    expect(shuffled.map((q) => q.id).sort()).toEqual(['s1', 's2']);
    expect(buildLocalQueue([], 'random', createRng('q'))).toEqual([]);
  });

  it('two students with the same name are two queue entries', () => {
    const students = [
      { id: 'a', name: 'Sam Lee', email: '', active: true },
      { id: 'b', name: 'Sam Lee', email: '', active: true },
    ];
    expect(buildLocalQueue(students, 'alphabetical', createRng('q')).map((q) => q.id).sort()).toEqual(['a', 'b']);
  });
});

describe('storage mode', () => {
  const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
  const connection = { 'ringwheel.apiUrl': 'https://backend.example.test/exec', 'ringwheel.apiToken': 'a-saved-token' };

  it('is local for a first-time visitor and when storage is unavailable', () => {
    expect(resolveStorageMode(storage({}))).toBe('local');
    expect(resolveStorageMode(undefined)).toBe('local');
    expect(
      resolveStorageMode({
        getItem: () => {
          throw new Error('blocked');
        },
      })
    ).toBe('local');
  });

  it('an explicit choice always wins', () => {
    expect(resolveStorageMode(storage({ [MODE_KEY]: 'local', ...connection }))).toBe('local');
    expect(resolveStorageMode(storage({ [MODE_KEY]: 'connected' }))).toBe('connected');
    expect(resolveStorageMode(storage({ [MODE_KEY]: 'nonsense' }))).toBe('local');
  });

  it('a browser that already holds a complete saved connection keeps using it', () => {
    expect(resolveStorageMode(storage(connection))).toBe('connected');
    // A half-finished or placeholder connection is not enough to leave Local Mode.
    expect(resolveStorageMode(storage({ 'ringwheel.apiUrl': connection['ringwheel.apiUrl'] }))).toBe('local');
    expect(resolveStorageMode(storage({ ...connection, 'ringwheel.apiToken': 'your-api-token-here' }))).toBe('local');
  });

  it('nothing in the build can switch a visitor to Connected Mode', () => {
    vi.stubEnv('VITE_SPIN_API_URL', 'https://backend.example.test/exec');
    vi.stubEnv('VITE_RINGWHEEL_API_TOKEN', 'token-from-the-build');
    try {
      expect(resolveStorageMode(storage({}))).toBe('local');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
