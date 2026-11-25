import { useRef, useState } from 'react';
import { describeError, isApiConfigured } from '../api';
import { useData } from '../data/context';
import { TEST_MODES, runAutoTestCase, type TestMode } from '../utils/auto-test';
import {
  computeAutoTestMetrics,
  computeProjections,
  formatElapsedTime,
  formatInterval,
  type AutoTestMetrics,
} from '../utils/autoTestMetrics';
import { buildSpinLogPayload } from '../utils/spin-log';
import { emptyPairHistory, randomSeed, recordPair, type RingConfig } from '../utils/spin-engine';

type Summary = Record<TestMode, { total: number; errorCount: number }>;

const MAX_ERRORS_PER_MODE = 10;

const emptySummary = (): Summary =>
  Object.fromEntries(TEST_MODES.map((mode) => [mode, { total: 0, errorCount: 0 }])) as Summary;

export interface AutoTestPanelProps {
  config: RingConfig;
  pairCapPct: number;
  sessionId: string;
}

/**
 * In-app smoke check for the spin rules.
 *
 * It uses its own pair history, so test spins never influence real spins.
 * Writing test rows to the sheet is off unless the teacher turns it on, and
 * those rows are always marked is_test. This is a convenience check; the
 * independent test suite is `npm test`.
 *
 * Timing metrics and the cancel control come from the
 * ringwheel-classroom-spinner prototype.
 */
export function AutoTestPanel({ config, pairCapPct, sessionId }: AutoTestPanelProps) {
  const [running, setRunning] = useState(false);
  const [logToSheet, setLogToSheet] = useState(false);
  const [spinsPerMode, setSpinsPerMode] = useState(20);
  const [enabled, setEnabled] = useState<Record<TestMode, boolean>>(
    () => Object.fromEntries(TEST_MODES.map((mode) => [mode, true])) as Record<TestMode, boolean>
  );
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [errors, setErrors] = useState<{ mode: TestMode; message: string }[]>([]);
  const [metrics, setMetrics] = useState<AutoTestMetrics | null>(null);
  const cancelRef = useRef(false);

  const { mode, provider } = useData();
  const canLog = mode === 'local' || isApiConfigured();

  const run = async () => {
    const modes = TEST_MODES.filter((mode) => enabled[mode]);
    const total = modes.length * spinsPerMode;
    const nextSummary = emptySummary();
    const nextErrors: { mode: TestMode; message: string }[] = [];
    const timestamps: number[] = [];
    let history = emptyPairHistory();
    let done = 0;
    let complete = true;

    cancelRef.current = false;
    setRunning(true);
    setSummary(null);
    setErrors([]);
    setMetrics(null);
    setProgress({ done: 0, total });
    const startTime = Date.now();

    const record = (mode: TestMode, message: string) => {
      nextErrors.push({ mode, message });
      nextSummary[mode].errorCount++;
    };

    outer: for (const mode of modes) {
      for (let i = 0; i < spinsPerMode; i++) {
        if (cancelRef.current) {
          complete = false;
          break outer;
        }
        if (nextSummary[mode].errorCount >= MAX_ERRORS_PER_MODE) {
          record(mode, `Stopped this mode after ${MAX_ERRORS_PER_MODE} errors.`);
          break;
        }

        try {
          const testCase = runAutoTestCase({ mode, seed: randomSeed(), config, history, pairCapPct });
          history = recordPair(history, testCase.base.region, testCase.base.taxon);
          for (const message of testCase.errors) record(mode, message);

          if (logToSheet && canLog) {
            await provider.logSpin(
              buildSpinLogPayload({
                outcome: testCase.outcome,
                timestamp: new Date(),
                sessionId,
                student: null,
                isTest: true,
              })
            );
          }
        } catch (err) {
          record(mode, describeError(err));
        }

        nextSummary[mode].total++;
        done++;
        timestamps.push(Date.now());
        setProgress({ done, total });
        // Yield so the progress display and the cancel button stay responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    setMetrics(computeAutoTestMetrics(startTime, Date.now(), timestamps, done, complete));
    setSummary(nextSummary);
    setErrors(nextErrors);
    setProgress(null);
    setRunning(false);
  };

  return (
    <section className="panel" aria-labelledby="autotest-heading" data-testid="auto-test-panel">
      <h2 id="autotest-heading" className="text-xl font-bold text-sun">
        Auto test harness
      </h2>
      <p className="mt-1 text-sm text-ink-dim">
        Runs the spin rules many times and checks them. Test spins never affect real spins.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Spins per mode</span>
          <input
            type="number"
            className="field w-24"
            min={1}
            max={500}
            value={spinsPerMode}
            disabled={running}
            onChange={(e) => setSpinsPerMode(Math.max(1, Math.min(500, Number.parseInt(e.target.value, 10) || 20)))}
          />
        </label>
        {running ? (
          <button type="button" className="btn btn-danger" onClick={() => (cancelRef.current = true)}>
            Cancel ({progress?.done ?? 0} / {progress?.total ?? 0})
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={run}>
            Run auto test
          </button>
        )}
      </div>

      <fieldset className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm" disabled={running}>
        <legend className="eyebrow mb-1">Modes</legend>
        {TEST_MODES.map((mode) => (
          <label key={mode} className="flex items-center gap-1 capitalize">
            <input
              type="checkbox"
              checked={enabled[mode]}
              onChange={(e) => setEnabled((prev) => ({ ...prev, [mode]: e.target.checked }))}
            />
            {mode.replace('_', ' ')}
          </label>
        ))}
      </fieldset>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={logToSheet && canLog}
          disabled={running || !canLog}
          onChange={(e) => setLogToSheet(e.target.checked)}
        />
        Also write test rows to the log (marked as test)
      </label>

      {summary && (
        <table className="mt-4 w-full text-sm" data-testid="auto-test-summary">
          <thead className="text-left text-ink-dim">
            <tr>
              <th scope="col">Mode</th>
              <th scope="col">Spins</th>
              <th scope="col">Errors</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {TEST_MODES.filter((mode) => enabled[mode]).map((mode) => (
              <tr key={mode} className="border-t border-line">
                <td className="capitalize">{mode.replace('_', ' ')}</td>
                <td>{summary[mode].total}</td>
                <td>{summary[mode].errorCount}</td>
                <td className={summary[mode].errorCount === 0 ? 'text-good' : 'text-bad font-bold'}>
                  {summary[mode].errorCount === 0 ? 'OK' : 'FAIL'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {metrics && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4" data-testid="auto-test-metrics">
          <div>
            <dt className="eyebrow">{metrics.isComplete ? 'Total time' : 'Time (canceled)'}</dt>
            <dd>{formatElapsedTime(metrics.totalElapsedMs)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Median interval</dt>
            <dd>{formatInterval(metrics.medianIntervalMs)}s</dd>
          </div>
          <div>
            <dt className="eyebrow">Spins per second</dt>
            <dd>{metrics.spinsPerSecond.toFixed(1)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Projected</dt>
            <dd>
              {computeProjections(metrics.medianIntervalMs)
                .map((p) => `${p.targetSpins}: ${p.estimatedTotal}`)
                .join(', ')}
            </dd>
          </div>
        </dl>
      )}

      {errors.length > 0 && (
        <ul className="mt-3 max-h-40 list-disc overflow-auto pl-6 text-sm text-bad" data-testid="auto-test-errors">
          {errors.map((err, idx) => (
            <li key={idx}>
              <strong>{err.mode}:</strong> {err.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
