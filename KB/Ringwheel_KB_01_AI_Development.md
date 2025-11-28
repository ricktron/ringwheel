<!-- FILE: Ringwheel_KB_01_AI_Development_Working_Agreements.md -->

# Ringwheel_KB_01 - AI Development Working Agreements  
_Last updated: 2025-11-28_

These agreements describe how AI tools should work with Rick on Ringwheel, the classroom spinner tool  
(Apps Script Web API + frontend + CSV / Sheets schemas).

They apply across all Ringwheel repos and environments.

---

## 1. Purpose and scope

- Make Ringwheel changes predictable, reversible, and well-documented.  
- Encode Rick’s preferences so different tools behave consistently.  
- Ensure all work stays aligned with:
  - `Ringwheel – Master Guide v1`  
  - The live Ringwheel backend (Apps Script Web App + Sheets / CSV schemas).

This doc is not a product spec.  
It is a collaboration contract between Rick and AI tools that touch Ringwheel.

---

## 2. Roles and tools

Assume the following roles unless a specific task says otherwise.

### 2.1 ChatGPT (this assistant)

- Primary for:
  - System design and architecture discussions.  
  - Specs, KB files, and runbooks.  
  - High-level API and schema design.  
  - Refactoring plans and migration strategies.
- Should:
  - Propose plans before executing non-trivial work.  
  - Keep Ringwheel KB and Master Guide in mind.  
  - Flag KB drift and add **KB UPDATE NEEDED** blocks when needed.

### 2.2 Repo-focused code agent (Claude Code / “Codex” / equivalent)

- Primary for:
  - Multi-file edits in the Ringwheel repo.  
  - Large refactors, new modules, and coordinated code changes.  
  - Running tests, linters, and build commands in a dev container.
- Should:
  - Use prompts produced by ChatGPT when possible.  
  - Avoid speculative changes; follow the spec and KB.  
  - Summarize file-level changes in a way that is easy to paste back into KB.

### 2.3 GitHub Copilot / Copilot Chat

- Primary for:
  - Inline suggestions while Rick is editing files locally.  
  - Small refactors and local improvements inside a single file.
- Should:
  - Be treated as “helper,” not source of truth.  
  - Follow the patterns and contracts described in the Ringwheel Master Guide and this doc.

### 2.4 Apps Script editor and Google-side tooling

- Used for:
  - Editing `Code.gs` and other Apps Script backend files.  
  - Managing web app deployments and secret storage.  
  - Connecting Sheets / Drive files and the Ringwheel API.

Any time a tool proposes Apps Script changes, it should also propose:

- How to deploy (new version vs overwrite).  
- How to roll back if something breaks in class.

### 2.5 Other tools and sources

- Web search:
  - Use for general JS/TS/React/Apps Script questions.  
  - Do not override project-specific contracts from the Ringwheel KB.
- Prior chats and internal memories:
  - Useful context, but never binding if they conflict with this doc or the Master Guide.

---

## 3. Order of precedence (sources of truth)

When information conflicts, prefer sources in this order:

1. **Live Ringwheel backend and data**  
   - What the Apps Script Web App and backing Sheets / CSV files actually do today.  
   - How the frontend currently behaves against that backend.

2. **Ringwheel – Master Guide v1**  
   - Intended architecture, behavior, and classroom use.  
   - Canonical description of spin rules and fairness.

3. **Repo main branch**  
   - Implementation reality (code and configuration).

4. **This Working Agreements doc and `Ringwheel_README_Using_The_KB.md`**  
   - How we collaborate and how the KB should be used.

5. **Older KB docs, prior chats, internal tool memories**  
   - Advisory only. Use them for context, not contracts.

When live behavior and the Master Guide disagree:

- Treat live behavior as truth for **what exists right now** and what students see.  
- Treat the Master Guide as truth for **intent**.  
- Do not silently “redefine” the spec in the KB.
- Instead:
  - Propose whether implementation should move toward the spec,  
    or the spec should be updated to match reality.  
  - Add a **KB UPDATE NEEDED** block at the end of the reply listing the files that need edits.

For core changes to tool roles, fairness rules, or schema contracts, the assistant may use:

`***URGENT*** <filename> MUST BE UPDATED!`

in that block.

---

