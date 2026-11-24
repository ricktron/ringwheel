# Ringwheel consolidation record

Date: 2026-11-24

This records how the two Ringwheel applications were merged into one, what was kept from each,
what changed in behavior, what is still open, and how to retire the second repository.

- Canonical repository: `ricktron/ringwheel` (this one).
- Secondary source: `ricktron/ringwheel-classroom-spinner` (private, generated in Lovable).
- Baseline commits inspected: `ringwheel` main `d472b88`, `ringwheel-classroom-spinner` main `a0a1962`.

Nothing in this work touched either `main` branch, the deployed Apps Script project, the live
Google Sheet, or any real roster or spin history. All testing used synthetic students.

## 1. Why this repository stays canonical

| Evidence | ringwheel | ringwheel-classroom-spinner |
| --- | --- | --- |
| Backend and sheet contracts | Has `gas/Code.gs`, `schema/`, and the KB | None. Frontend only. |
| Talks to the real backend contract | Yes. Verified locally end to end. | No. It expects `{ classes: [...] }`, `{ rings: [...] }` and a Bearer header. The backend returns plain lists and reads the token from the query or body. The Lovable project's own last screenshot (2025-12-02) shows it failing with `"Forbidden" is not valid JSON`. |
| Classroom rules | Queue, semester and period, Region/Taxon/IUCN, veto, pair cap, Plantae Mercy, history, admin | Picks a random student and a random slice per ring. No Plantae rule, no veto, no weights, no pair cap. |
| Wheel matches the result | Not applicable (three separate text circles) | No. The rings rotate by a random amount unrelated to the result. |
| Visual design | Broken. Tailwind 4 was configured with the Tailwind 3 directives, so the app rendered as unstyled HTML. | Strong. Dark projector theme, concentric wheel, large result panel. |
| Tests and CI | None | None |

Conclusion: keep this repository and its behavior, and bring over the secondary's look and
its few useful ideas.

## 2. Feature reconciliation

Decision key: REUSE (taken nearly as is), ADAPT (idea kept, rebuilt to fit), ALREADY PRESENT,
DISCARD, DEFER.

| Secondary feature | Decision | What happened |
| --- | --- | --- |
| Concentric multi-ring wheel with pointer | ADAPT | Rebuilt as `src/components/RingWheel.tsx` for Region, Taxon and IUCN. Unlike the original it stops with the winning slices under the pointer, rings do not overlap, and slice size follows weight. |
| Spin animation (Framer Motion, 3 s ease-out) | ADAPT | Same timing curve and duration using CSS transitions. Framer Motion itself was not added; the dependency was not needed for this. Honors the reduced-motion preference. |
| Dark, high-contrast projector theme | ADAPT | Palette carried into `src/index.css` as Tailwind 4 theme tokens. Uses system fonts so nothing is fetched from the network. |
| Large animated result panel with the student name | ADAPT | `src/components/ResultPanel.tsx`. Adds a save status that is stated in words. |
| Recent spins panel (in browser memory) | ADAPT | `src/components/SessionSpins.tsx`. Each entry shows whether it was saved, with a retry. |
| Class selector populated from the roster | ADAPT | The period field becomes a dropdown of the periods found in the roster once it is loaded. Semester and period were kept because the real roster is organized that way. |
| Auto test timing metrics and projections | REUSE | `src/utils/autoTestMetrics.ts`, with the median corrected for even-length samples. |
| Auto test cancel button and "log to sheet" off by default | REUSE | In `src/components/AutoTestPanel.tsx`. The original defaulted to writing test rows to the real sheet. |
| Seeded generator (mulberry32) | REUSE | Used in the engine with a stronger seed hash. The original logged a seed that had nothing to do with the result. |
| Full-page error when the backend fails | ALREADY PRESENT | Status indicator and banners existed; they now state the actual reason. |
| Three-column layout: history, wheel, result | ADAPT | Used on wide screens; stacks on narrow ones. |
| Random student chosen on every spin (with replacement) | DISCARD | It conflicts with the existing queue, in which every student spins once. See decision D4. |
| Its API client, response shapes, Bearer auth | DISCARD | Incompatible with the backend. |
| Hard-coded fallback backend URL | DISCARD | A missing configuration silently pointed at production. |
| Its spin engine | DISCARD | No classroom rules. |
| shadcn/ui component library (49 generated files), Radix, react-query, sonner, lucide, zod, recharts and others | DISCARD | Unused or replaceable with a few lines of markup. Avoids more than 45 runtime dependencies. |
| Supabase client and tracked `.env` | DISCARD | Never used by the app. Not copied. |
| Lovable tagger, OpenGraph tags, Google Fonts link | DISCARD | Tooling and branding specific to Lovable. |
| Not-found page | ADAPT | Unknown addresses now redirect to the spinner. Before, they showed a blank page. |
| Toast notifications | DISCARD | Inline status messages are easier to read on a projector and for screen readers. |

