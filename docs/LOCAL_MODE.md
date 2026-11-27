# Local Mode and Connected Mode

Date: 2026-11-24. Updated 2026-11-25 (destructive actions are checked and atomic; backups are recorded only on confirmation).

RingWheel keeps classroom data in one of two places. The app always says which one is in
charge, on every page.

| | Local Mode (default) | Connected Mode (optional) |
| --- | --- | --- |
| Who it is for | Any teacher | A teacher who runs their own RingWheel Google Sheet |
| Setup | None. No account, no token, no backend. | Enter your backend address and token once on the Admin page |
| Where data lives | This browser, on this computer (IndexedDB) | Your Google Sheet, through your Apps Script backend |
| Network | None. Works offline. | Requests go only to your backend |
| Classes | Any number of separate classes | The periods in your Sheet |
| Backup | You download a file | The Sheet is the record |

## What decides the mode

One setting, stored in this browser: `ringwheel.mode`.

- It is `local` unless the teacher turns Connected Mode on from Admin > "Where data is kept".
- Connected Mode only turns on when a complete address and token have been entered.
- Nothing in the build, the web address, or a visitor's first load can select Connected Mode.
  RingWheel reads no build-time environment variables at all.
- One exception, to avoid breaking an existing setup: a browser that already holds a complete
  connection saved from the Admin page before Local Mode existed keeps using it.

Switching modes never copies or merges anything. Local classes stay in the browser and are
never sent to a Sheet. Sheet data is never written into a local class. The spinner and admin
pages are rebuilt from scratch on every switch, so a queue or history list cannot carry over.

**If you previously used `.env.local`:** that file is no longer read. Open Admin, enter the
same backend address and token under "Where data is kept", and press "Save connection and
turn on Connected Mode". This is a one-time step per browser.

## Architecture

```
pages and components
        |
        v
  DataProvider  (src/data/provider.ts)      one small interface
     /        \
local          connected
src/data/local/ src/api.ts (unchanged Apps Script client)
     |
WorkspaceStore (src/data/local/store.ts)
     /        \
IndexedDbStore  MemoryStore (tests, and a visible fallback when the browser refuses storage)
```

- `DataProvider` is the set of calls the Sheets backend already offered: health, settings,
  rings, spin log read and append. Connected Mode passes them straight to the existing client,
  so its behavior is unchanged. Local Mode answers the same calls from browser storage.
- It is not a plugin system. There are exactly two providers and no registry.
- The spin rules (`src/utils/spin-engine.ts`) are shared and untouched. Both modes produce
  results the same way.
- `tests/repo/hygiene.test.ts` fails the build if anything under `src/data/local/` could make a
  network request or imports the backend client, and if any page bypasses the provider.

## Local data model

Schema version 1 (`WORKSPACE_SCHEMA_VERSION` in `src/data/local/schema.ts`).

IndexedDB database `ringwheel`, version 1:

| Store | Key | Holds |
| --- | --- | --- |
| `workspaces` | `id` | One record per class: name, roster, settings, ring weights, revision, last backup time |
| `spins` | `id` (index: `workspaceId`) | One record per spin. Append-only. |
| `recovery` | `id` | Copies taken when a class is deleted or replaced, in the same step as the deletion or replacement. The newest five are kept. |

```ts
interface Workspace {
  id: string;              // never changes
  schemaVersion: number;
  name: string;
  createdAt: string;       // ISO time
  updatedAt: string;       // last roster, settings or name change
  rev: number;             // +1 on every such change; an edit based on an older rev is refused
  students: LocalStudent[];
  settings: SettingRow[];  // same rows as the Settings sheet
  rings: RingSlice[];      // same rows as the Rings sheet
  lastBackupAt: string | null;  // when the newest backup file the teacher confirmed (or restored from) was built
}

interface LocalStudent {
  id: string;              // stable within the class; not derived from the name
  name: string;
  email: string;           // optional; only used to recognize the same student on import
  active: boolean;         // false: on the roster, not in the spin queue
  createdAt: string;
}

interface LocalSpin extends SpinsLogPayload {   // the same fields as a SpinsLog sheet row
  id: string;
  workspaceId: string;
  studentId: string | null;
}
```

Rules the storage layer enforces (covered by `tests/local/store.contract.test.ts`, run against
both the in-memory store and the real IndexedDB code):

- Spins can be added and never edited.
- A roster or settings change succeeds only on top of the revision it was based on. A second
  tab holding an older copy is refused instead of overwriting.
