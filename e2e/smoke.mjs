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
import { mkdirSync } from 'node:fs';
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

async function startFrontend(env) {
  for (const key of ['VITE_SPIN_API_URL', 'VITE_RINGWHEEL_API_TOKEN', 'VITE_SPIN_API_TOKEN']) {
    // Explicit empty strings also beat any .env file a developer has locally.
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
  const before = await page.getByTestId('debug-payload').count() ? await page.getByTestId('debug-payload').innerText() : '';
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
// Part A: backend configured
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

await step('spin page loads, backend reports connected, no result is shown before a spin', async () => {
  await page.goto(`${app.url}/spin`);
  await page.locator('[data-testid="api-status"][data-status="ok"]').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('api-not-configured').count(), 0);
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
  const before = await page.getByTestId('debug-payload').innerText();
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
  const before = await page.getByTestId('debug-payload').innerText();
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

await context.close();
await app.server.close();

// ===========================================================================
// Part B: backend not configured
// ===========================================================================
const bare = await startFrontend({});
const context2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCREENSHOTS ? 2 : 1 });
const page2 = await context2.newPage();

await step('without configuration the page says spins are not being saved', async () => {
  await page2.goto(`${bare.url}/spin`);
  await page2.getByTestId('api-not-configured').waitFor();
  assert.match(await text(page2, 'api-not-configured'), /Spins are NOT being saved/);
  assert.match(await text(page2, 'api-not-configured'), /backend URL is not set/);
  await page2.locator('[data-testid="api-status"][data-status="unconfigured"]').waitFor();
});

await step('Plantae Mercy before any spin records LC with no seed, as it did before consolidation', async () => {
  await page2.getByTestId('mercy-button').click();
  await page2.getByRole('dialog', { name: 'Plantae Mercy' }).getByRole('button', { name: 'Nearctic' }).click();
  const mercy = await readResult(page2);
  assert.deepEqual([mercy.region, mercy.taxon, mercy.iucn], ['Nearctic', 'Plantae', 'LC']);
  await page2.locator('details summary').click();
  const payload = JSON.parse(await page2.getByTestId('debug-payload').innerText());
  assert.equal(payload.seed, '');
  assert.equal(payload.plantae_mercy, true);
  assert.deepEqual(JSON.parse(payload.rule_flags_json), ['plantae_mercy', 'wildcard_iucn']);
});

await step('a local-only spin (full-length animation) is clearly marked as not saved', async () => {
  const requestsBefore = mock.state.requests.length;
  const started = Date.now();
  const result = await spinOnce(page2);
  assert.ok(Date.now() - started >= 2500, 'the full spin animation did not run');
  assert.equal(result.student, 'No student selected');
  await waitForLogStatus(page2, 'local_only');
  assert.match(await page2.locator('section[aria-labelledby="result-heading"]').innerText(), /NOT SAVED: backend not configured/);
  assert.equal(mock.state.requests.length, requestsBefore);
  await page2.waitForTimeout(200);
  await assertWheelPointsAt(page2, { region: result.region, taxon: result.taxon, iucn: result.iucn });
  await shot(page2, '10-not-configured');
});

await step('the connection can be set from the Admin page without rebuilding', async () => {
  await page2.goto(`${bare.url}/admin`);
  await page2.getByLabel('Backend URL').fill(mock.url);
  await page2.getByLabel('API token', { exact: true }).fill(mock.token);
  await page2.getByRole('button', { name: 'Save connection' }).click();
  await page2.locator('[data-testid="api-status"][data-status="ok"]').waitFor({ timeout: 10000 });
  assert.match(await text(page2, 'token-source'), /saved in this browser/);
  await page2.goto(`${bare.url}/spin`);
  await page2.locator('[data-testid="api-status"][data-status="ok"]').waitFor({ timeout: 10000 });
  assert.equal(await page2.getByTestId('api-not-configured').count(), 0);
});

await context2.close();
await bare.server.close();
await browser.close();
await mock.close();

console.log(results.join('\n'));
console.log(`\n${results.length - failures - skipped} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failures === 0 ? 0 : 1);
