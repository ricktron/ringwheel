/**
 * Ringwheel API client. The only module that talks to the backend.
 *
 * Backend: the Apps Script Web App in gas/Code.gs.
 * - GET  {url}?type=health|roster|rings|settings&token=...
 * - POST {url} with a JSON body sent as text/plain (no CORS preflight)
 *
 * Apps Script answers every request with HTTP 200, so failures arrive as a
 * plain text body ("Forbidden", "Not Found"), an HTML error page, or JSON with
 * `ok: false`. This client turns each of those into a typed ApiError. A call
 * only resolves when the backend positively confirmed it.
 *
 * Configuration (first match wins):
 * 1. Values saved in this browser from the Admin page (localStorage).
 * 2. Build-time env vars: VITE_SPIN_API_URL, VITE_RINGWHEEL_API_TOKEN
 *    (VITE_SPIN_API_TOKEN is still read as a legacy fallback).
 *
 * SECURITY: anything in a VITE_ variable is compiled into the JavaScript bundle
 * and can be read by anyone who can load the site. Never treat it as a secret.
 * See docs/CONSOLIDATION.md for the recommended setup.
 */
import type { RingName, RingSlice, RosterStudent, SettingRow, SpinLogRow, SpinsLogPayload } from './types';

export type ApiErrorKind =
  | 'not_configured'
  | 'network'
  | 'timeout'
  | 'forbidden'
  | 'not_found'
  | 'http'
  | 'bad_response'
  | 'rejected';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }
}

/** Short, user-presentable description of any thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
  url: 'ringwheel.apiUrl',
  token: 'ringwheel.apiToken',
} as const;

export interface ApiConfig {
  url: string;
  token: string;
  /** Where the token came from. A build-time token is public to anyone with the site. */
  tokenSource: 'browser' | 'build' | 'none';
  /** Human-readable reasons the API cannot be used. Empty when usable. */
  problems: string[];
}

type EnvLike = Record<string, string | boolean | undefined>;
type StorageLike = Pick<Storage, 'getItem'>;

const looksLikePlaceholder = (value: string): boolean =>
  /your[-_ ]?(api|secret|deployment|script)|your-api-token-here|<[^>]*>|changeme|example-token/i.test(value);

function readStorage(storage: StorageLike | undefined, key: string): string {
  try {
    return (storage?.getItem(key) ?? '').trim();
  } catch {
    return '';
  }
}

const envString = (env: EnvLike, key: string): string => {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
};

/** Work out the API settings and say exactly what is wrong when they are unusable. */
export function resolveApiConfig(env: EnvLike, storage?: StorageLike): ApiConfig {
  const storedUrl = readStorage(storage, STORAGE_KEYS.url);
  const storedToken = readStorage(storage, STORAGE_KEYS.token);
  const envToken = envString(env, 'VITE_RINGWHEEL_API_TOKEN') || envString(env, 'VITE_SPIN_API_TOKEN');

  const url = storedUrl || envString(env, 'VITE_SPIN_API_URL');
  const token = storedToken || envToken;
  const tokenSource: ApiConfig['tokenSource'] = storedToken ? 'browser' : envToken ? 'build' : 'none';

  const problems: string[] = [];
  if (!url) {
    problems.push('The backend URL is not set.');
  } else if (looksLikePlaceholder(url)) {
    problems.push('The backend URL is still the placeholder from the example file.');
  } else if (!/^https?:\/\//i.test(url)) {
    problems.push('The backend URL must start with https://.');
  }
  if (!token) {
    problems.push('The API token is not set.');
  } else if (looksLikePlaceholder(token)) {
    problems.push('The API token is still the placeholder from the example file.');
  }

  return { url, token, tokenSource, problems };
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Current configuration, re-read on every call so Admin page changes apply immediately. */
export function getApiConfig(): ApiConfig {
  return resolveApiConfig(import.meta.env as EnvLike, browserStorage());
}

export function isApiConfigured(): boolean {
  return getApiConfig().problems.length === 0;
}

/** Save (or clear, with empty strings) the connection settings for this browser only. */
export function saveBrowserApiConfig(url: string, token: string): void {
  const storage = browserStorage();
  if (!storage) throw new Error('This browser does not allow saving settings.');
  const write = (key: string, value: string) => {
    if (value.trim()) storage.setItem(key, value.trim());
    else storage.removeItem(key);
  };
  write(STORAGE_KEYS.url, url);
  write(STORAGE_KEYS.token, token);
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

const asText = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

/** Sheets hands back real booleans, numbers or text depending on the cell. */
function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = asText(value).toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return fallback;
}

function expectArray(data: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(data)) {
    const detail =
      data && typeof data === 'object' && 'error' in data ? `: ${asText((data as { error: unknown }).error)}` : '';
    throw new ApiError('bad_response', `The backend did not return a list of ${what}${detail}.`);
  }
  return data.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object');
}

