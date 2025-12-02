/**
 * Ringwheel API Client
 *
 * This is the canonical API client for the Ringwheel frontend.
 * It communicates with the Apps Script Web App backend.
 *
 * Environment variables:
 * - VITE_SPIN_API_URL: The deployed Apps Script Web App URL
 * - VITE_RINGWHEEL_API_TOKEN: The API token for authentication (primary)
 * - VITE_SPIN_API_TOKEN: Legacy token env var (fallback)
 */

import type { RingSlice, SettingRow, SpinsLogPayload, RosterStudent, SpinLogRow } from './types';

const base = import.meta.env.VITE_SPIN_API_URL || '';
// Support both new and legacy token env var names
const API_TOKEN = import.meta.env.VITE_RINGWHEEL_API_TOKEN || import.meta.env.VITE_SPIN_API_TOKEN || '';

/**
 * Returns the base API URL (deployed Apps Script Web App URL)
 */
function getApiBase(): string {
  return base;
}

/**
 * Build URL with common query parameters including token
 * Used for GET requests to avoid CORS preflight
 */
function buildUrl(params: Record<string, string>): string {
  const apiBase = getApiBase();
  const search = new URLSearchParams({
    token: API_TOKEN,
    ...params,
  });
  return `${apiBase}?${search.toString()}`;
}

/**
 * Handle response errors and non-JSON responses
 * Provides robust error handling for backend responses
 */
async function handleResponse<T>(res: Response): Promise<T> {
  const ct = res.headers.get('content-type') || '';

  if (!res.ok) {
    // Try to surface backend error text (e.g., "Forbidden")
    const text = await res.text().catch(() => '');
    throw new Error(text ? `Backend error ${res.status}: ${text}` : `Backend error ${res.status}`);
  }

  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(text ? `Backend returned non-JSON response: ${text}` : 'Backend returned non-JSON response');
  }

  return res.json() as Promise<T>;
}

/**
 * Generic GET request using lowercase `type` parameter
 * Uses buildUrl to include token in query string
 * No Content-Type header to avoid CORS preflight
 */
async function get<T>(type: string): Promise<T> {
  const url = buildUrl({ type });
  console.log('[Ringwheel] Fetching', url); // TEMP: verify token is in URL
  const res = await fetch(url, {
    method: 'GET',
    // No headers to keep request "simple" and avoid CORS preflight
  });
  return handleResponse<T>(res);
}

/**
 * Generic POST request with token in JSON body.
 * We use text/plain to avoid CORS preflight with Apps Script.
 * Apps Script still parses JSON from e.postData.contents.
 */
async function post<T>(body: unknown): Promise<T> {
  console.debug('Ringwheel API POST', body);
  const res = await fetch(getApiBase(), {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify({ ...(body as Record<string, unknown>), token: API_TOKEN }),
  });
  console.debug('Ringwheel API POST response', res.status);
  return handleResponse<T>(res);
}

/**
 * Ringwheel API client
 *
 * Methods:
 * - health(): Check if API is alive
 * - roster(): Get roster entries
 * - rings(): Get ring slice definitions
 * - settings(): Get settings
 * - logSpin(payload): Log a spin result to SpinsLog
 * - writeRings(rows): Overwrite Rings sheet
 * - writeSettings(rows): Overwrite Settings sheet
 * - email(to, subject, text): Send an email
 */
export const api = {
  health: () => get<{ status: string }>('health'),
  roster: () => get<RosterStudent[]>('roster'),
  rings: () => get<RingSlice[]>('rings'),
  settings: () => get<SettingRow[]>('settings'),
  getSpins: (filters: { date?: string; period?: string; email?: string }) =>
    post<SpinLogRow[]>({ mode: 'getSpins', ...filters }),
  logSpin: (payload: SpinsLogPayload) =>
    post<{ ok: boolean }>({ type: 'logspin', payload }),
  writeRings: (rows: RingSlice[]) =>
    post<{ ok: boolean }>({ type: 'writerings', rows }),
  writeSettings: (rows: SettingRow[]) =>
    post<{ ok: boolean }>({ type: 'writesettings', rows }),
  email: (to: string, subject: string, text: string) =>
    post<{ ok: boolean }>({ type: 'email', to, subject, text }),
};

/**
 * Check if API is configured with both URL and token
 */
export function isApiConfigured(): boolean {
  return Boolean(base && API_TOKEN);
}
