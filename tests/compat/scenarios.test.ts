/**
 * Rollback and roll-forward against the frozen baseline, on both stores.
 * The scenarios are in scenarios.ts, which also runs in real Chromium against
 * the browser's own IndexedDB (e2e/smoke.mjs).
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { indexedDbPair, memoryPair, type Pair } from './pair';
import { compatScenarios } from './scenarios';

const kinds: [string, () => () => Promise<Pair>][] = [
  ['MemoryStore', () => async () => memoryPair()],
  // Each call is a separate browser profile; inside one, both builds open the same database.
  ['IndexedDbStore', () => async () => indexedDbPair(new IDBFactory())],
];

describe.each(kinds)('the older build and the current build on one storage (%s)', (_kind, opener) => {
  it.each(compatScenarios.map((scenario) => [`${scenario.id}: ${scenario.name}`, scenario] as const))('%s', async (_name, scenario) => {
    await scenario.run(opener());
  });

  it('covers every baseline row of the matrix', () => {
    expect(compatScenarios.map((scenario) => scenario.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'K14', 'S12']);
  });
});
