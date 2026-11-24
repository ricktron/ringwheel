import type { SettingRow, Settings } from '../types';
import { DEFAULT_PAIR_CAP_PCT, normalizePairCapPct } from './spin-engine';

export const DEFAULT_SETTINGS: Settings = {
  enableAudio: true,
  enableConfetti: true,
  enablePlantaeMercy: true,
  pairCapPercent: DEFAULT_PAIR_CAP_PCT,
  tickerSpeed: 100,
  enableTestHarness: false,
  applyRingWeights: false,
  usePairCapSetting: false,
};

/**
 * The pair cap spins actually use.
 *
 * The app has always capped pairs at a fixed 12% and ignored the value in the
 * Settings sheet. Honoring the sheet value changes which results can come up,
 * so it stays off until the teacher turns on `usePairCapSetting`.
 */
export function effectivePairCapPct(settings: Settings): number {
  return settings.usePairCapSetting ? settings.pairCapPercent : DEFAULT_PAIR_CAP_PCT;
}

/** The documented sheet key for the pair cap, plus the legacy key the admin page used to write. */
const PAIR_CAP_KEYS = ['midterm_pair_cap_pct', 'pairCapPercent'] as const;

const BOOLEAN_KEYS = [
  'enableAudio',
  'enableConfetti',
  'enablePlantaeMercy',
  'enableTestHarness',
  'applyRingWeights',
  'usePairCapSetting',
] as const;

const TICKER_MIN = 50;
const TICKER_MAX = 500;

function parseBoolean(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return null;
}

/**
 * Turn Settings sheet rows into the typed settings the UI uses.
 * Unknown keys are ignored. Bad values fall back to the default and produce a
 * warning so a typo in the sheet is visible instead of silently changing behavior.
 */
export function parseSettings(rows: SettingRow[]): { settings: Settings; warnings: string[] } {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  for (const key of BOOLEAN_KEYS) {
    const raw = byKey.get(key);
    if (raw === undefined || raw === '') continue;
    const parsed = parseBoolean(raw);
    if (parsed === null) {
      warnings.push(`Setting "${key}" has the value "${raw}", which is not true or false. Using ${DEFAULT_SETTINGS[key]}.`);
    } else {
      settings[key] = parsed;
    }
  }

  const capKey = PAIR_CAP_KEYS.find((k) => byKey.get(k) !== undefined && byKey.get(k) !== '');
  if (capKey) {
    const cap = normalizePairCapPct(byKey.get(capKey));
    settings.pairCapPercent = cap.value;
    // Only worth a warning when the value is actually in use.
    if (!cap.valid && settings.usePairCapSetting) {
      warnings.push(
        `Setting "${capKey}" has the value "${byKey.get(capKey)}". The pair cap must be above 0 and at most 100. Using ${DEFAULT_PAIR_CAP_PCT}.`
      );
    }
  }

  const tickerRaw = byKey.get('tickerSpeed');
  if (tickerRaw !== undefined && tickerRaw !== '') {
    const ticker = Number.parseInt(tickerRaw, 10);
    if (Number.isFinite(ticker) && ticker >= TICKER_MIN && ticker <= TICKER_MAX) {
      settings.tickerSpeed = ticker;
    } else {
      warnings.push(
        `Setting "tickerSpeed" has the value "${tickerRaw}". It must be between ${TICKER_MIN} and ${TICKER_MAX}. Using ${DEFAULT_SETTINGS.tickerSpeed}.`
      );
    }
  }

  return { settings, warnings };
}

/**
 * Produce the rows to write back to the Settings sheet.
 *
 * The existing rows are the starting point: unknown keys, notes, extra columns
 * and row order are all preserved. Only values the admin page owns are changed.
 * A key that is missing from the sheet is appended only when it differs from
 * the built-in default.
 */
export function mergeSettingsRows(existing: SettingRow[], settings: Settings): SettingRow[] {
  const rows = existing.map((r) => ({ ...r }));

  const set = (key: string, value: string, isDefault: boolean) => {
    const matches = rows.filter((r) => r.key === key);
    if (matches.length > 0) {
      for (const row of matches) row.value = value;
    } else if (!isDefault) {
      rows.push({ key, value, notes: '' });
    }
  };

  for (const key of BOOLEAN_KEYS) {
    set(key, String(settings[key]), settings[key] === DEFAULT_SETTINGS[key]);
  }
  set('tickerSpeed', String(settings.tickerSpeed), settings.tickerSpeed === DEFAULT_SETTINGS.tickerSpeed);

  // Keep every pair cap key that already exists in step. If none exists, use the documented key.
  const capValue = String(settings.pairCapPercent);
  const presentCapKeys = PAIR_CAP_KEYS.filter((k) => rows.some((r) => r.key === k));
  if (presentCapKeys.length > 0) {
    for (const key of presentCapKeys) set(key, capValue, false);
  } else {
    set(PAIR_CAP_KEYS[0], capValue, settings.pairCapPercent === DEFAULT_SETTINGS.pairCapPercent);
  }

  return rows;
}
