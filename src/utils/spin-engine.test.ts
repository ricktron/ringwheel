import { describe, expect, it, vi } from 'vitest';
import type { Region, Taxon } from '../types';
import {
  DEFAULT_PAIR_CAP_PCT,
  DEFAULT_RING_CONFIG,
  IUCN_STATUS,
  REGIONS,
  RING_KEYS,
  SpinError,
  TAXA,
  createRng,
  eligibleOptions,
  emptyPairHistory,
  isPairOverCap,
  normalizePairCapPct,
  pairKey,
  plantaeMercy,
  randomSeed,
  recordPair,
  shuffle,
  spin,
  vetoRespin,
  type PairHistory,
  type RingConfig,
  type RingKey,
} from './spin-engine';

const SPINNABLE_TAXA = TAXA.filter((t) => t !== 'Plantae');
const seeds = (n: number, prefix = 'seed') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

function tally<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

/** Copy of the default config with some options changed. */
function configWith(changes: Partial<Record<RingKey, Record<string, { weight?: number; active?: boolean }>>>): RingConfig {
  const patch = (ring: RingKey) =>
    DEFAULT_RING_CONFIG[ring].map((o) => ({ ...o, ...(changes[ring]?.[o.label] ?? {}) }));
  return { region: patch('region'), taxon: patch('taxon'), iucn: patch('iucn') } as RingConfig;
}

