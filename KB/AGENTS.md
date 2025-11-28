# AGENTS.md – Ringwheel

Guidance for AI coding agents and human contributors working on **Ringwheel**, the classroom spinner tool.

Ringwheel is:

- An Apps Script Web App backend that exposes a small HTTP API over Google Sheets / CSV-like schemas.
- A browser-based frontend (React or similar) that draws a multi-ring spinner, talks to the API, and logs spins.
- A KB-backed project with clear rules for fairness, risk, and classroom safety.

This file defines:

- Global rules for all agents
- Repo identity and layout
- Role scopes for different types of work
- Safe commands and workflows
- How to coordinate with the Ringwheel KB

For deeper context, always pair this with:

- `kb/Ringwheel_KB_01_AI_Development_Working_Agreements.md`
- `kb/Ringwheel_Master_Guide_v1.md`
- `kb/Ringwheel_README_Using_The_KB.md`
0. Global rules for all agents
Do no harm to live classes

Assume Ringwheel may be used today in front of students on a projector.

Prefer additive, reversible changes over destructive ones.

Avoid breaking spin behavior, rosters, or basic UI in ways that could surface mid-class.

If a task might affect classroom behavior, propose a plan and guardrails instead of directly changing core behavior.

Respect fairness and spin rules

Anything that changes who gets picked, how often, or how random it feels is high-risk.

Before touching spin logic, read the spin and fairness sections of the Master Guide.

Do not introduce hidden weights, exclusions, or no-repeat logic. If required, document them clearly and keep them behind flags or settings.

Respect environment and secrets

Do not hardcode API tokens, script IDs, or any sensitive values.

Keep secrets in:

.env / .env.local (frontend dev) and deployment env vars.

Apps Script script properties / secret storage, not in source.

Do not change how env is loaded unless the task explicitly asks for it.

Respect Sheets / CSV contracts

Roster, Rings, Settings, and SpinsLog schemas are shared contracts between backend and frontend.

Treat schema changes as high-risk (see Section 2 and the KB for details).

Prefer additive schema changes (new columns) over repurposing existing ones.

Use the KB as your contract

Core KB:

Ringwheel_KB_01_AI_Development_Working_Agreements.md

Ringwheel_Master_Guide_v1.md

Ringwheel_README_Using_The_KB.md

For non-trivial work, load those files first and obey their precedence rules.

If repo reality and KB disagree, treat live behavior as “what exists” and the KB as “intent,” then flag the drift in your notes.

Use the smallest necessary surface area

When implementing a feature, only touch:

The files that own that behavior.

The minimum supporting types and helpers.

Avoid cross-cutting edits across unrelated modules without a compelling reason.

Explain what you changed

After code changes, provide:

A short summary of what changed and why.

Any commands to run or checks to perform.

Any new contracts that should be reflected in this AGENTS.md and/or the KB.

Lint, type checks, and basic verification

Use the repo’s existing NPM scripts as defined in package.json.

If a lint script exists, run it after changes and fix errors rather than suppressing them.

If TypeScript is used, ensure type checks pass (e.g., via npm run build or npx tsc --noEmit, depending on scripts).

For Apps Script changes, describe at least one explicit manual test (e.g., hit /health, run a test spin).

1. Repo identity and layout
1.1 Purpose
Ringwheel’s purpose (summary):

Provide a teacher-first, projector-friendly spinner that replaces popsicle sticks and ad-hoc random selection.

Use rosters, rings, and settings to control how students or outcomes are selected.

Log spins for basic history and future analytics, without becoming a grading or attendance system.

The canonical definition of behavior, architecture, and fairness lives in the Ringwheel Master Guide.
Use this AGENTS.md as the repo-local implementation contract and workflow guide.

1.2 Typical structure
Actual layout may evolve, but the repo is expected to look roughly like:

text
Copy code
ringwheel/
  src/                  # Frontend (React or similar)
    components/
    pages/
    utils/
    ...
  gas/                  # Apps Script backend (Code.gs, appsscript.json, etc.)
    Code.gs
    appsscript.json
  schema/               # CSV-like schema docs or sample files
    Roster.csv
    Rings.csv
    Settings.csv
    SpinsLog.csv
  kb/
    Ringwheel_KB_01_AI_Development_Working_Agreements.md
    Ringwheel_Master_Guide_v1.md
    Ringwheel_README_Using_The_KB.md
    ...
  public/               # Static assets (if applicable)
  .env.example
  package.json
  AGENTS.md             # This file
