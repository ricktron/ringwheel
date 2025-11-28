<!-- FILE: Ringwheel_Master_Guide_v1.md -->

# Ringwheel – Master Guide v1  
_Last updated: 2025-11-28_  
_Version: 1.0 (baseline documentation)_

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

### 6.3 Future flows (not yet implemented)

Potential future flows (not spec’d in detail here):

- Per-student “history in this class” view.  
- “Who hasn’t been picked recently?” summary.  
- Advanced spin modes (e.g., teams, groups, or weighted selection).

When these are implemented, they should be added as new subsections with explicit behavior.

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
- **Path hint:** `kb/Ringwheel_Master_Guide_v1.md` at the root of the Ringwheel KB folder.  
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

**Quick validation steps:**

1. Confirm “Last updated” and version number are current.  
2. Skim Sections 1–3 to ensure the goals and constraints still match how you actually want to use Ringwheel.  
3. Skim Sections 4–7 to confirm that:
   - Architecture description matches reality.  
   - Data model and spin rules match current or intended behavior.  
4. If anything material has changed since this was written, update this file or create a KB UPDATE NEEDED block in the active chat.

<!-- END FILE: Ringwheel_Master_Guide_v1.md -->