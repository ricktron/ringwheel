/**
 * Presentation Draw at the storage level, on both stores.
 * The scenarios themselves are in scenarios.ts, which also runs in real
 * Chromium against the browser's own IndexedDB (e2e/smoke.mjs).
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, it } from 'vitest';
import { IndexedDbStore } from '../../src/data/local/idb-store';
import { MemoryStore } from '../../src/data/local/store';
import { scenarios, type Tabs } from './scenarios';

const kinds: [string, () => Promise<Tabs>][] = [
  [
    'MemoryStore',
    async () => {
      const store = new MemoryStore();
      return { a: store, b: store };
    },
  ],
  [
    'IndexedDbStore',
    async () => {
      const browser = new IDBFactory();
      return { a: await IndexedDbStore.open(browser), b: await IndexedDbStore.open(browser) };
    },
  ],
];

describe.each(kinds)('presentation draws in storage (%s)', (kind, open) => {
  for (const scenario of scenarios) {
    if (scenario.memoryOnly && kind !== 'MemoryStore') continue;
    it(`${scenario.id}: ${scenario.name}`, () => scenario.run(open), scenario.heavy ? 120000 : 30000);
  }
});
