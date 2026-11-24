import { describe, expect, it } from 'vitest';
import { TEST_MODES, runAutoTestCase } from './auto-test';
import { computeAutoTestMetrics, computeProjections, formatElapsedTime, formatInterval } from './autoTestMetrics';
import { DEFAULT_RING_CONFIG, emptyPairHistory, recordPair } from './spin-engine';
import { FULL_TURNS, layoutSlices, nextRotation } from './wheel-geometry';

describe('auto test timing metrics (ported from the prototype)', () => {
  it('computes elapsed time, intervals and rate', () => {
    const m = computeAutoTestMetrics(1000, 2000, [1100, 1300, 1600, 2000], 4);
    expect(m.totalElapsedMs).toBe(1000);
    expect(m.avgIntervalMs).toBeCloseTo(300);
    expect(m.medianIntervalMs).toBe(300);
    expect(m.minIntervalMs).toBe(200);
    expect(m.maxIntervalMs).toBe(400);
    expect(m.spinsPerSecond).toBe(4);
    expect(m.isComplete).toBe(true);
  });

  it('uses the true median for an even number of intervals', () => {
    expect(computeAutoTestMetrics(0, 100, [0, 10, 30], 3).medianIntervalMs).toBe(15);
  });

  it('copes with no spins and with a canceled run', () => {
    const m = computeAutoTestMetrics(500, 500, [], 0, false);
    expect(m).toMatchObject({ totalElapsedMs: 0, avgIntervalMs: 0, medianIntervalMs: 0, minIntervalMs: 0, maxIntervalMs: 0, spinsPerSecond: 0, isComplete: false });
  });

  it('projects longer runs and formats times', () => {
    expect(computeProjections(650)).toEqual([
      { targetSpins: 100, estimatedTotal: '1:05' },
      { targetSpins: 200, estimatedTotal: '2:10' },
    ]);
    expect(formatElapsedTime(1234)).toBe('1.23s');
    expect(formatInterval(250)).toBe('0.250');
  });
});

describe('in-app auto test cases', () => {
  it('report no errors for the real engine in every mode', () => {
    let history = emptyPairHistory();
    for (const mode of TEST_MODES) {
      for (let i = 0; i < 300; i++) {
        const result = runAutoTestCase({ mode, seed: `${mode}-${i}`, config: DEFAULT_RING_CONFIG, history, pairCapPct: 12 });
        expect(result.errors).toEqual([]);
        history = recordPair(history, result.base.region, result.base.taxon);
      }
    }
  });
});

describe('wheel geometry', () => {
  const mod = (n: number) => ((n % 360) + 360) % 360;

  it('lays equal weights out as equal slices that fill the circle, Plantae included for display', () => {
    const slices = layoutSlices(DEFAULT_RING_CONFIG, 'taxon', undefined);
    expect(slices.map((s) => s.label)).toContain('Plantae');
    expect(slices).toHaveLength(10);
    for (const s of slices) expect(s.sweep).toBeCloseTo(36);
    expect(slices[slices.length - 1].start + slices[slices.length - 1].sweep).toBeCloseTo(360);
  });

  it('sizes slices by weight and leaves out options that cannot be landed on', () => {
    const config = {
      ...DEFAULT_RING_CONFIG,
      region: DEFAULT_RING_CONFIG.region.map((o) =>
        o.label === 'Nearctic' ? { ...o, weight: 3 } : o.label === 'Oceanic' ? { ...o, active: false } : o
      ),
    };
    const slices = layoutSlices(config, 'region', undefined);
    expect(slices.map((s) => s.label)).not.toContain('Oceanic');
    const nearctic = slices.find((s) => s.label === 'Nearctic');
    const other = slices.find((s) => s.label === 'Palearctic');
    expect(nearctic!.sweep / other!.sweep).toBeCloseTo(3);
    // An excluded option is still drawn when it is the result on screen (for example from history).
    expect(layoutSlices(config, 'region', 'Oceanic').map((s) => s.label)).toContain('Oceanic');
  });

  it('always stops with the chosen slice centred under the pointer', () => {
    for (const direction of [1, -1] as const) {
      for (const current of [0, 37.5, 1440, -2890.25, 123456]) {
        for (const center of [0, 18, 90, 199.9, 342]) {
          for (const spinning of [true, false]) {
            const next = nextRotation(current, center, direction, spinning);
            // Rotation plus slice centre is a whole number of turns.
            const landed = mod(next + center);
            expect(Math.min(landed, 360 - landed)).toBeLessThan(1e-6);
            if (spinning) {
              expect(Math.sign(next - current)).toBe(direction);
              expect(Math.abs(next - current)).toBeGreaterThanOrEqual(FULL_TURNS * 360);
              expect(Math.abs(next - current)).toBeLessThan((FULL_TURNS + 1) * 360);
            } else {
              expect(Math.abs(next - current)).toBeLessThanOrEqual(180 + 1e-9);
            }
          }
        }
      }
    }
  });
});
