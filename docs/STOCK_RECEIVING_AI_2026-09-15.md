# Stock UI and AI receiving fixes — 2026-09-15

## Changes
- Writeoff quantity is kept as editable text; removed silent clamping to the stale row stock and the stale HTML maximum. Positive finite quantities are validated; the local warehouse still checks current stock before any deduction. Piece-unit arrows step by 1; measured units retain fractional steps. Legacy numeric drafts still load.
- Removed the obsolete postImmediately checkbox, state, draft property and secondary posting button. Explicit invoice submission posts the invoice; leaving the form still preserves its draft. AI recognition still creates a draft, never posts automatically.
- Recognition did not release sendBusy in its finally block. Confirmation then returned silently because recognition was still marked busy. The lock is now released by the recognition operation itself, including failed recognition, before upload cleanup.
- Recognized supply invoices open the complete review modal directly; duplicate short table removed. Closing review retains the prepared action for reopening.

## Norvego stock investigation (read-only)
Product d2c2e779-cfdc-4323-a26c-df62069f2672, SKU 86137, barcode 4823110603659, 10W40 Norvego Super SG/CD 4L. Only one card matches that barcode.
- Inventory named 02.09.2026, completed 03.09 at 09:43 UTC: counted 6.
- Completed sale L-260903-6583-0014 at 10:38 UTC: 2 units, recorded stock after sale 4.
- Backup Forsage-2026-09-04_05-22-49-674.db: stock 4, updated 03.09.
- Backup Forsage-2026-09-05_10-02-14-967.db and subsequent checked backups: stock 0 with old updated_at 26.08.2026.
- Current stock remains 0. This establishes an old stock rollback between those backups, not a change introduced by today's rebuild. Available evidence does not establish the exact historical actor/process. Current IPC authority guards prohibit incoming server stock/bootstrap writes; their tests passed.
- The user reports 2 physically present, whereas the latest recorded inventory and sale imply 4. Do not silently restore either value. Reconcile physical stock and any missing movements through an explicit inventory correction after confirmation.

## Verification
489 web tests passed. 21 desktop stock/idempotency/authority tests passed, including writeoff of 5 from 12 and rejection of 8 from the remaining 7 without partial writes. Web typecheck and lint passed before the last UI simplification; the final build rechecks types. No production stock mutations or AI paid recognition were performed. EXE was rebuilt in place after the user closed the app; these fixes are also included in the 15:24 build. Later invoice duplicate correction is documented separately in INVOICE_DRAFT_PRINT_FIX_2026-09-15.md.
