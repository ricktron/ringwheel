import { describe, expect, it } from 'vitest';
import type { SettingRow } from '../types';
import { DEFAULT_SETTINGS, mergeSettingsRows, parseSettings } from './settings';

const row = (key: string, value: string, notes = ''): SettingRow => ({ key, value, notes });

describe('parseSettings', () => {
  it('uses the defaults for an empty sheet', () => {
    expect(parseSettings([])).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
  });

  it('reads booleans, the pair cap and the tick speed', () => {
    const { settings, warnings } = parseSettings([
      row('enableAudio', 'false'),
      row('enableConfetti', 'FALSE'),
      row('enablePlantaeMercy', 'false'),
      row('applyRingWeights', 'true'),
      row('enableTestHarness', 'yes'),
      row('midterm_pair_cap_pct', '20'),
      row('tickerSpeed', '250'),
      row('mode', 'midterm'),
    ]);
    expect(warnings).toEqual([]);
    expect(settings).toEqual({
      enableAudio: false,
      enableConfetti: false,
      enablePlantaeMercy: false,
      applyRingWeights: true,
      enableTestHarness: true,
      pairCapPercent: 20,
      tickerSpeed: 250,
    });
  });

  it('keeps weights off and the harness hidden unless the sheet says otherwise', () => {
    const { settings } = parseSettings([row('enableAudio', 'true')]);
    expect(settings.applyRingWeights).toBe(false);
    expect(settings.enableTestHarness).toBe(false);
  });

  it('prefers the documented pair cap key over the legacy one', () => {
    expect(parseSettings([row('pairCapPercent', '30'), row('midterm_pair_cap_pct', '15')]).settings.pairCapPercent).toBe(15);
    expect(parseSettings([row('pairCapPercent', '30')]).settings.pairCapPercent).toBe(30);
  });

  it('falls back to the default and warns on values that make no sense', () => {
    const { settings, warnings } = parseSettings([
      row('enableAudio', 'maybe'),
      row('midterm_pair_cap_pct', '0'),
      row('tickerSpeed', '5'),
    ]);
    expect(settings.enableAudio).toBe(DEFAULT_SETTINGS.enableAudio);
    expect(settings.pairCapPercent).toBe(DEFAULT_SETTINGS.pairCapPercent);
    expect(settings.tickerSpeed).toBe(DEFAULT_SETTINGS.tickerSpeed);
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toMatch(/enableAudio/);
    expect(warnings.join(' ')).toMatch(/pair cap must be above 0/);
    expect(warnings.join(' ')).toMatch(/tickerSpeed/);
  });
});

describe('mergeSettingsRows', () => {
  const existing: SettingRow[] = [
    row('midterm_pair_cap_pct', '12', 'Cap for A|B pairs in midterm mode'),
    row('mode', 'midterm', 'midterm or final'),
    row('enableAudio', 'true', 'teacher note'),
    { key: 'custom_key', value: 'keep me', notes: 'not owned by the app', owner: 'someone' },
  ];

  it('changes nothing when the settings match what is already there', () => {
    const { settings } = parseSettings(existing);
    expect(mergeSettingsRows(existing, settings)).toEqual(existing);
  });

  it('keeps unknown rows, notes, extra columns and row order', () => {
    const { settings } = parseSettings(existing);
    const merged = mergeSettingsRows(existing, { ...settings, enableAudio: false, pairCapPercent: 25 });
    expect(merged.map((r) => r.key)).toEqual(['midterm_pair_cap_pct', 'mode', 'enableAudio', 'custom_key']);
    expect(merged[0]).toEqual(row('midterm_pair_cap_pct', '25', 'Cap for A|B pairs in midterm mode'));
    expect(merged[1]).toEqual(existing[1]);
    expect(merged[2]).toEqual(row('enableAudio', 'false', 'teacher note'));
    expect(merged[3]).toEqual(existing[3]);
  });

  it('does not mutate the rows it was given', () => {
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeSettingsRows(existing, { ...DEFAULT_SETTINGS, enableAudio: false, pairCapPercent: 40 });
    expect(existing).toEqual(snapshot);
  });

  it('appends a missing key only when it differs from the default', () => {
    const merged = mergeSettingsRows([], { ...DEFAULT_SETTINGS, applyRingWeights: true });
    expect(merged).toEqual([row('applyRingWeights', 'true')]);
    expect(mergeSettingsRows([], DEFAULT_SETTINGS)).toEqual([]);
  });

  it('writes a new pair cap under the documented key and keeps a legacy key in step', () => {
    expect(mergeSettingsRows([], { ...DEFAULT_SETTINGS, pairCapPercent: 30 })).toEqual([row('midterm_pair_cap_pct', '30')]);
    const both = mergeSettingsRows([row('pairCapPercent', '12'), row('midterm_pair_cap_pct', '12')], {
      ...DEFAULT_SETTINGS,
      pairCapPercent: 18,
    });
    expect(both.map((r) => r.value)).toEqual(['18', '18']);
  });

  it('round-trips: what is saved is what is read back', () => {
    const wanted = { ...DEFAULT_SETTINGS, enableConfetti: false, applyRingWeights: true, pairCapPercent: 33, tickerSpeed: 80 };
    expect(parseSettings(mergeSettingsRows(existing, wanted)).settings).toEqual(wanted);
  });
});