describe('seeded randomness', () => {
  it('produces the same sequence for the same seed and a different one for another seed', () => {
    const a = createRng('abc');
    const b = createRng('abc');
    const c = createRng('abd');
    const seqA = [a(), a(), a(), a()];
    expect([b(), b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c(), c()]).not.toEqual(seqA);
  });

  it('stays inside [0, 1) and is centred', () => {
    const rng = createRng('range-check');
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 20000).toBeGreaterThan(0.49);
    expect(sum / 20000).toBeLessThan(0.51);
  });

  it('randomSeed returns 16 hex characters and does not repeat', () => {
    const generated = new Set(Array.from({ length: 200 }, () => randomSeed()));
    expect(generated.size).toBe(200);
    for (const seed of generated) expect(seed).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never uses Math.random, so a logged seed fully determines the result', () => {
    const spy = vi.spyOn(Math, 'random');
    const base = spin({ seed: 's1' });
    vetoRespin({ seed: 's2', current: base, target: 'region' });
    plantaeMercy({ current: null, region: 'Nearctic' });
    shuffle([1, 2, 3, 4], createRng('s4'));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('normal spin', () => {
  it('is reproducible: same seed, config and history give the same outcome', () => {
    const history = recordPair(emptyPairHistory(), 'Nearctic', 'Aves');
    for (const seed of seeds(50)) {
      expect(spin({ seed, history })).toEqual(spin({ seed, history }));
    }
  });

  it('keeps producing the recorded results for known seeds (replay of old log rows must not drift)', () => {
    // If this fails, the algorithm changed and seeds already written to SpinsLog no longer replay.
    expect(spin({ seed: 'ringwheel-golden-1' })).toMatchObject(GOLDEN[0]);
    expect(spin({ seed: 'ringwheel-golden-2' })).toMatchObject(GOLDEN[1]);
    expect(spin({ seed: '0123456789abcdef' })).toMatchObject(GOLDEN[2]);
  });

  it('only ever returns canonical labels, never Plantae, and is not marked veto or mercy', () => {
    for (const seed of seeds(5000)) {
      const outcome = spin({ seed });
      expect(REGIONS).toContain(outcome.region);
      expect(SPINNABLE_TAXA).toContain(outcome.taxon);
      expect(IUCN_STATUS).toContain(outcome.iucn);
      expect(outcome.plantaeMercy).toBe(false);
      expect(outcome.vetoUsed).toBe(false);
      expect(outcome.flags).toEqual([]);
      expect(outcome.seed).toBe(seed);
    }
  });

  it('is unbiased over the eligible options of each ring', () => {
    const n = 72000;
    const outcomes = seeds(n, 'uniform').map((seed) => spin({ seed }));
    const check = (values: string[], labels: string[]) => {
      const counts = tally(values);
      const expected = n / labels.length;
      expect(Object.keys(counts).sort()).toEqual([...labels].sort());
      for (const label of labels) {
        // Within 5% of the expected share. With n = 72000 that is well over 4 standard deviations.
        expect(Math.abs(counts[label] - expected) / expected).toBeLessThan(0.05);
      }
    };
    check(outcomes.map((o) => o.region), REGIONS);
    check(outcomes.map((o) => o.taxon), SPINNABLE_TAXA);
    check(outcomes.map((o) => o.iucn), IUCN_STATUS);
  });

  it('draws the three rings independently', () => {
    const n = 72000;
    const pairs = tally(seeds(n, 'indep').map((seed) => {
      const o = spin({ seed });
      return pairKey(o.region, o.taxon);
    }));
    const expected = n / (REGIONS.length * SPINNABLE_TAXA.length);
    expect(Object.keys(pairs)).toHaveLength(REGIONS.length * SPINNABLE_TAXA.length);
    for (const count of Object.values(pairs)) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.15);
    }
  });
});

describe('weights and active flags', () => {
  it('follows weights proportionally', () => {
    const config = configWith({ region: { Nearctic: { weight: 3 } } });
    const counts = tally(seeds(40000, 'weighted').map((seed) => spin({ seed, config }).region));
    // Nearctic has weight 3 of a total 10.
    expect(counts.Nearctic / 40000).toBeGreaterThan(0.285);
    expect(counts.Nearctic / 40000).toBeLessThan(0.315);
    expect(counts.Oceanic / 40000).toBeGreaterThan(0.09);
    expect(counts.Oceanic / 40000).toBeLessThan(0.11);
  });

  it('never lands on an option with weight 0 or one that is inactive', () => {
    const config = configWith({
      region: { Antarctic: { weight: 0 }, Oceanic: { active: false } },
      taxon: { Fungi: { active: false } },
      iucn: { EX: { weight: 0 } },
    });
    for (const seed of seeds(4000, 'excluded')) {
      const o = spin({ seed, config });
      expect(o.region).not.toBe('Antarctic');
      expect(o.region).not.toBe('Oceanic');
      expect(o.taxon).not.toBe('Fungi');
      expect(o.taxon).not.toBe('Plantae');
      expect(o.iucn).not.toBe('EX');
    }
  });

  it('keeps Plantae out of random picks even when the sheet gives it a large weight', () => {
    const config = configWith({ taxon: { Plantae: { weight: 1000, active: true } } });
    expect(eligibleOptions(config, 'taxon').map((o) => o.label)).not.toContain('Plantae');
    for (const seed of seeds(2000, 'plantae')) {
      expect(spin({ seed, config }).taxon).not.toBe('Plantae');
    }
  });

  it('refuses to spin when a ring has nothing eligible, instead of inventing a result', () => {
    const noRegions = configWith({ region: Object.fromEntries(REGIONS.map((r) => [r, { active: false }])) });
    expect(() => spin({ seed: 'x', config: noRegions })).toThrowError(SpinError);
    try {
      spin({ seed: 'x', config: noRegions });
    } catch (err) {
      expect((err as SpinError).code).toBe('no_eligible_options');
    }

    // Plantae being the only active taxon still counts as nothing eligible.
    const onlyPlantae = configWith({ taxon: Object.fromEntries(SPINNABLE_TAXA.map((t) => [t, { weight: 0 }])) });
    expect(() => spin({ seed: 'x', config: onlyPlantae })).toThrowError(/taxon ring/);
  });
});

describe('pair cap', () => {
  it('caps a pair when its share of the session is at or above the cap', () => {
    const empty = emptyPairHistory();
    expect(isPairOverCap(empty, 'A:B', 12)).toBe(false);

    const one: PairHistory = { total: 1, counts: { 'A:B': 1 } };
    expect(isPairOverCap(one, 'A:B', 12)).toBe(true);
    expect(isPairOverCap(one, 'A:C', 12)).toBe(false);

    // 1 of 8 is 12.5% (capped); 1 of 9 is 11.1% (allowed again).
    expect(isPairOverCap({ total: 8, counts: { 'A:B': 1 } }, 'A:B', 12)).toBe(true);
    expect(isPairOverCap({ total: 9, counts: { 'A:B': 1 } }, 'A:B', 12)).toBe(false);
    // Exactly at the cap counts as capped.
    expect(isPairOverCap({ total: 25, counts: { 'A:B': 3 } }, 'A:B', 12)).toBe(true);
  });

  it('recordPair counts without mutating the previous history', () => {
    const first = emptyPairHistory();
    const second = recordPair(first, 'Nearctic', 'Aves');
    const third = recordPair(second, 'Nearctic', 'Aves');
    expect(first).toEqual({ total: 0, counts: {} });
    expect(second).toEqual({ total: 1, counts: { 'Nearctic:Aves': 1 } });
    expect(third).toEqual({ total: 2, counts: { 'Nearctic:Aves': 2 } });
  });

  it('never returns a capped pair, and flags exactly the spins that had to be redrawn', () => {
    // A history in which three pairs are over the cap.
    let history = emptyPairHistory();
    const capped: [Region, Taxon][] = [['Nearctic', 'Aves'], ['Oceanic', 'Fungi'], ['Antarctic', 'Insecta']];
    for (const [r, t] of capped) history = recordPair(recordPair(history, r, t), r, t);
    const cappedKeys = new Set(capped.map(([r, t]) => pairKey(r, t)));

    let redrawn = 0;
    for (const seed of seeds(20000, 'cap')) {
      const free = spin({ seed });
      const constrained = spin({ seed, history });
      expect(cappedKeys.has(pairKey(constrained.region, constrained.taxon))).toBe(false);
      expect(constrained.iucn).toBe(free.iucn);

      if (cappedKeys.has(pairKey(free.region, free.taxon))) {
        redrawn++;
        expect(constrained.flags).toEqual(['pair_cap_reroll']);
      } else {
        // The cap must not disturb a spin that was already legal.
        expect(constrained.flags).toEqual([]);
        expect(constrained.region).toBe(free.region);
        expect(constrained.taxon).toBe(free.taxon);
      }
    }
    // 3 of 72 pairs are capped, so about 4.2% of spins are redrawn.
    expect(redrawn / 20000).toBeGreaterThan(0.035);
    expect(redrawn / 20000).toBeLessThan(0.05);
  });

  it('spreads redrawn spins over the allowed pairs without favouring any', () => {
    // Every pair except those in two regions is capped, so all spins that start elsewhere are redrawn.
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of REGIONS) {
      for (const t of SPINNABLE_TAXA) {
        if (r !== 'Nearctic' && r !== 'Oceanic') {
          counts[pairKey(r, t)] = 1;
          total++;
        }
      }
    }
    const history: PairHistory = { total, counts };
    const n = 36000;
    const landed = tally(seeds(n, 'redraw').map((seed) => {
      const o = spin({ seed, history, pairCapPct: 1 });
      return pairKey(o.region, o.taxon);
    }));
    expect(Object.keys(landed)).toHaveLength(2 * SPINNABLE_TAXA.length);
    const expected = n / (2 * SPINNABLE_TAXA.length);
    for (const count of Object.values(landed)) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.08);
    }
  });

  it('holds across a whole simulated class session', () => {
    let history = emptyPairHistory();
    const seen: string[] = [];
    for (const seed of seeds(300, 'session')) {
      const o = spin({ seed, history, pairCapPct: DEFAULT_PAIR_CAP_PCT });
      const key = pairKey(o.region, o.taxon);
      // The pair chosen was legal at the moment it was chosen.
      expect(isPairOverCap(history, key, DEFAULT_PAIR_CAP_PCT)).toBe(false);
      seen.push(key);
      history = recordPair(history, o.region, o.taxon);
    }
    // With a 12% cap no pair can repeat within the first 9 spins.
    expect(new Set(seen.slice(0, 9)).size).toBe(9);
    // Over the session no pair ever holds 12% or more once enough spins exist.
    const max = Math.max(...Object.values(history.counts));
    expect((max / history.total) * 100).toBeLessThan(DEFAULT_PAIR_CAP_PCT);
  });

  it('throws when every pair is capped; it does not fall back to a fixed answer', () => {
    const config = configWith({
      region: Object.fromEntries(REGIONS.filter((r) => r !== 'Nearctic').map((r) => [r, { active: false }])),
      taxon: Object.fromEntries(SPINNABLE_TAXA.filter((t) => t !== 'Aves').map((t) => [t, { active: false }])),
    });
    const history = recordPair(emptyPairHistory(), 'Nearctic', 'Aves');
    for (const seed of seeds(50, 'exhausted')) {
      let error: unknown;
      try {
        spin({ seed, config, history });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SpinError);
      expect((error as SpinError).code).toBe('pair_cap_exhausted');
    }
  });

  it('rejects pair cap settings that would block everything or mean nothing', () => {
    expect(normalizePairCapPct(12)).toEqual({ value: 12, valid: true });
    expect(normalizePairCapPct('20')).toEqual({ value: 20, valid: true });
    expect(normalizePairCapPct(100)).toEqual({ value: 100, valid: true });
    for (const bad of [0, -5, 101, 'abc', '', null, undefined, Number.NaN]) {
      expect(normalizePairCapPct(bad)).toEqual({ value: DEFAULT_PAIR_CAP_PCT, valid: false });
    }
  });
});

