/**
 * Local stand-in for the deployed Apps Script Web App.
 *
 * Runs the real gas/Code.gs against in-memory fake sheets (see
 * tests/gas/harness.mjs) and exposes it over HTTP the way Apps Script does:
 * - every response is HTTP 200, errors are plain text bodies
 * - CORS is allowed on simple requests only; preflight (OPTIONS) is NOT
 *   answered, so a client that triggers preflight fails here exactly as it
 *   would against the real Web App
 *
 * No real data, no Google services, no email.
 */
import http from 'node:http';
import { createGasRuntime, syntheticSheets, TEST_TOKEN } from '../tests/gas/harness.mjs';

export function startMockServer({ port = 0, sheets = syntheticSheets(), properties = {}, codePath } = {}) {
  const runtime = createGasRuntime({
    sheets,
    properties: { API_TOKEN: TEST_TOKEN, ...properties },
    codePath,
  });

  const state = { failLogSpin: false, requests: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const params = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'OPTIONS') {
      // Apps Script Web Apps do not answer CORS preflight.
      res.writeHead(405);
      res.end();
      return;
    }

    const send = (out) => {
      res.writeHead(200, {
        'Content-Type': `${out.mimeType}; charset=utf-8`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(out.content);
    };

    if (req.method === 'GET') {
      state.requests.push({ method: 'GET', type: params.type });
      try {
        send(runtime.get(params));
      } catch (err) {
        send({ mimeType: 'text/html', content: `<html><body>Exception: ${err.message}</body></html>` });
      }
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let type = '';
        try {
          const parsed = JSON.parse(body);
          type = String(parsed.mode || parsed.type || '').toLowerCase();
        } catch {
          // leave type empty
        }
        state.requests.push({ method: 'POST', type });
        const logSheet = runtime.sheet('SpinsLog');
        if (logSheet) logSheet.failAppend = state.failLogSpin && type === 'logspin';
        try {
          send(runtime.postRaw(body, params));
        } catch (err) {
          // An uncaught Apps Script exception surfaces as an HTML error page.
          send({ mimeType: 'text/html', content: `<html><body>Exception: ${err.message}</body></html>` });
        }
      });
      return;
    }

    res.writeHead(405);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actualPort } = server.address();
      resolve({
        url: `http://127.0.0.1:${actualPort}/exec`,
        token: TEST_TOKEN,
        runtime,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Allow `node e2e/mock-server.mjs [port]` for manual local development.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8787);
  startMockServer({ port }).then((mock) => {
    console.log(`Mock Ringwheel backend (synthetic data) listening on ${mock.url}`);
    console.log(`Use token: ${mock.token}`);
  });
}
