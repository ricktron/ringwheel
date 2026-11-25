import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeError, getApiConfig } from '../api';
import { useData } from '../data/context';

type Status = 'unconfigured' | 'checking' | 'ok' | 'error';

const ICONS: Record<Status, string> = { unconfigured: '!', checking: '…', ok: '✓', error: '✗' };
const TONES: Record<Status, string> = {
  unconfigured: 'border-sun text-sun',
  checking: 'border-line text-ink-dim',
  ok: 'border-good text-good',
  error: 'border-bad text-bad',
};

/**
 * Shows whether the storage in charge is working.
 * Connected Mode: the backend health check (token accepted, sheet tabs and columns present).
 * Local Mode: the browser database opened and the class can be read. No request is sent anywhere.
 */
export const ApiStatusIndicator = () => {
  const { mode, provider } = useData();
  const isLocal = mode === 'local';
  const configured = isLocal || getApiConfig().problems.length === 0;
  const [status, setStatus] = useState<Status>(configured ? 'checking' : 'unconfigured');
  const [detail, setDetail] = useState('');
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    provider
      .health()
      .then((health) => {
        if (cancelled) return;
        setStatus('ok');
        setNotes([
          ...(!isLocal && health.contract === null
            ? ['Older backend version: it cannot confirm that every field of a spin was stored.']
            : []),
          ...health.warnings,
        ]);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setDetail(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [configured, isLocal, provider]);

  const subject = isLocal ? 'Browser storage' : 'Backend';
  const label: Record<Status, string> = {
    unconfigured: `${subject}: not configured`,
    checking: `${subject}: checking…`,
    ok: isLocal ? 'Browser storage: working' : 'Backend: connected',
    error: `${subject}: error`,
  };

  return (
    <div className="flex flex-col items-end gap-1" data-testid="api-status" data-status={status} data-mode={mode}>
      <span className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-bold ${TONES[status]}`} role="status">
        <span aria-hidden="true">{ICONS[status]}</span>
        {label[status]}
      </span>
      {status === 'error' && detail && <span className="max-w-xs text-right text-xs text-bad">{detail}</span>}
      {status === 'ok' &&
        notes.map((note) => (
          <span key={note} className="max-w-xs text-right text-xs text-sun" data-testid="api-note">
            {note}
          </span>
        ))}
    </div>
  );
};

/**
 * Warning shown only in Connected Mode when the connection is incomplete.
 * Local Mode needs no configuration, so it never shows this.
 */
export const ApiNotConfiguredBanner = () => {
  const { mode, setMode } = useData();
  const { problems } = getApiConfig();
  if (mode === 'local' || problems.length === 0) return null;

  return (
    <div className="rounded-xl border-2 border-sun bg-sun/10 p-4" role="alert" data-testid="api-not-configured">
      <h2 className="text-lg font-bold text-sun">Spins are NOT being saved</h2>
      <p className="mt-1">Connected Mode is on, but the connection to your Google Sheet is not complete.</p>
      <ul className="mt-2 list-disc pl-6">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to="/admin" className="btn">
          Finish the connection
        </Link>
        <button type="button" className="btn" onClick={() => setMode('local')}>
          Use Local Mode instead
        </button>
      </div>
    </div>
  );
};
