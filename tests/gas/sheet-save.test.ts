/**
 * Admin saves when someone else edits the Sheet in the meantime.
 *
 * Runs the real API client and the real save helper against the real backend
 * code on fake in-memory sheets. Also covers a backend that ignores
 * `base_rows`, which is how the version deployed before this change behaves.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../../src/api';
import { createGasRuntime, syntheticSheets, TEST_TOKEN } from './harness.mjs';
import type { RingSlice, SettingRow } from '../../src/types';
import { mergeRingWeights, ringWeightsFromRows } from '../../src/utils/rings';
import { mergeSettingsRows, parseSettings } from '../../src/utils/settings';
import { describeSheetChange, saveGuarded } from '../../src/utils/sheet-save';

type Runtime = ReturnType<typeof createGasRuntime>;

function connect(rt: Runtime, { legacyBackend = false, beforeWrite }: { legacyBackend?: boolean; beforeWrite?: () => void } = {}) {
  const requests: string[] = [];
  const client = createApiClient({
    url: 'https://backend.test/exec',
    token: TEST_TOKEN,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        requests.push(`POST ${body.type}`);
        // A backend from before this change does not know about base_rows.
        if (legacyBackend) delete body.base_rows;
        beforeWrite?.();
        const res = rt.postRaw(JSON.stringify(body));
        return new Response(res.content, { status: 200 });
      }
      requests.push(`GET ${url.searchParams.get('type')}`);
      return new Response(rt.get(Object.fromEntries(url.searchParams)).content, { status: 200 });
    }) as typeof fetch,
  });
  return { client, requests };
}

const newRuntime = () => createGasRuntime({ sheets: syntheticSheets(), properties: { API_TOKEN: TEST_TOKEN } });

const saveSettings = (client: ReturnType<typeof createApiClient>, loaded: Awaited<ReturnType<typeof client.readSettings>>, change: (s: ReturnType<typeof parseSettings>['settings']) => void) => {
  const settings = parseSettings(loaded.rows).settings;
  change(settings);
  return saveGuarded<SettingRow>({
    sheetName: 'Settings',
    loaded,
    read: client.readSettings,
    write: client.writeSettings,
    buildRows: (current) => mergeSettingsRows(current, settings),
    identify: (row) => String(row.key ?? ''),
  });
};

async function conflictFrom(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('conflict');
    return err as ApiError;
  }
  throw new Error('expected a conflict, but the save went through');
}

describe.each([
  ['current backend', false],
  ['older backend that ignores base_rows', true],
])('guarded admin save (%s)', (_name, legacyBackend) => {
  it('saves when nothing else changed, and returns a fresh starting point', async () => {
    const rt = newRuntime();
    const { client, requests } = connect(rt, { legacyBackend });
    const loaded = await client.readSettings();
    const saved = await saveSettings(client, loaded, (s) => (s.enableConfetti = true));

    expect(rt.rows('Settings').find((r: unknown[]) => r[0] === 'enableConfetti')).toEqual(['enableConfetti', 'true', '']);
    expect(saved.rows.find((r) => r.key === 'enableConfetti')?.value).toBe('true');
    expect(requests).toEqual(['GET settings', 'GET settings', 'POST writesettings', 'GET settings']);

    // A second save from the returned starting point also works.
    await saveSettings(client, saved, (s) => (s.enableConfetti = false));
    expect(rt.rows('Settings').find((r: unknown[]) => r[0] === 'enableConfetti')).toEqual(['enableConfetti', 'false', '']);
  });

  it('refuses, writes nothing, and keeps a row someone added after the page loaded', async () => {
    const rt = newRuntime();
    const { client, requests } = connect(rt, { legacyBackend });
    const loaded = await client.readSettings();

    rt.sheet('Settings').rows.push(['added_in_sheets', 'yes', 'by a colleague']);
    const afterEdit = JSON.stringify(rt.rows('Settings'));

    const err = await conflictFrom(saveSettings(client, loaded, (s) => (s.enableConfetti = true)));
    expect(err.message).toMatch(/Settings sheet was changed by someone else after this page loaded it \(added: added_in_sheets\)/);
    expect(err.message).toMatch(/Nothing was saved/);
    expect(JSON.stringify(rt.rows('Settings'))).toBe(afterEdit);
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('refuses and keeps a value someone changed after the page loaded', async () => {
    const rt = newRuntime();
    const { client } = connect(rt, { legacyBackend });
    const loaded = await client.readSettings();

    rt.sheet('Settings').rows[1][1] = 30; // a colleague sets the pair cap to 30 in Sheets
    const err = await conflictFrom(saveSettings(client, loaded, (s) => (s.enableConfetti = true)));
    expect(err.message).toMatch(/changed: midterm_pair_cap_pct/);
    expect(rt.rows('Settings')[1]).toEqual(['midterm_pair_cap_pct', 30, 'Cap for A|B pairs in midterm mode']);
  });

  it('after a reload the edit goes through and both changes are in the sheet', async () => {
    const rt = newRuntime();
    const { client } = connect(rt, { legacyBackend });
    const stale = await client.readSettings();
    rt.sheet('Settings').rows.push(['added_in_sheets', 'yes', 'by a colleague']);
    await conflictFrom(saveSettings(client, stale, (s) => (s.enableConfetti = true)));

    const reloaded = await client.readSettings();
    await saveSettings(client, reloaded, (s) => (s.enableConfetti = true));
    const rows = rt.rows('Settings');
    expect(rows.find((r: unknown[]) => r[0] === 'added_in_sheets')).toEqual(['added_in_sheets', 'yes', 'by a colleague']);
    expect(rows.find((r: unknown[]) => r[0] === 'enableConfetti')).toEqual(['enableConfetti', 'true', '']);
    expect(rows.find((r: unknown[]) => r[0] === 'mode')).toEqual(['mode', 'midterm', 'midterm or final']);
  });

  it('protects ring weights the same way and keeps colors, order and active flags', async () => {
    const rt = newRuntime();
    const { client } = connect(rt, { legacyBackend });
    const loaded = await client.readRings();
    const weights = ringWeightsFromRows(loaded.rows);
    weights.region.Nearctic = 3;
    const save = (from: typeof loaded) =>
      saveGuarded<RingSlice>({
        sheetName: 'Rings',
        loaded: from,
        read: client.readRings,
        write: client.writeRings,
        buildRows: (current) => mergeRingWeights(current, weights),
        identify: (row) => `${String(row.ring_name ?? '')} ${String(row.label ?? '')}`.trim(),
      });

    rt.sheet('Rings').rows[3][5] = false; // a colleague switches Neotropical off in Sheets
    const err = await conflictFrom(save(loaded));
    expect(err.message).toMatch(/changed: A Neotropical/);
    expect(rt.rows('Rings')[2][3]).toBe(1);

    await save(await client.readRings());
    const rows = rt.rows('Rings');
    expect(rows).toHaveLength(26);
    expect(rows[2]).toEqual(['A', 'Nearctic', '#4f46e5', 3, 1, true]);
    expect(rows[3]).toEqual(['A', 'Neotropical', '#4f46e5', 1, 2, false]);
  });
});

describe('the gap between the last read and the write', () => {
  it('is closed by the current backend: an edit in that instant is refused, not overwritten', async () => {
    const rt = newRuntime();
    let edited = false;
    const { client } = connect(rt, {
      beforeWrite: () => {
        if (!edited) rt.sheet('Settings').rows.push(['added_at_the_last_moment', 'yes', '']);
        edited = true;
      },
    });
    const loaded = await client.readSettings();
    const err = await conflictFrom(saveSettings(client, loaded, (s) => (s.enableConfetti = true)));
    expect(err.message).toMatch(/changed by someone else/);
    expect(rt.rows('Settings').map((r: unknown[]) => r[0])).toContain('added_at_the_last_moment');
    expect(rt.rows('Settings').find((r: unknown[]) => r[0] === 'enableConfetti')).toEqual(['enableConfetti', false, '']);
  });

  it('is NOT closed by an older backend: this documents the remaining risk until the backend is deployed', async () => {
    const rt = newRuntime();
    let edited = false;
    const { client } = connect(rt, {
      legacyBackend: true,
      beforeWrite: () => {
        if (!edited) rt.sheet('Settings').rows.push(['added_at_the_last_moment', 'yes', '']);
        edited = true;
      },
    });
    const loaded = await client.readSettings();
    await saveSettings(client, loaded, (s) => (s.enableConfetti = true));
    // The row added in the instant before the write is gone. The window is one request long.
    expect(rt.rows('Settings').map((r: unknown[]) => r[0])).not.toContain('added_at_the_last_moment');
  });
});

describe('describeSheetChange', () => {
  const id = (row: Record<string, unknown>) => String(row.key);
  it('names what changed, was added and was removed', () => {
    const before = [{ key: 'a', value: 1 }, { key: 'b', value: 2 }, { key: 'c', value: 3 }];
    const after = [{ key: 'a', value: 1 }, { key: 'b', value: 9 }, { key: 'd', value: 4 }];
    expect(describeSheetChange(before, after, id)).toBe('changed: b; added: d; removed: c');
  });
  it('falls back to a general description for a pure reorder', () => {
    expect(describeSheetChange([{ key: 'a' }, { key: 'b' }], [{ key: 'b' }, { key: 'a' }], id)).toBe('rows were reordered or edited');
  });
});