- Importing, replacing, deleting and clearing are all-or-nothing.
- Classes never share students, settings or history.
- Deleting a class, replacing one from a backup, undoing either, and "delete everything" all go
  through one storage call (`replaceClasses`, or `clearAll` with the classes the page showed).
  See the next section.

### Destructive actions and other tabs

A teacher can have RingWheel open in two tabs: one on the Classes page, one spinning. The risk
is that a spin or a roster edit made in one tab lands between the moment the other tab reads a
class and the moment it deletes or replaces it. The rules that close that gap:

1. **Every destructive action says what the teacher was looking at.** The Classes page keeps a
   fingerprint (`stampOf`) of each class as it last showed it and sends it with the action.
2. **The fingerprint covers the spin history, not only the revision.** It is built from the
   revision, the last edit time, the number of spins and a hash of the spin ids. Logging a spin
   does not move the revision, so the revision alone would miss it.
3. **Check, recovery copy and change are one step.** In IndexedDB that is one read-write
   transaction over the `workspaces`, `spins` and `recovery` stores. The browser runs
   transactions on the same stores one after another, so a write from another tab is either
   wholly before the step (the fingerprint no longer matches and the action is refused) or
   wholly after it. The in-memory store does the same work with no pause in the middle.
4. **A refusal changes nothing.** No class is removed, no class from a backup file is added, no
   recovery copy is written, and a recovery copy being used for an undo is not used up. The
   page says which class changed, shows the current version, and the teacher can try again.
5. **The recovery copy is the class as it was at that instant**, read inside the same step, so
   it always includes the newest spin.
6. **A replaced class gets a revision above the one it replaced.** A tab still holding the old
   version gets the normal "changed in another tab" refusal instead of editing over the
   restored class. A revision that is already higher is kept, so a restore into an empty
   browser is still an exact copy.
7. A spin logged to a class that has just been deleted is refused and shown as NOT SAVED. It is
   never dropped silently.

Covered by `tests/local/concurrency-scenarios.ts`. The same scenarios run against the in-memory
store and the IndexedDB code in `npm test`, and against Chromium's real IndexedDB in
`npm run test:e2e`, which also drives two real tabs through the Classes page.

### Changing the schema later

Version numbers describe what a record holds, not which build wrote it. A class with no
presentation data is schema 1 and a backup with no presentation data is format 1, whichever
build wrote them, so they stay readable by the site as it was before Presentation Draw. See
"Presentation Draw storage" below before changing any of this.

1. Prefer an optional field on the class record over a new object store. Every store write
   spreads the record it read inside its own transaction, so a field a build does not know
   about survives that build's edits. A new object store would need a `DB_VERSION` bump, and an
   older site cannot open a database with a higher version at all.
2. Give the new content its own version number and stamp it only on records that hold the
   content (`schemaVersionFor`, `formatVersionFor` in `schema.ts`).
3. A file or class saved by a newer version is refused with a "newer version" message, never
   half-read. So is a record that claims a version without holding what that version writes.
4. If a store or index really must be added, bump `DB_VERSION` in `idb-store.ts`, extend
   `upgrade`, and treat it as a one-way change that needs its own rollback plan.

## Backup, restore and export

Everything is on the Classes page.

| Action | What it does |
| --- | --- |
| Back up a class / all classes | Hands the browser one JSON file with the complete roster, settings and spin history, then asks whether the file saved |
| Restore > Add | Adds the classes in the file. Nothing already in the browser is changed. A class that already exists is added beside it as a copy. |
| Restore > Replace | Replaces a class with the same id. A copy of the replaced version is kept under Recovery as part of the same step. Refused if the class changed in another tab after the page showed it. |
| Recovery > Put it back | Undoes a delete or a replace. The undo is itself undoable. |
| Spin history as CSV / Roster as CSV | Ordinary spreadsheets for classroom records |
| Delete everything | Requires typing DELETE. Removes all classes, history and recovery copies. Not undoable. |

### What "backed up" means

RingWheel cannot see the downloads folder. A browser can block a download, the teacher can
cancel the save dialog, and a disk can be full, and the page is told none of this. So:

- Building the file and handing it to the browser records nothing.
- The page then asks "Did the backup file save?". Only "Yes, I have the file" records a backup.
  "No, it did not save", closing the tab, or reloading records nothing.
