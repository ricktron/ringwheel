import type { SpinQueueItem, SpinsLogPayload } from '../types';
import type { SpinOutcome } from './spin-engine';

/** Flag that marks a SpinsLog row as produced by the in-app auto test harness. */
export const AUTO_TEST_FLAG = 'auto_test_run';

export interface SpinLogInput {
  outcome: SpinOutcome;
  timestamp: Date;
  sessionId: string;
  /** The student the spin belongs to, or null for a spin with nobody selected. */
  student: Pick<SpinQueueItem, 'name' | 'email' | 'period'> | null;
  isTest: boolean;
}

/**
 * Build the exact row written to the SpinsLog sheet.
 * The seed is the one that produced the outcome, never a fresh one.
 * Test rows always carry both is_test and the auto test flag.
 */
export function buildSpinLogPayload({ outcome, timestamp, sessionId, student, isTest }: SpinLogInput): SpinsLogPayload {
  const flags = [...outcome.flags];
  if (isTest && !flags.includes(AUTO_TEST_FLAG)) flags.unshift(AUTO_TEST_FLAG);

  return {
    timestamp_iso: timestamp.toISOString(),
    session_id: sessionId,
    period: student?.period ?? '',
    student_name: student?.name ?? '',
    email: student?.email ?? '',
    result_A: outcome.region,
    result_B: outcome.taxon,
    result_C: outcome.iucn,
    plantae_mercy: outcome.plantaeMercy,
    veto_used: outcome.vetoUsed,
    seed: outcome.seed,
    is_test: isTest,
    rule_flags_json: JSON.stringify(flags),
  };
}
