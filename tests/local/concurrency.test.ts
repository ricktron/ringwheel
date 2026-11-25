/**
 * Destructive actions against a class that another tab is changing.
 *
 * The scenarios themselves live in concurrency-scenarios.ts so that exactly the
 * same checks also run against the browser's real IndexedDB (see e2e/smoke.mjs).
 * Here they run against both store implementations.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbStore } from '../../src/data/local/idb-store';
import { MemoryStore } from '../../src/data/local/store';
import { scenarios, type Tabs } from './concurrency-scenarios';

const kinds: [string, () => Promise<Tabs>][] = [
  [
    // An in-memory store belongs to one page, so "another tab" is another caller of the same store.
    'MemoryStore',
    async () => {
      const store = new MemoryStore();
      return { a: store, b: store };
    },
  ],
  [
    // Two separate connections to one database, as two browser tabs have.
    'IndexedDbStore',
    async () => {
      const browser = new IDBFactory();
      return { a: await IndexedDbStore.open(browser), b: await IndexedDbStore.open(browser) };
    },
  ],
];

describe.each(kinds)('destructive actions while another tab is working (%s)', (_kind, open) => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    await scenario.run(open);
  });

  it('runs a meaningful number of scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(14);
  });
});
