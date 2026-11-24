/**
 * The same contract, run against both stores: the in-memory one and the real
 * IndexedDB implementation (on a test double of the browser database).
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbStore } from '../../src/data/local/idb-store';
import { newId } from '../../src/data/local/schema';
import { MAX_RECOVERY_POINTS, MemoryStore, StoreConflictError, StoreMissingError, type WorkspaceStore } from '../../src/data/local/store';
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

  it('replaces a class together with all of its old spins, and only when asked', async () => {
    const store = await open();
    const original = sampleBundle('Period 3', ['Ada Sample', 'Ben Placeholder'], 6);
    const other = sampleBundle('Untouched', ['Eli Testcase'], 3);
    await store.putBundles([original, other]);

    const replacement = { workspace: { ...original.workspace, name: 'Period 3 restored' }, spins: sampleSpins(original.workspace, 2) };
    await store.putBundles([replacement], { replace: [original.workspace.id] });

    expect(await store.getBundle(original.workspace.id)).toEqual(replacement);
    expect(await store.getBundle(other.workspace.id)).toEqual(other);
  });

  it('deletes one class and its spins and nothing else', async () => {
    const store = await open();
    const keep = sampleBundle('Keep');
    const drop = sampleBundle('Drop');
    await store.putBundles([keep, drop]);
    await store.deleteWorkspace(drop.workspace.id);
    expect((await store.listWorkspaces()).map((w) => w.name)).toEqual(['Keep']);
    expect(await store.listSpins(drop.workspace.id)).toEqual([]);
    expect(await store.getBundle(keep.workspace.id)).toEqual(keep);
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
    await store.clearAll();
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
