/**
 * Ringwheel spin engine: the single source of truth for how a spin is decided.
 *
 * Everything here is a pure function of its inputs. Given the same seed, ring
 * configuration and pair history, a spin always produces the same outcome, so
 * the seed written to SpinsLog really does reproduce the logged result.
 *
 * Rules implemented here (keep docs/CONSOLIDATION.md in sync when they change):
 * - Each ring is a weighted pick over its eligible options.
 * - An option is eligible when it is active and has a weight above zero.
 * - Plantae is never eligible for a random pick. It is only reachable through
 *   Plantae Mercy, which is a deliberate teacher action.
 * - Pair cap: a Region|Taxon pair whose share of this session's normal spins is
 *   at or above the cap is not allowed. If the first draw lands on a capped
 *   pair, the pair is redrawn from the allowed pairs and the spin is flagged.
 * - Veto re-spins exactly one ring and always changes that ring's value.
 * - If no legal outcome exists the engine throws. It never falls back to a
 *   fixed answer.
 */
import type { Region, Taxon, IUCN } from '../types';

export const REGIONS: Region[] = [
  'Palearctic', 'Nearctic', 'Neotropical', 'Afrotropical',
  'Indomalayan', 'Australasian', 'Antarctic', 'Oceanic',
];

export const TAXA: Taxon[] = [
  'Mammalia', 'Aves', 'Reptilia', 'Amphibia',
  'Actinopterygii', 'Chondrichthyes', 'Insecta', 'Arachnida',
  'Plantae', 'Fungi',
];

export const IUCN_STATUS: IUCN[] = ['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX'];

/** The taxon that random spins never produce. */
export const MERCY_TAXON: Taxon = 'Plantae';

export const DEFAULT_PAIR_CAP_PCT = 12;

export type RingKey = 'region' | 'taxon' | 'iucn';
export const RING_KEYS: RingKey[] = ['region', 'taxon', 'iucn'];

export interface RingOption<T extends string = string> {
  label: T;
  weight: number;
  active: boolean;
}

export interface RingConfig {
  region: RingOption<Region>[];
  taxon: RingOption<Taxon>[];
  iucn: RingOption<IUCN>[];
}

const equalOptions = <T extends string>(labels: T[]): RingOption<T>[] =>
  labels.map((label) => ({ label, weight: 1, active: true }));

/** Built-in configuration: every canonical label, equal weight. */
export const DEFAULT_RING_CONFIG: RingConfig = {
  region: equalOptions(REGIONS),
  taxon: equalOptions(TAXA),
  iucn: equalOptions(IUCN_STATUS),
};

export interface SpinTriple {
  region: Region;
  taxon: Taxon;
  iucn: IUCN;
}

export interface SpinOutcome extends SpinTriple {
  /** Seed that produced this outcome. */
  seed: string;
  /** Rule flags describing how the outcome was reached. */
  flags: string[];
  plantaeMercy: boolean;
  vetoUsed: boolean;
}

export type SpinErrorCode = 'no_eligible_options' | 'pair_cap_exhausted' | 'no_alternative';

/** Raised when the rules leave no legal outcome. Never swallowed by the engine. */
export class SpinError extends Error {
  readonly code: SpinErrorCode;

