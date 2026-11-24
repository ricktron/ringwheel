import { describe, expect, it } from 'vitest';
import type { RingSlice } from '../types';
import { buildRingConfig, mergeRingWeights, ringWeightsFromRows, validateRingWeights } from './rings';
import { DEFAULT_RING_CONFIG, IUCN_STATUS, REGIONS, TAXA, eligibleOptions } from './spin-engine';

const slice = (ring_name: 'A' | 'B' | 'C', label: string, weight = 1, active = true, extra: Record<string, unknown> = {}): RingSlice => ({
  ring_name,
  label,
  color_hex: '#123456',
  weight,
  order_index: 0,
  active,
  ...extra,
});

const fullSheet = (): RingSlice[] => [
  ...REGIONS.map((l) => slice('A', l)),
  ...TAXA.map((l) => slice('B', l)),
  ...IUCN_STATUS.map((l) => slice('C', l)),
];

describe('buildRingConfig', () => {
  it('ignores the sheet completely while weights are switched off', () => {
    const rows = fullSheet().map((r) => ({ ...r, weight: 7, active: false }));
    expect(buildRingConfig(rows, false)).toEqual({ config: DEFAULT_RING_CONFIG, weighted: false, warnings: [] });
    expect(buildRingConfig(null, true).config).toBe(DEFAULT_RING_CONFIG);
    expect(buildRingConfig([], true).config).toBe(DEFAULT_RING_CONFIG);
  });

  it('is not reported as weighted when every sheet weight is 1 and active', () => {
    const setup = buildRingConfig(fullSheet(), true);
    expect(setup.weighted).toBe(false);
    expect(setup.config).toEqual(DEFAULT_RING_CONFIG);
    expect(setup.warnings).toEqual([]);
  });

  it('applies weights and active flags when switched on, and says the spin is weighted', () => {
    const rows = fullSheet().map((r) =>
      r.label === 'Nearctic' ? { ...r, weight: 4 } : r.label === 'Fungi' ? { ...r, active: false } : r
    );
    const setup = buildRingConfig(rows, true);
    expect(setup.weighted).toBe(true);
    expect(setup.config.region.find((o) => o.label === 'Nearctic')).toEqual({ label: 'Nearctic', weight: 4, active: true });
    expect(eligibleOptions(setup.config, 'taxon').map((o) => o.label)).not.toContain('Fungi');
  });

  it('keeps the canonical labels and warns about sheet rows it does not recognize', () => {
    const rows = [slice('A', 'Northern', 5), slice('A', 'Nearctic', 2), slice('B', 'Dragons', 9)];
    const setup = buildRingConfig(rows, true);
    expect(setup.config.region.map((o) => o.label)).toEqual(REGIONS);
    expect(setup.config.taxon.map((o) => o.label)).toEqual(TAXA);
    expect(setup.warnings.join(' ')).toMatch(/2 rows did not match/);
  });

  it('replaces an invalid weight with 1 and warns', () => {
    const setup = buildRingConfig([slice('C', 'LC', Number.NaN), slice('C', 'NT', -2)], true);
    expect(setup.config.iucn.find((o) => o.label === 'LC')?.weight).toBe(1);
    expect(setup.config.iucn.find((o) => o.label === 'NT')?.weight).toBe(1);
    expect(setup.warnings).toHaveLength(2);
  });
});

describe('admin weight editing', () => {
  it('shows the sheet weight where there is one and 1 otherwise', () => {
    const weights = ringWeightsFromRows([slice('A', 'Nearctic', 2.5)]);
    expect(weights.region.Nearctic).toBe(2.5);
    expect(weights.region.Oceanic).toBe(1);
    expect(Object.keys(weights.taxon)).toEqual(TAXA);
  });

  it('changes only the weight of matching rows and preserves everything else', () => {
    const existing = [
      slice('A', 'Nearctic', 1, false, { color_hex: '#abcdef', order_index: 7, comment: 'teacher column' }),
      slice('A', 'Custom slice', 2, true, { order_index: 8 }),
      ...fullSheet().filter((r) => r.label !== 'Nearctic'),
    ];
    const weights = ringWeightsFromRows(existing);
    weights.region.Nearctic = 5;
    const merged = mergeRingWeights(existing, weights);

    expect(merged).toHaveLength(existing.length);
    expect(merged[0]).toEqual({ ...existing[0], weight: 5 });
    expect(merged[1]).toEqual(existing[1]);
    expect(merged.slice(2)).toEqual(existing.slice(2));
  });

  it('appends canonical labels that the sheet is missing, after the existing rows', () => {
    const existing = [slice('A', 'Nearctic', 1, true, { order_index: 3 })];
    const merged = mergeRingWeights(existing, ringWeightsFromRows(existing));
    expect(merged).toHaveLength(REGIONS.length + TAXA.length + IUCN_STATUS.length);
    expect(merged[0]).toEqual(existing[0]);
    expect(merged[1]).toMatchObject({ ring_name: 'A', label: 'Palearctic', weight: 1, active: true, order_index: 4 });
    expect(new Set(merged.map((r) => `${r.ring_name}:${r.label}`)).size).toBe(merged.length);
  });

  it('does not mutate the rows it was given', () => {
    const existing = fullSheet();
    const snapshot = JSON.parse(JSON.stringify(existing));
    const weights = ringWeightsFromRows(existing);
    weights.iucn.LC = 9;
    mergeRingWeights(existing, weights);
    expect(existing).toEqual(snapshot);
  });

  it('blocks a save that would leave a ring with nothing to land on', () => {
    const existing = fullSheet();
    const ok = ringWeightsFromRows(existing);
    expect(validateRingWeights(ok, existing)).toEqual([]);

    const noRegion = ringWeightsFromRows(existing);
    for (const r of REGIONS) noRegion.region[r] = 0;
    expect(validateRingWeights(noRegion, existing).join(' ')).toMatch(/region ring would have no option/);

    // Plantae alone does not count, because random spins never land on it.
    const onlyPlantae = ringWeightsFromRows(existing);
    for (const t of TAXA) onlyPlantae.taxon[t] = t === 'Plantae' ? 1 : 0;
    expect(validateRingWeights(onlyPlantae, existing).join(' ')).toMatch(/taxon ring would have no option/);

    // A positive weight on an inactive row does not count either.
    const inactive = existing.map((r) => (r.ring_name === 'C' ? { ...r, active: false } : r));
    expect(validateRingWeights(ringWeightsFromRows(inactive), inactive).join(' ')).toMatch(/iucn ring would have no option/);
  });

  it('rejects negative and non-numeric weights', () => {
    const existing = fullSheet();
    const weights = ringWeightsFromRows(existing);
    weights.region.Nearctic = -1;
    weights.iucn.LC = Number.NaN;
    const problems = validateRingWeights(weights, existing);
    expect(problems.join(' ')).toMatch(/Nearctic/);
    expect(problems.join(' ')).toMatch(/LC/);
  });
});
