<!-- FILE: Ringwheel_Master_Guide_v1.md -->

# Ringwheel – Master Guide v1  
_Last updated: 2026-11-25_  
_Version: 1.1 (adds Local Mode, Connected Mode, local data and backups, and the open approval gates)_  
_Baseline: 1.0, 2025-11-28. The 1.0 text is kept as written. Additions are marked "added in v1.1" or "v1.1 note"._

This Master Guide is the canonical description of how Ringwheel is intended to work:

- What Ringwheel is for.  
- How the system is structured.  
- Key behaviors (especially spin rules and fairness).  
- Core data model and contracts at a conceptual level.  
- Operational expectations (testing, deployment, classroom safety).

It should be used together with:

- `Ringwheel_KB_01_AI_Development_Working_Agreements.md`  
- `Ringwheel_README_Using_The_KB.md`

Those files define how we collaborate and how to use the KB; this file defines what Ringwheel **is** and **does**.

Supporting references in the repository (added in v1.1). Detail lives there. Intent lives here, and this guide wins if they disagree:

- `docs/LOCAL_MODE.md`: the two storage modes, the local data model, backup and restore.  
- `docs/CONSOLIDATION.md`: the spin rules as implemented and the decision table D1 to D15.  
- `docs/SECURITY.md`: where credentials may and may not live.  
- `docs/VERCEL.md`: static hosting.  
- `docs/verification.md`: the before-class checklist.

File name note: in this repository the Working Agreements file is `KB/Ringwheel_KB_01_AI_Development.md`.

---

## 1. Overview and goals

### 1.1 What Ringwheel is

Ringwheel is a classroom spinner tool for teachers. It replaces popsicle sticks and ad-hoc randomization with:

- A configurable, multi-ring spinner displayed on the projector.  
- A roster-driven selection system that knows who is in each class.  
- Logging of spins for later analysis (who was picked, when, using which configuration).

Primary audience: **teacher at the front of the room.**  
Secondary audience (planned, not yet spec’d): future student-facing views (for example, history of spins for a class or aggregated stats).

### 1.2 Core goals

Ringwheel exists to:

- Make student selection **fast**, **fair**, and **visible** to the whole class.  
- Preserve a basic record of selections and metadata (who, when, from which ring config).  
- Let Rick experiment with different selection patterns (rings) without needing code changes each time.

### 1.3 Non-goals (for v1)

Ringwheel **does not** (for v1):

- Handle student authentication or per-student logins.  
- Persist detailed behavior analytics or grading information.  
- Replace gradebook or attendance systems.  
- Guarantee complex probabilistic fairness beyond what is documented in Section 7.

Those may become future features, but they are outside this v1 guide.

> **v1.1 note.** Ringwheel also has no accounts and no server of its own. The place the app is served from holds no class data (Section 4.3).

---

## 2. Canonical truths and constraints

These are the “do not break without a discussion” rules.

1. **Teacher-operated, projector-first**  
   - The primary usage is a teacher running Ringwheel on a laptop/iPad, visible to the whole class via projector.

2. **Roster-driven selection**  
   - Ringwheel must respect the active roster for the selected class/period.  
   - No student should be selected if they are not on the roster or have been explicitly marked inactive.

3. **Fairness and transparency**  
   - The spin should *feel* random and be defensible as fair given the documented rules in this guide.  
   - Any rule that biases selection (weights, no-repeat, exclusion) must be documented and visible to Rick.

4. **No mid-class breaking changes**  
   - Changes that can break spinning, rosters, or basic UI must not be applied while class is actively using Ringwheel.  
   - See the Working Agreements for “do-no-harm” expectations.

5. **Logs are conceptually append-only**  
   - Spin logs are treated as historical records.  
   - Fixing bad logs is allowed, but the default pattern is append, not overwrite-in-place.

6. **Docs vs implementation**  
   - Live backend behavior and data reflect what exists; this Master Guide reflects intent.  
   - When they disagree, we flag drift and decide whether to change code or update docs.

Items 7 to 12 were added in v1.1. They carry the same weight as items 1 to 6.

7. **Local Mode is the default**  
   - A first-time visitor can use Ringwheel with no account, no backend and no token.  
   - In Local Mode nothing is sent anywhere. Class data stays in the teacher's browser.

