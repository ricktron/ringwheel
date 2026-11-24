# Hosting on Vercel

Date: 2026-11-24

The app is a static site. It needs no server, no database, no environment variables and no
paid feature. `vercel.json` in the repository root is the whole configuration.

## What `vercel.json` does

| Setting | Why |
| --- | --- |
| `rewrites`: everything to `/index.html` | Opening or refreshing `/spin`, `/classes` or `/admin` directly works. Real files are served first. |
| Content Security Policy | Scripts and styles only from the site. Connections only to Google Apps Script, for Connected Mode. The page cannot send data to its own host or to any other site. |
| `Referrer-Policy: no-referrer` | The page address is never passed to another site. |
| `X-Content-Type-Options`, `Permissions-Policy` | Standard hardening. Camera, microphone and location are switched off. |
| Long cache on `/assets/` | Build files have content hashes in their names. |

There is nothing secret in the file, and a test fails if a token or environment value is added.

## What was verified without a Vercel account

`npm run test:e2e` builds the site with the real build command and serves it through a small
local server that applies the rewrites and headers from `vercel.json`. It then checks, in a
browser:

- every route opens directly and survives a refresh;
- Local Mode works under the security policy with zero policy violations;
- the page is blocked from sending data to its own host and to another site;
- the build contains no backend address, token or student name, even when the old
  `VITE_` variables are set to canary values at build time.

This is a stand-in for Vercel's routing, not Vercel itself. A real preview is still worth one look.

## Owner steps to get a preview (not done: needs your account)

No Vercel project exists for this repository yet. Creating one links your Vercel account to
the GitHub repository, so it was left for you.

1. In Vercel: Add New > Project > import `ricktron/ringwheel`.
2. Framework preset: Vite (detected). Leave build and output settings alone.
3. **Add no environment variables.** The app does not read any.
4. Be aware: once the project is linked, Vercel builds a preview for every pull request and
   builds `main` as the production deployment. If you want previews only for now, open the
   project's Settings > Git and turn off automatic production deployments, or link it after you
   have reviewed this pull request.
5. Open the preview URL for the pull request and run the checks below.

The Hobby plan is free and enough for this site. It is intended for personal, non-commercial
use. No custom domain is needed.

## Checks on the preview (synthetic students only)

- [ ] `/spin`, `/classes` and `/admin` each open directly and survive a refresh.
- [ ] The page says "Local Mode" and "Browser storage: working".
- [ ] Add a class with two made-up students, spin, reload: the students and the spin are still there.
- [ ] Classes > Back up all classes downloads a file.
- [ ] Browser developer tools > Network, filtered to Fetch/XHR, stays empty while you spin.
- [ ] Do not enter your real backend token on a preview URL you have shared with anyone.

## Rolling back

Vercel keeps every deployment. Promote the previous one from the Deployments list. No data is
involved: class data lives in each teacher's browser, not on Vercel.

## Note for teachers using the hosted site

Data is tied to the site address. Classes saved on a preview address are not visible on the
production address, and the other way round. Use Classes > Back up to move them.
