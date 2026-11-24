import type { SpinOutcome } from '../utils/spin-engine';

export type LogStatus = 'pending' | 'logged' | 'failed' | 'local_only';

export interface LogStatusBadgeProps {
  status: LogStatus;
  /** Reason shown with a failed status. */
  error?: string;
}

const STATUS_TEXT: Record<LogStatus, string> = {
  pending: 'Saving to the log…',
  logged: 'Saved to the log',
  failed: 'NOT SAVED to the log',
  local_only: 'NOT SAVED: backend not configured',
};

const STATUS_STYLE: Record<LogStatus, string> = {
  pending: 'border-line text-ink-dim',
  logged: 'border-good text-good',
  failed: 'border-bad bg-bad/15 text-bad',
  local_only: 'border-sun bg-sun/10 text-sun',
};

/** Says, in words and not only color, whether a spin reached the SpinsLog sheet. */
export function LogStatusBadge({ status, error }: LogStatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-bold ${STATUS_STYLE[status]}`}
      data-testid="log-status"
      data-status={status}
      title={error}
    >
      <span aria-hidden="true">{status === 'logged' ? '✓' : status === 'pending' ? '…' : '!'}</span>
      {STATUS_TEXT[status]}
    </span>
  );
}

export interface ResultPanelProps {
  outcome: SpinOutcome | null;
  studentName: string | null;
  spinning: boolean;
  logStatus: LogStatus | null;
  logError?: string;
  onRetryLog?: () => void;
}

/**
 * The large readout the class looks at.
 * Adapted from the ResultPanel in the ringwheel-classroom-spinner prototype.
 */
export function ResultPanel({ outcome, studentName, spinning, logStatus, logError, onRetryLog }: ResultPanelProps) {
  return (
    <section className="panel" aria-labelledby="result-heading">
      <h2 id="result-heading" className="text-3xl font-extrabold text-sun mb-4">
        Result
      </h2>

      <div aria-live="polite" aria-atomic="true">
        {spinning ? (
          <p className="text-2xl text-ink-dim" data-testid="result-spinning">
            Spinning…
          </p>
        ) : !outcome ? (
          <p className="text-xl text-ink-dim" data-testid="result-empty">
            No spin yet. Press SPIN to begin.
          </p>
        ) : (
          <div className="result-pop space-y-3" key={`${outcome.seed}-${outcome.flags.join('|')}`} data-testid="result-ready">
            <div className="rounded-xl bg-panel-raised/60 p-4">
              <p className="eyebrow">Student</p>
              <p className="text-3xl font-extrabold break-words" data-testid="result-student">
                {studentName ?? 'No student selected'}
              </p>
            </div>
            {(
              [
                ['Region', outcome.region, 'result-region'],
                ['Taxon', outcome.taxon, 'result-taxon'],
                ['IUCN status', outcome.iucn, 'result-iucn'],
              ] as const
            ).map(([label, value, testId]) => (
              <div key={label} className="rounded-xl bg-panel-raised/60 p-4">
                <p className="eyebrow">{label}</p>
                <p className="text-3xl font-extrabold text-ember break-words" data-testid={testId}>
                  {value}
                </p>
              </div>
            ))}

            <div className="flex flex-wrap gap-2 pt-1">
              {outcome.plantaeMercy && (
                <span className="rounded-full bg-leaf px-3 py-1 text-sm font-bold text-stage">Plantae Mercy</span>
              )}
              {outcome.vetoUsed && (
                <span className="rounded-full bg-bad px-3 py-1 text-sm font-bold text-stage">Veto re-spin</span>
              )}
              {outcome.flags.includes('pair_cap_reroll') && (
                <span className="rounded-full border border-line px-3 py-1 text-sm font-bold text-ink-dim">
                  Pair cap re-roll
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {!spinning && outcome && logStatus && (
        <div className="mt-4 space-y-2" role={logStatus === 'failed' || logStatus === 'local_only' ? 'alert' : undefined}>
          <LogStatusBadge status={logStatus} error={logError} />
          {logStatus === 'failed' && (
            <>
              <p className="text-sm text-bad" data-testid="log-error">
                {logError ?? 'The backend did not confirm the spin.'}
              </p>
              <p className="text-sm">The result above still stands. Only the log entry is missing.</p>
              {onRetryLog && (
                <button type="button" className="btn" onClick={onRetryLog}>
                  Retry saving
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
