# Black-box follow-up — 2026-09-14

## Confirmed and repaired

- Mirror signing failed because the administrative provisioning helper used the Electron encryption profile, while the packaged app used the desktop profile. Rewrapped the existing encrypted identity through private process IPC, validated the unchanged public key and a signature, preserved the prior encrypted file. No plaintext key files, key rotation, database reset or balance recalculation. The live application's outbox subsequently drained to zero (7448 acknowledged operations at the check).
- Provisioning and application startup now explicitly select the existing desktop profile. An unreadable or mismatched signing identity is never silently regenerated.
- Customer card serialization omitted loyalty_mode and always returned price_tier=null. Creation also omitted loyalty_mode. Read/edit/create now preserve the mode and configured group; barcode, picker and edited-card POS paths share one discount calculation. Cashback does not reduce the receipt. An explicit group retains precedence, now explained beside the field.
- The latest logged customer save was by a cashier, successfully completed in 9 ms. Existing policy allows customer financial changes only to owner/admin/manager. Unauthorized financial writes now fail clearly rather than being silently dropped. No expansion of cashier permissions.
- Categories and brands used correlated scans of the outbox. A single tenant-scoped exclusion set returns the same rows. Read-only measurement on the working database: categories 1209 ms -> 8 ms (149 rows); brands 1595 ms -> 10 ms (192 rows).
- Order counters, sidebar picking, mirror dispatch, backup dispatch and sync-health reads pause while the access gate is locked. The underlying drafts remain mounted; main-process authorization is unchanged.
- Failed manual inventory quantity/purchase/retail saves remain completion blockers after the initial toast and repeated completion attempts. Only a successful save of that field or removal of that row clears its failure. Errors are scoped by revision and field; no automatic replay of uncertain writes.
- Print preflight no longer deletes pre-existing jobs. Failed or timed-out spooler checks are not reported as success and do not trigger an automatic driver retry.
- Black-box error classification distinguishes lock, inventory availability, stale card, mirror identity and print errors without logging customer/product names or credentials. Native crash capture is local-only, with no upload URL, to diagnose the early native crashes that had no dump.

## Verification

- Unit/regression checks cover customer creation and round trips, discount policy, cashier rejection, reference tombstones/tenant isolation, identity preservation, diagnostic privacy, printer safety and failed inventory writes.
- Typecheck and lint passed. Tests: web 480, desktop 420, server 275 (1175 total). Electron SQLite smoke passed. Portable replacement requires the running EXE to be released.
- Live printer status read: all queues empty and printers reported Normal. No real print, sale, refund or stock correction was performed by this audit.

## Not proven fixed

- The early renderer/utility/GPU crashes with exit code -2147483645 had no native dump or matching Windows Application event. No claim of an identified native root cause. New capture supports analysis if they recur; no sandbox/security disabling or automatic destructive recovery.
- The historical label failure cannot be assigned to a physical printer/driver cause from the old privacy-limited log. Physical print quality and reliability still require an actual print.
- Two rejected sales were availability/reservation checks, not evidence to override stock protection. Actual balances were not rewritten.
- Existing two-PC LAN verification and other previously documented audit limitations remain separate.
