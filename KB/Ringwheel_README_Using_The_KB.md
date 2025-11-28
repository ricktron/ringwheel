<!-- FILE: Ringwheel_README_Using_The_KB.md -->

# Ringwheel README – Using The KB  
_Last updated: 2025-11-28_

This README explains how to use the Ringwheel KB (knowledge base) when working on the Ringwheel classroom spinner tool.

The goal is to:

- Make it obvious which docs matter most.  
- Give a repeatable “boot sequence” for serious work.  
- Keep the KB and the live system from drifting away from each other.

This file is about *how* to use the KB, not about Ringwheel’s product behavior itself.

---

## 1. What counts as the “core KB” for Ringwheel

For Ringwheel, the **core KB** is exactly three files:

1. `Ringwheel_KB_01_AI_Development_Working_Agreements.md`  
   - Collaboration rules for Rick and AI tools.  
   - Order of precedence between live system, Master Guide, repo, and prior chats.  
   - Risk levels by change type, and how to flag KB drift.

2. `Ringwheel_Master_Guide_v1.md`  
   - Canonical description of what Ringwheel is and how it works.  
   - Architecture, classroom flows, spin rules and fairness.  
   - Data model and key contracts (at a high level).

3. `Ringwheel_README_Using_The_KB.md` (this file)  
   - How to use and maintain the KB itself.  
   - Boot sequence for any serious Ringwheel work.

Other KB-style files are **supporting docs**, not core:

- For example (names are suggestions, not required):
  - `Ringwheel_Schema_And_API_Reference.md`  
    - Detailed schemas and API contracts.  
  - `Ringwheel_Feature_Bank.md`  
    - Backlog and roadmap.  
  - `Ringwheel_Session_Summaries/…`  
    - Historical session summaries.

These supporting docs are helpful, but the three core files above are the ones that must always be loaded and respected for serious work.

---

## 2. Expected directory layout (can be adjusted later)

Default assumption:

- The KB lives inside the Ringwheel repo, under a folder like `kb/` or `docs/kb/`.  
- These files sit there as plain markdown.

Example:

