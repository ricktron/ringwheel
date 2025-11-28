# 🎡 Ringwheel

Ringwheel is a multi-ring classroom spinner that fairly randomizes Region, Taxon, and IUCN results while supporting admin controls, vetoes, and celebratory effects.

## Project Overview
- Frontend powered by Vite, React, TypeScript, and Tailwind CSS.
- Integrates with a Spin API for roster, ring weights, settings, and logging.
- Includes dedicated spaces for the web client, Google Apps Script backend, schemas, shared assets, and documentation.

## Setup (outline)
1. Install Node.js (v18+ recommended) and npm.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env` and fill in the Spin API details.
4. Start the dev server with `npm run dev` and open `http://localhost:5173`.
5. Review `/docs` for onboarding notes and `/backend` for API integration when available.

## Repository Structure
- `app/` – frontend application workspace.
- `gas/` – Google Apps Script or other backend automation.
- `schema/` – data contracts and validation files.
- `assets/` – shared images, audio, and other static resources.
- `docs/` – architectural notes, onboarding guides, and milestones.
- `backend/` – existing backend implementation details.
- `src/` – current frontend source code.

## Milestone Checklist
- [ ] Finalize Spin API contract and sample responses.
- [ ] Wire frontend to authenticated Spin API calls.
- [ ] Implement admin ring-weight editor and validation.
- [ ] Add telemetry/logging pipeline for spins.
- [ ] Prepare deployment playbook and operations runbook.
