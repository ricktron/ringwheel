# Ringwheel backend (Apps Script)

`gas/Code.gs` is the only backend. The frontend client that talks to it is `src/api.ts`.
The route list, request shapes and response shapes are documented at the top of `Code.gs`.

Nothing in this repository deploys the backend. Changes here reach production only when
someone pastes `Code.gs` into the Apps Script project and creates a new deployment version.

## Script Properties

Set these in the Apps Script editor under Project Settings > Script Properties.

| Property | Required | Purpose |
| --- | --- | --- |
| `API_TOKEN` | yes | Every request must carry it. Without it every request is refused. |
| `SPREADSHEET_ID` | yes | The spreadsheet with the `Roster`, `Rings`, `Settings` and `SpinsLog` tabs. |
| `ADMIN_TOKEN` | no | When set, saving settings, saving ring weights and sending email also require this second token. When not set, behavior is unchanged. |
| `EMAIL_ALLOWED_RECIPIENTS` | no | Comma-separated addresses the email route may send to. When not set, email can only go to the account that owns the script. |

## Test before you deploy

The tests run this exact file against fake in-memory sheets. They never contact Google.

```bash
npm test
```

To check the code that is deployed right now, copy it from the Apps Script editor into a
local file and run the same tests against it:

```bash
RINGWHEEL_GAS_PATH=/path/to/deployed-Code.gs npm test
```

## Deploy

Do this outside class time.

1. In the Apps Script editor, note the current deployment's version number.
2. Replace the contents of `Code.gs` with `gas/Code.gs` from this repository and save.
3. Deploy > Manage deployments > edit the existing Web App deployment > Version: New version > Deploy.
   Editing the existing deployment keeps the same `/exec` URL.
4. Run the checks below.

## Verify

Replace `URL` and `TOKEN` with your own values. Run these from your own machine.

```bash
curl -sL "URL?type=health&token=TOKEN"
```

Expected: `{"status":"ok"}`. If a tab is missing the answer names it.

```bash
curl -sL "URL?type=health"
```

Expected: `Forbidden`.

Then open the app, load a demo period, run one spin and confirm a new row in `SpinsLog`.

## Roll back

Deploy > Manage deployments > edit the Web App deployment > Version: choose the previous
version number > Deploy. The URL does not change and no sheet data is touched.

## Sheet columns

The health check and the log route use the same lists.

| Tab | Required | Optional |
| --- | --- | --- |
| `Roster` | `email`, `first`, `last`, and at least one of `S1 Period`, `S2 Period` | `class` |
| `Rings` | `ring_name`, `label` | `color_hex`, `weight`, `order_index`, `active` |
| `Settings` | `key`, `value` | `notes` |
| `SpinsLog` | `timestamp_iso`, `period`, `student_name`, `email`, `result_A`, `result_B`, `result_C` | `session_id`, `plantae_mercy`, `veto_used`, `seed`, `is_test`, `rule_flags_json` |

Column names must match exactly. Extra columns are left alone. An empty `SpinsLog` tab is
fine: the header row is created on the first spin.

What happens when `SpinsLog` does not match:

| Sheet state | Answer to `logspin` | In the app |
| --- | --- | --- |
| All 13 columns | `{ ok: true, complete: true }` | Saved to the log |
| An optional column is absent | `{ ok: true, complete: false, missing_optional: [...] }`. The row is written without those fields. | Saved INCOMPLETE, naming the fields |
| A required column is absent | `{ ok: false, error, missing_required: [...] }`. Nothing is written. | NOT SAVED, naming the columns |
| A test spin and no `is_test` column | `{ ok: false, ... }`. Nothing is written, so a test row can never pass for a real spin. | NOT SAVED |

`health` reports the same problems up front: status `degraded` with a `problems` list when a
required column is absent, and status `ok` with a `warnings` list when only optional ones are.

## Saving settings and ring weights safely

`writesettings` and `writerings` accept `base_rows`: the rows exactly as the client read them.
When present, the write happens only if the tab still holds those rows. Otherwise the answer
is `{ ok: false, conflict: true, error }` and nothing is written. The Admin page always sends
it, so an edit someone made directly in the Sheet is never silently overwritten. Requests
without `base_rows` behave as before.

## What changed compared with the version on `main` before consolidation

All existing requests keep working. The frontend on `main` and the consolidated frontend
both work against either backend version.

- `health` now also confirms the four tabs exist and have the required columns, and returns
  `contract: 2`.
- `logspin` says whether the record was stored in full, in part, or not at all. Before, it
  answered `{ ok: true }` in all three cases.
- `writerings` and `writesettings` validate first, never clear the sheet, keep formatting and
  extra columns, refuse an empty list, and refuse when the tab changed since it was read.
- Text sent by a client is stored as text, never as a formula.
- `getspins` rows also include `is_test`, `seed` and `session_id`.
- `email` only sends to an allowed recipient.
- Optional `ADMIN_TOKEN` for the configuration and email routes.
- A request is refused when `API_TOKEN` is not configured.
