import type { RingName, RingSlice } from '../types';
import { DEFAULT_RING_CONFIG, RING_KEYS, type RingConfig, type RingKey, type RingOption } from './spin-engine';

export const RING_NAME_TO_KEY: Record<RingName, RingKey> = { A: 'region', B: 'taxon', C: 'iucn' };
export const RING_KEY_TO_NAME: Record<RingKey, RingName> = { region: 'A', taxon: 'B', iucn: 'C' };

/** Default slice colors, matching schema/Rings.csv. */
export const RING_COLORS: Record<RingName, string> = {
  A: '#4f46e5',
  B: '#16a34a',
  C: '#eab308',
};

export interface RingSetup {
  config: RingConfig;
  /** True when the sheet actually changes the odds (a weight other than 1, or an inactive slice). */
  weighted: boolean;
  warnings: string[];
}

/**
 * Build the engine configuration.
 *
 * The canonical Region, Taxon and IUCN labels always define what is on the
 * wheel. When `applyWeights` is on, matching rows from the Rings sheet supply
 * each label's weight and active flag. With it off (the default) every label
 * has equal weight and the sheet has no effect on the odds.
 */
export function buildRingConfig(rows: RingSlice[] | null, applyWeights: boolean): RingSetup {
  if (!applyWeights || !rows || rows.length === 0) {
    return { config: DEFAULT_RING_CONFIG, weighted: false, warnings: [] };
  }

  const warnings: string[] = [];
  let weighted = false;
  let matched = 0;

  const overlay = <T extends string>(ring: RingKey, defaults: RingOption<T>[]): RingOption<T>[] =>
    defaults.map((option) => {
      const row = rows.find((r) => RING_NAME_TO_KEY[r.ring_name] === ring && r.label === option.label);
      if (!row) return option;
      matched++;
      let weight = row.weight;
      if (!Number.isFinite(weight) || weight < 0) {
        warnings.push(`Rings sheet: "${option.label}" has an invalid weight. Using 1.`);
        weight = 1;
      }
      if (weight !== 1 || !row.active) weighted = true;
      return { label: option.label, weight, active: row.active };
    });

  const config: RingConfig = {
    region: overlay('region', DEFAULT_RING_CONFIG.region),
    taxon: overlay('taxon', DEFAULT_RING_CONFIG.taxon),
    iucn: overlay('iucn', DEFAULT_RING_CONFIG.iucn),
  };

  const unmatched = rows.length - matched;
  if (unmatched > 0) {
    warnings.push(
      `Rings sheet: ${unmatched} row${unmatched === 1 ? '' : 's'} did not match a known Region, Taxon or IUCN label and ${unmatched === 1 ? 'was' : 'were'} ignored.`
    );
  }

  return { config, weighted, warnings };
}

export type RingWeights = Record<RingKey, Record<string, number>>;

/** Weights for the admin editor: sheet value where present, otherwise 1. */
export function ringWeightsFromRows(rows: RingSlice[]): RingWeights {
  const weights = {} as RingWeights;
  for (const ring of RING_KEYS) {
    weights[ring] = {};
    for (const option of DEFAULT_RING_CONFIG[ring]) {
      const row = rows.find((r) => RING_NAME_TO_KEY[r.ring_name] === ring && r.label === option.label);
      weights[ring][option.label] = row && Number.isFinite(row.weight) ? row.weight : 1;
    }
  }
  return weights;
}

/** Problems that must block a save because they would make spinning impossible. */
export function validateRingWeights(weights: RingWeights, existing: RingSlice[]): string[] {
  const problems: string[] = [];
  for (const ring of RING_KEYS) {
    let usable = 0;
    for (const option of DEFAULT_RING_CONFIG[ring]) {
      const weight = weights[ring][option.label];
      if (!Number.isFinite(weight) || weight < 0) {
        problems.push(`${option.label}: weight must be a number that is 0 or more.`);
        continue;
      }
      const row = existing.find((r) => RING_NAME_TO_KEY[r.ring_name] === ring && r.label === option.label);
      const active = row ? row.active : true;
      if (weight > 0 && active && !(ring === 'taxon' && option.label === 'Plantae')) usable++;
    }
    if (usable === 0) {
      problems.push(`The ${ring} ring would have no option left to land on. Give at least one option a weight above 0.`);
    }
  }
  return problems;
}

/**
 * Produce the rows to write back to the Rings sheet.
 *
 * Existing rows are the starting point. Only the weight of matching rows is
 * changed: colors, order, active flags, extra columns and rows the editor does
 * not know about are preserved. Labels missing from the sheet are appended.
 */
export function mergeRingWeights(existing: RingSlice[], weights: RingWeights): RingSlice[] {
  const rows = existing.map((r) => ({ ...r }));
  let nextOrder = rows.reduce((max, r) => (Number.isFinite(r.order_index) ? Math.max(max, r.order_index) : max), -1) + 1;

  for (const ring of RING_KEYS) {
    const ringName = RING_KEY_TO_NAME[ring];
    for (const option of DEFAULT_RING_CONFIG[ring]) {
      const weight = weights[ring][option.label];
      const matches = rows.filter((r) => r.ring_name === ringName && r.label === option.label);
      if (matches.length > 0) {
        for (const row of matches) row.weight = weight;
      } else {
        rows.push({
          ring_name: ringName,
          label: option.label,
          color_hex: RING_COLORS[ringName],
          weight,
          order_index: nextOrder++,
          active: true,
        });
      }
    }
  }

  return rows;
}
