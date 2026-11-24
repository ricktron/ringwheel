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

1. Each ring is a weighted pick over its eligible options. An option is eligible when it is
   active and its weight is above zero.
2. By default every canonical label has weight 1. The Rings sheet changes the odds only when
   the setting `applyRingWeights` is `true`. The spin page then says "Weighted spin" and slice
   sizes show the odds.
3. Plantae is never produced by a random pick, whatever the sheet says.
4. Pair cap: a Region and Taxon pair is not allowed while its share of this session's normal
   spins is at or above the cap (default 12%). If the first draw lands on a capped pair, the
   pair is redrawn from the allowed pairs and the row is flagged `pair_cap_reroll`.
5. Veto re-spins exactly one ring. The other two do not change and the target always changes.
6. Plantae Mercy sets the taxon to Plantae with the region the teacher picks, keeps the IUCN
   status, and is flagged `plantae_mercy` and `wildcard_iucn`. It is not a veto.
7. If no legal outcome exists, no spin is made and the page says why. There is no fallback result.
8. Every outcome comes from a seed. The seed written to `SpinsLog` reproduces the logged
   result when replayed with the same ring configuration and pair history.

### Behavior that changed compared with `main`

| Area | Before | Now |
| --- | --- | --- |
| Seed in `SpinsLog` | A fresh random value unrelated to the result | The seed that produced the result |
| Pair cap value | Always 12, whatever the Settings sheet said | Read from `midterm_pair_cap_pct` (or the legacy `pairCapPercent`) |
| Ring weights | Saved by the admin page but never used by spins | Still unused by default. Used only when `applyRingWeights` is on. |
| Dead end in the rules | Silently returned Palearctic, Mammalia, LC | Shows an error, logs nothing |
| Auto test spins | Counted toward the real pair cap; wrote to the sheet by default | Separate history; sheet writes are opt-in |
| Veto after a mercy | Row had Plantae with `plantae_mercy` false | Mercy marking is kept unless the taxon ring is re-spun |
| Failed log write | Console message only | "NOT SAVED" on screen, a count of unsaved spins, and a retry |
| Queue after a failed log | Student stayed "not spun" | Student is marked as spun; the save status is tracked separately |
| Admin save | Replaced the whole sheet with five rows, dropping other keys and all notes | Merges into the loaded rows. Unknown rows, notes, colors, order and active flags are kept. Save is disabled if loading failed. |
| Before the first spin | Showed Palearctic, Mammalia, LC as if it were a result | Shows "No spin yet" |
| Spin length | 2 seconds | 3 seconds (0.4 with reduced motion) |
| Setting values stored as real TRUE/FALSE cells | Read as false | Read correctly |
| Duplicate roster rows | Student appeared twice in the queue | Appears once |

## 5. Decisions that need the teacher

The Master Guide deliberately leaves several rules open. These were kept as they were, or
resolved in the most conservative way, and need a yes or no.

| ID | Question | Current behavior |
| --- | --- | --- |
| D1 | Should the pair cap in the Settings sheet be honored? | Yes. If the sheet has a value other than 12, spins will now follow it. |
| D2 | What is the pair cap measured over? | One page load, across all periods. Veto and mercy results are not counted and are not blocked by it. Reloading the page resets it. |
| D3 | Should ring weights ever apply? | Off unless `applyRingWeights` is set to true. A weight of 0 or `active` false removes an option. |
| D4 | Queue or random student? | Queue: every student spins once, in alphabetical or shuffled order. The prototype's "random student each spin" was not adopted. |
| D5 | Spin when settings cannot be loaded? | Yes, with built-in defaults and a red banner. Master Guide 6.2 says not to spin on partial data; `main` already spun in this case. |
| D6 | Plantae Mercy details | Allowed at any time. If there is no result yet, the IUCN status is drawn at random. |
| D7 | Second spin for a student who already spun | Allowed, with a hint. Not blocked. |
| D8 | Inactive students | The roster has no status column, so there is no way to mark a student inactive short of removing the row. |
| D9 | `mode` (midterm or final) and "random events" | Not implemented. The only code for them was unused and was removed. |
| D10 | SPIN while a veto ring is selected | Performs the veto, as on `main`. The button label now says so. |
| D11 | What counts as "today" in the log view | The UTC date, as on `main`. In the evening Central time (6 pm or 7 pm, depending on daylight saving) the view rolls to the next day. |

## 6. Security

Findings, most important first.

1. **The API token is not a secret once it is in a build.** Any `VITE_` value is readable by
   anyone who can load the site. The same token unlocks the roster (names and emails) and the
   write routes. Until the backend has real sign-in, do not host a build with the token baked
   in anywhere other people can reach. The Admin page can now store the URL and token in the
   teacher's browser instead, so a hosted build can ship with no token.
2. **`.env.example` on `main` contains a full Web App deployment URL and a token-like value.** This
   repository is public. Both are replaced with placeholders here, but they remain in Git
   history. If that value was ever the real `API_TOKEN`, treat it as exposed and rotate it.
3. **The email route was an open relay** for anyone holding the token. In `gas/Code.gs` it
   now only sends to the script owner or an explicit allowlist. Takes effect when deployed.
4. **Admin writes could erase a sheet.** An empty or malformed request cleared the tab first.
   The backend now validates before writing and never clears. Takes effect when deployed.
   The frontend fix (merge instead of replace) takes effect with the frontend alone.
5. **Spreadsheet formula injection.** Text from a request was written as is, so a value
   starting with `=` would run as a formula. Now stored as text. Takes effect when deployed.
6. **The backend said `ok: true` when it had written nothing** (missing tab). Now `ok: false`.
7. **The token travels in the query string on reads.** That is how the existing contract
   avoids CORS preflight. It can appear in browser history. Left as is.
8. **Secondary repository:** tracks a `.env` with Supabase publishable settings (unused) and
   hard-codes the production Web App URL. It is private; nothing was copied from it.
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
| Deploy `gas/Code.gs` to the Apps Script project | Production change. Steps and rollback are in `gas/README.md`. The consolidated frontend works with the currently committed backend too. |
| Confirm the deployed script matches the repository | Could not be checked without production access. `RINGWHEEL_GAS_PATH=... npm test` runs the contract tests against a pasted copy. |
| Rotate `API_TOKEN` | Credential change. See Security item 2. |
| Compare `schema/Roster.csv` with the live sheet headers | The old sample did not match what the backend reads. It was aligned to the backend code, not to the live sheet, which was not inspected. |
| Health check and one test spin against production | No requests were sent to the live backend. |
| Decide D1 to D11 | Fairness and classroom policy. |

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
  - Section 7: document the rules in section 4 above (weights behind a setting, Plantae
    exclusion, pair cap, veto, mercy, no fallback, real seeds), once D1 to D11 are decided.
  - Section 5.4: add `pair_cap_reroll` to the known rule flags.
  - Section 6.2: reconcile with D5.
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