export function normalizeRoster(data: unknown): RosterStudent[] {
  return expectArray(data, 'students')
    .map((row) => ({
      email: asText(row.email),
      first: asText(row.first),
      last: asText(row.last),
      class: asText(row.class),
      s1Period: asText(row.s1Period) || null,
      s2Period: asText(row.s2Period) || null,
    }))
    .filter((student) => student.email !== '');
}

export function normalizeRings(data: unknown): RingSlice[] {
  const slices: RingSlice[] = [];
  for (const row of expectArray(data, 'ring slices')) {
    const ringName = asText(row.ring_name).toUpperCase();
    const label = asText(row.label);
    if (!['A', 'B', 'C'].includes(ringName) || !label) continue;
    slices.push({
      ...row,
      ring_name: ringName as RingName,
      label,
      color_hex: asText(row.color_hex),
      weight: typeof row.weight === 'number' ? row.weight : Number.parseFloat(asText(row.weight)),
      order_index: typeof row.order_index === 'number' ? row.order_index : Number.parseFloat(asText(row.order_index)),
      // A blank "active" cell counts as active. Only an explicit false turns a slice off.
      active: toBoolean(row.active, true),
    });
  }
  return slices;
}

export function normalizeSettings(data: unknown): SettingRow[] {
  return expectArray(data, 'settings')
    .map((row) => {
      const raw = row.value;
      const value = typeof raw === 'boolean' ? String(raw) : /^(true|false)$/i.test(asText(raw)) ? asText(raw).toLowerCase() : asText(raw);
      return { ...row, key: asText(row.key), value, notes: asText(row.notes) };
    })
    .filter((row) => row.key !== '');
}