8. **Connected Mode is an explicit choice by the teacher**  
   - It turns on only when the teacher enters their own backend address and token on the Admin page.  
   - Nothing in a build, a deployment setting, a web address or a first visit can turn it on.  
   - Credentials never belong in source code, in a compiled frontend build, in a `.env` file or in a hosting environment variable.

9. **One place is in charge of the data at a time, and the app says which**  
   - Either the browser (Local Mode) or the teacher's Google Sheet (Connected Mode).  
   - Switching modes never copies or merges data in either direction.

10. **Teacher data in the browser is never silently overwritten, migrated or discarded**  
    - Deleting or replacing a class keeps a recovery copy and can be undone.  
    - A delete, replace or undo is refused, with nothing changed, if the class changed in another tab after the teacher last saw it. A newly logged spin counts as a change.  
    - A backup file is checked completely before a restore changes anything.

11. **Never claim more than is known**  
    - A spin is shown as saved only when it was saved (Section 6.2).  
    - A backup is shown as made only when the teacher confirms they have the file. Ringwheel cannot see the downloads folder.

12. **Fairness behavior changes only with the teacher's approval**  
    - The open decisions are listed in Section 7.5. Until one is decided, today's behavior stays and its switch stays off.

---

## 3. Change history (high level)

This section records major shifts in Ringwheel’s design and behavior. For v1, this is intentionally coarse.

### 3.1 v1.0 – Documentation baseline (2025-11-28)

- Established core KB trio:
  - Working Agreements  
  - Master Guide v1 (this file)  
  - README – Using The KB
- Defined Ringwheel’s scope as a teacher-first classroom spinner tool.  
- Documented at a high level:
  - Architecture (Apps Script API + frontend + CSV/Sheets).  
  - Conceptual data model (Roster, Rings, Settings, SpinsLog).  
  - Seeded RNG and fairness concepts.  
  - Operational “do-no-harm” expectations.

Future changes (new spin modes, schema changes, new views) should be added as subsections here with date and short description.

### 3.2 v1.1: Local Mode, Connected Mode and approval gates (2026-11-25)

What happened in the product since 1.0:

