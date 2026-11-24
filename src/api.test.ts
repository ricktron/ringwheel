import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  createApiClient,
  normalizeRings,
  normalizeRoster,
  normalizeSettings,
  normalizeSpins,
  resolveApiConfig,
} from './api';
import type { SpinsLogPayload } from './types';

const URL_ = 'https://script.example.test/exec';
const TOKEN = 'unit-test-token';

type Call = { url: string; init: RequestInit };

/** A fetch stand-in that records calls and answers with a canned body. */
function fakeFetch(body: string, init: { status?: number } = {}) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), init: requestInit ?? {} });
    return new Response(body, { status: init.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const clientFor = (body: string, init?: { status?: number }) => {
  const fetchDouble = fakeFetch(body, init);
  return { client: createApiClient({ url: URL_, token: TOKEN, fetchImpl: fetchDouble.impl }), calls: fetchDouble.calls };
};

const payload: SpinsLogPayload = {
  timestamp_iso: '2026-11-24T15:30:00.000Z',
  session_id: 'sess',
  period: 'A',
  student_name: 'Ada Sample',
  email: 'ada.sample@example.com',
  result_A: 'Nearctic',
  result_B: 'Aves',
  result_C: 'LC',
  plantae_mercy: false,
  veto_used: false,
  seed: '0123456789abcdef',
  is_test: false,
  rule_flags_json: '[]',
};

async function errorFrom(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('request shape (must match gas/Code.gs and avoid CORS preflight)', () => {
  it('GET sends type and token in the query string with no custom headers', async () => {
    const { client, calls } = clientFor('[]');
    await client.roster();
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(URL_);
    expect(url.searchParams.get('type')).toBe('roster');
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers).toBeUndefined();
  });

  it('POST sends JSON as text/plain with the token and lowercase type in the body', async () => {
    const { client, calls } = clientFor('{"ok":true}');
    await client.logSpin(payload);
    expect(calls[0].url).toBe(URL_);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'text/plain;charset=utf-8' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: 'logspin', payload, token: TOKEN });
  });

  it('uses the route names the backend switches on', async () => {
    const seen: string[] = [];
    for (const call of [
      (c: ReturnType<typeof createApiClient>) => c.rings(),
      (c: ReturnType<typeof createApiClient>) => c.settings(),
      (c: ReturnType<typeof createApiClient>) => c.getSpins({ date: '2026-11-24', period: 'A' }),
      (c: ReturnType<typeof createApiClient>) => c.writeRings([]),
      (c: ReturnType<typeof createApiClient>) => c.writeSettings([], 'admin-secret'),
    ]) {
      const { client, calls } = clientFor('{"ok":true}');
      await call(client).catch(() => undefined);
      const c = calls[0];
      if (c.init.method === 'GET') seen.push(`GET ${new URL(c.url).searchParams.get('type')}`);
      else {
        const body = JSON.parse(String(c.init.body));
        seen.push(`POST ${body.mode ?? body.type}${body.admin_token ? ' +admin' : ''}`);
      }
    }
    expect(seen).toEqual(['GET rings', 'GET settings', 'POST getSpins', 'POST writerings', 'POST writesettings +admin']);
  });
});

