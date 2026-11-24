import { describe, expect, it } from 'vitest';
import { buildSpinLogPayload } from './spin-log';
import { plantaeMercy, spin, vetoRespin } from './spin-engine';

const timestamp = new Date('2026-11-24T15:30:00.000Z');
const student = { name: 'Ada Sample', email: 'ada.sample@example.com', period: 'A' };
const SHEET_COLUMNS = [
  'timestamp_iso', 'session_id', 'period', 'student_name', 'email', 'result_A', 'result_B', 'result_C',
  'plantae_mercy', 'veto_used', 'seed', 'is_test', 'rule_flags_json',
];

describe('buildSpinLogPayload', () => {
  it('has exactly the SpinsLog columns', () => {
    const payload = buildSpinLogPayload({ outcome: spin({ seed: 'abc' }), timestamp, sessionId: 'sess', student, isTest: false });
    expect(Object.keys(payload).sort()).toEqual([...SHEET_COLUMNS].sort());
  });

  it('records the student, period, session, result and the seed that produced it', () => {
    const outcome = spin({ seed: 'abc' });
    const payload = buildSpinLogPayload({ outcome, timestamp, sessionId: 'sess-1', student, isTest: false });
    expect(payload).toEqual({
      timestamp_iso: '2026-11-24T15:30:00.000Z',
      session_id: 'sess-1',
      period: 'A',
      student_name: 'Ada Sample',
      email: 'ada.sample@example.com',
      result_A: outcome.region,
      result_B: outcome.taxon,
      result_C: outcome.iucn,
      plantae_mercy: false,
      veto_used: false,
      seed: 'abc',
      is_test: false,
      rule_flags_json: '[]',
    });
    // The seed in the row replays to the row's result.
    const replay = spin({ seed: payload.seed });
    expect([replay.region, replay.taxon, replay.iucn]).toEqual([payload.result_A, payload.result_B, payload.result_C]);
  });

  it('leaves student fields empty when nobody is selected', () => {
    const payload = buildSpinLogPayload({ outcome: spin({ seed: 'abc' }), timestamp, sessionId: 's', student: null, isTest: false });
    expect([payload.student_name, payload.email, payload.period]).toEqual(['', '', '']);
  });

  it('marks veto and mercy rows with their flags', () => {
    const base = spin({ seed: 'base' });
    const veto = buildSpinLogPayload({ outcome: vetoRespin({ seed: 'v', current: base, target: 'iucn' }), timestamp, sessionId: 's', student, isTest: false });
    expect(veto.veto_used).toBe(true);
    expect(veto.plantae_mercy).toBe(false);
    expect(JSON.parse(veto.rule_flags_json)).toEqual(['veto_respin', 'veto_respin_iucn']);

    const mercy = buildSpinLogPayload({ outcome: plantaeMercy({ seed: 'm', current: base, region: 'Oceanic' }), timestamp, sessionId: 's', student, isTest: false });
    expect(mercy.veto_used).toBe(false);
    expect(mercy.plantae_mercy).toBe(true);
    expect(mercy.result_B).toBe('Plantae');
    expect(JSON.parse(mercy.rule_flags_json)).toEqual(['plantae_mercy', 'wildcard_iucn']);
  });

  it('keeps test spins distinguishable from real ones in two ways', () => {
    const outcome = spin({ seed: 'abc' });
    const real = buildSpinLogPayload({ outcome, timestamp, sessionId: 's', student, isTest: false });
    const test = buildSpinLogPayload({ outcome, timestamp, sessionId: 's', student: null, isTest: true });
    expect(real.is_test).toBe(false);
    expect(JSON.parse(real.rule_flags_json)).not.toContain('auto_test_run');
    expect(test.is_test).toBe(true);
    expect(JSON.parse(test.rule_flags_json)).toEqual(['auto_test_run']);
    // The engine outcome itself is not altered by logging.
    expect(outcome.flags).toEqual([]);
  });
});
