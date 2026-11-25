/**
 * The same contract, run against both stores: the in-memory one and the real
 * IndexedDB implementation (on a test double of the browser database).
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbStore } from '../../src/data/local/idb-store';
import { newId } from '../../src/data/local/schema';
import { MAX_RECOVERY_POINTS, MemoryStore, StoreConflictError, StoreMissingError, stampOf, type WorkspaceStore } from '../../src/data/local/store';
import { sampleBundle, sampleSpins, sampleWorkspace } from './fixtures';

const stores: [string, () => Promise<WorkspaceStore>][] = [
  ['MemoryStore', async () => new MemoryStore()],
  ['IndexedDbStore', async () => IndexedDbStore.open(new IDBFactory())],
];

describe.each(stores)('%s', (_name, open) => {
  it('starts empty', async () => {
    const store = await open();
    expect(await store.listWorkspaces()).toEqual([]);
    expect(await store.listRecoveryPoints()).toEqual([]);
    expect(await store.getWorkspace('nope')).toBeNull();
    expect(await store.getBundle('nope')).toBeNull();
  });

  it('stores and returns a class exactly, sorted by name', async () => {
    const store = await open();
    const b = sampleWorkspace('Period 10');
    const a = sampleWorkspace('Period 2');
    await store.createWorkspace(b);
    await store.createWorkspace(a);
    expect(await store.getWorkspace(a.id)).toEqual(a);
    expect((await store.listWorkspaces()).map((w) => w.name)).toEqual(['Period 2', 'Period 10']);
    await expect(store.createWorkspace(a)).rejects.toThrow();
  });

  it('hands out copies, so changing a returned object changes nothing stored', async () => {
    const store = await open();
    const workspace = sampleWorkspace();
    await store.createWorkspace(workspace);
    const got = await store.getWorkspace(workspace.id);
    got!.students.pop();
    got!.name = 'changed';
    expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
  });

  it('applies an edit only on top of the revision it was based on', async () => {
    const store = await open();
    const workspace = sampleWorkspace();
    await store.createWorkspace(workspace);

    const first = await store.updateWorkspace(workspace.id, 1, (w) => ({ ...w, name: 'Renamed' }));
    expect(first.rev).toBe(2);
    expect(first.name).toBe('Renamed');
    expect(first.id).toBe(workspace.id);
    expect(first.createdAt).toBe(workspace.createdAt);
    expect(first.updatedAt > workspace.updatedAt).toBe(true);

    // A second tab still holding revision 1 must not overwrite the first edit.
    await expect(store.updateWorkspace(workspace.id, 1, (w) => ({ ...w, name: 'Stale edit' }))).rejects.toBeInstanceOf(StoreConflictError);
    expect((await store.getWorkspace(workspace.id))!.name).toBe('Renamed');

    await expect(store.updateWorkspace('missing', 1, (w) => w)).rejects.toBeInstanceOf(StoreMissingError);
  });

  it('writes nothing when an edit throws half way', async () => {
    const store = await open();
    const workspace = sampleWorkspace();
    await store.createWorkspace(workspace);
    await expect(
      store.updateWorkspace(workspace.id, 1, () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
  });

  it('an edit cannot change the class id or creation date', async () => {
    const store = await open();
    const workspace = sampleWorkspace();
    await store.createWorkspace(workspace);
    const next = await store.updateWorkspace(workspace.id, 1, (w) => ({ ...w, id: 'hijacked', createdAt: '1999-01-01T00:00:00.000Z' }));
    expect(next.id).toBe(workspace.id);
    expect(next.createdAt).toBe(workspace.createdAt);
    expect(await store.getWorkspace('hijacked')).toBeNull();
  });

  it('appends spins, never changes them, and keeps each class to itself', async () => {
    const store = await open();
    const one = sampleBundle('Class one');
    const two = sampleBundle('Class two', ['Dee Fixture'], 2);
    await store.createWorkspace(one.workspace);
    await store.createWorkspace(two.workspace);
    for (const spin of [...one.spins, ...two.spins]) await store.appendSpin(spin);

    expect(await store.listSpins(one.workspace.id)).toEqual(one.spins);
    expect(await store.listSpins(two.workspace.id)).toEqual(two.spins);
    expect(await store.getBundle(one.workspace.id)).toEqual(one);

    // The same spin cannot be written twice, and a spin needs an existing class.
    await expect(store.appendSpin(one.spins[0])).rejects.toThrow();
    await expect(store.appendSpin({ ...one.spins[0], id: newId(), workspaceId: 'missing' })).rejects.toBeInstanceOf(StoreMissingError);
    expect(await store.listSpins(one.workspace.id)).toHaveLength(4);

    // Logging a spin is not a roster edit: it must not disturb the revision.
    expect((await store.getWorkspace(one.workspace.id))!.rev).toBe(1);
  });

  it('records a backup time without counting as an edit', async () => {
    const store = await open();
    const workspace = sampleWorkspace();
    await store.createWorkspace(workspace);
    await store.markBackedUp([workspace.id, 'missing'], '2026-11-24T10:00:00.000Z');
    const after = await store.getWorkspace(workspace.id);
    expect(after).toEqual({ ...workspace, lastBackupAt: '2026-11-24T10:00:00.000Z' });

    // A backup time never moves backwards: an older file confirmed later does not hide newer work.
    await store.markBackedUp([workspace.id], '2026-11-20T10:00:00.000Z');
    expect((await store.getWorkspace(workspace.id))!.lastBackupAt).toBe('2026-11-24T10:00:00.000Z');
    await store.markBackedUp([workspace.id], '2026-11-25T10:00:00.000Z');
    expect((await store.getWorkspace(workspace.id))!.lastBackupAt).toBe('2026-11-25T10:00:00.000Z');
  });

  it('writes whole classes all-or-nothing', async () => {
    const store = await open();
    const existing = sampleBundle('Already here');
    await store.putBundles([existing]);

    const fresh = sampleBundle('New class');
    // The second bundle collides with an existing class, so neither may be written.
    await expect(store.putBundles([fresh, existing])).rejects.toThrow();
    expect((await store.listWorkspaces()).map((w) => w.name)).toEqual(['Already here']);
    expect(await store.listSpins(fresh.workspace.id)).toEqual([]);

    // A spin id collision inside the batch also rejects everything.
    const clash = sampleBundle('Clashing spins');
    clash.spins[1] = { ...clash.spins[1], id: existing.spins[0].id };
    await expect(store.putBundles([clash])).rejects.toThrow();
    expect(await store.getWorkspace(clash.workspace.id)).toBeNull();
    expect(await store.getBundle(existing.workspace.id)).toEqual(existing);
  });

  it('adding classes never replaces one: an id that is in use is refused', async () => {
    const store = await open();
    const original = sampleBundle('Period 3', ['Ada Sample'], 2);
    await store.putBundles([original]);
    const impostor = { workspace: { ...original.workspace, name: 'Impostor' }, spins: [] };
    await expect(store.putBundles([impostor])).rejects.toThrow();
    expect(await store.getBundle(original.workspace.id)).toEqual(original);
  });

  it('replaces a class together with all of its old spins, keeps a recovery copy, and moves the revision forward', async () => {
    const store = await open();
    const original = sampleBundle('Period 3', ['Ada Sample', 'Ben Placeholder'], 6);
    const other = sampleBundle('Untouched', ['Eli Testcase'], 3);
    await store.putBundles([original, other]);

    const replacement = { workspace: { ...original.workspace, name: 'Period 3 restored' }, spins: sampleSpins(original.workspace, 2) };
    const result = await store.replaceClasses({
      remove: [{ id: original.workspace.id, expected: stampOf(original), recover: true }],
      put: [replacement],
      recovery: { id: 'point-1', takenAt: '2026-11-25T16:00:00.000Z', describe: (recovered) => `Before replacing ${recovered[0].workspace.name}` },
    });

    expect(result.removed).toEqual([original]);
    expect(result.recoveryPoint).toEqual({ id: 'point-1', takenAt: '2026-11-25T16:00:00.000Z', reason: 'Before replacing Period 3', bundles: [original] });
    expect(await store.listRecoveryPoints()).toEqual([result.recoveryPoint]);
    // The replacement is a new state of the class, so its revision is past both versions.
    expect(await store.getBundle(original.workspace.id)).toEqual({ workspace: { ...replacement.workspace, rev: 2 }, spins: replacement.spins });
    expect(await store.getBundle(other.workspace.id)).toEqual(other);

    // A replacement whose revision is already higher is stored exactly as given (a restore stays an exact copy).
    const stored = (await store.getBundle(original.workspace.id))!;
    const ahead = { workspace: { ...original.workspace, rev: 9 }, spins: [] };
    await store.replaceClasses({ remove: [{ id: original.workspace.id, expected: stampOf(stored), recover: false }], put: [ahead] });
    expect(await store.getBundle(original.workspace.id)).toEqual(ahead);
  });

  it('removes one class and its spins and nothing else, and only if it is still what the caller saw', async () => {
    const store = await open();
    const keep = sampleBundle('Keep');
    const drop = sampleBundle('Drop');
    await store.putBundles([keep, drop]);

    // Wrong fingerprint: refused, nothing changes, no recovery point.
    await expect(
      store.replaceClasses({
        remove: [{ id: drop.workspace.id, expected: stampOf(keep), recover: true }],
        put: [],
        recovery: { id: 'p', takenAt: '2026-11-25T16:00:00.000Z', describe: () => 'never stored' },
      })
    ).rejects.toBeInstanceOf(StoreConflictError);
    expect((await store.listWorkspaces()).map((w) => w.name)).toEqual(['Drop', 'Keep']);
    expect(await store.listRecoveryPoints()).toEqual([]);

    // A class that is not there at all is also a conflict, not a silent success.
    await expect(store.replaceClasses({ remove: [{ id: 'gone', expected: 'x', recover: false }], put: [] })).rejects.toBeInstanceOf(StoreConflictError);

    const result = await store.replaceClasses({ remove: [{ id: drop.workspace.id, expected: stampOf(drop), recover: false }], put: [] });
    expect(result).toEqual({ removed: [drop], recoveryPoint: null });
    expect((await store.listWorkspaces()).map((w) => w.name)).toEqual(['Keep']);
    expect(await store.listSpins(drop.workspace.id)).toEqual([]);
    expect(await store.getBundle(keep.workspace.id)).toEqual(keep);
    expect(await store.listRecoveryPoints()).toEqual([]);
  });

  it('a recovery point written by a class change obeys the same limit as any other', async () => {
    const store = await open();
    for (let i = 0; i < MAX_RECOVERY_POINTS; i++) {
      await store.addRecoveryPoint({ id: `old${i}`, takenAt: `2026-11-0${i + 1}T00:00:00.000Z`, reason: `point ${i}`, bundles: [sampleBundle()] });
    }
    const bundle = sampleBundle('Newest');
    await store.putBundles([bundle]);
    await store.replaceClasses({
      remove: [{ id: bundle.workspace.id, expected: stampOf(bundle), recover: true }],
      put: [],
      recovery: { id: 'newest', takenAt: '2026-11-20T00:00:00.000Z', describe: () => 'newest' },
    });
    expect((await store.listRecoveryPoints()).map((p) => p.id)).toEqual(['newest', 'old4', 'old3', 'old2', 'old1']);
  });

  it(`keeps only the ${MAX_RECOVERY_POINTS} newest recovery points`, async () => {
    const store = await open();
    for (let i = 0; i < MAX_RECOVERY_POINTS + 3; i++) {
      await store.addRecoveryPoint({ id: `p${i}`, takenAt: `2026-11-0${i + 1}T00:00:00.000Z`, reason: `point ${i}`, bundles: [sampleBundle()] });
    }
    const points = await store.listRecoveryPoints();
    expect(points.map((p) => p.id)).toEqual(['p7', 'p6', 'p5', 'p4', 'p3']);
    await store.deleteRecoveryPoint('p6');
    expect((await store.listRecoveryPoints()).map((p) => p.id)).toEqual(['p7', 'p5', 'p4', 'p3']);
  });

  it('clearAll removes every class, spin and recovery point', async () => {
    const store = await open();
    const bundle = sampleBundle();
    await store.putBundles([bundle]);
    await store.addRecoveryPoint({ id: 'p', takenAt: '2026-11-01T00:00:00.000Z', reason: 'r', bundles: [bundle] });
    // With a list of what the caller saw, it only goes ahead if that is still what is stored.
    await expect(store.clearAll({})).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.clearAll({ [bundle.workspace.id]: 'not-the-fingerprint' })).rejects.toBeInstanceOf(StoreConflictError);
    expect(await store.getBundle(bundle.workspace.id)).toEqual(bundle);
    expect(await store.listRecoveryPoints()).toHaveLength(1);

    await store.clearAll({ [bundle.workspace.id]: stampOf(bundle) });
    expect(await store.listWorkspaces()).toEqual([]);
    expect(await store.listSpins(bundle.workspace.id)).toEqual([]);
    expect(await store.listRecoveryPoints()).toEqual([]);
  });
});

describe('IndexedDbStore persistence', () => {
  it('reports itself as persistent, unlike the in-memory fallback', async () => {
    expect((await IndexedDbStore.open(new IDBFactory())).persistent).toBe(true);
    expect(new MemoryStore().persistent).toBe(false);
  });

  it('data written by one opening of the database is there for the next (a page reload)', async () => {
    const browser = new IDBFactory();
    const bundle = sampleBundle('Survives a reload');
    const first = await IndexedDbStore.open(browser);
    await first.putBundles([bundle]);
    await first.updateWorkspace(bundle.workspace.id, 1, (w) => ({ ...w, name: 'Renamed before reload' }));

    const second = await IndexedDbStore.open(browser);
    const reopened = await second.getBundle(bundle.workspace.id);
    expect(reopened!.workspace.name).toBe('Renamed before reload');
    expect(reopened!.workspace.rev).toBe(2);
    expect(reopened!.spins).toEqual(bundle.spins);
  });

  it('two tabs on the same database cannot silently overwrite each other', async () => {
    const browser = new IDBFactory();
    const workspace = sampleWorkspace();
    const tabA = await IndexedDbStore.open(browser);
    const tabB = await IndexedDbStore.open(browser);
    await tabA.createWorkspace(workspace);

    const seenByB = await tabB.getWorkspace(workspace.id);
    await tabA.updateWorkspace(workspace.id, 1, (w) => ({ ...w, students: w.students.slice(0, 1) }));
    await expect(tabB.updateWorkspace(workspace.id, seenByB!.rev, (w) => ({ ...w, name: 'From tab B' }))).rejects.toBeInstanceOf(StoreConflictError);

    const final = await tabB.getWorkspace(workspace.id);
    expect(final!.students).toHaveLength(1);
    expect(final!.name).toBe(workspace.name);
  });

  it('spins logged from two tabs are both kept', async () => {
    const browser = new IDBFactory();
    const bundle = sampleBundle('Shared', ['Ada Sample'], 2);
    const tabA = await IndexedDbStore.open(browser);
    const tabB = await IndexedDbStore.open(browser);
    await tabA.createWorkspace(bundle.workspace);
    await Promise.all([tabA.appendSpin(bundle.spins[0]), tabB.appendSpin(bundle.spins[1])]);
    expect(await tabA.listSpins(bundle.workspace.id)).toEqual(bundle.spins);
  });

  it('falls back cleanly when the browser refuses to open the database', async () => {
    const refusing = {
      open: () => {
        throw new Error('SecurityError: storage is disabled');
      },
    } as unknown as IDBFactory;
    await expect(IndexedDbStore.open(refusing)).rejects.toThrow(/storage is disabled/);
  });
});
