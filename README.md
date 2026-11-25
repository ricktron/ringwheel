# Ringwheel

A projector-first classroom spinner. Three concentric rings (Region, Taxon, IUCN status) spin
for each student in a class queue. Supports veto re-spins of a single ring, a pair cap, Plantae
Mercy, a class roster, spin history, and an admin page for settings and ring weights.

It works immediately with no account, no backend and no token. Classes are stored in your
browser and can be backed up to a file. A teacher who runs their own RingWheel Google Sheet can
switch to Connected Mode instead.

## Two ways to keep data

| | Local Mode (default) | Connected Mode (optional) |
| --- | --- | --- |
| Setup | None | Enter your backend address and token on the Admin page |
| Data lives in | This browser | Your Google Sheet |
| Needs a network | No | Yes |

Details, the data model and privacy notes: [docs/LOCAL_MODE.md](docs/LOCAL_MODE.md).

## Architecture

| Part | Location | Notes |
| --- | --- | --- |
| Frontend | `src/` | Vite, React, TypeScript, Tailwind CSS 4 |
| Spin rules | `src/utils/spin-engine.ts` | The only place a spin is decided. Pure and seeded. Shared by both modes. |
| Data provider | `src/data/provider.ts` | The one interface pages use to read and write data |
| Local storage | `src/data/local/` | Versioned class data in IndexedDB. Never touches the network. |
| Sheets client | `src/api.ts` | Used only in Connected Mode |
| Backend | `gas/Code.gs` | Apps Script Web App over Google Sheets. See [gas/README.md](gas/README.md). |
| Sheet contracts | `schema/*.csv` | Column headers and synthetic sample rows. No real student data. |
| Hosting | `vercel.json` | Static site. See [docs/VERCEL.md](docs/VERCEL.md). |
| Tests | `src/**/*.test.ts`, `tests/`, `e2e/` | See Testing below. |
| Project KB | `KB/` | Working agreements, Master Guide, agent guide. |

History of how two earlier apps became this one: [docs/CONSOLIDATION.md](docs/CONSOLIDATION.md).

## Setup

1. Install Node.js 22 or newer.
2. Install dependencies.

```bash
npm install
```

3. Start the app.

```bash
npm run dev
```

4. Open `http://localhost:5173`. It starts in Local Mode. There is nothing to configure.

There is no `.env` file. RingWheel reads no build-time variables, so a built copy of the site
never contains a backend address or token.

To try Connected Mode without a real backend or real data, run the local fake backend in a
second terminal, then enter the address and token it prints on the Admin page.

```bash
npm run mock:backend
```

## Testing

| Command | What it checks |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run build` | TypeScript and the production build |
| `npm test` | Spin fairness rules, local storage contract, backup and restore, CSV import, API client, backend contract, no credentials in the repository, Local Mode cannot reach a backend |
| `npm run test:e2e` | Both modes in a real browser, reload persistence, backup round trip, offline use, and the production build served the way `vercel.json` says |
| `npm run check` | Lint, build and unit tests together |

The browser test needs a Chromium for Playwright. Install it once:

```bash
npx playwright install chromium
```

No test contacts Google, the deployed Web App, or a real roster.

The "Auto test harness" panel inside the app is a quick convenience check for the teacher.
It is not the test suite.

## Deploying

Frontend: see [docs/VERCEL.md](docs/VERCEL.md). Any static host works; the build is the `dist/` folder.

```bash
npm run build
```

Backend (Connected Mode only): see [gas/README.md](gas/README.md) for deploy, verify and roll back steps.

Security rules and the token rotation procedure: [docs/SECURITY.md](docs/SECURITY.md).

Before class, follow [docs/verification.md](docs/verification.md).

## Repository layout

- `src/` frontend source
- `src/data/` storage modes, the data provider, local class storage
- `gas/` Apps Script backend
- `schema/` sheet contracts with synthetic samples
- `tests/gas/` backend test harness and contract tests
- `tests/local/` local storage, backup and import tests
- `tests/repo/` repository hygiene and privacy guards
- `e2e/` browser tests and local fake backend
- `docs/` guides and records
- `KB/` project knowledge base
- `app/`, `assets/` reserved, currently empty
