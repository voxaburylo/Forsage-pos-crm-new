# Label batches and receipt quantity correction — 2026-09-16

## Print fix

- User reported `ERR_FAILED (-2)` loading a large base64 `data:text/html` URL and confirmed a large label batch.
- A hidden, isolated Electron probe reproduced long-navigation failure at 1.6 MB and 4 MB (probe error `ERR_INVALID_URL`; the exact original HTML was not available).
- All three print paths now load a fixed short opaque-origin shell and insert the HTML without embedding the document in the navigation URL. Sandbox, context isolation, printer routing, timeouts and no-automatic-fallback rules are unchanged.
- Label/receipt errors no longer expose the huge encoded document to users.
- Visual QA caught a blank offscreen receipt resize frame after document injection. Receipt capture now rejects blank/transparent frames and requests bounded preview repaints until ink is present; physical print is never retried. Nine real Electron runs and visual inspection confirmed rendered text. The final packaged application includes this guard.
- Real Electron dry-run: 4 MB HTML, all three pages retained; small and large versions produced identical TSPL bytes. A second 4 MB/100-label batch completed in 7.3 seconds with all 100 labels (811,000 TSPL bytes). Receipt raster rendering passed. No physical print was sent.

## Invoice quantity fix

- Removed the separate manual-quantity cache, which could overwrite later scan/import additions with an old value at submission.
- Item updates synchronously update the editing and autosave snapshots. Submission captures visible quantity controls by stable row key, checks positive values, recalculates totals, and freezes a copy before asynchronous lookups.
- Hidden desktop/mobile duplicate controls cannot override the visible quantity. Form controls and cancellation/back actions are guarded while posting.
- Regression cases cover 46/56 → 98, scan/import additions after editing, decimals, invalid quantities, immutable submission, and local draft edit → posting exactly once.
- The precise sequence that caused the user's original 56 cannot be proven from existing event logs. Both databases recorded 56 initially; this was not a later server overwrite.

## User-confirmed data correction

- Invoice `dfc7fd07-b176-4c8a-b5a3-cb3801b65a77`, product `930ee99c-daa7-45ed-b510-7288bb8b55b9`, barcode `2000177521924`.
- User confirmed 98 received and 6,810 UAH actually paid.
- Corrected 56 → 98 with a linked +42 movement; invoice line 980 UAH; invoice total and paid amount 6,810 UAH; debt zero.
- Original 6,390 UAH payment retained; added a separately audited 420 UAH correction using the original cash/owner-funds method. Cashbox rows unchanged.
- Repair first tested on isolated SQLite copy with integrity and unrelated-row hash checks. Idempotent repair marker prevents repeated application.
- Local and server records verified after commit. Server local-balance mirror advanced using the registered device and current local sequence; stock trigger protections remained enabled. The first server attempt rolled back because it correctly retained the old mirror snapshot; no partial server changes remained.
- Only the new payment outbox entry was marked delivered after server verification; original historical events were retained.

Backups before live repair:

- `C:/Users/neo/AppData/Local/Forsage/backups/before-circle98-2026-09-16T13-41-26-021Z.sqlite`
- `C:/Users/neo/AppData/Local/Forsage/backups/before-circle98-server-2026-09-16.json`
- `C:/Users/neo/AppData/Local/Forsage/backups/before-circle98-balance-mirror-2026-09-16.json`

## Verification and delivery

- Full desktop (496 tests) and web (567 tests) suites, both type checks, web lint and whitespace check passed.
- User authorized closing the application and replacing the existing portable EXE. Application closed normally, without force kill.
- No Git push or Vercel deployment requested in this delivery. Physical printer confirmation remains a user check.
- Final build replaced the existing `apps/desktop/release/Forsage-0.1.0-portable.exe`: 91,341,520 bytes, 2026-09-16 17:08:13 local time. SHA256: `C82D70856F3387BCECDAFB63F3AF9E4E8B32FF4D31963FFFC0863F242AED0E06`. Packaged resources were checked for the short print shell, receipt ink guard/bounded redraw, and invoice quantity capture without the stale override. The existing desktop shortcut `ФОРСАЖ — КАСА.lnk` still points to this file. No extra desktop shortcut or application copy was created.