  constructor(code: SpinErrorCode, message: string) {
    super(message);
    this.name = 'SpinError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

export type Rng = () => number;

/** Fresh 64-bit seed from the platform CSPRNG, as 16 hex characters. */
export function randomSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** xmur3 string hash, used to turn a seed string into PRNG state. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministic generator (mulberry32) returning floats in [0, 1).
 * The same seed always yields the same sequence.
 */
export function createRng(seed: string): Rng {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Weighted {
  weight: number;
}

function weightedPick<T extends Weighted>(options: T[], rng: Rng): T {
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let remaining = rng() * total;
  for (const option of options) {
    remaining -= option.weight;
    if (remaining < 0) return option;
  }
  // Only reachable through floating point rounding at the very top of the range.
  return options[options.length - 1];
}

/** Fisher-Yates shuffle driven by the supplied generator. Does not mutate. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Options a random pick may land on for a ring: active, weight above zero,
 * and never the mercy taxon.
 */
export function eligibleOptions<K extends RingKey>(config: RingConfig, ring: K): RingConfig[K] {
  const options = config[ring] as RingOption[];
  return options.filter(
    (o) => o.active && Number.isFinite(o.weight) && o.weight > 0 && !(ring === 'taxon' && o.label === MERCY_TAXON)
  ) as RingConfig[K];
}

function requireEligible<K extends RingKey>(config: RingConfig, ring: K): RingConfig[K] {
  const options = eligibleOptions(config, ring);
  if (options.length === 0) {
    throw new SpinError('no_eligible_options', `No active options with a positive weight on the ${ring} ring.`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Pair cap
// ---------------------------------------------------------------------------

/** Region|Taxon counts for the normal spins of one session. */
export interface PairHistory {
  total: number;
  counts: Record<string, number>;
}

export function emptyPairHistory(): PairHistory {
  return { total: 0, counts: {} };
}

export function pairKey(region: string, taxon: string): string {
  return `${region}:${taxon}`;
}

/** Returns a new history with one more spin recorded. Does not mutate. */
export function recordPair(history: PairHistory, region: string, taxon: string): PairHistory {
  const key = pairKey(region, taxon);
  return {
    total: history.total + 1,
    counts: { ...history.counts, [key]: (history.counts[key] ?? 0) + 1 },
  };
}

/**
 * A pair is over the cap when its share of the session's spins so far is at or
 * above the cap. With no spins recorded nothing is capped.
 */
export function isPairOverCap(history: PairHistory, key: string, capPct: number): boolean {
  if (history.total === 0) return false;
  const count = history.counts[key] ?? 0;
  return (count / history.total) * 100 >= capPct;
}

/**
 * Validate a pair cap setting. Anything outside (0, 100] is rejected and the
 * default is used instead, so a bad sheet value can never block every pair.
 */
export function normalizePairCapPct(raw: unknown): { value: number; valid: boolean } {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  if (Number.isFinite(value) && value > 0 && value <= 100) {
    return { value, valid: true };
  }
  return { value: DEFAULT_PAIR_CAP_PCT, valid: false };
}

// ---------------------------------------------------------------------------
// Spins
// ---------------------------------------------------------------------------

export interface SpinInput {
  seed: string;
  config?: RingConfig;
  history?: PairHistory;
  pairCapPct?: number;
}

/** A normal spin across all three rings. */
export function spin({
  seed,
  config = DEFAULT_RING_CONFIG,
  history = emptyPairHistory(),
  pairCapPct = DEFAULT_PAIR_CAP_PCT,
}: SpinInput): SpinOutcome {
  const regions = requireEligible(config, 'region');
  const taxa = requireEligible(config, 'taxon');
  const statuses = requireEligible(config, 'iucn');
  const rng = createRng(seed);
  const flags: string[] = [];

  // Draw order is fixed so a seed always replays the same way.
  let region = weightedPick(regions, rng).label;
  let taxon = weightedPick(taxa, rng).label;
  const iucn = weightedPick(statuses, rng).label;

  if (isPairOverCap(history, pairKey(region, taxon), pairCapPct)) {
    // Redraw from the allowed pairs only. Weighting each pair by the product
    // of its ring weights gives the same distribution as redrawing both rings
    // until an allowed pair comes up, without any retry limit.
    const allowed: { region: Region; taxon: Taxon; weight: number }[] = [];
    for (const r of regions) {
      for (const t of taxa) {
        if (!isPairOverCap(history, pairKey(r.label, t.label), pairCapPct)) {
          allowed.push({ region: r.label, taxon: t.label, weight: r.weight * t.weight });
        }
      }
    }
    if (allowed.length === 0) {
      throw new SpinError(
        'pair_cap_exhausted',
        `The ${pairCapPct}% pair cap leaves no Region and Taxon combination available. Raise the pair cap or allow more options on the Admin page.`
      );
    }
    const redraw = weightedPick(allowed, rng);
    region = redraw.region;
    taxon = redraw.taxon;
    flags.push('pair_cap_reroll');
  }

  return { region, taxon, iucn, seed, flags, plantaeMercy: false, vetoUsed: false };
}

export interface VetoInput {
  seed: string;
  current: SpinTriple & { plantaeMercy?: boolean };
  target: RingKey;
  config?: RingConfig;
}

/**
 * Veto: re-spin exactly one ring. The other two rings are returned unchanged
 * and the target ring always lands on a different value.
 */
export function vetoRespin({ seed, current, target, config = DEFAULT_RING_CONFIG }: VetoInput): SpinOutcome {
  const options = (eligibleOptions(config, target) as RingOption[]).filter((o) => o.label !== current[target]);
  if (options.length === 0) {
    throw new SpinError('no_alternative', `There is no other option to land on for the ${target} ring.`);
  }
  const picked = weightedPick(options, createRng(seed)).label;
  const flags = ['veto_respin', `veto_respin_${target}`];

  // A mercy result stays a mercy result unless the taxon ring itself is re-spun.
  const plantaeMercy = target !== 'taxon' && current.taxon === MERCY_TAXON && current.plantaeMercy === true;
  if (plantaeMercy) flags.push('plantae_mercy');

  return {
    region: current.region,
    taxon: current.taxon,
    iucn: current.iucn,
    [target]: picked,
    seed,
    flags,
    plantaeMercy,
    vetoUsed: true,
  } as SpinOutcome;
}

export interface MercyInput {
  seed: string;
  /** The result on screen, if any. Its IUCN status is kept. */
  current: SpinTriple | null;
  /** Region chosen by the teacher. */
  region: Region;
  config?: RingConfig;
}

/**
 * Plantae Mercy: the teacher assigns Plantae with a chosen region.
 * This is not a veto and does not count toward the pair cap.
 * The IUCN status is kept from the current result. Only when there is no
 * current result is one drawn, using the seed.
 */
export function plantaeMercy({ seed, current, region, config = DEFAULT_RING_CONFIG }: MercyInput): SpinOutcome {
  const iucn = current ? current.iucn : weightedPick(requireEligible(config, 'iucn'), createRng(seed)).label;
  return {
    region,
    taxon: MERCY_TAXON,
    iucn,
    seed,
    flags: ['plantae_mercy', 'wildcard_iucn'],
    plantaeMercy: true,
    vetoUsed: false,
  };
}
