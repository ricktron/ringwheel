/**
 * Invariant checks behind the in-app auto test harness.
 *
 * These run the real spin engine and verify its outputs. They are a quick
 * in-browser smoke check for the teacher. The independent test suite lives in
 * the *.test.ts files and runs with `npm test`.
 */
import type { Region } from '../types';
import {
  MERCY_TAXON,
  REGIONS,
  RING_KEYS,
  createRng,
  plantaeMercy,
  spin,
  vetoRespin,
  type PairHistory,
  type RingConfig,
  type RingKey,
  type SpinOutcome,
} from './spin-engine';

export type TestMode = 'normal' | 'veto_region' | 'veto_taxon' | 'veto_iucn' | 'mercy';
export const TEST_MODES: TestMode[] = ['normal', 'veto_region', 'veto_taxon', 'veto_iucn', 'mercy'];

const VETO_TARGET: Partial<Record<TestMode, RingKey>> = {
  veto_region: 'region',
  veto_taxon: 'taxon',
  veto_iucn: 'iucn',
};

const VETO_FLAGS = ['veto_respin', 'veto_respin_region', 'veto_respin_taxon', 'veto_respin_iucn'];

export interface AutoTestCase {
  outcome: SpinOutcome;
  /** The normal spin every mode starts from. It is what counts toward the pair history. */
  base: SpinOutcome;
  errors: string[];
}

export interface AutoTestInput {
  mode: TestMode;
  seed: string;
  config: RingConfig;
  history: PairHistory;
  pairCapPct: number;
}

/** Run one test spin in the given mode and check the rules that mode must obey. */
export function runAutoTestCase({ mode, seed, config, history, pairCapPct }: AutoTestInput): AutoTestCase {
  const errors: string[] = [];
  const base = spin({ seed, config, history, pairCapPct });

  if (base.taxon === MERCY_TAXON) errors.push('Normal spin landed on Plantae.');
  if (base.plantaeMercy || base.vetoUsed) errors.push('Normal spin was marked as mercy or veto.');
  for (const flag of [...VETO_FLAGS, 'plantae_mercy', 'wildcard_iucn']) {
    if (base.flags.includes(flag)) errors.push(`Normal spin carried the ${flag} flag.`);
  }

  if (mode === 'normal') {
    return { outcome: base, base, errors };
  }

  if (mode === 'mercy') {
    const pick = Math.floor(createRng(`${seed}:mercy`)() * REGIONS.length);
    const region: Region = REGIONS[pick];
    const outcome = plantaeMercy({ current: base, region });
    if (outcome.taxon !== MERCY_TAXON) errors.push('Mercy did not set the taxon to Plantae.');
    if (outcome.region !== region) errors.push('Mercy did not use the chosen region.');
    if (outcome.iucn !== base.iucn) errors.push('Mercy changed the IUCN status.');
    if (!outcome.plantaeMercy) errors.push('Mercy result was not marked as mercy.');
    if (outcome.vetoUsed) errors.push('Mercy result was marked as a veto.');
    for (const flag of ['plantae_mercy', 'wildcard_iucn']) {
      if (!outcome.flags.includes(flag)) errors.push(`Mercy result is missing the ${flag} flag.`);
    }
    for (const flag of VETO_FLAGS) {
      if (outcome.flags.includes(flag)) errors.push(`Mercy result carried the ${flag} flag.`);
    }
    return { outcome, base, errors };
  }

  const target = VETO_TARGET[mode] as RingKey;
  const outcome = vetoRespin({ seed: `${seed}:veto`, current: base, target, config });
  for (const ring of RING_KEYS) {
    if (ring === target && outcome[ring] === base[ring]) errors.push(`Veto did not change the ${ring} ring.`);
    if (ring !== target && outcome[ring] !== base[ring]) errors.push(`Veto on ${target} also changed the ${ring} ring.`);
  }
  if (outcome.taxon === MERCY_TAXON) errors.push('Veto landed on Plantae.');
  if (!outcome.vetoUsed) errors.push('Veto result was not marked as a veto.');
  for (const flag of ['veto_respin', `veto_respin_${target}`]) {
    if (!outcome.flags.includes(flag)) errors.push(`Veto result is missing the ${flag} flag.`);
  }
  for (const flag of ['plantae_mercy', 'wildcard_iucn']) {
    if (outcome.flags.includes(flag)) errors.push(`Veto result carried the ${flag} flag.`);
  }
  return { outcome, base, errors };
}
