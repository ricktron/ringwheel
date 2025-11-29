// Core types for the ringwheel application

// Legacy types for backward compatibility
export type Region = 'Palearctic' | 'Nearctic' | 'Neotropical' | 'Afrotropical' | 'Indomalayan' | 'Australasian' | 'Antarctic' | 'Oceanic';
export type Taxon = 'Mammalia' | 'Aves' | 'Reptilia' | 'Amphibia' | 'Actinopterygii' | 'Chondrichthyes' | 'Insecta' | 'Arachnida' | 'Plantae' | 'Fungi';
export type IUCN = 'LC' | 'NT' | 'VU' | 'EN' | 'CR' | 'EW' | 'EX';

// New API contract types (M1-M8)
export type RingName = 'A' | 'B' | 'C';

export interface RingSlice {
  ring_name: RingName;
  label: string;
  color_hex: string;
  weight: number;
  order_index: number;
  active: boolean;
}

export interface SettingRow {
  key: string;
  value: string;
  notes?: string;
}

export interface SpinResultNew {
  A: string;
  B: string;
  C: string;
  seed: string;
  flags: string[];
  plantae_mercy: boolean;
  veto_used: boolean;
  is_test: boolean;
}

export interface RosterStudent {
  email: string;
  first: string;
  last: string;
  class: string;
  s1Period: string | null;
  s2Period: string | null;
}

export interface SpinQueueItem {
  email: string;
  name: string;
  period: string;
  hasSpun: boolean;
}

export interface SpinLogRow {
  timestamp_iso: string;
  student_name: string;
  email: string;
  period: string;
  result_region: string;
  result_taxon: string;
  result_iucn: string;
  plantae_mercy: boolean;
  veto_used: boolean;
  rule_flags: string[];
}

export interface SpinsLogPayload {
  timestamp_iso: string;
  session_id: string;
  period: string;
  student_name: string;
  email: string;
  result_A: string;
  result_B: string;
  result_C: string;
  plantae_mercy: boolean;
  veto_used: boolean;
  seed: string;
  is_test: boolean;
  rule_flags_json: string;
}

// Legacy SpinResult for backward compatibility with existing UI
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
