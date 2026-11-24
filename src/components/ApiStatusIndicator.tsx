import { useEffect, useState } from 'react';
import { api, describeError, getApiConfig } from '../api';

type ApiStatus = 'unconfigured' | 'checking' | 'ok' | 'error';

const STYLES: Record<ApiStatus, { className: string; label: string; icon: string }> = {
  unconfigured: { className: 'border-sun text-sun', label: 'Backend: not configured', icon: '!' },
  checking: { className: 'border-line text-ink-dim', label: 'Backend: checking…', icon: '…' },
  ok: { className: 'border-good text-good', label: 'Backend: connected', icon: '✓' },
  error: { className: 'border-bad text-bad', label: 'Backend: error', icon: '✗' },
};

/**
 * Shows whether the backend health check passed.
 * "Connected" means the token was accepted and all four sheet tabs exist.
 */
export const ApiStatusIndicator = () => {
  const configured = getApiConfig().problems.length === 0;
  const [status, setStatus] = useState<ApiStatus>(configured ? 'checking' : 'unconfigured');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    api
      .health()
      .then(() => {
        if (!cancelled) setStatus('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setDetail(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [configured]);

  const style = STYLES[status];

  return (
    <div className="flex flex-col items-end gap-1" data-testid="api-status" data-status={status}>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-bold ${style.className}`}
        role="status"
      >
        <span aria-hidden="true">{style.icon}</span>
        {style.label}
      </span>
      {status === 'error' && detail && <span className="max-w-xs text-right text-xs text-bad">{detail}</span>}
    </div>
  );
};

/**
 * Full-width warning shown when the API cannot be used, listing exactly why.
 */
export const ApiNotConfiguredBanner = () => {
  const { problems } = getApiConfig();
  if (problems.length === 0) return null;

  return (
    <div className="rounded-xl border-2 border-sun bg-sun/10 p-4" role="alert" data-testid="api-not-configured">
      <h2 className="text-lg font-bold text-sun">Spins are NOT being saved</h2>
      <p className="mt-1">The Ringwheel backend is not configured, so this page cannot load the roster or log spins.</p>
      <ul className="mt-2 list-disc pl-6">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-ink-dim">
        Set the connection on the Admin page, or set <code>VITE_SPIN_API_URL</code> and{' '}
        <code>VITE_RINGWHEEL_API_TOKEN</code> in <code>.env.local</code> for local development.
      </p>
    </div>
  );
};