describe('veto re-spin', () => {
  it('changes only the target ring, always to a different value, and never to Plantae', () => {
    for (const target of RING_KEYS) {
      for (const seed of seeds(1500, `veto-${target}`)) {
        const current = spin({ seed: `${seed}-base` });
        const next = vetoRespin({ seed, current, target });
        for (const ring of RING_KEYS) {
          if (ring === target) expect(next[ring]).not.toBe(current[ring]);
          else expect(next[ring]).toBe(current[ring]);
        }
        expect(next.taxon).not.toBe('Plantae');
        expect(next.vetoUsed).toBe(true);
        expect(next.plantaeMercy).toBe(false);
        expect(next.flags).toEqual(['veto_respin', `veto_respin_${target}`]);
        expect(next.seed).toBe(seed);
      }
    }
  });

  it('is reproducible from its seed', () => {
    const current = spin({ seed: 'base' });
    expect(vetoRespin({ seed: 'v', current, target: 'iucn' })).toEqual(vetoRespin({ seed: 'v', current, target: 'iucn' }));
  });

  it('is unbiased over the remaining options', () => {
    const current = { region: 'Nearctic' as Region, taxon: 'Aves' as Taxon, iucn: 'LC' as const };
    const n = 35000;
    const counts = tally(seeds(n, 'veto-uniform').map((seed) => vetoRespin({ seed, current, target: 'region' }).region));
    expect(counts.Nearctic).toBeUndefined();
    const expected = n / (REGIONS.length - 1);
    for (const region of REGIONS.filter((r) => r !== 'Nearctic')) {
      expect(Math.abs(counts[region] - expected) / expected).toBeLessThan(0.06);
    }
  });

  it('respects weights and active flags', () => {
    const config = configWith({ iucn: { EX: { weight: 0 }, EW: { active: false } } });
    const current = spin({ seed: 'base', config });
    for (const seed of seeds(2000, 'veto-weights')) {
      const next = vetoRespin({ seed, current, target: 'iucn', config });
      expect(['EX', 'EW']).not.toContain(next.iucn);
    }
  });

  it('throws when the ring has no other option', () => {
    const config = configWith({ iucn: Object.fromEntries(IUCN_STATUS.filter((i) => i !== 'LC').map((i) => [i, { active: false }])) });
    const current = { region: 'Nearctic' as Region, taxon: 'Aves' as Taxon, iucn: 'LC' as const };
    expect(() => vetoRespin({ seed: 'x', current, target: 'iucn', config })).toThrowError(/no other option/);
  });

  it('keeps a mercy result marked as mercy unless the taxon ring itself is re-spun', () => {
    const mercy = plantaeMercy({ current: spin({ seed: 'base' }), region: 'Oceanic' });

    const regionVeto = vetoRespin({ seed: 'v1', current: mercy, target: 'region' });
    expect(regionVeto.taxon).toBe('Plantae');
    expect(regionVeto.plantaeMercy).toBe(true);
    expect(regionVeto.flags).toEqual(['veto_respin', 'veto_respin_region', 'plantae_mercy']);

    const taxonVeto = vetoRespin({ seed: 'v2', current: mercy, target: 'taxon' });
    expect(taxonVeto.taxon).not.toBe('Plantae');
    expect(taxonVeto.plantaeMercy).toBe(false);
    expect(taxonVeto.flags).toEqual(['veto_respin', 'veto_respin_taxon']);
  });
});

