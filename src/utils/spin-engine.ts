import type { Region, Taxon, IUCN, SpinResult, RingWeights } from '../types';
import { CryptoRNG } from './crypto-rng';

// Default ring options
export const REGIONS: Region[] = [
  'Palearctic', 'Nearctic', 'Neotropical', 'Afrotropical',
  'Indomalayan', 'Australasian', 'Antarctic', 'Oceanic'
];

export const TAXA: Taxon[] = [
  'Mammalia', 'Aves', 'Reptilia', 'Amphibia',
  'Actinopterygii', 'Chondrichthyes', 'Insecta', 'Arachnida',
  'Plantae', 'Fungi'
];

export const IUCN_STATUS: IUCN[] = ['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX'];

// Default equal weights
export const DEFAULT_WEIGHTS: RingWeights = {
  regions: Object.fromEntries(REGIONS.map(r => [r, 1])) as Record<Region, number>,
  taxa: Object.fromEntries(TAXA.map(t => [t, 1])) as Record<Taxon, number>,
  iucn: Object.fromEntries(IUCN_STATUS.map(i => [i, 1])) as Record<IUCN, number>,
};

export interface SpinOptions {
  weights?: RingWeights;
  pairCapPercent?: number;
  vetoedPairs?: Set<string>;
  vetoedTriples?: Set<string>;
  enablePlantaeMercy?: boolean;
  manualRegion?: Region;
}

export class SpinEngine {
  private weights: RingWeights;
  private pairCapPercent: number;
  private vetoedPairs: Set<string>;
  private vetoedTriples: Set<string>;
  private spinHistory: SpinResult[] = [];

  constructor(options: SpinOptions = {}) {
    this.weights = options.weights || DEFAULT_WEIGHTS;
    this.pairCapPercent = options.pairCapPercent || 12;
    this.vetoedPairs = options.vetoedPairs || new Set();
    this.vetoedTriples = options.vetoedTriples || new Set();
  }

  /**
   * Perform a single spin across all three rings
   */
  spin(options: { enablePlantaeMercy?: boolean; manualRegion?: Region } = {}): SpinResult {
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      attempts++;

      // Spin each ring
      let region = options.manualRegion || this.spinRing(REGIONS, this.weights.regions);
      let taxon = this.spinRing(TAXA, this.weights.taxa);
      let iucn = this.spinRing(IUCN_STATUS, this.weights.iucn);

      const pairKey = `${region}:${taxon}`;
      const tripleKey = `${region}:${taxon}:${iucn}`;

      // Check pair cap constraint
      if (this.isPairOverCap(pairKey)) {
        continue;
      }

      // Check vetoed pairs
      if (this.vetoedPairs.has(pairKey)) {
        continue;
      }

      // Check exact triple veto
      if (this.vetoedTriples.has(tripleKey)) {
        continue;
      }

      // Apply Plantae Mercy rule
      let plantaeMercyApplied = false;
      if (options.enablePlantaeMercy && taxon === 'Plantae' && ['NT', 'VU', 'EN'].includes(iucn)) {
        // Re-roll IUCN status, avoiding C statuses
        const safeStatuses = IUCN_STATUS.filter(s => !['NT', 'VU', 'EN'].includes(s));
        iucn = safeStatuses[CryptoRNG.getRandomInt(safeStatuses.length)];
        plantaeMercyApplied = true;
      }

      const result: SpinResult = {
        region,
        taxon,
        iucn,
        timestamp: Date.now(),
        plantaeMercyApplied,
        manualRegion: options.manualRegion,
      };

      this.spinHistory.push(result);
      return result;
    }

    // Fallback if all attempts fail (should be rare)
    const fallbackResult: SpinResult = {
      region: REGIONS[0],
      taxon: TAXA[0],
      iucn: 'LC',
      timestamp: Date.now(),
    };
    this.spinHistory.push(fallbackResult);
    return fallbackResult;
  }

  /**
   * Spin a single ring with weighted selection
   */
  private spinRing<T extends Region | Taxon | IUCN>(
    items: T[],
    weights: Record<string, number>
  ): T {
    const itemWeights = items.map(item => weights[item] || 1);
    return CryptoRNG.weightedSelect(items, itemWeights);
  }

  /**
   * Check if a region-taxon pair exceeds the cap percentage
   */
  private isPairOverCap(pairKey: string): boolean {
    if (this.spinHistory.length === 0) return false;

    const pairCount = this.spinHistory.filter(
      s => `${s.region}:${s.taxon}` === pairKey
    ).length;

    const percentage = (pairCount / this.spinHistory.length) * 100;
    return percentage >= this.pairCapPercent;
  }

  /**
   * Veto a spin result (for re-spin functionality)
   */
  vetoSpin(result: SpinResult, vetoType: 'pair' | 'triple' = 'triple') {
    if (vetoType === 'triple') {
      const tripleKey = `${result.region}:${result.taxon}:${result.iucn}`;
      this.vetoedTriples.add(tripleKey);
    } else {
      const pairKey = `${result.region}:${result.taxon}`;
      this.vetoedPairs.add(pairKey);
    }
  }

  /**
   * Clear veto for a specific spin
   */
  clearVeto(result: SpinResult, vetoType: 'pair' | 'triple' = 'triple') {
    if (vetoType === 'triple') {
      const tripleKey = `${result.region}:${result.taxon}:${result.iucn}`;
      this.vetoedTriples.delete(tripleKey);
    } else {
      const pairKey = `${result.region}:${result.taxon}`;
      this.vetoedPairs.delete(pairKey);
    }
  }

  /**
   * Get spin history
   */
  getHistory(): SpinResult[] {
    return [...this.spinHistory];
  }

  /**
   * Clear spin history
   */
  clearHistory() {
    this.spinHistory = [];
  }
}
