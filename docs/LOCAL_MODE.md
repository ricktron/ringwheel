# Local Mode and Connected Mode

Date: 2026-11-24

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
| `recovery` | `id` | Copies taken before a class is deleted or replaced. The newest five are kept. |

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
  lastBackupAt: string | null;
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

### Changing the schema later

1. Bump `WORKSPACE_SCHEMA_VERSION` and add a step to `migrateWorkspace`.
2. If a store or index is added, bump `DB_VERSION` in `idb-store.ts` and extend `upgrade`.
3. If the backup file gains fields, bump `BACKUP_FORMAT_VERSION`. Older files must still import.
4. A file or class saved by a newer version is refused with a clear message, never half-read.

## Backup, restore and export

Everything is on the Classes page.

| Action | What it does |
| --- | --- |
| Back up a class / all classes | Downloads one JSON file with the complete roster, settings and spin history |
| Restore > Add | Adds the classes in the file. Nothing already in the browser is changed. A class that already exists is added beside it as a copy. |
| Restore > Replace | Replaces a class with the same id. A copy of the current version is kept under Recovery first. |
| Recovery > Put it back | Undoes a delete or a replace. The undo is itself undoable. |
| Spin history as CSV / Roster as CSV | Ordinary spreadsheets for classroom records |
| Delete everything | Requires typing DELETE. Removes all classes, history and recovery copies. Not undoable. |

Guarantees, each covered by a test:

- A backup file is validated from top to bottom before anything is written. One problem
  anywhere rejects the whole file and changes nothing.
- Back up, delete everything, restore: the data is identical, including ids, selections,
  timestamps, seeds and flags.
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
  says this, shows when each class was last backed up, and warns when the browser is not
  keeping data at all.
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

## Interfaces reserved for later work

Nothing below is implemented. It records the smallest additions the next two pieces of work
need, so this change does not have to be reworked.

### PR #10: Presentation Draw

Already in place and relied on: stable student ids, the per-student `active` flag, the seeded
shuffle in the spin engine, revision-checked edits, recovery points, and the schema migration
hook.

Additions (workspace schema version 2, database version 2, backup format version 2):

```ts
/** Why a student is left out of a draw. Separate from `active`, which is a roster-level switch. */
interface DrawExclusion {
  studentId: string;
  reason: 'absent' | 'already_presented' | 'teacher_choice';
  until: string | null;          // ISO date; null means until removed
}

interface PresentationSession {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'active' | 'finished';
  seed: string;                  // the order is the engine's shuffle of eligible ids under this seed
  exclusions: DrawExclusion[];
  schedule: {
    startDate: string;           // ISO date
    meetingWeekdays: number[];   // 0 = Sunday
    slotsPerMeeting: number;
    skipDates: string[];
  };
  entries: PresentationEntry[];
}

interface PresentationEntry {
  studentId: string;
  position: number;              // fixed once drawn
  state: 'pending' | 'completed' | 'skipped' | 'absent';
  estimatedDate: string | null;  // derived from the schedule; stored so it can be shown offline
  completedAt: string | null;
}
```

- Storage: a new `sessions` object store keyed by `id` with an index on `workspaceId`, plus
  `listSessions`, `putSession(expectedUpdatedAt)` and `deleteSession` on `WorkspaceStore`.
- Backup: each class bundle gains `sessions: PresentationSession[]`. A version 1 file imports
  with an empty list.
- Resumption: a session is the saved state. Reopening the page loads the `active` session.
- Connected Mode would need new Sheet tabs. That is a separate decision; the provider interface
  should grow session calls on the local provider only until it is made.

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