describe('Plantae Mercy', () => {
  it('sets Plantae with the chosen region, keeps the IUCN status, and is flagged as mercy, not veto', () => {
    for (const seed of seeds(200, 'mercy')) {
      const current = spin({ seed: `${seed}-base` });
      for (const region of REGIONS) {
        const next = plantaeMercy({ current, region });
        expect(next.region).toBe(region);
        expect(next.taxon).toBe('Plantae');
        expect(next.iucn).toBe(current.iucn);
        expect(next.plantaeMercy).toBe(true);
        expect(next.vetoUsed).toBe(false);
        expect(next.flags).toEqual(['plantae_mercy', 'wildcard_iucn']);
      }
    }
  });

  it('involves no randomness, so it carries no seed', () => {
    const current = spin({ seed: 'base' });
    expect(plantaeMercy({ current, region: 'Oceanic' }).seed).toBe('');
    expect(plantaeMercy({ current, region: 'Oceanic' })).toEqual(plantaeMercy({ current, region: 'Oceanic' }));
  });

  it('with no result yet records LC, exactly as the app did before consolidation (decision D6)', () => {
    // This pins the long-standing behavior. Changing it needs teacher approval.
    for (const region of REGIONS) {
      expect(plantaeMercy({ current: null, region })).toEqual({
        region,
        taxon: 'Plantae',
        iucn: 'LC',
        seed: '',
        flags: ['plantae_mercy', 'wildcard_iucn'],
        plantaeMercy: true,
        vetoUsed: false,
      });
    }
  });
});

