import type { APIResponse, RosterEntry, RingWeights, Settings, SpinResult } from '../types';

const API_URL = import.meta.env.VITE_WEB_APP_URL || '';
const API_TOKEN = import.meta.env.VITE_API_TOKEN || '';

export class APIService {
  private static async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    data?: unknown
  ): Promise<APIResponse<T>> {
    try {
      const url = new URL(API_URL);
      url.searchParams.append('action', endpoint);
      url.searchParams.append('token', API_TOKEN);

      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      if (method === 'POST' && data) {
        options.body = JSON.stringify(data);
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
    return this.request<void>('logSpin', 'POST', spin);
  }

  static async writeRings(weights: RingWeights): Promise<APIResponse<void>> {
    return this.request<void>('writeRings', 'POST', weights);
  }

  static async writeSettings(settings: Settings): Promise<APIResponse<void>> {
    return this.request<void>('writeSettings', 'POST', settings);
  }

  static async sendEmail(data: { recipient: string; subject: string; body: string }): Promise<APIResponse<void>> {
    return this.request<void>('email', 'POST', data);
  }

  /**
   * Check if API is configured
   */
  static isConfigured(): boolean {
    return Boolean(API_URL && API_TOKEN);
  }
}
