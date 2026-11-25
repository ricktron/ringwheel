# Frozen baseline: local-data modules at `a785855`

These files are an exact copy of the Local Mode storage code as it shipped before
Presentation Draw (`main` at `a7858559f2878a27534115176d6303583f7380bb`), with one
header comment added to each and one import path adjusted (`../../types` to `./types`).

They exist so the tests can run the **older site's own code** against data written by the
newer code, and the other way round. That is how rollback is proven rather than assumed:

- the older build keeps presentation data through every ordinary edit;
- it never treats a class that holds presentation data as an empty starter class;
- it refuses, rather than half-reads, a backup it cannot understand.

Rules:

- **Never edit these files.** If they change, the tests no longer describe the build that shipped.
- **The app never imports them.** `tests/repo/presentation-hygiene.test.ts` fails if anything under `src/` does, or if any of these files changes (it pins their checksums).
- To verify the copy, strip the first four header lines (one for `types.ts`) and compare with
  `git show a7858559f2878a27534115176d6303583f7380bb:src/data/local/<file>.ts`.
