import type { APIResponse, RosterEntry, RingWeights, Settings, SpinResult, RingSlice, SettingRow, SpinsLogPayload } from '../types';

// Support both old and new env variable names for backward compatibility
const API_URL = import.meta.env.VITE_SPIN_API_URL || import.meta.env.VITE_WEB_APP_URL || '';
// Primary: VITE_RINGWHEEL_API_TOKEN, fallback to legacy names
const API_TOKEN = import.meta.env.VITE_RINGWHEEL_API_TOKEN || import.meta.env.VITE_SPIN_API_TOKEN || import.meta.env.VITE_API_TOKEN || '';

/**
 * Returns the base API URL (deployed Apps Script Web App URL)
 */
function getApiBase(): string {
  return API_URL;
}

/**
 * Build URL with common query parameters including token
 * Used for GET requests to avoid CORS preflight
 */
function buildUrl(params: Record<string, string>): string {
  const base = getApiBase();
  const search = new URLSearchParams({
    token: API_TOKEN,
    ...params,
  });
  return `${base}?${search.toString()}`;
}

/**
 * Handle response errors and non-JSON responses
 * Provides robust error handling for backend responses
 */
async function handleResponse<T>(response: Response): Promise<T> {
  const ct = response.headers.get('content-type') || '';

  if (!response.ok) {
    // Try to surface backend error text (e.g., "Forbidden")
    const text = await response.text().catch(() => '');
    throw new Error(text ? `Backend error ${response.status}: ${text}` : `Backend error ${response.status}`);
  }

  if (!ct.includes('application/json')) {
    const text = await response.text().catch(() => '');
    throw new Error(text ? `Backend returned non-JSON response: ${text}` : 'Backend returned non-JSON response');
  }

  return response.json() as Promise<T>;
}

/**
 * Generic GET request using lowercase `type` parameter
 * Uses buildUrl to include token in query string
 * No Content-Type header to avoid CORS preflight
 */
async function get<T>(type: string): Promise<T> {
  const url = buildUrl({ type });
  console.log('[Ringwheel] Fetching', url); // TEMP: verify token is in URL
  const response = await fetch(url, {
    method: 'GET',
    // No headers to keep request "simple" and avoid CORS preflight
  });
  return handleResponse<T>(response);
}

/**
 * Generic POST request with lowercase `type` in JSON body
 * Token is included in the JSON body for authentication
 * Uses text/plain to avoid CORS preflight with Apps Script
 */
async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(getApiBase(), {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify({ ...body, token: API_TOKEN }),
  });
  return handleResponse<T>(response);
}

/**
 * New API client using the M1-M8 contract with lowercase type strings
 */
export const api = {
  roster: () => get<RosterEntry[]>('roster'),
  rings: () => get<RingSlice[]>('rings'),
  settings: () => get<SettingRow[]>('settings'),
  health: () => get<{ status: string }>('health'),
  logSpin: (payload: SpinsLogPayload) => post<{ ok: boolean }>({ type: 'logspin', payload }),
  writeRings: (rows: RingSlice[]) => post<{ ok: boolean }>({ type: 'writerings', rows }),
  writeSettings: (rows: SettingRow[]) => post<{ ok: boolean }>({ type: 'writesettings', rows }),
  email: (to: string, subject: string, text: string) => post<{ ok: boolean }>({ type: 'email', to, subject, text }),
};

/**
 * Legacy APIService class for backward compatibility with existing UI
 */
export class APIService {
  private static async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    data?: unknown
  ): Promise<APIResponse<T>> {
    try {
      let response: Response;
      
      if (method === 'GET') {
        // GET: Use buildUrl with token in query string, no Content-Type header
        response = await fetch(buildUrl({ type: endpoint }), {
          method: 'GET',
          // No headers to keep request "simple" and avoid CORS preflight
        });
      } else {
        // POST: Token goes in JSON body, use text/plain to avoid CORS preflight
        response = await fetch(getApiBase(), {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8',
          },
          body: JSON.stringify({ ...(data as object), token: API_TOKEN }),
        });
      }

      const ct = response.headers.get('content-type') || '';

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          success: false,
          error: text ? `Backend error ${response.status}: ${text}` : `Backend error ${response.status}`,
        };
      }

      if (!ct.includes('application/json')) {
        const text = await response.text().catch(() => '');
        return {
          success: false,
          error: text ? `Backend returned non-JSON response: ${text}` : 'Backend returned non-JSON response',
        };
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error(`API request failed for ${endpoint}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * GET endpoints
   */
  static async getRoster(): Promise<APIResponse<RosterEntry[]>> {
    return this.request<RosterEntry[]>('roster', 'GET');
  }

  static async getRings(): Promise<APIResponse<RingWeights>> {
    return this.request<RingWeights>('rings', 'GET');
  }

  static async getSettings(): Promise<APIResponse<Settings>> {
    return this.request<Settings>('settings', 'GET');
  }

  /**
   * POST endpoints
   */
  static async logSpin(spin: SpinResult): Promise<APIResponse<void>> {
    return this.request<void>('logspin', 'POST', { type: 'logspin', payload: spin });
  }

  static async writeRings(weights: RingWeights): Promise<APIResponse<void>> {
    return this.request<void>('writerings', 'POST', { type: 'writerings', rows: weights });
  }

  static async writeSettings(settings: Settings): Promise<APIResponse<void>> {
    return this.request<void>('writesettings', 'POST', { type: 'writesettings', rows: settings });
  }

  static async sendEmail(data: { recipient: string; subject: string; body: string }): Promise<APIResponse<void>> {
    return this.request<void>('email', 'POST', { type: 'email', to: data.recipient, subject: data.subject, text: data.body });
  }

  /**
   * Check if API is configured
   */
  static isConfigured(): boolean {
    return Boolean(API_URL && API_TOKEN);
  }
}
