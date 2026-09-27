# Invoice draft, category and receipt repair — 2026-09-15

## Findings and changes
- The local invoice list prepended every browser snapshot as a new invoice, including snapshots of existing AI invoices. It also repeated these snapshots on every page.
- Snapshots now share invoice identity (including legacy edit keys), replace the existing draft row, and paginate without duplicates. Posted snapshots are not offered as new drafts.
- Explicit cancellation removes all aliases only after successful deletion; an already missing document can be removed from the draft list. Unrelated drafts are preserved.
- The form records the created document ID before payments and posting. A retry after a failed response uses a durable operation ID. Opening an already posted document no longer automatically clones it.
- Initial split payment retries do not repeat a successfully recorded payment part. Resuming a paid draft loads its payment state.
- Each row's folder selector and the bulk selector offer Create folder. The dialog stays in the invoice; the selection is preserved during exact product matching.
- AI sees names from the local category list. The local transaction reuses a matching folder or creates a suggested missing one, keeps existing assigned product categories, and rolls new categories back if any row fails validation. New products still have no invented barcode and zero stock until posting.
- Cyrillic case and extra spaces no longer bypass folder duplicate detection.
- Receipt errors translated by desktop IPC are now shown instead of a generic print-failed message. No automatic retry was added.

## Authorized data correction
The owner confirmed a single actual delivery and explicitly approved cancellation of the second invoice:
- Kept: 8b5ca995-96f1-46f3-b8e0-bdc85024fc0b, number 0000133371, total 666726 kopecks.
- Cancelled: 1e692044-8e2d-43c8-bc45-9cf9598e8586, same number, total and 18 exact item rows, no payment.
- Before changing the live DB: consistent backup plus trial cancellation on a separate copy.
- Backup: C:/Users/neo/AppData/Local/Forsage/backups/before-duplicate-cancel-2026-09-15T12-21-02-835Z.db
- Used existing LocalSupplyRepository.cancelInvoice without initializing/migrating the production database. Validated exact IDs, status, supplier, amounts, item equality and payment absence inside the write transaction.
- Removed 29 duplicate units across 18 products; recorded 18 cancellation movements. Original remains posted. Cash operations unchanged.
- Detailed before/after: tmp/duplicate-cancellation-result.log. No other stock corrections performed.

## Printer
- Actual recorded failure: PRINT_QUEUE_STUCK on POS-58-Series.
- Stuck job was our older technical diagnostic, ID 5, Deleting/Printing/Retained, zero reported pages.
- With explicit permission, restarted Windows Spooler via administrator confirmation. Afterwards POS-58 queue empty, printer reported Normal. Other queues empty before restart.
- No receipt was resent, and physical printing has not yet been confirmed by the owner.

## Verification
- Web: 502 tests passed in 76 files.
- Desktop: 430 tests passed in 75 files.
- Web lint, desktop compilation and git diff whitespace check passed.
- Same-path EXE rebuilt successfully at 15:24 local time (2026-09-15), 91,316,759 bytes. Existing desktop shortcut verified. Native Electron local-DB smoke test passed on a disposable database. No extra user-facing application copy. No GitHub push in this iteration.