describe('failures are never reported as success', () => {
  it('logSpin resolves only when the backend says ok: true', async () => {
    await expect(clientFor('{"ok":true}').client.logSpin(payload)).resolves.toEqual({ ok: true, warnings: [] });
    await expect(clientFor('{"ok":true,"warnings":["missing column"]}').client.logSpin(payload)).resolves.toEqual({
      ok: true,
      warnings: ['missing column'],
    });
  });

  it.each([
    ['an explicit refusal', '{"ok":false,"error":"The SpinsLog sheet was not found. Nothing was logged."}', 'rejected', /SpinsLog sheet was not found/],
    ['an empty object', '{}', 'rejected', /did not confirm/],
    ['a truthy but not true ok', '{"ok":"true"}', 'rejected', /did not confirm/],
    ['a JSON array', '[]', 'rejected', /did not confirm/],
    ['JSON null', 'null', 'rejected', /did not confirm/],
    ['a rejected token', 'Forbidden', 'forbidden', /rejected the token/],
    ['an unknown route', 'Not Found', 'not_found', /older version/],
    ['an Apps Script error page', '<!DOCTYPE html><html><body><div>TypeError: Cannot read properties of null</div></body></html>', 'bad_response', /not JSON: TypeError: Cannot read properties of null/],
    ['an empty body', '', 'bad_response', /not JSON/],
  ])('logSpin rejects on %s', async (_name, body, kind, message) => {
    const err = await errorFrom(clientFor(body).client.logSpin(payload));
    expect(err.kind).toBe(kind);
    expect(err.message).toMatch(message);
  });

  it('rejects on HTTP errors', async () => {
    expect((await errorFrom(clientFor('oops', { status: 500 }).client.logSpin(payload))).kind).toBe('http');
    expect((await errorFrom(clientFor('nope', { status: 403 }).client.roster())).kind).toBe('forbidden');
  });

  it('rejects when the network fails', async () => {
    const client = createApiClient({
      url: URL_,
      token: TOKEN,
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    const err = await errorFrom(client.logSpin(payload));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/Could not reach the backend/);
  });

  it('rejects when the backend never answers', async () => {
    const client = createApiClient({
      url: URL_,
      token: TOKEN,
      timeoutMs: 20,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })) as typeof fetch,
    });
    expect((await errorFrom(client.logSpin(payload))).kind).toBe('timeout');
  });

  it('admin writes reject unless confirmed', async () => {
    expect((await errorFrom(clientFor('{"ok":false,"error":"No rows were sent."}').client.writeSettings([]))).message).toMatch(/No rows were sent/);
    expect((await errorFrom(clientFor('Forbidden').client.writeRings([]))).kind).toBe('forbidden');
  });

  it('health passes only on status ok and names missing tabs', async () => {
    await expect(clientFor('{"status":"ok"}').client.health()).resolves.toEqual({ status: 'ok' });
    const err = await errorFrom(clientFor('{"status":"degraded","missing":["SpinsLog"]}').client.health());
    expect(err.kind).toBe('bad_response');
    expect(err.message).toMatch(/Missing sheet tabs: SpinsLog/);
  });

  it('list reads reject when the backend returns something that is not a list', async () => {
    const err = await errorFrom(clientFor('{"ok":false,"error":"Internal error: boom"}').client.roster());
    expect(err.kind).toBe('bad_response');
    expect(err.message).toMatch(/Internal error: boom/);
  });

  it('never writes the token or student details to the console', async () => {
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    await clientFor('[]').client.roster();
    await clientFor('{"ok":true}').client.logSpin(payload);
    await clientFor('Forbidden').client.logSpin(payload).catch(() => undefined);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('response normalization (Sheets returns booleans, numbers or text depending on the cell)', () => {
  it('settings values always become strings', () => {
    expect(
      normalizeSettings([
        { key: 'enableAudio', value: false, notes: 'n' },
        { key: 'enableConfetti', value: 'TRUE' },
        { key: 'midterm_pair_cap_pct', value: 12 },
        { key: '', value: 'dropped' },
        { key: 'mode', value: ' midterm ', owner: 'kept' },
      ])
    ).toEqual([
      { key: 'enableAudio', value: 'false', notes: 'n' },
      { key: 'enableConfetti', value: 'true', notes: '' },
      { key: 'midterm_pair_cap_pct', value: '12', notes: '' },
      { key: 'mode', value: 'midterm', notes: '', owner: 'kept' },
    ]);
  });

  it('rings get numeric weights and real booleans, unknown rings are dropped, extra columns survive', () => {
    const rings = normalizeRings([
      { ring_name: 'a', label: 'Nearctic', color_hex: '#fff', weight: '2.5', order_index: '3', active: 'FALSE', comment: 'x' },
      { ring_name: 'B', label: 'Aves', color_hex: '', weight: 1, order_index: 0, active: true },
      { ring_name: 'C', label: 'LC', weight: '', order_index: '', active: '' },
      { ring_name: 'D', label: 'nope', weight: 1 },
      { ring_name: 'A', label: '', weight: 1 },
    ]);
    expect(rings).toHaveLength(3);
    expect(rings[0]).toEqual({ ring_name: 'A', label: 'Nearctic', color_hex: '#fff', weight: 2.5, order_index: 3, active: false, comment: 'x' });
    expect(rings[1].active).toBe(true);
    // A blank active cell counts as active; a blank weight is reported as not a number.
    expect(rings[2].active).toBe(true);
    expect(Number.isNaN(rings[2].weight)).toBe(true);
  });

  it('roster rows without an email are skipped and blank periods become null', () => {
    expect(
      normalizeRoster([
        { email: 'ada.sample@example.com', first: 'Ada', last: 'Sample', class: 'ES', s1Period: 'A', s2Period: null },
        { email: '', first: 'Ghost', last: 'Row' },
        { email: ' ben@example.com ', first: 'Ben', last: 'Placeholder', class: 'ES', s1Period: 2, s2Period: '' },
      ])
    ).toEqual([
      { email: 'ada.sample@example.com', first: 'Ada', last: 'Sample', class: 'ES', s1Period: 'A', s2Period: null },
      { email: 'ben@example.com', first: 'Ben', last: 'Placeholder', class: 'ES', s1Period: '2', s2Period: null },
    ]);
  });

  it('spin rows identify test spins from is_test, or from the flag on older backends', () => {
    const rows = normalizeSpins([
      { timestamp_iso: 't1', result_region: 'Nearctic', rule_flags: [], is_test: false },
      { timestamp_iso: 't2', result_region: 'Nearctic', rule_flags: ['auto_test_run'], is_test: true },
      { timestamp_iso: 't3', result_region: 'Nearctic', rule_flags: ['auto_test_run', 'veto_respin'] },
      { timestamp_iso: 't4', result_region: 'Nearctic', rule_flags: 'not-an-array', plantae_mercy: 'TRUE' },
    ]);
    expect(rows.map((r) => r.is_test)).toEqual([false, true, true, false]);
    expect(rows[3].rule_flags).toEqual([]);
    expect(rows[3].plantae_mercy).toBe(true);
  });
});

describe('configuration problems are explicit', () => {
  const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

  it('is usable with a URL and a token', () => {
    expect(resolveApiConfig({ VITE_SPIN_API_URL: URL_, VITE_RINGWHEEL_API_TOKEN: TOKEN })).toEqual({
      url: URL_,
      token: TOKEN,
      tokenSource: 'build',
      problems: [],
    });
  });

  it('says what is missing', () => {
    expect(resolveApiConfig({}).problems).toEqual(['The backend URL is not set.', 'The API token is not set.']);
    expect(resolveApiConfig({ VITE_SPIN_API_URL: URL_ }).problems).toEqual(['The API token is not set.']);
  });

  it('treats the example-file placeholders as not configured instead of sending them', () => {
    const fromExample = resolveApiConfig({
      VITE_SPIN_API_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',
      VITE_RINGWHEEL_API_TOKEN: 'your-api-token-here',
    });
    expect(fromExample.problems).toEqual([
      'The backend URL is still the placeholder from the example file.',
      'The API token is still the placeholder from the example file.',
    ]);
    expect(resolveApiConfig({ VITE_SPIN_API_URL: 'script.google.com/x', VITE_RINGWHEEL_API_TOKEN: TOKEN }).problems).toEqual([
      'The backend URL must start with https://.',
    ]);
  });

  it('still honours the legacy token variable', () => {
    expect(resolveApiConfig({ VITE_SPIN_API_URL: URL_, VITE_SPIN_API_TOKEN: 'legacy' }).token).toBe('legacy');
    expect(resolveApiConfig({ VITE_SPIN_API_URL: URL_, VITE_SPIN_API_TOKEN: 'legacy', VITE_RINGWHEEL_API_TOKEN: 'primary' }).token).toBe('primary');
  });

  it('prefers values saved in the browser and reports where the token came from', () => {
    const config = resolveApiConfig(
      { VITE_SPIN_API_URL: URL_, VITE_RINGWHEEL_API_TOKEN: TOKEN },
      storage({ 'ringwheel.apiUrl': 'https://other.example.test/exec', 'ringwheel.apiToken': 'browser-token' })
    );
    expect(config).toMatchObject({ url: 'https://other.example.test/exec', token: 'browser-token', tokenSource: 'browser', problems: [] });
    expect(resolveApiConfig({ VITE_SPIN_API_URL: URL_ }, storage({ 'ringwheel.apiToken': 't' })).tokenSource).toBe('browser');
  });

  it('the app-wide client refuses to send anything when not configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.stubEnv('VITE_SPIN_API_URL', '');
    vi.stubEnv('VITE_RINGWHEEL_API_TOKEN', '');
    vi.stubEnv('VITE_SPIN_API_TOKEN', '');
    try {
      const err = await errorFrom(api.logSpin(payload));
      expect(err.kind).toBe('not_configured');
      expect(err.message).toMatch(/backend URL is not set/);
      expect((await errorFrom(api.roster())).kind).toBe('not_configured');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