- **2026-11-24, repository consolidation (PR #8, merged).** One spin engine, one API client and one backend (`gas/Code.gs`). Save status is shown in words (saved, incomplete, NOT SAVED). Admin saves are refused if the Sheet changed after the page loaded. The owner approved decisions D12 to D15 in the merge and kept every other policy and production gate.  
- **Local-first foundation (PR #9).** Local Mode became the default. Connected Mode became an explicit setting made by the teacher. Local classes with stable student identifiers and an "In queue" flag. Browser storage (IndexedDB). JSON backup and restore, CSV export. A `vercel.json` for static hosting. The frontend no longer reads any build-time configuration.  
- **2026-11-25, data-integrity correction (PR #9).** Destructive actions are checked against what the teacher was looking at and made in one step with their recovery copy. A backup is recorded only when the teacher confirms they have the file.

What changed in this guide:

- Added: Section 2 items 7 to 12, and Sections 4.3, 4.4, 5.5, 5.6, 6.4, 7.5, 8.4.  
- Added short "v1.1 note" lines where the 1.0 text describes only the Google Sheets path.  
- No 1.0 text was removed or reworded. The only 1.0 lines touched are the date and version at the top, and one sentence appended to the path hint in Section 11.

What did not change:

- The spin engine and the Ecology selection rules.  
- Decisions D1 to D11. They are recorded in Section 7.5 as open. This update decides none of them.

Not built, and not described here as existing: Presentation Draw and the Theme Engine.

---

## 4. Architecture and data flow

### 4.1 High-level components

Ringwheel consists of:

1. **Frontend app**  
   - A browser-based UI (React or similar) that:
     - Lets the teacher pick class/period.  
     - Shows the multi-ring spinner.  
     - Allows configuration of rings and settings (within UI constraints).  
     - Displays spin results and basic history.

2. **Apps Script Web App (backend API)**  
   - Exposes HTTP endpoints for:
     - Health checks.  
     - Reading roster, rings, and settings.  
     - Writing rings and settings.  
     - Logging spins.  
     - Sending optional emails (e.g., debug or error alerts).
   - Reads/writes from Google Sheets or CSV-like structured data as its storage layer.

3. **Data storage (Sheets/CSV)**  
   - Conceptual CSVs:
     - `Roster`  
     - `Rings`  
     - `Settings`  
     - `SpinsLog`  
   - Physically implemented as Google Sheets tabs or files in Drive.

4. **Deployment and hosting**

   - Backend: Google Apps Script Web App deployments, configured with appropriate access level.  
   - Frontend: Hosted as static files (GitHub Pages, Vercel, Netlify, etc.) or bundled into Apps Script HTML service.  
   - This v1 guide does **not** lock in a specific frontend hosting vendor.

> **v1.1 note.** Items 2 and 3 describe Connected Mode only. In Local Mode there is no backend and no Sheet (Section 4.3). Hosting is still not locked to a vendor: the repository carries a `vercel.json` so the static build can be served by Vercel, and the same build works on any static host. Hosting holds no class data and no credentials.

### 4.2 Typical runtime flow

1. Teacher visits Ringwheel frontend.  
2. Frontend calls API `GET /health` to confirm backend is alive.  
3. Frontend calls API `GET /roster` to retrieve list of available classes/periods and students.  
4. Frontend calls API `GET /rings` and `GET /settings` to retrieve:
   - Current ring definitions.  
   - Current global / per-class settings.

5. Teacher selects a class and ring configuration, then initiates a spin.  
6. Frontend uses the spin engine (seeded RNG + ring logic) to calculate the spin result.  
7. Frontend posts the result to the API via `POST /logspin` (or equivalent), including:
   - Who was selected (if applicable).  
   - Which ring configuration was used.  
   - Timestamp and any relevant metadata (e.g., seed used).

8. Backend appends the spin record into `SpinsLog` storage.  
9. UI updates to show the result and, optionally, recent spins.

> **v1.1 note.** This is the Connected Mode flow, and the paths are conceptual. For Local Mode see Section 4.4.

### 4.3 Storage modes (added in v1.1)

Ringwheel keeps classroom data in one of two places. Every page says which one is in charge.

**Local Mode (the default).** Classes, rosters, settings and spin history are kept in the teacher's browser. No account, no backend, no token. No network request is made.

**Connected Mode (optional).** A teacher who runs their own Ringwheel Google Sheet enters their backend address and token once on the Admin page. From then on that browser reads from and writes to that Sheet through the teacher's Apps Script backend, exactly as described in 4.1 and 4.2.

How the mode is decided:

- It is Local unless the teacher turns Connected Mode on from the Admin page with a complete address and token.  
- One exception, so an existing setup does not break: a browser that already holds a complete connection saved from the Admin page before Local Mode existed keeps using it.  
- Switching back to Local Mode is one button. The saved connection stays in the browser but is not used.  
- Both modes use the same spin engine. The mode changes where data is kept. It never changes how a result is chosen.

Three things that are easy to confuse:

| | What it is | Holds class data? | Holds credentials? |
| --- | --- | --- | --- |
| **Browser storage** (Local Mode) | A database inside the teacher's browser (IndexedDB), on that device, for that site address | Yes: classes, rosters, settings, spin history, recovery copies | No |
| **Connected Mode** | The teacher's own Google Sheet, reached through their own Apps Script backend | Yes: the Sheet is the record | The token lives in the Apps Script project's properties and in the browser where the teacher typed it. Nowhere else. |
| **Hosting** | The place the app's static files are served from (Vercel or any static host) | No, never | No. No environment variables, no server code. |

Consequences worth remembering:

- Changing or redeploying hosting does not move, copy or delete class data.  
- Local data belongs to one browser profile on one device at one site address. The same teacher in another browser, another profile, another device, or at a different address (for example a preview address and a production address) starts empty until a backup file is restored there.  
- Local classes are never sent to a Sheet, and Sheet data is never written into a local class.

### 4.4 Local Mode runtime flow (added in v1.1)

1. Teacher opens Ringwheel. The app opens browser storage. On a first visit it creates an empty starter class called "My class".  
2. The page shows "Local Mode", the class in use, and "Browser storage: working".  
3. Teacher picks a class and, if it has a roster, loads the queue: the students whose "In queue" flag is on.  
4. Teacher spins. The same spin engine as Connected Mode decides the result.  
5. The spin is added to that class's history in browser storage and the result panel says "Saved in this browser". If the save fails the panel says NOT SAVED.  
6. No step makes a network request, so Local Mode keeps working if the network drops after the page has loaded.

---

## 5. Data model and key objects (conceptual)

This section describes entities **conceptually**. It is intentionally high-level.

- Exact column names, types, and encoding details belong in a supporting reference like `Ringwheel_Schema_And_API_Reference.md` if/when that file exists.  
- The Master Guide should remain stable even if low-level schema evolves.

### 5.1 Roster

Represents students (and possibly staff) who may be selected by the spinner.

Conceptual fields:

- **Person identifier** (stable across sessions; not necessarily a student ID number, but must be consistent).  
- **Display name** (what appears on the spinner and UI).  
- **Class/Period association** (e.g., A Period, B Period).  
- **Status** (active/inactive; inactive entries should never be selected).

Assumptions:

- A person can appear in more than one class/period.  
- The roster is maintained or imported externally and then used by Ringwheel via the `Roster` schema.

> **v1.1 note.** Both the stable person identifier and the active or inactive status exist in Local Mode (Section 5.5). The Sheet roster used by Connected Mode has neither: a student there is recognized by email and period, and the only way to leave a student out is to remove the row. Closing that gap is open decision D8 (Section 7.5).

### 5.2 Rings

Represents one or more configurable rings and their slices.

Conceptual fields per record:

- **Ring identifier or name** (e.g., “Student Ring,” “Task Ring,” “Points Ring”).  
- **Slice label** (what appears on that slice of the ring).  

Optional conceptual metadata:

- **Weight or frequency** (if unequal slice probabilities are ever supported).  
- **Enabled/disabled** flag for slices.  
- **Order index** or grouping, if needed.

Ring definitions are used by the frontend spin engine to draw visuals and compute results.

### 5.3 Settings

Represents configuration values that are not inherently tied to a single ring or student.

Conceptual fields:

- **Key** (string, e.g., `default_class`, `allow_back_to_back`).  
- **Value** (string/number/boolean encoded at storage layer).  

Optional:

- **Scope** (global vs per-class or per-teacher).  
- **Description** (human-readable explanation).

Settings allow Ringwheel behavior to evolve without hard-coding everything into the frontend.

### 5.4 SpinsLog

Represents the historical record of spins.

Conceptual fields:

- **Timestamp** of spin.  
- **Class/Period** context.  
- **Selected person identifier** (if a student was selected).  
- **Ring configuration identifier(s)** (which ring or combo of rings was used).  
- Optional:
  - **Spin seed** (if the frontend logs the RNG seed used).  
  - **Spin duration** (for UX debugging).  
  - **Flags** (e.g., “manual override,” “test spin”).

SpinsLog is intended to be conceptually append-only. Cleanup and archival is allowed but should preserve real classroom history.

### 5.5 Local Mode data (added in v1.1)

Exact field names live in `docs/LOCAL_MODE.md` and `src/data/local/schema.ts`. Conceptually:

**Class (called a workspace in the code).**

- One self-contained unit: name, roster, settings, ring weights and spin history.  
- A teacher can have any number of classes. Classes never share students, settings or history.  
- Each class has a permanent identifier and a revision number that goes up with every roster, settings or name change. An edit made on top of an older revision (for example from a second tab) is refused instead of overwriting.

**Student.**

- **Stable identifier.** Created when the student is added. Unique within the class. Not derived from the name or the email, and it does not change when either is corrected.  
- Spin records carry that identifier, so a student's history follows them through a name correction.  
- Removing a student from the roster leaves their past spins in the history.  
- On import, the same student is recognized by email when both entries have one, and otherwise by name. That is only used to avoid adding someone twice. It is not the identifier.

**Eligibility.**

- Each student has an "In queue" flag. Students with the flag on are queued for a spin.  
- A student with the flag off stays on the roster, keeps their history, and is never queued.  
- This is the Local Mode form of the active or inactive status in Section 5.1.

**Spin record.**

- The same fields as a `SpinsLog` row (Section 5.4), plus its own identifier, the class it belongs to, and the student's identifier when there was one.  
- Append-only. Local storage has no operation that edits a spin.

**Versioning.**

- Stored classes and backup files carry a version number. Data written by a newer version of Ringwheel is refused with a clear message. It is never half-read.

**Persistence (IndexedDB) and its limits.**

Browser storage does survive: reloading the page, closing the tab, and restarting the browser or the computer.

Browser storage does **not**:

- Sync between devices, browsers or browser profiles.  
- Follow the teacher to a different site address.  
- Survive "clear site data", or a private or incognito window being closed.  
- Come with a guarantee. A browser that is short of space may remove it. The Classes page lets the teacher ask the browser to protect the data, and the browser is allowed to say no.

Also:

- If the browser refuses storage altogether, Ringwheel still runs, says in red that nothing will be kept after the tab closes, and tells the teacher to download a backup before leaving.  
- Two tabs in the same browser share the same data. Spins logged from both are all kept. A stale edit, delete, replace or undo from one tab is refused rather than applied over the other tab's work.

**Browser storage is therefore not a backup.** Section 5.6 is the backup.

### 5.6 Backup, restore and export (added in v1.1)

Everything here is on the Classes page and applies to Local Mode. In Connected Mode the Sheet is the record.

**JSON backup file.**

- Holds one class or all classes completely: roster with identifiers, settings, ring weights and full spin history.  
- It contains student names. Store it as you would a gradebook.

**What "backed up" means.**

- Ringwheel hands the file to the browser and then asks whether it saved. It cannot see whether a download was blocked, cancelled or failed.  
- A backup is recorded only when the teacher answers that they have the file, or when a class is restored from a file.  
- The status reads "No confirmed backup", "Last confirmed backup: today" (or the number of days), or "Not in a confirmed backup: N spins and roster or settings changes".  
- "Confirmed" is the teacher's statement. Ringwheel does not claim to have verified a file on disk.

**Restore.**

- The whole file is checked first. One problem anywhere rejects the file and changes nothing.  
- **Add** never changes anything already in the browser. A class that is already there is added beside it as a copy.  
- **Replace** swaps a class for the version in the file and keeps the replaced version as a recovery copy.  
- Back up, delete everything, restore: the data comes back identical, identifiers, timestamps and seeds included.

**Recovery copies.**

- Deleting or replacing a class keeps a copy, taken in the same step as the change. The newest five are kept.  
- "Put it back" undoes the delete or replace. The undo is itself undoable.  
- Recovery copies live in the same browser storage, so they protect against a mistaken click, not against losing the browser's data.

**Delete everything.** Needs a typed confirmation, removes recovery copies too, and cannot be undone.

**CSV export.**

- Spin history and roster can be downloaded as ordinary spreadsheets for classroom records.  
- CSV is for reading. Only the JSON backup can restore a class with its history.  
- A roster CSV (a name column, optionally email) can be imported into a class. The import shows what would be added and what would be skipped before anything is added.

---

## 6. User-facing flows and behaviors

### 6.1 Teacher: basic flow

Core “happy path” for a typical class:

1. **Select class/period**
   - Teacher selects from a list of available classes based on the roster.

2. **Load ring configuration**
   - Ringwheel loads the default ring configuration for that class (or a global default if class-specific is not set).  
   - Teacher may optionally adjust ring settings within allowed UI controls.

3. **Run a spin**
   - Teacher hits “Spin” (or equivalent control).  
   - Rings animate and a result is chosen by the spin engine.

4. **Display result**
   - Selected student (or outcome) is clearly highlighted on the projector.  
   - If the spin selects a student, their name should be unambiguous.

5. **Log spin**
   - Spin information is sent to the backend and appended to `SpinsLog`.  
   - Minimal latency is preferred, but UI should not freeze if logging is slightly delayed.

6. **Repeat**
   - Teacher can run multiple spins per class, with or without adjusting rings.

### 6.2 Error and offline behavior (v1 expectations)

- If the backend API is unavailable:
  - UI should show a clear error and avoid pretending that spins are logged.  
  - If reasonable, a local-only spin could still run, but it must be clear that logs are not being saved.

- If roster or rings fail to load:
  - Show a friendly error and do not perform spins on partial/broken data.

> **v1.1 note.** In Local Mode there is no backend to be unavailable. The matching rules are: a spin that could not be stored is shown as NOT SAVED, and a browser that is not keeping data says so on every page. For Connected Mode, what happens when settings cannot be loaded differs from the second bullet above. That is open decision D5 (Section 7.5).

### 6.3 Future flows (not yet implemented)

Potential future flows (not spec’d in detail here):

- Per-student “history in this class” view.  
- “Who hasn’t been picked recently?” summary.  
- Advanced spin modes (e.g., teams, groups, or weighted selection).

When these are implemented, they should be added as new subsections with explicit behavior.

### 6.4 Teacher: Local Mode flow (added in v1.1)

1. **Open Ringwheel.** No sign-in and no setup. The page says "Local Mode" and names the class in use.  
2. **Set up a class (once).** On the Classes page: name the class, then type students in or import a roster CSV. Untick "In queue" for anyone who should stay on the roster but not spin.  
3. **Spin.** Pick the class, load the roster, press Next Spinner, then Spin. The result panel says "Saved in this browser".  
4. **Back up.** On the Classes page, download a backup, check the file is where downloads go, and answer "Yes, I have the file". Until that answer the class shows as not backed up.  
5. **Move or recover.** In another browser or on another computer, open Ringwheel, go to Classes, and restore the backup file.

A teacher who wants the Google Sheet instead turns on Connected Mode on the Admin page (Section 4.3). From then on Sections 6.1 and 6.2 describe the flow.

---

## 7. Spin rules and fairness

This section describes how Ringwheel is **intended** to make choices, and what “fair” means for v1.

### 7.1 RNG approach (v1)

- The frontend uses a **seeded random number generator** for spins.  
- The exact seed recipe (which inputs are used) is defined at the spin-engine level and may evolve, but must follow these constraints:
  - Given an eligible set of outcomes, the RNG is unbiased over that set.  
  - Seed-handling does not introduce obvious bias toward any student or outcome.

### 7.2 Eligible set for selection

For any spin that selects a student:

- Eligible set is derived from:
  - Active roster entries for the chosen class/period.  
  - Any configured filters (e.g., “exclude inactive,” “exclude flagged,” if such features exist).

The spin engine must **not** select:

- Students who are not on the roster for that class.  
- Students explicitly marked as inactive or excluded.

> **v1.1 note.** How a student is chosen today: Ringwheel does not pick a student at random. The teacher loads a class queue, alphabetical or shuffled, and each queued student takes one turn (recorded as D4 in Section 7.5). The spin decides the Ecology result (region, taxon and conservation status), not the student. In Local Mode the queue is the students of the selected class whose "In queue" flag is on. In Connected Mode it is the Sheet roster rows for the chosen semester and period.

### 7.3 Multi-ring behavior (conceptual)

Ringwheel supports the idea of multiple rings (for example, student ring + task ring). Conceptually:

- Each ring is defined as a set of slices.  
- A spin may:
  - Spin all active rings together, or  
  - Spin only a subset, depending on UI and settings.

For v1 documentation:

- This guide does **not** lock in a single multi-ring rule.  
- Any multi-ring behavior that affects **who** is eligible (not just metadata) must be clearly described in a future revision of this section once implemented.

### 7.4 No-repeat and weighting (future behavior)

As of v1:

- Ringwheel does **not** promise sophisticated “no-repeat” or weighted fairness logic beyond simple random selection from the eligible set.  
- If the implementation currently does anything more advanced, that behavior is **not** considered a stable contract until it is documented here.

When features like no back-to-back, weighted slices, or cooldowns are intentionally added, they should:

1. Be clearly described in this section.  
2. Explain how they impact the probability of selection.  
3. Be reflected in any supporting schema/API reference if new fields are required.

> **v1.1 note.** The implementation applies, and has always applied, a 12% cap on repeated Region and Taxon pairs. By the rule above it is existing behavior and not a stable contract. Whether to keep, change or remove it is open decision D2 (Section 7.5).

### 7.5 Ecology spin rules in force, and approval gates (added in v1.1)

This section records what the Ecology spinner does today and which questions are waiting for the teacher. **It decides none of them.**

**Rules in force.** The same in Local Mode and Connected Mode. Full wording and tests: `docs/CONSOLIDATION.md` section 4 and `src/utils/spin-engine.ts`.

1. Each ring (region, taxon, conservation status) is a pick over its eligible options. Every option has equal odds unless ring weights are switched on.  
2. Plantae is never produced by a random pick.  
3. Pair cap: a Region and Taxon pair is not allowed while its share of the session's normal spins is at or above 12%.  
4. Veto re-spins exactly one ring. The other two stay, and the vetoed ring always changes.  
5. Plantae Mercy sets the taxon to Plantae with the region the teacher picks, keeps the conservation status, and is flagged in the log.  
6. If the rules leave no legal outcome, no spin is made and the page says why. There is no fallback result.  
7. Every random outcome comes from a seed, and the seed in the log reproduces the logged result.

**What a gate means.** For every decision marked Open below, the behavior under "Today" stays exactly as it is until the teacher decides. Where a switch exists, it is off. Nobody, human or AI, changes one of these as a side effect of other work.

D2, D5 and D11 are marked SPECIAL REVIEW because today's behavior is hard to defend or differs from this guide.

| ID | Question | Today | Status |
| --- | --- | --- | --- |
| D1 | Should the pair cap value in Settings be honored? | No. The cap is a fixed 12% unless `usePairCapSetting` is on. | Open. Switch off. |
| D2 SPECIAL REVIEW | What is the pair cap measured over, and should it exist? | Counted over one page load, across every period spun in that time. A reload resets it. Veto and mercy results are not counted. | Open. Not part of the 1.0 guide (Section 7.4). |
| D3 | Should ring weights ever apply? | No, unless `applyRingWeights` is on. | Open. Switch off. |
| D4 | Queue or random student? | Queue. Every queued student spins once. | Open. |
| D5 SPECIAL REVIEW | Spin when settings cannot be loaded? | Yes, with built-in defaults and a red banner. | Open. Differs from Section 6.2. |
| D6 | Plantae Mercy before any spin? | Allowed. Records LC, flagged in the log. | Open. |
| D7 | Second spin for a student who already spun? | Allowed. The page shows a hint. | Open. |
| D8 | Inactive students in the Sheet roster? | Connected Mode has no way to mark one. Local Mode has "In queue". | Open for Connected Mode. Needs a Sheet schema change. Local Mode's flag does not decide it. |
| D9 | `mode` (midterm or final) and "random events"? | Not implemented. | Open. |
| D10 | Spin while a veto ring is selected? | Performs the veto. The button says so. | Open. |
| D11 SPECIAL REVIEW | What counts as "today" in the log view? | Connected Mode: the UTC date. Local Mode: the calendar day on the computer. | Open for Connected Mode. Needs a backend change. Local Mode's behavior does not decide it. |

Approved by the owner on 2026-11-24, in the merge of PR #8 ("Approved D12-D15. Retain all other policy and production deployment gates."):

| ID | Decision in force |
| --- | --- |
| D12 | After a failed save the student's turn is over. The save is tracked and retried separately. |
| D13 | A student listed twice in the roster for one period gets one turn, and the page says a duplicate was ignored. |
| D14 | Settings typed as real TRUE or FALSE cells in the Sheet are read as written. |
| D15 | Auto test spins do not count toward the real pair cap. |

The recommendation and the consequence of each open decision are in `docs/CONSOLIDATION.md` section 5. When the teacher decides one, record the decision and its date here, and update the rules above if the behavior changes.

---

## 8. Environments, deployment, and safety

### 8.1 Environments

Expected environments:

- **Development**  
  - Used for experimenting with UI and API changes.  
  - May point to test Sheets or stub data.

- **Staging / preview** (optional but recommended)  
  - Used to trial new versions with realistic data but without impact on live classes.

- **Production**  
  - Used in actual classrooms.  
  - Bound by “do-no-harm during class” expectations from the Working Agreements.

### 8.2 Deploying backend changes (conceptual)

When deploying new Apps Script code:

1. Deploy as a new version of the Web App.  
2. Verify:
   - `/health` endpoint returns ok.  
   - Basic `GET /roster`, `GET /rings`, `GET /settings` still work.  
3. If anything fails, either:
   - Roll back to the previous version, or  
   - Fix and re-deploy before classroom use.

### 8.3 Deploying frontend changes (conceptual)

When deploying frontend:

1. Build and deploy to hosting provider.  
2. Smoke test:
   - App loads.  
   - Health check passes.  
   - Roster & rings load.  
   - A test spin completes and logs.

If something breaks in production:

- Prefer a quick rollback (previous build) over trying to hotfix during class.

> **v1.1 note.** The health, roster and log checks in step 2 apply to Connected Mode. For Local Mode the smoke test is: the page says "Local Mode" and "Browser storage: working", and a test spin says "Saved in this browser". Both checklists are in `docs/verification.md`.

### 8.4 Hosting, storage and owner-only steps (added in v1.1)

- The frontend is static files. The host holds no class data and no credentials (Section 4.3).  
- The frontend reads no build-time configuration. Do not add an environment variable for a backend address or a token, on any host.  
- On the hosted site a security policy allows network connections only to Google Apps Script addresses. The page cannot send data even to its own host.  
- Deploying a new frontend build does not touch class data in either mode. Moving to a different site address gives Local Mode teachers an empty start there: back up first, restore after.  
- As of this update, no hosted production deployment has been made and no hosting project has been created as part of this work.

Steps only the owner can take, all still open (details in `docs/SECURITY.md`, `docs/VERCEL.md`, `gas/README.md` and `docs/CONSOLIDATION.md` sections 7 and 8):

1. Rotate the backend API token.  
2. Deploy the committed `gas/Code.gs` to the Apps Script project.  
3. Create a hosting project and check a preview.  
4. Decide D1 to D11 (Section 7.5).  
5. Retire the secondary repository.

---

## 9. Testing, monitoring, and troubleshooting

### 9.1 Pre-class quick check

Before using Ringwheel in a live class (especially after recent changes):

1. Load the app and confirm no obvious errors.  
2. Check health endpoint via UI (or a simple curl if needed).  
3. Run one or two test spins on a non-real/demo class, confirm:
   - Animations run.  
   - Spin results appear.  
   - Logs are written (spot-check in `SpinsLog` Sheet).

> **v1.1 note.** In Local Mode there is no Sheet to spot-check. Confirm instead that the page names the class you mean to use, that a test spin says "Saved in this browser", and that the backup line is not warning about work that is in no confirmed backup.

### 9.2 After-change regression checklist

For high-risk changes (schema, API, fairness):

- Confirm:
  - No errors in console or Apps Script logs.  
  - Roster and rings load correctly.  
  - Spin results are reasonable and use the new behavior as intended.

### 9.3 Troubleshooting hints

- If spins are failing:
  - Check network / CORS issues.  
  - Check `/health` on the API.  
  - Check for schema mismatches (added or removed columns) between frontend assumptions and Sheets.

- If selection feels biased:
  - Confirm the roster and any filters are correct.  
  - Review any no-repeat or weighting behavior that may have been added.  
  - Check that RNG usage matches the intended design.

Added in v1.1, for Local Mode:

- If a class or its history seems to be missing:
  - Check it is the same browser, the same browser profile, the same device and the same site address as before.  
  - Check it is not a private or incognito window, and that site data was not cleared.  
  - Restore the latest backup file from the Classes page.

- If the page says a class "changed in another tab or window":
  - That is the protection in Section 2 item 10 working. Nothing was deleted or replaced.  
  - The page now shows the current version. Check it, then repeat the action if you still want it.

- If the page says data is not being kept after the tab closes:
  - The browser refused storage. Download a backup before closing the tab.

---

## 10. Interaction with KB and future evolution

This Master Guide is:

- The main spec for what Ringwheel is supposed to do.  
- A living document that evolves with the product.

For collaboration rules and KB usage:

- See `Ringwheel_KB_01_AI_Development_Working_Agreements.md` and `Ringwheel_README_Using_The_KB.md`.

When new behavior is agreed in a conversation:

- Implementation should follow this guide.  
- If code diverges or new behavior emerges, the assistant should emit a **KB UPDATE NEEDED** block pointing at this file and any others that require edits, as defined in the Working Agreements and KB README.

---

## 11. Export rubric

- **Filename:** `Ringwheel_Master_Guide_v1.md`  
- **Path hint:** `kb/Ringwheel_Master_Guide_v1.md` at the root of the Ringwheel KB folder. In the repository the folder is `KB/`.  
- **Format:** Markdown, UTF-8.

**This file must:**

- Reference (by name):
  - `Ringwheel_KB_01_AI_Development_Working_Agreements.md`  
  - `Ringwheel_README_Using_The_KB.md`  
- Define:
  - Purpose and scope  
  - Canonical truths / constraints  
  - High-level change history  
  - Architecture and data flow  
  - Conceptual data model  
  - User-facing flows  
  - Spin rules and fairness  
  - Environments and safety expectations  
  - Testing and troubleshooting patterns  
  - How this guide interacts with the rest of the KB  
  - Storage modes, and what does and does not hold class data (added in v1.1)  
  - Local data, stable identifiers, eligibility, persistence limits, backup and export (added in v1.1)  
  - Open and approved decisions for Ecology fairness behavior (added in v1.1)

**Quick validation steps:**

1. Confirm “Last updated” and version number are current.  
2. Skim Sections 1–3 to ensure the goals and constraints still match how you actually want to use Ringwheel.  
3. Skim Sections 4–7 to confirm that:
   - Architecture description matches reality.  
   - Data model and spin rules match current or intended behavior.  
4. If anything material has changed since this was written, update this file or create a KB UPDATE NEEDED block in the active chat.

<!-- END FILE: Ringwheel_Master_Guide_v1.md -->