Key points:

gas/Code.gs (and related files) define the Apps Script Web App API and how it talks to Sheets.

schema/*.csv define the conceptual schema for roster, rings, settings, and spin logs.

src/ contains the frontend spinner UI and any client-side spin engine logic.

kb/ holds the core KB that all non-trivial work must respect.

If the real structure differs, update this section to match reality.

2. Order of truth for agents
When repo state and text disagree, use this priority (backed by the Working Agreements and Master Guide):

Live Ringwheel backend and data

What the Apps Script Web App and backing Sheets / CSV files do today.

What the frontend actually shows when used against that backend.

Ringwheel_Master_Guide_v1.md

Intended architecture, behavior, and classroom flows.

Spin rules and fairness expectations.

Repo main branch

Implementation reality (code, schemas, configuration).

Ringwheel_KB_01_AI_Development_Working_Agreements.md and Ringwheel_README_Using_The_KB.md

Collaboration rules, risk levels, KB usage and drift handling.

Older docs, prior chats, internal notes

Advisory only. Helpful for context, not binding.

When live behavior and the Master Guide diverge:

Treat live behavior as “what students see right now.”

Treat the Master Guide as “what we meant to do.”

Do not silently redefine either; instead:

Propose whether implementation should move toward the spec or vice versa.

Call out that the KB likely needs updates.

3. Roles and scopes for agents
Use these conceptual roles for AI coding work in this repo. Names are for prompts; scopes are the important part.

3.1 ringwheel-ui-agent – frontend and client-side behavior
Scope – allowed

src/:

React components, hooks, and pages.

Spin engine / RNG wrapper (if implemented client side).

UI state management, routing, and presentation logic.

Types and helpers that represent:

Roster rows

Ring definitions and slices

Settings

Spin results

Scope – avoid / coordinate

Editing gas/ (Apps Script backend) unless explicitly asked as part of the same task.

Changing CSV / Sheet schemas directly (see ringwheel-schema-agent).

Implementing new fairness rules that contradict the Master Guide without updating docs and getting explicit signoff.

Typical tasks

Adjust spinner UI, labels, and layouts for projector visibility.

Wire frontend calls to existing API endpoints (health, roster, rings, settings, logspin).

Improve error handling and loading states.

Implement non-destructive UX options (e.g., class selector, ring presets) atop existing APIs.

Key rules

Make all API access go through a small, central layer (e.g., src/services/api.ts or similar), not scattered across components.

Treat the spin engine as a “sensitive core”; changes to its behavior should be clearly described and tested.

For any change that might alter who gets picked or how often, treat it as high-risk and follow a plan/test workflow.

3.2 ringwheel-gas-agent – Apps Script backend and API
Scope – allowed

gas/:

Code.gs (main doGet/doPost handlers, routing, and dispatch).

Helper functions that read/write Sheets and enforce auth.

Apps Script deployment metadata (appsscript.json and related).

Read-only inspection of schema in bound Sheets.

Scope – avoid / coordinate

Changing sheet structure (tabs / columns) without involving ringwheel-schema-agent logic.

Introducing new auth mechanisms (tokens, IP checks, etc.) without explicit instructions.

Writing to any Sheets not clearly part of Ringwheel.

Typical tasks

Add or refine API routes:

GET for roster, rings, settings, health.

POST for spin logging, configuration updates, email hooks.

Harden error handling and input validation.

Improve logging and minimal debug information.

Key rules

Prefer pure functions for reading/writing from Sheets; make side effects obvious.

Do not log or echo secrets.

For each new or changed route, specify:

Path, method, inputs, outputs, and error cases.

At least one manual test (e.g., curl) to verify behavior.

3.3 ringwheel-schema-agent – CSV / Sheets schemas and logging
Scope – allowed

Schema definitions in schema/*.csv or equivalent docs.

Documentation around how roster, rings, settings, and spins are stored.

One-off migration or backfill scripts (e.g. Apps Script utilities) when needed.

Scope – avoid / coordinate

Renaming or removing columns without:

A clear migration path.

An understanding of who reads those columns (backend / frontend).

Changing meaning of existing columns without updating the Master Guide and KB.

Typical tasks

Adding new columns in an additive, backward-compatible way.

Defining schemas for new features (e.g., additional spin metadata).

Documenting how each schema is read and written by backend and frontend.

Key rules

Treat schema changes as high-risk.

Prefer:

New columns over reusing existing ones.

Versioned docs if semantics change significantly.

For each schema change, describe:

Old contract vs new contract.

Backfill / migration steps.

How to verify all consumers still work.

3.4 ringwheel-ops-agent – runbooks, debug, and KB alignment
Scope – allowed

kb/:

Session summaries.

Runbooks or ops notes specific to Ringwheel.

Optional debug UIs in src/ that are read-only:

Health status panels.

“Recent spins” summaries.

Simple admin dashboards that do not modify data.

Scope – avoid / coordinate

Any change that modifies spin behavior or fairness.

Any change that touches auth or write paths without a clear mandate.

Typical tasks

Writing or updating runbooks for:

Deploying a new Apps Script version.

Verifying the system before class.

Handling common errors.

Adding simple debug endpoints or panels to surface health or basic metrics.

Key rules

Never assume production credentials; examples should be safe copy-paste.

Keep debug UIs minimal and clearly labeled as such.

When you discover a new operational pattern, propose updating:

AGENTS.md (this file)

Relevant KB docs

4. Commands and tooling
Check package.json for the actual scripts; the following pattern is expected but not guaranteed:

Install dependencies:

sh
Copy code
npm install
Run dev server (frontend):

sh
Copy code
npm run dev
Build for production:

sh
Copy code
npm run build
Lint (if configured):

sh
Copy code
npm run lint
Before you assume a script exists, verify it in package.json. If it doesn’t exist:

Do not invent new workflows silently.

If adding a new script is part of the task, document it here after you add it.

For Apps Script:

Use the Apps Script editor or clasp (if configured) per repo docs.

When you change Code.gs, always describe:

How to deploy a new Web App version.

How to roll back to the previous one if something breaks.

5. When and how to coordinate with the KB
Changes in this repo must stay aligned with the Ringwheel KB.

5.1 Always read before high-risk work
Before any non-trivial change (spin logic, schema, backend API):

Confirm which repo/branch/environment is in scope.

Read:

kb/Ringwheel_KB_01_AI_Development_Working_Agreements.md

kb/Ringwheel_Master_Guide_v1.md

kb/Ringwheel_README_Using_The_KB.md

5.2 Recognize high-risk categories
Treat the following as high-risk, requiring a clear plan, tests, and rollback instructions:

Changes to how spins are selected or logged.

Changes to roster / rings / settings / spins schemas.

Changes to Apps Script routes or auth handling.

Anything that might bias selection or break the spinner mid-class.

5.3 Emitting KB update suggestions
If your work introduces new canonical behavior (new spin mode, new logging fields, new schema contracts) that is not reflected in the KB:

Call that out in your summary and suggest updates to:

Ringwheel_Master_Guide_v1.md (behavior/architecture/fairness).

Ringwheel_KB_01_AI_Development_Working_Agreements.md (if collaboration rules changed).

Any schema/API reference file in kb/ (if present).

Do not edit KB files from within automated code tasks unless the change request explicitly includes documentation updates.

6. Preferred workflow for non-trivial tasks
For any task that is more than a tiny tweak, follow this shape:

Plan

Summarize the requested change.

List the files you expect to inspect or modify.

Call out risk level (low/medium/high) and why.

For high-risk tasks, specify:

How to test.

How to roll back.

Inspect

Open relevant code files and KB sections.

Confirm assumptions before editing (e.g., API routes, schema shapes, props).

Implement

Keep diffs focused.

Follow existing patterns for API calls, RNG usage, and state management.

Avoid speculative refactors mixed into feature work.

Verify

Run appropriate commands (npm run build, npm run lint, etc.) if available.

Describe manual test steps:

Example: “Hit /health endpoint in browser and confirm { status: 'ok' }.”

Example: “Load frontend, pick demo class, run 3 spins, confirm logs appear in SpinsLog sheet.”

Summarize

Provide a short “What changed / Why it’s safe” summary.

Call out any expected KB updates.

7. Keeping AGENTS.md in sync
Update this file when:

New directories or core files are added that agents should know about (e.g., src/spin-engine/, schema/SpinsLog_v2.csv).

Environment handling changes in important ways (different API base URL mechanism, different auth).

We add major new features that have their own workflows (e.g., “teams mode,” “no-repeat mode,” teacher dashboard).

When updating AGENTS.md in ways that reflect new behavior or contracts, also:

Suggest KB updates (Master Guide and Working Agreements) so the global project docs stay aligned.