export function normalizeSpins(data: unknown): SpinLogRow[] {
  return expectArray(data, 'spins').map((row) => {
    const flags = Array.isArray(row.rule_flags) ? row.rule_flags.map((f) => asText(f)).filter(Boolean) : [];
    return {
      timestamp_iso: asText(row.timestamp_iso),
      student_name: asText(row.student_name),
      email: asText(row.email),
      period: asText(row.period),
      result_region: asText(row.result_region),
      result_taxon: asText(row.result_taxon),
      result_iucn: asText(row.result_iucn),
      plantae_mercy: toBoolean(row.plantae_mercy, false),
      veto_used: toBoolean(row.veto_used, false),
      rule_flags: flags,
      // Older backend deployments do not return is_test, so fall back to the flag.
      is_test: row.is_test === undefined ? flags.includes('auto_test_run') : toBoolean(row.is_test, false),
    };
  });
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface WriteResult {
  ok: true;
  /** Non-fatal notes from the backend, for example a missing sheet column. */
  warnings: string[];
}

const stripHtml = (text: string): string => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export function createApiClient({ url, token, fetchImpl, timeoutMs = 20000 }: ApiClientOptions) {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request(input: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(input, { ...init, signal: controller.signal });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ApiError('timeout', `The backend did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw new ApiError('network', `Could not reach the backend (${describeError(err)}).`);
    } finally {
      clearTimeout(timer);
    }

    const body = text.trim();
    if (body === 'Forbidden' || res.status === 401 || res.status === 403) {
      throw new ApiError('forbidden', 'The backend rejected the token. Check the API token (and admin token, if one is required).');
    }
    if (body === 'Not Found') {
      throw new ApiError('not_found', 'The backend does not recognize this request. The deployed backend may be an older version.');
    }
    if (!res.ok) {
      throw new ApiError('http', `The backend answered with HTTP ${res.status}.`);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      const snippet = stripHtml(body).slice(0, 160);
      throw new ApiError('bad_response', `The backend returned something that is not JSON${snippet ? `: ${snippet}` : '.'}`);
    }
  }

  /** GET with the token in the query string and no custom headers, to stay a "simple" CORS request. */
  function get(type: string): Promise<unknown> {
    const search = new URLSearchParams({ token, type });
    return request(`${url}?${search.toString()}`, { method: 'GET' });
  }

  /** POST with JSON sent as text/plain, which Apps Script parses and browsers do not preflight. */
  function post(body: Record<string, unknown>): Promise<unknown> {
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token }),
    });
  }

  /** A write only counts when the backend says `ok: true`. Anything else is a failure. */
  async function write(body: Record<string, unknown>, what: string): Promise<WriteResult> {
    const data = await post(body);
    if (data && typeof data === 'object' && (data as { ok?: unknown }).ok === true) {
      const warnings = (data as { warnings?: unknown }).warnings;
      return { ok: true, warnings: Array.isArray(warnings) ? warnings.map((w) => asText(w)) : [] };
    }
    const reason = data && typeof data === 'object' ? asText((data as { error?: unknown }).error) : '';
    throw new ApiError('rejected', `The backend did not confirm ${what}${reason ? `: ${reason}` : '.'}`);
  }

  return {
    async health(): Promise<{ status: 'ok' }> {
      const data = await get('health');
      if (!data || typeof data !== 'object' || (data as { status?: unknown }).status !== 'ok') {
        const missing = data && typeof data === 'object' ? (data as { missing?: unknown }).missing : undefined;
        const detail = Array.isArray(missing) && missing.length > 0 ? ` Missing sheet tabs: ${missing.map((m) => asText(m)).join(', ')}.` : '';
        throw new ApiError('bad_response', `The backend health check did not return status "ok".${detail}`);
      }
      return { status: 'ok' };
    },
    roster: async () => normalizeRoster(await get('roster')),
    rings: async () => normalizeRings(await get('rings')),
    settings: async () => normalizeSettings(await get('settings')),
    getSpins: async (filters: { date?: string; period?: string; email?: string }) =>
      normalizeSpins(await post({ mode: 'getSpins', ...filters })),
    logSpin: (payload: SpinsLogPayload) => write({ type: 'logspin', payload }, 'the spin was logged'),
    writeRings: (rows: RingSlice[], adminToken?: string) =>
      write({ type: 'writerings', rows, ...(adminToken ? { admin_token: adminToken } : {}) }, 'the ring weights were saved'),
    writeSettings: (rows: SettingRow[], adminToken?: string) =>
      write({ type: 'writesettings', rows, ...(adminToken ? { admin_token: adminToken } : {}) }, 'the settings were saved'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function currentClient(): ApiClient {
  const config = getApiConfig();
  if (config.problems.length > 0) {
    throw new ApiError('not_configured', `The Ringwheel API is not configured. ${config.problems.join(' ')}`);
  }
  return createApiClient({ url: config.url, token: config.token });
}

/**
 * The app-wide client. Each call reads the current configuration, and rejects
 * with a `not_configured` ApiError instead of sending a request that cannot work.
 */
export const api: ApiClient = {
  health: async () => currentClient().health(),
  roster: async () => currentClient().roster(),
  rings: async () => currentClient().rings(),
  settings: async () => currentClient().settings(),
  getSpins: async (filters) => currentClient().getSpins(filters),
  logSpin: async (payload) => currentClient().logSpin(payload),
  writeRings: async (rows, adminToken) => currentClient().writeRings(rows, adminToken),
  writeSettings: async (rows, adminToken) => currentClient().writeSettings(rows, adminToken),
};
