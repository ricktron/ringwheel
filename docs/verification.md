# Ringwheel verification checklist

Automated checks cover the rules and workflows listed in the README. This checklist is what
still needs a person and the real backend. Use a demo period, not a real class.

## Automated (run before any deploy)

```bash
npm run check
```

```bash
npm run test:e2e
```

Both must finish with no failures.

## Before class, Local Mode (about one minute)

- [ ] The page says "Local Mode" and the top right says "Browser storage: working".
- [ ] The class named in the Local Mode line is the one you mean to use.
- [ ] Load Roster lists the students you expect.
- [ ] Next Spinner, then SPIN. The result panel says "Saved in this browser".
- [ ] If the Local Mode line says "Never backed up" or "Not in a backup yet", download a backup
      from Classes when class is over.

## Before class, Connected Mode (about two minutes)

- [ ] The page says "Connected Mode" and the top right says "Backend: connected".
- [ ] No yellow or red banner is showing.
- [ ] Load Roster for a demo period lists the students you expect.
- [ ] Next Spinner, then SPIN. The wheel stops with the result under the pointer and the
      result panel says "Saved to the log". "Saved (not confirmed complete)" means the
      deployed backend is the older version. "Saved INCOMPLETE" or "NOT SAVED" names the
      column to add to the `SpinsLog` tab.
- [ ] A new row is in the `SpinsLog` sheet with the right student, period and results.
- [ ] The text is readable from the back of the room on the projector.

## After a backend deploy

- [ ] `health` returns `{"status":"ok"}` with the token and `Forbidden` without it
      (commands in `gas/README.md`).
- [ ] Roster, rings and settings load in the app.
- [ ] One test spin is logged.
- [ ] Admin: change one setting, save, reload, confirm it stuck and that other rows and
      notes in the `Settings` sheet are unchanged. Change it back.

## After a frontend deploy

- [ ] The checks under "Before class, Local Mode" pass on the deployed site.
- [ ] `/spin`, `/classes` and `/admin` each open directly and survive a refresh.
- [ ] A first visit in a private window starts in Local Mode with nothing configured.

## If something is wrong

- "NOT SAVED to the log": the result on screen still stands. Use Retry. If it keeps failing,
  write the result down and carry on; nothing is lost on screen until the page is closed.
- "Saved INCOMPLETE": the student and result were stored. The fields named were not,
  because `SpinsLog` has no column for them. Add the column headers.
- Admin says the Sheet "was changed by someone else": nothing was saved and nothing was
  lost. Press "Reload current values" and make the change again.
- "Backend: error": read the line under it. A rejected token means the token in the app does
  not match `API_TOKEN` in the Apps Script project.
- "No spin was made": the rules left nothing legal to pick. The message says which rule.
- Prefer rolling back to the previous version over fixing things during class.
