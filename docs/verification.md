# Ringwheel Verification Checklist

This document provides a manual QA checklist for verifying the implemented features.

## Health & Connectivity

- [ ] `GET {WEB_APP_URL}?type=health&token=API_TOKEN` returns `{ "status": "ok" }`.
- [ ] `GET {WEB_APP_URL}?type=rings&token=API_TOKEN` returns valid JSON array.
- [ ] `GET {WEB_APP_URL}?type=roster&token=API_TOKEN` returns valid JSON array.
- [ ] `GET {WEB_APP_URL}?type=settings&token=API_TOKEN` returns valid JSON array.
- [ ] Frontend app can be built with `npm run build` with no TS errors.
- [ ] Frontend app can be started with `npm run dev`.

## Spin Basics

- [ ] `/spin` page loads without errors.
- [ ] A visible "SPIN" button starts and stops the animation.
- [ ] Spinner wheels show Region, Taxon, and IUCN status.
- [ ] Current Result section displays A/B/C labels after spin.
- [ ] Recent spins list (if implemented) shows A/B/C labels and seeds.

## Logging

- [ ] After a spin, a new row appears in `SpinsLog` sheet with the correct `timestamp_iso` and `seed`.
- [ ] `rule_flags_json` contains a valid JSON array (e.g. `[]` or `["random_event_sparkles"]`).
- [ ] `plantae_mercy` field matches expectations (true when Plantae Mercy applied).
- [ ] `is_test` field is set correctly based on test mode.
- [ ] `session_id` is consistent across multiple spins in the same session.

## Admin Write-back

- [ ] `/admin` page loads without errors.
- [ ] `/admin` displays current Settings and Ring Weights.
- [ ] Editing a setting value and clicking "Save Settings" updates the Google Sheet.
- [ ] Editing a ring weight and clicking "Save Weights" updates the Google Sheet.
- [ ] Reloading `/spin` shows updated values after write-back.

## ASMR & Confetti

- [ ] Spinning triggers tick audio without crashing the app.
- [ ] Spin completion triggers reveal audio.
- [ ] Confetti appears at the end of a spin on supported browsers.
- [ ] Audio and confetti can be enabled/disabled via Settings (if implemented).

## Random Events & Plantae Mercy

- [ ] Over several spins, a random event flag appears at least once (you may temporarily force the probability to 100% for testing).
- [ ] A spin that meets the simple Plantae Mercy condition sets `plantae_mercy = true`.
- [ ] Plantae Mercy is logged with the `'plantae_mercy'` flag in `rule_flags_json`.
- [ ] "🌿 Plantae Mercy" button appears when conditions are met.
- [ ] Plantae Mercy button allows region selection for re-spin.

## API Contract Verification

- [ ] All GET requests use `type` query parameter (lowercase).
- [ ] All POST requests include `type` in JSON body (lowercase).
- [ ] All requests include `token` for authentication.
- [ ] Unauthorized requests (missing or invalid token) return "Forbidden".
- [ ] Unknown types return "Not Found".

## Browser Compatibility

- [ ] Works in Chrome (latest).
- [ ] Works in Firefox (latest).
- [ ] Works in Safari (latest).
- [ ] Works in Edge (latest).

## Edge Cases

- [ ] Empty Rings sheet handled gracefully (displays message or defaults).
- [ ] Empty Settings sheet handled gracefully (uses defaults).
- [ ] API errors displayed to user without crashing.
- [ ] Rapid spin clicks don't cause issues.