Only generic interface ideas, color values and one small utility were carried over. No
credentials, environment files, project identifiers or data came across.

## 3. What was removed from this repository

| Removed | Reason |
| --- | --- |
| `src/services/api.ts` | Second API client. Nothing imported it. |
| `backend/Code.gs`, `backend/README.md` | Legacy backend with a different contract, already marked deprecated. |
| `planSpin` and the `SpinEngine` class in `src/utils/spin-engine.ts` | Two parallel spin paths. One had a pair cap that was a placeholder and never applied; the other silently returned Palearctic, Mammalia, LC when it gave up. Replaced by one engine. |
| `src/utils/crypto-rng.ts`, `src/asmr.ts`, `src/components/Ticker.tsx`, `src/components/SpinnerWheels.tsx`, `src/App.css`, `src/assets/react.svg`, `tailwind.config.js` | Unused, duplicated or superseded. |

Everything removed remains available in Git history at commit `d472b88`.

## 4. Spin rules as implemented

One module decides every spin: `src/utils/spin-engine.ts`. It is covered by `src/utils/spin-engine.test.ts`.

With the Settings sheet at its defaults, the outcomes a class can get are the same as on
`main`. Anything that would change who or what can be picked is behind a switch that is off.

1. Each ring is a weighted pick over its eligible options. An option is eligible when it is
   active and its weight is above zero.
2. By default every canonical label has weight 1. The Rings sheet changes the odds only when
   the setting `applyRingWeights` is `true`. The spin page then says "Weighted spin" and slice
   sizes show the odds.
3. Plantae is never produced by a random pick, whatever the sheet says.
4. Pair cap: a Region and Taxon pair is not allowed while its share of this session's normal
   spins is at or above the cap. The cap is the fixed 12% it has always been. The value in the
   Settings sheet is used only when `usePairCapSetting` is `true`. If the first draw lands on a
   capped pair, the pair is redrawn from the allowed pairs and the row is flagged `pair_cap_reroll`.
5. Veto re-spins exactly one ring. The other two do not change and the target always changes.
6. Plantae Mercy sets the taxon to Plantae with the region the teacher picks, keeps the IUCN
   status, and is flagged `plantae_mercy` and `wildcard_iucn`. It is not a veto. With no
   result on screen yet the status recorded is LC, as on `main`.
7. If no legal outcome exists, no spin is made and the page says why. There is no fallback result.
8. Every random outcome comes from a seed. The seed written to `SpinsLog` reproduces the logged
   result when replayed with the same ring configuration and pair history. A mercy row has no
   seed because nothing in it is random.

### How this lines up with the Master Guide

| Master Guide | Implementation | Status |
| --- | --- | --- |
| 7.1 seeded generator, unbiased over the eligible set | Seeded generator, tested for uniformity | Aligned. `main` logged a seed unrelated to the result. |
| 7.2 only students on the roster for the chosen class | Queue built from the roster for one semester and period | Aligned |
| 2.3 any rule that biases selection must be documented and visible | Weights and the sheet pair cap are off unless switched on, and the page says when they apply | Aligned |
| 7.4 no weighting or no-repeat logic is promised in v1 | A 12% pair cap exists and always has | **Not in the guide.** Kept because it is existing behavior. Needs a decision: document it or remove it (D2). |
| 6.2 do not pretend spins are logged | Save status is shown in words: saved, incomplete, or NOT SAVED | Aligned |
| 6.2 do not spin on partial or broken data | Spins with built-in defaults and a red banner when settings cannot be loaded, as on `main` | **Differs from the guide.** Needs a decision (D5). |
| 5.1 inactive students are never selected | The roster has no status column | **Gap.** Needs a decision (D8). |
| 2.5 logs are append-only | The backend only ever appends to `SpinsLog` | Aligned |

### Behavior that changed compared with `main`

Changes that cannot alter which result a student gets:

| Area | Before | Now |
| --- | --- | --- |
| Seed in `SpinsLog` | A fresh random value unrelated to the result | The seed that produced the result. Empty for mercy rows. |
| Dead end in the rules | Silently returned Palearctic, Mammalia, LC | Shows an error, logs nothing. Not reachable with default settings. |
| Failed log write | Console message only | "NOT SAVED" on screen, a count of unsaved spins, and a retry |
| Log row missing fields | Reported as saved | "Saved INCOMPLETE" naming the fields, or refused if a required column is absent |
| Veto after a mercy | Row had Plantae with `plantae_mercy` false | Mercy marking is kept unless the taxon ring is re-spun |
| Admin save | Replaced the whole sheet with five rows, dropping other keys and all notes | Merges into the current rows and is refused if the Sheet changed after the page loaded |
| Before the first spin | Showed Palearctic, Mammalia, LC as if it were a result | Shows "No spin yet" |
| Spin length | 2 seconds | 3 seconds (0.4 with reduced motion) |

Changes that can alter classroom behavior. Each is either switched off or listed for approval in section 5:

| Area | Before | Now | Where decided |
| --- | --- | --- | --- |
| Pair cap value | Always 12 | Still always 12. Sheet value used only if `usePairCapSetting` is on. | D1, off |
| Ring weights | Never used | Still never used unless `applyRingWeights` is on | D3, off |
| Plantae Mercy before any spin | Recorded LC | Same | D6, unchanged |
| Queue after a failed log write | Student stayed "not spun", so Next Spinner chose the same student again | Student is marked as spun; the save is tracked and retried separately | D12, changed |
| Duplicate roster rows | Student appeared twice in the queue | Appears once, and the page says a duplicate was ignored | D13, changed |
| Settings stored as real TRUE/FALSE cells | Ignored: audio and Plantae Mercy stayed on even with a FALSE cell, and confetti stayed off even with a TRUE cell | Read as written | D14, changed |
| Auto test spins | Counted toward the real pair cap for the rest of the session | Kept in a separate history | D15, changed |

## 5. Decisions that need the teacher

Nothing below was decided for you. "Same as before?" compares with `main`. Where it says
"no change until approved", the code still does what `main` does.

Three items are marked **SPECIAL REVIEW** because the current behavior is hard to defend or
conflicts with the Master Guide.

