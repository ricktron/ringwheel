import type { APIResponse, RosterEntry, RingWeights, Settings, SpinResult, RingSlice, SettingRow, SpinsLogPayload } from '../types';

// Support both old and new env variable names for backward compatibility
const API_URL = import.meta.env.VITE_SPIN_API_URL || import.meta.env.VITE_WEB_APP_URL || '';
const API_TOKEN = import.meta.env.VITE_SPIN_API_TOKEN || import.meta.env.VITE_API_TOKEN || '';

/**
 * Generic GET request using lowercase `type` parameter
 */
async function get<T>(type: string): Promise<T> {
  const url = new URL(API_URL);
  url.searchParams.append('type', type);
  url.searchParams.append('token', API_TOKEN);
  
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`API GET failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Generic POST request with lowercase `type` in JSON body
 */
async function post<T>(body: unknown): Promise<T> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...(body as object), token: API_TOKEN }),
  });
  if (!response.ok) {
    throw new Error(`API POST failed: ${response.status}`);
  }
  return response.json();
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
      const url = new URL(API_URL);
      url.searchParams.append('type', endpoint);
      url.searchParams.append('token', API_TOKEN);

      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      if (method === 'POST' && data) {
        options.body = JSON.stringify({ ...(data as object), token: API_TOKEN });
      }

      const response = await fetch(url.toString(), options);
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