describe('shuffle (random queue order)', () => {
  it('returns a permutation, leaves the input alone, and is reproducible', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffle(input, createRng('q'));
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...out].sort()).toEqual(input);
    expect(shuffle(input, createRng('q'))).toEqual(out);
  });

  it('gives every student an equal chance at every position', () => {
    const input = ['a', 'b', 'c', 'd'];
    const n = 24000;
    const firstPlace: Record<string, number> = {};
    const lastPlace: Record<string, number> = {};
    for (const seed of seeds(n, 'shuffle')) {
      const out = shuffle(input, createRng(seed));
      firstPlace[out[0]] = (firstPlace[out[0]] ?? 0) + 1;
      lastPlace[out[3]] = (lastPlace[out[3]] ?? 0) + 1;
    }
    for (const item of input) {
      expect(Math.abs(firstPlace[item] - n / 4) / (n / 4)).toBeLessThan(0.05);
      expect(Math.abs(lastPlace[item] - n / 4) / (n / 4)).toBeLessThan(0.05);
    }
  });
});

const GOLDEN = [
  { region: 'Neotropical', taxon: 'Amphibia', iucn: 'NT' },
  { region: 'Nearctic', taxon: 'Reptilia', iucn: 'VU' },
  { region: 'Afrotropical', taxon: 'Amphibia', iucn: 'EN' },
];