| ID | Question | What the app does now | Same as before? | Recommended decision | If you approve the recommendation |
| --- | --- | --- | --- | --- | --- |
| D1 | Should the pair cap in the Settings sheet be honored? | No. The cap is a fixed 12%. The sheet value is ignored unless `usePairCapSetting` is on. | Yes | Leave off until D2 is settled. Then turn it on if you want to tune the cap. | Turning it on makes the Admin value real. A cap above 12 allows more repeats; below 12 allows fewer. |
| **D2 SPECIAL REVIEW** | What is the pair cap measured over, and should it exist? | Counted over one page load, across every period spun in that window. Reloading the page resets it. Veto and mercy results are not counted and are not limited. | Yes | Decide whether you want the rule at all, since the Master Guide does not include it. If yes: measure it per class period and rebuild the count from that period's logged spins, so a reload does not reset it. | Fewer repeated Region and Taxon pairs within one class, and consistent behavior after a reload. This changes which results can come up, so it needs your approval, a code change, and a Master Guide entry. Not implemented. |
| D3 | Should ring weights ever apply? | No, unless `applyRingWeights` is on. | Yes | Leave off unless you deliberately want unequal odds. | When on, a weight of 0 or `active` false removes an option, and the wheel shows the odds by slice size. |
| D4 | Queue or random student? | Queue. Every student spins once, in alphabetical or shuffled order. | Yes | Keep the queue. | No change. The prototype's "random student every spin" could pick one student twice and another never. |
| **D5 SPECIAL REVIEW** | Spin when settings cannot be loaded? | Yes, with built-in defaults (equal odds, 12% cap) and a red banner. | Yes | Block spinning until settings load, with a clearly labeled "Spin with defaults" override. | Brings the app in line with Master Guide 6.2. Matters most once D1 or D3 is on, because a failed load would otherwise quietly spin with different odds than you configured. Changes behavior during a backend outage. Not implemented. |
| D6 | Plantae Mercy before any spin | Allowed. Records LC as the IUCN status, flagged `wildcard_iucn`. | Yes | Require a spin first. | Removes a row whose IUCN value was never spun. Mercy would be unavailable until the student has a result. Not implemented. |
| D7 | Second spin for a student who already spun | Allowed. The page shows a hint. | Yes | Keep allowed. | No change. Blocking it would take away your ability to redo a spin. |
| D8 | Inactive students | No way to mark one. Removing the roster row is the only option. | Yes | Add an optional `active` column to the roster, blank meaning active. | Closes the gap with Master Guide 5.1. It is a sheet schema change, so it needs your approval and a backend deploy. Not implemented. |
| D9 | `mode` (midterm or final) and "random events" | Not implemented. | Yes (the only code for them was never used) | Leave out. Remove "random events" from the repository description. | No change in class. |
| D10 | SPIN while a veto ring is selected | Performs the veto. The button label says so. | Yes | Keep. | No change. |
| **D11 SPECIAL REVIEW** | What counts as "today" in the log view? | The UTC date. In the evening Central time (6 pm or 7 pm, depending on daylight saving) the view rolls over to the next day. | Yes | Use the school's time zone (America/Chicago, already set in the Apps Script project). | Evening use shows the right day. Daytime classes see no difference. It affects only which rows the log view lists and which can be re-rolled from it, not any result. Needs a backend change and deploy. Not implemented. |
| D12 | After a failed save, is the student's turn over? | Yes. The student is marked as spun and the save is retried separately. | **No** | Approve. | Aligns with Master Guide 6.1 and 6.2. Before, Next Spinner picked the same student again, which meant a second spin for them or a stuck queue. To reject: say so and the previous behavior can be restored. |
| D13 | A student listed twice in the roster for one period | One turn. The page says a duplicate row was ignored. | **No** | Approve. | Before, that student got two turns. |
| D14 | Settings typed as real TRUE or FALSE in the Sheet | Read as written. | **No** | Approve, and check the three cells once. | Before, such cells were ignored. If `enablePlantaeMercy` or `enableAudio` is a real FALSE cell today, the Mercy button or the sound will turn off, which is what the cell says. If `enableConfetti` is a real TRUE cell, confetti turns on. Cells typed as text behave as before. |
| D15 | Should auto test spins count toward the real pair cap? | No. | **No** | Approve. | Before, running the test harness changed which pairs real students could get for the rest of that session. |

What is switched off pending your approval: D1 (`usePairCapSetting`) and D3 (`applyRingWeights`).
What is not built pending your approval: D2, D5, D6, D8, D11.
What changed and needs your yes or no: D12 to D15.

## 6. Security

The credential finding, the rule, and the rotation procedure are in [`SECURITY.md`](SECURITY.md).

Findings, most important first.

1. **A token was published in `.env.example`.** Verified from history without printing the
   value: on `main` since 2025-11-28, not a placeholder, short and guessable, next to a full
   Web App deployment address. Replaced with placeholders on this branch but permanent in
   history. Rotate `API_TOKEN`. Procedure in `SECURITY.md`.
2. **The API token is not a secret once it is in a build.** Any `VITE_` value is readable by
   anyone who can load the site. The same token unlocks the roster (names and emails) and the
   write routes. Do not host a build with the token baked in anywhere other people can reach.
   The Admin page can store the URL and token in the teacher's browser instead, the build
   warns when a token is being compiled in, and a test fails if one is committed.
3. **The email route was an open relay** for anyone holding the token. In `gas/Code.gs` it
   now only sends to the script owner or an explicit allowlist. Takes effect when deployed.
4. **Admin writes could erase a sheet or overwrite someone else's edit.** The backend now
   validates before writing, never clears, and refuses a save when the Sheet changed after it
   was read. The frontend re-reads before saving, which protects even against the currently
   deployed backend, apart from an edit made in the instant between that read and the write.
5. **Spreadsheet formula injection.** Text from a request was written as is, so a value
   starting with `=` would run as a formula. Now stored as text. Takes effect when deployed.
6. **The backend said `ok: true` when it had written nothing or only part of a record.** It
   now answers complete, incomplete with the missing fields, or refused. Until it is deployed
   the app shows saves as "Saved (not confirmed complete)" instead of "Saved to the log".
7. **The token travels in the query string on reads.** That is how the existing contract
   avoids CORS preflight. It can appear in browser history. Left as is.