```text
ringwheel/
  src/
  gas/
  schema/
  kb/
    Ringwheel_KB_01_AI_Development_Working_Agreements.md
    Ringwheel_Master_Guide_v1.md
    Ringwheel_README_Using_The_KB.md
    Ringwheel_Schema_And_API_Reference.md        (optional but recommended)
    Ringwheel_Feature_Bank.md                    (optional but recommended)
    Ringwheel_Session_Summaries/                 (optional folder)
      Ringwheel_Summary_2025-11-28_M1-M8_Baseline.md
      ...
If the KB ever moves (into a separate repo, or into a different folder), this file should be updated with a short “where the KB lives now” note and path hint.

3. Boot sequence for serious Ringwheel work
Whenever a tool (or Rick) is about to do non-trivial Ringwheel work, it should treat the following as the standard boot sequence.

Examples of “non-trivial”:

Changing spin rules or fairness behavior.

Editing Apps Script / backend API behavior.

Changing CSV / Sheet schemas.

Adding or changing classroom flows.

Designing new major features.

3.1 Step 1: Identify repo and environment
First, clarify:

Which repo is in scope (Ringwheel repo name).

Which branch or environment:

Local dev

Staging / preview

Production (used in class)

If unclear, say so explicitly and avoid assuming production.

3.2 Step 2: Load the core KB
Assistant should load or request the following, in this order:

Ringwheel_KB_01_AI_Development_Working_Agreements.md

To know how to collaborate, how to treat risk, and how to flag drift.

Ringwheel_Master_Guide_v1.md

To understand the intended architecture, behavior, and classroom flows.

Ringwheel_README_Using_The_KB.md (this file)

To confirm how to use the KB and how to handle updates.

If they exist and are relevant to the task, the assistant may also load:

Ringwheel_Schema_And_API_Reference.md

Ringwheel_Feature_Bank.md

Any relevant Ringwheel_Session_Summaries/... files

But these are optional add-ons, not part of the core trio.

3.3 Step 3: Determine risk level
Using the Working Agreements doc as the baseline, classify the work as:

High risk

Schema changes, logging changes, or anything that affects student fairness or privacy.

Auth and API contract changes.

Medium risk

Frontend behavior that affects which student is picked, how often, or how random it feels.

Low risk

UI copy, purely visual adjustments, or doc-only changes.

For high-risk work, the assistant must be extra careful and must propose:

A clear plan.

Tests.

A rollback path.

3.4 Step 4: Propose a brief plan
Before writing or editing code, the assistant should propose a short plan:

3–5 bullets describing:

Files or areas to touch.

The order of operations.

How to test the result.

How to roll back if something breaks.

Rick does not need constant confirmation for tiny steps.
If the plan is reasonable, the assistant should execute and then show the result.

3.5 Step 5: Execute, then summarize
After executing a meaningful chunk of work:

Provide a Session summary inside the reply, with:

Overview of what changed.

Files / areas touched.

Behavioral impact.

Suggested tests and verification steps.

If the work created new canonical behavior not yet in the KB, append a KB UPDATE NEEDED block (see Section 5).

If the work was trivial (for example, a small wording tweak), a full session summary may not be needed, but the assistant should still mention what changed.

4. How to add or change KB files
4.1 When to add a new KB file vs a section
Prefer adding sections to existing core docs instead of creating many small files.

Good reasons to add a new KB file:

A new, coherent area of Ringwheel that will have its own lifecycle (for example, analytics or advanced dashboards).

A reference that changes often and would cause friction if mixed into the Master Guide.

Otherwise, default to:

Adding a section to Ringwheel_Master_Guide_v1.md if it defines how Ringwheel works.

Adding an item to Ringwheel_Feature_Bank.md if it is an idea or future enhancement.

Updating Ringwheel_KB_01_AI_Development_Working_Agreements.md if it affects collaboration norms.

4.2 Editing the KB
When editing KB files, the assistant should:

Respect the order of precedence defined in the Working Agreements.

Call out whether the change:

Is catching docs up to current behavior, or

Is defining new intended behavior that code does not yet implement.

If it is new intended behavior, the assistant should also recommend:

Where to track implementation:

Ringwheel_Feature_Bank.md entry.

GitHub issue.

Session summary file.

5. KB drift and the “KB UPDATE NEEDED” block
Ringwheel relies on the assistant to actively spot and flag drift between:

Described or planned behavior in this chat, and

What the KB currently says.

The Working Agreements define when KB is considered stale.
This README adds the behavioral expectation:

5.1 When to emit a KB UPDATE block
The assistant should end its reply with a KB UPDATE NEEDED block when:

The conversation introduces or confirms new behavior that is not reflected in any KB file.

There is an obvious contradiction between:

Live/implemented behavior described in chat, and

The existing KB text.

The block should:

Be placed at the very end of the reply.

Name each KB file that likely needs edits.

Include 1–2 bullets per file that summarize the required changes.

Example:

md
Copy code
---

KB UPDATE NEEDED

- Ringwheel_Master_Guide_v1.md
  - Document: new spin mode `no_repeat_this_period`.
  - Add: rules for when and how it applies.

- Ringwheel_Schema_And_API_Reference.md
  - Update: `SpinsLog` schema to include `spin_mode`.
For especially critical changes (tool roles, fairness, auth, or schema contracts), the assistant may instead or additionally emit:

md
Copy code
---

***URGENT*** Ringwheel_KB_01_AI_Development_Working_Agreements.md MUST BE UPDATED!
- Tool workflow changed (for example, new primary repo agent).
The assistant should not emit a KB update block when:

The discussion is purely exploratory or hypothetical.

No agreed change to Ringwheel’s canonical behavior has been made.

If in doubt, it is acceptable to include a KB update block and let Rick decide whether to act on it.

6. Using session summaries
Session summaries are useful for history and for reconstructing how a decision was made.

6.1 When to create a session summary file
Create a new Ringwheel_Session_Summaries/Ringwheel_Summary_YYYY-MM-DD_<topic>.md when:

A session includes multiple related changes or a non-trivial spec shift.

The work feels like a “chapter” in Ringwheel’s evolution.

You expect to refer back to the work later.

Each summary file should follow a consistent structure, for example:

Session overview

Key technical changes

Decisions and rationale

Open questions / follow-ups

KB impact (with notes about which KB files should be updated)

6.2 Optional index
If there are many session summaries, maintain a simple index file:

Ringwheel_Session_Summaries_Index.md

with a table containing:

Date

Topic

One-line description

Link to the summary file

7. Export rubric
Filename: Ringwheel_README_Using_The_KB.md

Path hint: kb/Ringwheel_README_Using_The_KB.md at the root of the Ringwheel repo KB folder.

Format: Markdown, UTF-8.

Must reference (by name):

Ringwheel_KB_01_AI_Development_Working_Agreements.md

Ringwheel_Master_Guide_v1.md

May reference (if present):

Ringwheel_Schema_And_API_Reference.md

Ringwheel_Feature_Bank.md

Ringwheel_Session_Summaries/...

Quick validation steps:

Confirm the “Last updated” date is reasonably current.

Check that Section 1 lists exactly three core KB files.

Check that Section 3 includes a clear, numbered boot sequence.

Confirm Section 5 contains at least one concrete example of a KB UPDATE NEEDED block.

In a fresh Ringwheel chat, load:

This README

The Working Agreements

The Master Guide (once it exists)

Then ask the assistant:
“How should you use the Ringwheel KB when making changes?”
Confirm the explanation matches the expectations in this file.

<!-- END FILE: Ringwheel_README_Using_The_KB.md -->