# Section audit remediation — 14 September 2026

Local SQLite remains the only authority for inventory and money. No historic stock reconciliation, production sale, return or payment was performed by these tests. The private audit and business exports are not published.

## Implemented

- A01/A02: atomic catalog imports and bulk edits; receipt and mutations share a transaction. Retrying a lost response uses the same operation ID. Large batches run in a worker, not the Electron main thread.
- A03: supplier payment identity survives a page reload; replaced the in-memory-only attempt tracker.
- A04/A17: strict fractional quantity parsing, invalid rows reported, exact SKU punctuation/leading zeros preserved, ambiguous matches rejected. The original import matching packet survives a reload.
- A05: removing a photo from an unsaved form no longer deletes its file. Cleanup follows a successful save and checks remaining references.
- A06: rich order drafts open in the full editor instead of dropping their fields in the quick editor.
- A07: one request deadline covers authentication, refresh, fetch and response body; abort is passed through to fetch.
- A08: paginated server reports with stable ID order, complete reads despite a smaller server page cap, and bounded ID chunks.
- A09: period profit uses the captured sale-item cost (cost_price in the mirror), discounted sale total and returns on their actual dates. No current catalog price fallback.
- A10: invoice, writeoff and audit responses are checked for current document/filter identity.
- A11: writeoff drafts persist through navigation; controls are disabled while posting; a draft-level operation ID prevents an old restored draft posting twice.
- A12/A14: read-only web navigation, view-only product entry points and valid role landing pages.
- A13: ABC and employee analytics have local database adapters; advances are not counted as salary expense a second time.
- A15/A16: picking count loads all pages; duplicate search is debounced and ignores stale responses.
- A18: unused misleading shift-report adapter removed.
- A19: shift backup embeds available local photos with SHA-256, restores them to a separate root, and checks free disk space before making a copy. Snapshot capture time stays distinct from shift-close time.
- A20: qs override upgraded to 6.16.0; production dependency audit reports no known vulnerabilities at verification time.

## Verification

Automated regression tests include rollback halfway through import/bulk editing, replay after lost reply/re-preview, storage cleanup failure, historical cost/discount/refund arithmetic, local employee analytics, server pagination beyond a configured cap, auth/body deadlines, and restoring a complete synthetic database with photos into a separate directory. Standard verification: pnpm verify, pnpm audit --prod, desktop runtime smoke and portable packaging.

The Supabase workflow was used to check actual mirror columns read-only before publication. Local purchase_price and mirror cost_price intentionally differ; no cloud schema mutation was required.

## Explicit remaining acceptance / limits

- Real two-PC LAN, actual printers/scanner, fiscal service and a full working day still require physical acceptance. Automated tests do not establish that every real-device scenario works.
- Existing historic stock discrepancies need document-by-document investigation, not automatic overwrite from the last movement.
- Existing shift archives and Excel exports were not deleted. Low-space protection is implemented; configurable archive rotation still needs an agreed retention policy. Existing hourly database rotation is unchanged.
- Missing/unreadable photos cannot be recovered from a backup; available file-backed photos are embedded. This is a database-and-photo backup, not an installer or a backup of Windows printer configuration.
- Duplicate merging has an additional safety guard: the old server-only merge must not mutate the mirror from a local application. Local merge is explicitly unavailable until its complete reference/stock migration is implemented and tested. Duplicate search remains available for inspection.
- Old data without a recorded cost cannot yield a provably accurate historical margin. No historical purchase prices were guessed or backfilled.
