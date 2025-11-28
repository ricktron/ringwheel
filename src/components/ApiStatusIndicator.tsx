import { useState, useEffect } from 'react';
import { api, isApiConfigured } from '../api';

type ApiStatus = 'unconfigured' | 'checking' | 'ok' | 'error';

/**
 * ApiStatusIndicator
 *
 * Displays the current API connection status.
 * - If API is not configured (missing env vars), shows "unconfigured".
 * - On mount, calls api.health() to verify connectivity.
 * - Shows "ok" or "error" based on result.
 */
export const ApiStatusIndicator = () => {
  const [status, setStatus] = useState<ApiStatus>(
    isApiConfigured() ? 'checking' : 'unconfigured'
  );

  useEffect(() => {
    if (!isApiConfigured()) {
      setStatus('unconfigured');
      return;
    }

    api.health()
      .then((res) => {
        if (res.status === 'ok') {
          setStatus('ok');
        } else {
          setStatus('error');
          console.error('API health check returned unexpected status:', res);
        }
      })
      .catch((err) => {
        setStatus('error');
        console.error('API health check failed:', err);
      });
  }, []);

  const statusStyles: Record<ApiStatus, { bg: string; text: string; label: string }> = {
    unconfigured: {
      bg: 'bg-yellow-100 border-yellow-400',
      text: 'text-yellow-800',
      label: 'API: Not Configured',
    },
    checking: {
      bg: 'bg-gray-100 border-gray-400',
      text: 'text-gray-600',
      label: 'API: Checking...',
    },
    ok: {
      bg: 'bg-green-100 border-green-400',
      text: 'text-green-800',
      label: 'API: OK',
    },
    error: {
      bg: 'bg-red-100 border-red-400',
      text: 'text-red-800',
      label: 'API: Error – see console',
    },
  };

  const style = statusStyles[status];

  return (
    <div className={`inline-flex items-center px-3 py-1 rounded-full border text-sm font-medium ${style.bg} ${style.text}`}>
      {status === 'ok' && <span className="mr-1">✓</span>}
      {status === 'error' && <span className="mr-1">✗</span>}
      {status === 'unconfigured' && <span className="mr-1">⚠</span>}
      {status === 'checking' && <span className="mr-1 animate-pulse">●</span>}
      {style.label}
    </div>
  );
};

/**
 * ApiNotConfiguredBanner
 *
 * Full-width warning banner shown when API is not configured.
 * Includes instructions for fixing the issue.
 */
export const ApiNotConfiguredBanner = () => {
  if (isApiConfigured()) return null;

  return (
    <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
      <div className="flex">
        <div className="flex-shrink-0">
          <span className="text-yellow-400 text-xl">⚠️</span>
        </div>
        <div className="ml-3">
          <h3 className="text-sm font-medium text-yellow-800">
            Ringwheel API is not configured
          </h3>
          <p className="mt-1 text-sm text-yellow-700">
            Check <code className="bg-yellow-100 px-1 rounded">VITE_SPIN_API_URL</code> and{' '}
            <code className="bg-yellow-100 px-1 rounded">VITE_SPIN_API_TOKEN</code> in your{' '}
            <code className="bg-yellow-100 px-1 rounded">.env</code> file.
          </p>
          <p className="mt-1 text-sm text-yellow-700">
            Spins will not be logged until the API is properly configured.
          </p>
        </div>
      </div>
    </div>
  );
};