## 4. Rick-specific interaction style

Tools should assume the following preferences on Ringwheel:

- **Plan first**  
  - For any non-trivial change: provide a short numbered plan and call out risky assumptions, then execute.  
  - “Non-trivial” includes anything touching:
    - Spin logic or fairness.  
    - Backend APIs / Apps Script.  
    - CSV / Sheet schemas.  
    - Auth or tokens.

- **Direct, low-fluff communication**  
  - Casual-professional tone.  
  - Avoid hype language and filler.  
  - Say what is actually true; if something is uncertain, say that.

- **Export-ready artifacts**  
  - When creating tests, docs, prompts, or schemas, package them so Rick can save or paste them directly.  
  - For larger artifacts, include a short “Export rubric” with filename, path hint, and quick validation steps.

- **Verification mindset**  
  - Include quick sanity checks and test steps with any code or config:
    - Example: “Hit `/api/health` and verify `status: ok`.”  
    - Example: “Load the spinner with demo data and confirm spins still complete.”

- **Respect for classroom constraints and fairness**  
  - Treat anything that affects which student is chosen, how often, or how random it feels as sensitive.  
  - Be careful with changes that might:
    - Bias selection toward or against specific students.  
    - Break or bypass “no repeats” or similar fairness rules.  
    - Leak identifiable student information beyond what Rick expects.

- **No-breaking-changes during class**  
  - Assume there is a “do no harm” window while classes are actively using Ringwheel.  
  - Do not propose changes that could break the spinner mid-class unless clearly labeled as:
    - “Do this only outside class time”  
    - With a rollback plan.

---

## 5. Working agreements by change type

### 5.1 Schema and logging changes (highest risk)

Examples: new columns in `Roster.csv`, `Rings.csv`, `Settings.csv`, `SpinsLog.csv`; changes to required columns; new backing Sheets.

Required:

- High-level description:
  - What behavior changes and why the schema must change.  
- Concrete spec:
  - New / changed columns, types, defaults, and nullable rules.  
- Migration approach:
  - Prefer additive, backward-compatible changes.  
  - Migrations or scripts to backfill / clean data if needed.  
- Sanity checks:
  - How to spot rows that violate the new contract.  
  - How to validate that the frontend and API still agree on shape.

Never silently repurpose an existing column.  
If semantics change, document it clearly and treat it as a breaking change.

### 5.2 API / backend changes (Apps Script Web App)

Examples: new routes, new query parameters, auth changes, response shape changes.

Required:

- Route spec:
  - Path, method, parameters, auth requirements.  
  - Request and response examples.  
- Backwards compatibility:
  - Avoid breaking existing frontend code without a clear plan.  
  - If breaking changes are unavoidable, note exactly which components will break and how to migrate them.  
- Testing:
  - At least one suggested manual test per new / changed endpoint.  
  - Health check guidance if a deployment fails.

Auth and token handling must not be “guessed.”  
If details are unknown, call that out explicitly and do not invent them.

### 5.3 Frontend behavior and UI logic

Examples: new spin modes, rules for combining rings, “no repeat” options, filters for which students can be selected.

Required:

- UX description:
  - What the teacher sees and can do that is new or different.  
- Logic description:
  - How the spin is computed, including any constraints (no repeats, weighting).  
- State and data flow:
  - What data is fetched from the API and when.  
  - What is cached in the client, and for how long.

Frontend changes that affect which student is picked or how often they appear are treated as fairness changes and should be handled carefully.

### 5.4 UI copy, layout, and styling-only changes

Examples: wording tweaks, color palette adjustments, small layout improvements.

Required:

- Short description:
  - What was changed and why (clarity, readability, projector visibility, etc).
- Visual check:
  - Guidance for Rick to confirm it looks good on a projector and at different font sizes.

These are low risk, but still need a quick human verification step.

### 5.5 KB, prompts, and documentation changes

Examples: updates to this doc, Master Guide, README, or code comments that encode behavior.

Required:

- Call out whether the change:
  - Reflects reality (catching the docs up to behavior), or  
  - Sets a new intended behavior that the code does not yet implement.
- If the latter:
  - Propose the implementation steps and where they should be tracked (feature bank, issue, etc).

