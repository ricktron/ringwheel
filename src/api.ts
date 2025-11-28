/**
 * Ringwheel API Client
 *
 * This is the canonical API client for the Ringwheel frontend.
 * It communicates with the Apps Script Web App backend.
 *
 * Environment variables:
 * - VITE_SPIN_API_URL: The deployed Apps Script Web App URL
 * - VITE_SPIN_API_TOKEN: The API token for authentication
 */

import type { RingSlice, SettingRow, SpinsLogPayload } from './types';

const base = import.meta.env.VITE_SPIN_API_URL || '';
const token = import.meta.env.VITE_SPIN_API_TOKEN || '';

/**
 * Generic GET request using lowercase `type` parameter
 */
async function get<T>(type: string): Promise<T> {
  const res = await fetch(`${base}?type=${type}&token=${token}`);
  if (!res.ok) throw new Error(`GET ${type} failed with ${res.status}`);
  return res.json();
}

/**
 * Generic POST request with token in JSON body
 */
async function post<T>(body: unknown): Promise<T> {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body as Record<string, unknown>), token }),
  });
  if (!res.ok) throw new Error(`POST failed with ${res.status}`);
  return res.json();
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
  roster: () => get<Record<string, unknown>[]>('roster'),
  rings: () => get<RingSlice[]>('rings'),
  settings: () => get<SettingRow[]>('settings'),
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
  return Boolean(base && token);
}
