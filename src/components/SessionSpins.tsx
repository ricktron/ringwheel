import type { SpinsLogPayload } from '../types';
import { LogStatusBadge, type LogStatus } from './ResultPanel';

export interface SessionSpin {
  id: string;
  payload: SpinsLogPayload;
  /** Local Mode: the roster id of the student this spin belongs to. */
  studentId?: string | null;
  status: LogStatus;
  error?: string;
}

export interface SessionSpinsProps {
  spins: SessionSpin[];
  onRetry: (id: string) => void;
}

/**
 * Spins made since this page was opened, newest first, each with its own
 * save status. Kept in the browser, so it works even when the backend is down.
 * Adapted from RecentSpins in the ringwheel-classroom-spinner prototype.
 */
export function SessionSpins({ spins, onRetry }: SessionSpinsProps) {
  const unsaved = spins.filter((s) => s.status === 'failed' || s.status === 'local_only').length;
  const incomplete = spins.filter((s) => s.status === 'partial').length;

  return (
    <section className="panel" aria-labelledby="session-heading">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h2 id="session-heading" className="text-xl font-bold">
          This session
        </h2>
        <span className="flex gap-3">
          {incomplete > 0 && (
            <span className="text-sm font-bold text-sun" data-testid="incomplete-count">
              {incomplete} incomplete
            </span>
          )}
          {unsaved > 0 && (
            <span className="text-sm font-bold text-bad" data-testid="unsaved-count">
              {unsaved} not saved
            </span>
          )}
        </span>
      </div>

      {spins.length === 0 ? (
        <p className="text-ink-dim">No spins yet.</p>
      ) : (
        <ol className="space-y-2 max-h-80 overflow-y-auto pr-1" data-testid="session-spins">
          {spins.map((spin) => (
            <li key={spin.id} className="rounded-lg border border-line bg-panel-raised/50 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-bold">{spin.payload.student_name || 'No student selected'}</span>
                <time className="text-xs text-ink-dim" dateTime={spin.payload.timestamp_iso}>
                  {new Date(spin.payload.timestamp_iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
              <p className="text-sm text-ink-dim">
                <span className="text-ember font-semibold">{spin.payload.result_A}</span>
                {' · '}
                <span className="text-ember font-semibold">{spin.payload.result_B}</span>
                {' · '}
                <span className="text-ember font-semibold">{spin.payload.result_C}</span>
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <LogStatusBadge status={spin.status} error={spin.error} />
                {spin.status === 'failed' && (
                  <button type="button" className="btn text-sm" onClick={() => onRetry(spin.id)}>
                    Retry
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
