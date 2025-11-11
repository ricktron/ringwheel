// Core types for the ringwheel application
export type Region = 'Palearctic' | 'Nearctic' | 'Neotropical' | 'Afrotropical' | 'Indomalayan' | 'Australasian' | 'Antarctic' | 'Oceanic';
export type Taxon = 'Mammalia' | 'Aves' | 'Reptilia' | 'Amphibia' | 'Actinopterygii' | 'Chondrichthyes' | 'Insecta' | 'Arachnida' | 'Plantae' | 'Fungi';
export type IUCN = 'LC' | 'NT' | 'VU' | 'EN' | 'CR' | 'EW' | 'EX';

export interface SpinResult {
  region: Region;
  taxon: Taxon;
  iucn: IUCN;
  timestamp: number;
  wasVetoed?: boolean;
  plantaeMercyApplied?: boolean;
  manualRegion?: Region;
}

export interface RosterEntry {
  id: string;
  name: string;
  region?: Region;
  taxon?: Taxon;
  iucn?: IUCN;
  timestamp?: number;
}

export interface RingWeights {
  regions: Record<Region, number>;
  taxa: Record<Taxon, number>;
  iucn: Record<IUCN, number>;
}

export interface Settings {
  enableAudio: boolean;
  enableConfetti: boolean;
  enablePlantaeMercy: boolean;
  pairCapPercent: number; // default 12%
  tickerSpeed: number; // ms per tick
}

export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