- If the browser refuses the download outright, the page says so and records nothing.
- The time recorded is when the file's contents were read, not when the button was pressed.
  Anything done after that still shows as not backed up. A spin that was stamped before the
  file was built but stored just after it is also treated as not backed up.
- A class restored from a file counts as backed up as of that file.
- A backup time never moves backwards.

The status line therefore reads "No confirmed backup", "Last confirmed backup: today", or
"Not in a confirmed backup: 2 spins and roster or settings changes". "Confirmed" means the
teacher said they have the file. It is not a claim that RingWheel verified the file on disk,
and it cannot know whether the file was later moved or deleted.

Guarantees, each covered by a test:

- A backup file is validated from top to bottom before anything is written. One problem
  anywhere rejects the whole file and changes nothing.
- Back up, delete everything, restore: the data is identical, including ids, selections,
  timestamps, seeds and flags.
- A delete, replace or undo is refused, with nothing changed, if the class is no longer what
  the page showed. See "Destructive actions and other tabs" above.
- A backup is recorded only on the teacher's confirmation, never by the download starting.
- Exported CSV cells that a spreadsheet would treat as a formula are neutralized.
- A CSV import shows what would be added and what would be skipped, and why, before adding.
- The same student is recognized by email when both entries have one, otherwise by name.
  Two students with the same name and different emails are two people.

## Privacy

- Local Mode makes no network request. The browser test fails if a single request leaves the
  app's own address, and separately proves the Sheets backend is never contacted.
- Student names are never placed in a web address, a log line, or an error report. There is no
  analytics and no error-reporting service.
- On the hosted site a Content Security Policy allows connections only to Google Apps Script.
  The page cannot send data even to its own host.
- **Browser storage is not a backup.** Clearing site data, a private window, another browser or
  another computer will not have it, and a browser low on space may remove it. The Classes page
  says this, shows the last backup the teacher confirmed for each class, and warns when the
  browser is not keeping data at all.
- Backup files contain student names. Store them as you would a gradebook.

## Differences between the modes that are intentional

| Topic | Local Mode | Connected Mode |
| --- | --- | --- |
| "Today" in the log view | The calendar day on this computer | UTC day, unchanged (decision D11 is still open) |
| Class selection | Pick a class | Semester and period, unchanged |
| Inactive students | "In queue" checkbox per student | Not available (decision D8 is still open) |
| Save status | "Saved in this browser" | "Saved to the log", or the incomplete and not-saved states |

