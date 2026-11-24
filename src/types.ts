// Core types for the Ringwheel application.
// Anything that crosses the network mirrors the Apps Script contract in gas/Code.gs.

export type Region =
  | 'Palearctic'
  | 'Nearctic'
  | 'Neotropical'
  | 'Afrotropical'
  | 'Indomalayan'
  | 'Australasian'
  | 'Antarctic'
  | 'Oceanic';

export type Taxon =
  | 'Mammalia'
  | 'Aves'
  | 'Reptilia'
  | 'Amphibia'
  | 'Actinopterygii'
  | 'Chondrichthyes'
  | 'Insecta'
  | 'Arachnida'
  | 'Plantae'
  | 'Fungi';

export type IUCN = 'LC' | 'NT' | 'VU' | 'EN' | 'CR' | 'EW' | 'EX';

/** Sheet-side ring names. A = Region, B = Taxon, C = IUCN. */
export type RingName = 'A' | 'B' | 'C';

/** One row of the Rings sheet. Extra sheet columns are carried through untouched. */
export interface RingSlice {
  ring_name: RingName;
  label: string;
  color_hex: string;
  weight: number;
  order_index: number;
  active: boolean;
  [extraColumn: string]: unknown;
}

/** One row of the Settings sheet. Values are always normalized to strings. */
export interface SettingRow {
  key: string;
  value: string;
  notes?: string;
  [extraColumn: string]: unknown;
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

/** A row returned by the backend's getSpins query. */
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
  /** True for auto-test rows. Derived from rule flags when the backend omits it. */
  is_test: boolean;
}

/** The exact row shape appended to the SpinsLog sheet. */
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

/** Typed view of the Settings sheet used by the UI. */
export interface Settings {
  enableAudio: boolean;
  enableConfetti: boolean;
  enablePlantaeMercy: boolean;
  /** Region|Taxon pair cap, percent of session spins, as written in the Settings sheet. */
  pairCapPercent: number;
  /**
   * When true, spins use `pairCapPercent`. When false (the default) spins use
   * the fixed 12% the app has always used, whatever the sheet says.
   */
  usePairCapSetting: boolean;
  /** Milliseconds between tick sounds while the wheel spins. */
  tickerSpeed: number;
  /** Show the in-app auto test harness outside of dev builds. */
  enableTestHarness: boolean;
  /** When true, weights and active flags from the Rings sheet affect spins. */
  applyRingWeights: boolean;
}