Any time a conversation establishes a new “canonical” behavior that is not already in the KB, the assistant must add a **KB UPDATE NEEDED** block naming the relevant file(s).

---

## 6. Session bootstrapping checklist

Before making non-trivial changes for Ringwheel, tools (or humans) should:

1. **Identify the repo and environment**  
   - Confirm which Ringwheel repo / branch is in scope.  
   - Note whether you are talking about:
     - Local dev  
     - Staging / preview  
     - Production (used in class)

2. **Load core Ringwheel context**  
   - `Ringwheel – Master Guide v1`  
   - `Ringwheel_KB_01_AI_Development_Working_Agreements.md` (this file)  
   - `Ringwheel_README_Using_The_KB.md`  
   - Repo-local `AGENTS.md` or similar, if it exists

3. **Clarify risk level**  
   - Is this:
     - Docs / prompts only  
     - Frontend-only behavior  
     - Backend / API  
     - Schema / logging  
   - If it affects fairness or classroom stability, treat it as high risk.

4. **Outline a plan**  
   - At least 3–5 bullets:
     - What will be changed  
     - In what order  
     - How it will be tested  
     - How to roll back if something breaks

5. **Summarize results at the end**  
   - Short “Session summary” block with:
     - Files touched  
     - Behavior changes  
     - Tests suggested  
     - Any KB drift and a **KB UPDATE NEEDED** block if applicable

---

## 7. KB update rules and “KB UPDATE NEEDED” blocks

Update **this file** when:

- Tool roles or preferences for Ringwheel change.  
- Workflow between ChatGPT, repo-focused agents, Copilot, and Apps Script changes.  
- The risk classification for change types needs adjustment.

Update **Ringwheel – Master Guide v1** when:

- Architecture, spin rules, classroom flows, or view / schema contracts change.  
- New modes, rings, or classroom patterns are introduced.  
- New pitfalls or sanity checklists are discovered.

Update **Ringwheel_README_Using_The_KB.md** when:

- The set of core Ringwheel KB files changes.  
- The recommended loading / boot sequence evolves.

### 7.1 When to say “KB is stale”

The assistant should consider the KB stale and flag it when:

- New endpoints, columns, or behaviors are discussed in chat that are not described in the relevant KB files.  
- The described current behavior conflicts with what the Master Guide or this doc claims.  
- Rick explicitly says “we changed this recently” and the KB still shows the old version.

When that happens, the assistant must:

1. Treat the described live behavior as truth for existence.  
2. Treat the Master Guide and this file as truth for intent, unless Rick says intent has changed.  
3. End the reply with a **KB UPDATE NEEDED** block, for example:

   ```md
   ---

   KB UPDATE NEEDED

   - Ringwheel_Master_Guide_v1.md
     - Document: new spin mode `no_repeat_this_period`.
     - Add: rules for when and how it applies.

   - Ringwheel_Schema_And_API_Reference.md
     - Update: `SpinsLog` schema to include `spin_mode`.
For especially critical changes (tool roles, fairness, auth, or schema contracts), the assistant may instead or additionally use:

md
Copy code
---

***URGENT*** Ringwheel_KB_01_AI_Development_Working_Agreements.md MUST BE UPDATED!
- Tool workflow changed (for example, new primary repo agent).
The assistant should not spam this block when nothing material has changed.
Only use it when there is real drift.

8. Export rubric
Filename: Ringwheel_KB_01_AI_Development_Working_Agreements.md

Path hint: Root of the Ringwheel KB folder or equivalent KB store.

Format: Markdown, UTF-8.

Must reference:

Ringwheel – Master Guide v1

Ringwheel_README_Using_The_KB.md

Quick validation steps:

Open the file and confirm the “Last updated” date is current.

Confirm section headings roughly match:

Purpose and scope

Roles and tools

Order of precedence

Rick-specific interaction style

Working agreements by change type

Session bootstrapping checklist

KB update rules and “KB UPDATE NEEDED” blocks

Export rubric

In a fresh Ringwheel-oriented chat, load:

This file

The Ringwheel Master Guide

The Ringwheel KB README

Then ask the assistant to summarize how it should work;
confirm the summary matches your expectations.

<!-- END FILE: Ringwheel_KB_01_AI_Development_Working_Agreements.md -->