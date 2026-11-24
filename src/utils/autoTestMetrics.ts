/**
 * Timing metrics for the in-app auto test harness.
 * Ported from the ringwheel-classroom-spinner prototype (median corrected for
 * even-length samples).
 */

export interface AutoTestMetrics {
  totalSpins: number;
  totalElapsedMs: number;
  avgIntervalMs: number;
  medianIntervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  spinsPerSecond: number;
  isComplete: boolean;
}

export interface TestRunProjection {
  targetSpins: number;
  /** Estimated duration as m:ss. */
  estimatedTotal: string;
}

export function computeAutoTestMetrics(
  startTime: number,
  endTime: number,
  timestamps: number[],
  totalSpins: number,
  isComplete = true
): AutoTestMetrics {
  const totalElapsedMs = Math.max(0, endTime - startTime);

  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    totalSpins,
    totalElapsedMs,
    avgIntervalMs: intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0,
    medianIntervalMs: median,
    minIntervalMs: intervals.length > 0 ? Math.min(...intervals) : 0,
    maxIntervalMs: intervals.length > 0 ? Math.max(...intervals) : 0,
    spinsPerSecond: totalElapsedMs > 0 ? totalSpins / (totalElapsedMs / 1000) : 0,
    isComplete,
  };
}

export function computeProjections(medianIntervalMs: number, targets: number[] = [100, 200]): TestRunProjection[] {
  return targets.map((targetSpins) => {
    const totalSeconds = Math.floor((medianIntervalMs * targetSpins) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return { targetSpins, estimatedTotal: `${minutes}:${seconds.toString().padStart(2, '0')}` };
  });
}

export function formatElapsedTime(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatInterval(ms: number): string {
  return (ms / 1000).toFixed(3);
}