The spin queue is rebuilt each time the page loads in both modes. Who has already spun today
is not remembered across a reload. That belongs to Presentation Draw (PR #10).

## Presentation Draw storage

Status: logic and storage only (PR 10a). **There is no screen, route or link for it yet**, and
nothing a teacher can do in this build creates presentation data. The screens are PR 10b. This
section is the contract PR 10b builds on.

Presentation Draw puts a class into a random speaking order for an assignment and tracks who
has presented. It is separate from the Ecology wheel: it does not change the spin engine, the
student queue or the "In queue" checkbox, and decisions D1 to D11 are untouched.

### Where the code is

| Path | What it is |
| --- | --- |
| `src/presentation/` | Pure logic: draw, eligibility, actions, replay, schedule, capacity, validation. No network, storage, clock or randomness of its own (enforced by `tests/repo/presentation-hygiene.test.ts`). |
| `src/data/local/presentations.ts` | The operations a screen will call. Each is one stale-safe write. |
| `src/data/local/store.ts`, `idb-store.ts` | `updatePresentation`, the only way presentation data is changed. |
| `tests/compat/baseline-a785855/` | Frozen copy of the storage code as it shipped before this feature. Test-only. Never edit, never import from `src/`. |

### Storage shape

One optional field on the class record, `presentation`. No new object store, no new index,
`DB_VERSION` stays 1.

```ts
interface PresentationData {
  epoch: string;      // lineage id: new whenever the class is restored, replaced or put back
  rev: number;        // rises by one on every presentation write
  updatedAt: string;
  classLog: ClassLogEntry[];          // class-level eligibility changes and the "continued" marker
  inactive: InactiveStudent[];        // students not presenting in this class (derived from classLog)
  movedTo: { classId; at; on; classRev } | null;  // set when the work continued in another class;
                                              // classRev is the class's own revision at that moment
  continuedFrom: { classId; marker } | null;  // set on a class that continues another
  draws: PresentationDraw[];
}
```

A draw holds its order (seed, input ids, drawn positions), a starting snapshot (`base`), an
append-only event log, and the current state. Types are in `src/presentation/types.ts`.

### Version rules

| Record | Version |
| --- | --- |
| Class with no `presentation` field | `schemaVersion` 1, exactly the ten original fields, byte-identical to the older build's record |
| Class with a `presentation` field | `schemaVersion` 2, and `rev` at least 2 |
| Backup with no presentation data in any class | `formatVersion` 1, byte-identical to the older build's file |
| Backup where any class holds presentation data | `formatVersion` 2. Classes inside it without presentation data are still schema 1. |

Both directions are enforced on restore: schema 2 without presentation data, format 2 without
any presentation class, and presentation data on a revision-1 class are each refused. Schema 3
or format 3 is refused as "newer version". Nothing is written when a file is refused.

**The first-write rule.** The write that creates a class's presentation data also raises the
class `rev` by one (later presentation writes do not). The older build decides whether the
automatic starter class is disposable partly by `rev === 1`; this rule means it can never see
a class that holds presentation data as disposable.

### Rollback: what the older site does with this data

Verified by running the older build's own code (the frozen baseline) against data written by
this one, on the in-memory store, on the IndexedDB code, and on Chromium's real IndexedDB.
Scenario ids refer to `tests/compat/scenarios.ts` and `tests/presentation/scenarios.ts`.

| Older build does | Result | Verified by |
| --- | --- | --- |
| Opens the database, lists and reads classes | Works. Presentation data is carried, unseen. | C8 |
| Rename, add, edit or remove a student, untick "In queue", save settings, log a spin, confirm a backup | Presentation data unchanged, token unchanged | C9 |
| Delete a class, then "Put it back" | Presentation data returns intact | C10 |
| Replace a class from an older file | Draws move to the recovery copy. "Put it back" (either build) restores them. | C11 |
| Back up a class that holds presentation data | Writes a file labelled format 1 with a schema 2 class. The older build refuses to reopen it ("newer version"); this build accepts it. | C12 |
| Restore a format 2 file | Refused as "newer version". Nothing written. | C13 |
| Restore over a starter class that holds only a draft | Never dropped: the draft stays in the class or in the recovery copy | S12 |
| Edits from a tab still running the older code while a draw is in use | Both kept. After a replace, the presentation tab is refused. | K14 |

What the older build cannot do: show, edit or back up presentation data in a form it can
restore itself. A teacher on a rolled-back site should make backups only after rolling
forward again, or keep the format 1 labelled file for this build to read.

### The starter class

`isUntouchedStarter` (the test that lets a restore replace the automatic first class without
asking) is true only for a class that has exactly the ten original fields, is schema 1, and is
otherwise empty. A starter class holding a draft, an empty presentation record, or any field
this build does not recognize is never dropped. If the draft appears in another tab after the
restore has read the class, the restore is refused and changes nothing (S1 to S14).

### Stale-safe writes

A tab presents a token, `{ epoch, rev }`, read from the class it is showing.
`updatePresentation(classId, token, change)` applies `change` only if the stored token is
still equal, inside one transaction (or one uninterrupted step in memory). Otherwise it throws
`StoreConflictError` and nothing changes.

- `rev` alone is not enough: restoring an older backup and acting again can reach the same
  number with different content. `epoch` is replaced on every restore, replace and put-back.
- Each action also states what it expects (`{ type: 'done', entry }` names the presenter) and
  is refused if that is not the current state, even when the token matches.
- Roster edits and presentation actions do not block each other.
- The class fingerprint used by delete, replace, "Put it back" and "delete everything"
  (`stampOf`) includes the presentation token, so a presentation action in another tab makes a
  stale destructive action refuse. A class with no presentation data keeps its old fingerprint.

### The replay contract

`replay(order, base, events)` rebuilds a draw's state from its order, its starting snapshot
and its log. It takes nothing else: not the roster, not the clock, not the source class.

- Events record outcomes (who was revealed, who was passed over and why), never inputs that
  would have to be re-evaluated.
- **Every write is checked.** `commitPresentation` (the single gate inside
  `updatePresentation`) replays each drawn draw and refuses the write unless the result equals
  the state being saved. A record whose saved state disagrees with its log cannot be stored.
- Restore runs the same check. A file with one inconsistent draw is rejected whole.
- History only grows. A drawn order cannot be removed or altered except by a counted redraw
  before anyone is revealed. Undo appends an event; it does not delete one.

### Capacity

One budget, measured as the number of bytes a class's presentation data adds to a backup file
exactly as the file is written (`presentationFileBytes`). The number shown, the number checked
on every write and the number that matters for restore are the same number.

| Limit | Value | Effect |
| --- | --- | --- |
| Budget per class | 2 MiB | A write that would pass it is refused before anything is stored |
| Warn | 75% | Reported by `usageOf` |
| New work | 90% | New draws, new orders and redraws refused. Work on existing draws continues. |
| Reserve | 16 KiB | Only the "continued in another class" marker may use it |
| Open work | half the budget | Adding draws, presenters, dates or exclusions is refused once the unfinished work could no longer be carried into a new class. Reveal, done, defer, absent, skip and undo never count against it. |

Nothing is ever deleted to make room. A full class is continued in a new one:

- **Continue in a new class** (`continueInNewClass`) is one storage step
  (`WorkspaceStore.continuePresentation`). Inside that one step it confirms the tab's view is
  current, confirms the new class's id is free and that the continuation is valid and fits,
  marks the old class as continued, and creates the new class from the old class exactly as
  the step reads it. If any part fails, including the write of the new class, nothing is
  changed: the old class is not frozen and no class is created.
- **The new class is one coherent snapshot.** Its roster, settings, ring weights, presentation
  state and absences for the day all come from that single reading. There is no moment at
  which the old class is frozen and the new class does not exist, so an edit in another tab
  lands either wholly before the step (and is in both classes) or wholly after it (and is in
  the old class only). An earlier version froze first and built the new class in a second
  step from a later reading; a roster edit in between produced a new class that mixed two
  moments. Scenarios X1 to X4 reproduce that and now pass.
- **The old class stays a working class.** Roster, settings, ring weights, spins, backup,
  delete and put-back all work there afterwards. Only its presentation history is closed.
- **Retries change nothing.** Calling `continueInNewClass` or `finishMoving` again, from any
  tab with any token, finds the class that exists. It is recognised by its id and by the
  `continuedFrom` record naming this class and this marker. Anything else under that id is
  never accepted and never overwritten (`ContinuationConflictError`).
- **If the new class is later missing** (deleted, or only the old class was restored from a
  backup), `finishMoving` creates it again in one step. The marker records the old class's
  revision at the freeze (`classRev`), which rises with every roster, settings or ring-weight
  edit. If it is unchanged, the class is rebuilt exactly as first created. If it has changed,
  nothing is created (`ContinuationChangedError`) unless the caller passes
  `acceptCurrentClass`, and then the new class is built from the old class as it is now, in
  one step, and dated when it was really made.
- `reopenPresentations` undoes the freeze while the continuation does not exist. The check and
  the change are one step, so a reopen and a recreation in two tabs can never both happen.
- The new class carries every unfinished presenter with their exact state (on deck, revealed,
  held until a date, absent today, skipped, exclusions, schedule) and starts its own class log
  consistent with the copied eligibility. It does not copy the old class's marker.
- A carried draw's snapshot holds that state itself, so it replays without the old class.
- The two rules above guarantee a full class can always be continued: the marker always fits in
  the reserve, and the continuation is never larger than half the budget. Property-tested
  (`Q13`, "the largest valid classes can always be continued").

### Backup size

RingWheel refuses to restore a file over 25 MB. `exportBackupChecked` measures the real
serialized file (roster, settings, spin history and presentation data) and throws
`BackupTooLargeError` rather than hand over a file that could not be restored. For "all
classes" it reports whether each class fits on its own, so the teacher can back them up one
at a time. Under the limit the text is exactly what `exportBackup` plus
`JSON.stringify(backup, null, 2)` has always produced.

The Classes page still calls `exportBackup` in this build. Switching it to the checked version,
with the wording for the refusal, is PR 10b.

Known and unchanged: one class can pass 25 MB through spin history alone (roughly 45,000
spins). That was already true before this feature. `exportBackupChecked` names the class
instead of producing the file; splitting one class's history across files is not designed.

### Display privacy

`publicView(draw, roster)` is the only data a projected display may use. It contains the
title, the current and on-deck presenters once revealed, and counts. It never contains a name
that has not been revealed. This protects what is on the screen. It does not hide data from
someone with access to the browser profile: the full order is in the same storage.

### Acceptance cases added on owner approval (2026-11-25)

These refine the blueprint's capacity and continuation cases.

| Case | Requirement | Test |
| --- | --- | --- |
| Q5 | A continued draw keeps every unfinished presenter's state: current-day absence, on deck, revealed, holds, eligibility, exclusions, schedule | Q5, R8 |
| Q6 | Its snapshot reproduces that state without the source class | Q5 (`drawIsConsistent`), R8 |
| Q7 | The new class starts a valid class log matching the copied eligibility, with no "moved" entry from the source | Q5, "the new class gets its own class log" |
| Q8 | Stable destination id; retries and two tabs arrive at one class | Q8 |
| Q9 | A conflicting class under the destination id is never overwritten; capacity and id are checked before the source is frozen | Q9 |
| Q10 | A class at the largest valid size can always be continued | Q3, Q13, "the largest valid classes" |
| Q11 | Backup size is the real serialized size including roster, settings and spins | Q11, Q14 |
| Q12 | Neither a single-class nor an all-class backup over the restore limit is produced silently | Q11 |

### Continuation integrity cases (2026-11-27)

Added after review found that the new class could be built from a later reading of the old
class than the one that froze it. All run on both stores and in Chromium's own IndexedDB
(`tests/presentation/continuation-scenarios.ts`, and X12 in `tests/compat/scenarios.ts`).

| Case | Requirement |
| --- | --- |
| X1 | An edit landing immediately after the freeze is not in the new class |
| X2 | An edit landing immediately before the freeze is in both classes |
| X3 | Interrupted, then the roster is edited, then recovery: the new class matches the old class at the recorded freeze |
| X4 | An interruption while the new class is being written undoes the whole step, including the write already made to the old class |
| X5 | Retries from any tab with any token create no second class and never reset the new class |
| X6 | The old class keeps working for the wheel; neither class changes the other |
| X7 | New class deleted, old class unchanged: recreated exactly as first created, once, even when two tabs ask together |
| X8 | New class deleted, old class changed: nothing is created silently; accept the current class in one step, or reopen |
| X9 | A class under the destination id that is unrelated, or names another marker or another class, is never accepted or overwritten |
| X10 | Reopen and recreation can never both happen |
| X11 | The storage step refuses a stale view, an id in use, an invalid new class and a builder error, each with nothing stored |
| X12 | The older build keeps using both classes; its edits count as a change to the old class |

## Interfaces reserved for later work

It records the smallest additions later work needs, so this change does not have to be reworked.

### PR #10: Presentation Draw

No longer reserved. The logic and storage are implemented (PR 10a) and described in
"Presentation Draw storage" below. The screens are PR 10b. The design sketched here earlier (a
separate `sessions` store, database version 2) was replaced: it could not be rolled back.

### PR #11: Theme Engine

Current seams: color tokens in `src/index.css` (`@theme`), ring fills in
`src/components/RingWheel.tsx`, sounds in `src/services/audio.ts`, and the points in
`src/pages/SpinPage.tsx` where a spin starts, ticks, settles and saves.

```ts
/** Everything the spinner announces. Themes and sound packs react to these and nothing else. */
type SpinEvent =
  | { type: 'spin_started'; rings: RingKey[]; durationMs: number }
  | { type: 'tick' }
  | { type: 'spin_settled'; outcome: SpinOutcome }
  | { type: 'veto_started'; ring: RingKey }
  | { type: 'mercy_applied'; outcome: SpinOutcome }
  | { type: 'save_confirmed' }
  | { type: 'save_failed' };

interface ThemeDefinition {
  id: string;
  name: string;
  version: number;
  tokens: Record<string, string>;                       // CSS custom properties from @theme
  ringFills: Record<RingKey, [string, string]>;
  soundPackId: string | null;
}

interface SoundPack {
  id: string;
  name: string;
  cues: Partial<Record<SpinEvent['type'], { src: string; volume: number }>>;
}

interface AccessibilityPrefs {
  reducedMotion: 'system' | 'on' | 'off';
  highContrast: boolean;
  textScale: number;                                    // 1 = default
  sound: boolean;
}
```

- A theme is data, never code. It cannot change an outcome: the engine decides the result
  before the first event is sent.
- Accessibility preferences belong to the device, not to a class: store them in `localStorage`
  under `ringwheel.prefs`, outside the workspace and outside backups.
- A class may name a preferred theme with a `theme` row in its settings, which already
  round-trips through backups.
- Sound and image files for themes must be served from the site itself. The Content Security
  Policy in `vercel.json` would need `media-src 'self'` and nothing wider.
