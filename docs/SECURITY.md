# Ringwheel security notes

Date: 2026-11-24

## The rule

No credential belongs in this repository or in a compiled copy of the site.

- This repository is public. Anything committed is public forever, including in history.
- RingWheel reads no build-time environment variables. A backend address or token is never
  compiled into the site, whatever is set when it is built.
- The API token is the only thing protecting a connected roster (student names and email
  addresses), the spin log, and the routes that change settings.
- Local Mode, the default, has no token and contacts no backend. See `docs/LOCAL_MODE.md`.

What enforces the rule:

- `tests/repo/hygiene.test.ts` fails the build if any `.env` file is tracked, if a real Apps
  Script address appears in a tracked file, if the frontend reads a `VITE_` variable or gains a
  hard-coded address or token, or if Local Mode code could make a network request.
- `npm run test:e2e` builds the site with canary values in the old variables and fails if
  either appears anywhere in the output.
- `npm run build` prints a notice when one of the old variables is set, saying it is ignored.
- On the hosted site a Content Security Policy allows connections only to Google Apps Script.
- Connected Mode turns on only when the teacher enters a complete connection on the Admin page.

Where the token should live instead:

- Backend: `API_TOKEN` in the Apps Script project's Script Properties. Never in `Code.gs`.
- Frontend, local or hosted: entered on the Admin page under "Where data is kept". It is kept
  in that browser's storage only. There is no `.env` file any more.
- A token in browser storage can be read by anyone with access to that browser profile. Use
  Connected Mode on your own computer, not a shared one.

## Finding: a token was published in `.env.example`

Verified on 2026-11-24 from Git history, without printing or using the value.

| Fact | Detail |
| --- | --- |
| File | `.env.example` on `main` |
| Variable | `VITE_SPIN_API_TOKEN` |
| First committed | 2025-11-28, commit `1c5ba9b` |
| Still present on `main` | Yes (`d472b88`) |
| Nature of the value | Not a placeholder. 14 characters, lowercase letters and digits only, and it contains the project name. It is guessable as well as public. |
| Published alongside it | The full address of an Apps Script Web App deployment, in the same file |
| Other places | The same deployment address is hard-coded in the private `ringwheel-classroom-spinner` repository. The token value is not in that repository. |
| On the consolidation branch | Both replaced with placeholders. They remain in history. |

An earlier commit (`cfb853b`) holds a different value that reads as a "replace me" template,
not a credential.

Not verified: whether the published value is, or ever was, the real `API_TOKEN`. Checking
would mean sending it to the production backend, which was not authorized.

### Risk if the value is or was the real token

Anyone who found the repository could:

- read the roster: student names and school email addresses;
- read the spin log;
- append false rows to the spin log;
- overwrite the Rings and Settings tabs;
- send email from the script owner's Google account to any address, through the email route.

Because the value is short and built from the project name, treat it as compromised even if
it was never committed anywhere else.

## Rotation procedure

Only the owner of the Apps Script project can do this. Nothing below was done for you.
It takes about five minutes. Do it outside class time.

1. **Check first (optional).** Open the Apps Script project > Project Settings > Script
   Properties and look at `API_TOKEN`. If it is 14 characters long and contains the project
   name, it is the published value. Rotate either way if you are unsure.
2. **Generate a new token** on your own computer. Do not make one up.

```bash
openssl rand -hex 32
```

3. **Replace it.** In Script Properties, set `API_TOKEN` to the new value and save. It takes
   effect immediately. No new deployment is needed and the Web App address does not change.
4. **Update your own copy of the app.** Enter the new value on the Admin page under "Where data
   is kept" and save.
5. **Confirm the new token works** (replace `URL` and `NEW`):

```bash
curl -sL "URL?type=health&token=NEW"
```

   Expected: a response containing `"status":"ok"`.
6. **Confirm the old token is dead** (replace `URL` and `OLD`):

```bash
curl -sL "URL?type=health&token=OLD"
```

   Expected: `Forbidden`.
7. **Look for misuse during the exposure window** (2025-11-28 to the day you rotate):
   - `SpinsLog`: rows you do not recognize.
   - `Rings` and `Settings`: use File > Version history in Sheets to look for edits you did
     not make.
   - Gmail > Sent: mail you did not send.
   - Apps Script > Executions: activity at times you were not using the app.
8. **Do not** paste the new token into a chat, an issue, a commit, or a hosted build.

Rolling back is setting `API_TOKEN` to the previous value, which is not advisable.

### What rotation does not fix

- The old value stays in public Git history, in forks and in caches. Once rotated it is
  useless, so rewriting history is not required. Rewriting history on a public repository is
  disruptive and does not recall copies that already exist.
- A token shared by every user is still weak protection for a roster. See the proposed
  sign-in change in `docs/CONSOLIDATION.md`, section 6.

### After the backend is deployed

Two optional Script Properties add separation (see `gas/README.md`):

- `ADMIN_TOKEN`: a second token required to change settings or ring weights or to send email.
- `EMAIL_ALLOWED_RECIPIENTS`: limits who the email route can send to. Without it, only the
  script owner.

## Other security-relevant behavior

- A spin is only shown as saved in full when the backend confirms every field was stored.
- A save from the Admin page is refused if the Sheet changed after the page loaded it.
- Text sent to the backend is stored as text, never as a spreadsheet formula.
- The backend refuses every request when `API_TOKEN` is not set.
