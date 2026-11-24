import { MERCY_TAXON, type RingConfig, type RingKey } from './spin-engine';

/** Full turns a ring makes during a spin before it stops on its slice. */
export const FULL_TURNS = 4;

export interface Slice {
  label: string;
  start: number;
  sweep: number;
  center: number;
}

/** Slices shown for a ring: everything a spin can land on, plus Plantae and the current result. */
export function layoutSlices(config: RingConfig, ring: RingKey, resultLabel: string | undefined): Slice[] {
  const shown = config[ring].filter(
    (o) =>
      (o.active && o.weight > 0) || o.label === resultLabel || (ring === 'taxon' && o.label === MERCY_TAXON)
  );
  const displayWeight = (weight: number) => (Number.isFinite(weight) && weight > 0 ? weight : 1);
  const total = shown.reduce((sum, o) => sum + displayWeight(o.weight), 0);
  let cursor = 0;
  return shown.map((o) => {
    const sweep = (displayWeight(o.weight) / total) * 360;
    const slice = { label: o.label, start: cursor, sweep, center: cursor + sweep / 2 };
    cursor += sweep;
    return slice;
  });
}

/**
 * Next rotation for a ring so that `sliceCenter` ends up under the pointer.
 * When spinning, the ring also travels at least FULL_TURNS full turns in its direction.
 */
export function nextRotation(current: number, sliceCenter: number, direction: 1 | -1, spinning: boolean): number {
  const mod = (n: number) => ((n % 360) + 360) % 360;
  const target = mod(-sliceCenter);
  if (!spinning) {
    // Shortest way round.
    let delta = mod(target - mod(current));
    if (delta > 180) delta -= 360;
    return current + delta;
  }
  const travel = direction === 1 ? mod(target - mod(current)) : -mod(mod(current) - target);
  return current + direction * FULL_TURNS * 360 + travel;
}