8. **Secondary repository:** tracks a `.env` with Supabase publishable settings (unused) and
   hard-codes the production Web App address. It is private; nothing was copied from it.
9. **Dependencies:** `npm audit fix` applied. Zero known issues in runtime dependencies;
   7 moderate remain in development tooling only.

Proposed production auth migration (not done, needs a decision): deploy the Web App as
"Execute as: me, access: anyone in the school domain", or verify a Google ID token in
`doGet`/`doPost`, so the roster is tied to a signed-in account instead of a shared token.
The optional `ADMIN_TOKEN` in `gas/Code.gs` is a smaller step that separates "can log a spin"
from "can change configuration".

## 7. Still gated (needs the owner)

| Step | Why it is gated |
| --- | --- |
| Review and merge the pull request | Merging was not authorized. |
| Rotate `API_TOKEN` | Credential change. Procedure in `SECURITY.md`. Can be done before or after merging. |
| Decide D1 to D15 | Fairness and classroom policy. |
| Deploy `gas/Code.gs` to the Apps Script project | Production change. Steps and rollback are in `gas/README.md`. The consolidated frontend works with the currently committed backend too. |
| Confirm the deployed script matches the repository | Could not be checked without production access. `RINGWHEEL_GAS_PATH=... npm test` runs the contract tests against a pasted copy. |
| Compare the live sheet headers with `schema/` | The live sheet was not inspected. After the backend is deployed, the health check does this for you and names any missing column. |
| Health check and one test spin against production | No requests were sent to the live backend. |

## 8. Retiring `ringwheel-classroom-spinner`

Status: **BLOCKED** until steps 1 to 3 are done.

Found on 2026-11-24: the Lovable project "RingwheelUI" is still connected. Its latest commit
is the same as the repository's `main` (`a0a1962`), it was last edited 2025-12-02, and it is
published publicly. The published app does not work (the backend rejects its requests), so it
serves no class, but it is live and it embeds the production Web App URL.

1. In Lovable, unpublish the RingwheelUI project.
2. In Lovable project settings, disconnect the GitHub integration (or delete the project if
   you do not want to keep its prompt history). If it stays connected, any future edit in
   Lovable pushes to the repository again.
3. If the Lovable Cloud (Supabase) project created for it is not used elsewhere, pause or
   delete it. The app never used it.
4. Confirm the pull request in this repository is merged and the checks in
   `docs/verification.md` pass against production.
5. Optional: tag the final commit in the secondary repository (for example
   `final-before-archive`) so the history is easy to find later.
6. Add one line at the top of its README pointing to `ricktron/ringwheel`.
7. Archive the repository (Settings > Archive). Archiving keeps all code and history readable
   and can be undone. Do not delete it.

Nothing useful is lost by archiving: every idea worth keeping is listed in section 2 and now
lives here, and the rest is generated template code.

## 9. KB UPDATE NEEDED

The KB files were not rewritten, in line with the working agreements. These edits are proposed.

- `Ringwheel_Master_Guide_v1.md`
  - Section 3: add a v1.1 entry for the consolidation.
  - Section 7.4: the pair cap exists in the app and is not in the guide. Document it or
    remove it, per D2.
  - Section 7: once D1 to D15 are decided, document the rules in section 4 above.
  - Section 5.4: list the rule flags in use (`pair_cap_reroll`, `veto_respin`,
    `veto_respin_region`, `veto_respin_taxon`, `veto_respin_iucn`, `plantae_mercy`,
    `wildcard_iucn`, `auto_test_run`) and say which `SpinsLog` columns are required.
  - Section 6.2: reconcile with D5.
  - Section 5.1: reconcile with D8.
- `KB/AGENTS.md`: layout and commands were updated in this change to match the repository.
- File name drift: the KB refers to `Ringwheel_KB_01_AI_Development_Working_Agreements.md`
  in a `kb/` folder. The file in the repository is `KB/Ringwheel_KB_01_AI_Development.md`.
  They are the same document. Either rename the file or update the references.
- `Ringwheel_Schema_And_API_Reference.md` is mentioned as optional and does not exist. The
  contract currently lives in the header of `gas/Code.gs`, in `gas/README.md` and in `schema/`.

## 10. Obsidian Command Center note

If this project is tracked in the Obsidian Command Center, link to these as the sources of
truth instead of copying them: this file (decisions and status), `docs/verification.md`
(receipts checklist), `gas/README.md` (deploy runbook), and the pull request (evidence).
