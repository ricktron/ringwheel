# Ringwheel

A projector-first classroom spinner. Three concentric rings (Region, Taxon, IUCN status) spin
for each student in a class queue. Results are logged to a Google Sheet through an Apps Script
Web App. Supports veto re-spins of a single ring, a pair cap, Plantae Mercy, and an admin page
for settings and ring weights.

This is the one canonical Ringwheel codebase. The earlier `ringwheel-classroom-spinner`
prototype was folded into it. See [docs/CONSOLIDATION.md](docs/CONSOLIDATION.md).

## Architecture

| Part | Location | Notes |
| --- | --- | --- |
| Frontend | `src/` | Vite, React, TypeScript, Tailwind CSS 4 |
| Spin rules | `src/utils/spin-engine.ts` | The only place a spin is decided. Pure and seeded. |
| API client | `src/api.ts` | The only module that talks to the backend. |
| Backend | `gas/Code.gs` | Apps Script Web App over Google Sheets. See [gas/README.md](gas/README.md). |
| Sheet contracts | `schema/*.csv` | Column headers and synthetic sample rows. No real student data. |
| Tests | `src/**/*.test.ts`, `tests/gas/`, `e2e/` | See Testing below. |
| Project KB | `KB/` | Working agreements, Master Guide, agent guide. |

Data flow: the browser loads settings, rings and the roster from the backend, decides each
spin locally with the seeded engine, shows it, then posts one row to `SpinsLog`. A spin is
only shown as saved after the backend confirms the write.

## Setup

1. Install Node.js 22 or newer.
2. Install dependencies.

```bash
npm install
```

3. Copy `.env.example` to `.env.local` and fill in the backend URL and token.
4. Start the app.

```bash
npm run dev
```

5. Open `http://localhost:5173`.

To try the app without the real backend or any real data, run the local fake backend in a
second terminal and point `.env.local` at the URL and token it prints.

```bash
npm run mock:backend
```

## Testing

| Command | What it checks |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run build` | TypeScript and the production build |
| `npm test` | Spin fairness rules, API client, backend contract, sheet schema mismatch, concurrent edits, no credentials in the repository |
| `npm run test:e2e` | The classroom workflows in a real browser, against the real backend code on fake sheets |
| `npm run check` | Lint, build and unit tests together |

The browser test needs a Chromium for Playwright. Install it once:

```bash
npx playwright install chromium
```

No test contacts Google, the deployed Web App, or a real roster.

The "Auto test harness" panel inside the app is a quick convenience check for the teacher.
It is not the test suite.

## Deploying

Frontend: build and host the `dist/` folder on any static host.

```bash
npm run build
```

Read [docs/SECURITY.md](docs/SECURITY.md) before hosting it anywhere other people can reach.
Never build a hosted copy with the API token in a `VITE_` variable. To roll back, redeploy the previous build.

Backend: see [gas/README.md](gas/README.md) for deploy, verify and roll back steps.

Before class, follow [docs/verification.md](docs/verification.md).

## Repository layout

- `src/` frontend source
- `gas/` Apps Script backend
- `schema/` sheet contracts with synthetic samples
- `tests/gas/` backend test harness and contract tests
- `e2e/` browser smoke test and local fake backend
- `docs/` consolidation record and verification checklist
- `KB/` project knowledge base
- `app/`, `assets/` reserved, currently empty
