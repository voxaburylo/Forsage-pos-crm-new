# Stability follow-up and shift backups

Owner request: implement the recommendations, add private server backup and two
dated Excel exports (products/customers) next to the program after shift close.

## Plan and acceptance

- [x] Report failures: visible error/retry, no stale period results or export.
- [x] Full customer history: paginated receipts/account operations and date range.
- [x] Performance: repeatable isolated load checks; measurements below.
- [x] AI invoice recovery: persist recognized action before write, reuse operation ID.
- [x] CI: workflow for code/tests/build on pushes and pull requests.
- [x] Shift backup: durable job after committed close, full consistent snapshot,
      products/customers XLSX, stable dated paths, no duplicate close/write.
- [x] Cloud: private authenticated upload, bounded retry, verified completion,
      no reverse sync; offline shift close must not wait for network.
- [x] Verify generated exports and restoration using isolated fixtures.
- [ ] Real two-PC LAN acceptance: needs both PCs; do not claim performed.

Constraints: preserve existing working data and unrelated edits; never publish
credentials or customer exports to Git; keep one desktop executable/location.

## Verification performed

- `pnpm verify`: passed (web tests, 350 desktop tests, 253 server tests,
  TypeScript and ESLint). `pnpm --filter server build`: passed.
- `pnpm build:desktop`: passed, existing
  `apps/desktop/release/Forsage-0.1.0-portable.exe` replaced in place.
- Packaged Electron/ASAR worker on an isolated DB: closing a fixture shift
  generated exactly two XLSX files and a verified gzip. Production DB untouched.
- Browser fixture at 375 px: error/retry and export guard, late response from old
  period ignored, all 231 receipts and 75 account operations reachable, invalid
  date range rejected; document width 375 px, no JS errors.
- Read-only copy of working catalog: 280 repeated first-page searches plus next
  pages, median 70.60 ms, p95 82.34 ms, max 89.57 ms. Retained heap +0.26 MiB
  after GC. This is repository load testing, not a full-day UI soak test.
- Failure/restart tests: failed export retains its original snapshot; retry
  does not substitute later stock. Job failure rolls back shift closing. Tenant
  and signed-upload origin/path checks covered. Restore waits for export worker.

## Initial live backup and exports

Created 2026-09-10 19:17:24 UTC from the working DB using a separate read-only
connection. No business records or working schema were modified.

- Local snapshot: `C:/Users/neo/AppData/Local/Forsage/backups/Forsage-2026-09-10_19-17-24-277Z-manual.db`.
- Private Storage bucket: `forsage-private-backups`; public access denied.
- Object: `00000000-0000-0000-0000-000000000001/65835ce5-9b59-4cc9-91d9-f0afe8d76840/67fe13b7-3ba4-4018-8e4b-d1167bd4e448-5d708c9c32b8fa6cd7101126508c6aefa3fea50bcb35d17e359f6ae5e402cfdc.db.gz`.
- Compressed size: 16,069,728 bytes. SHA-256:
  `5d708c9c32b8fa6cd7101126508c6aefa3fea50bcb35d17e359f6ae5e402cfdc`.
- Downloaded again: hash verified, decompressed bytes equal the local snapshot.
- Initial Excel pair: `apps/desktop/release/Вивантаження/2026-09-10_початкова-копія/`;
  14,369 products and 184 customers. Identifiers remain text, money is in UAH.

## Operating rules and remaining acceptance

- Automatic exports start with the next shift closed in the new executable.
  They are stored under `Вивантаження/<timestamp and shift ID>/` near the EXE.
- Closing a shift does not wait for Internet or file generation. Its durable
  job resumes at next startup if interrupted. Each export uses one consistent
  snapshot; metadata distinguishes close time from actual snapshot time.
- Server upload requires the app to be open, online and server-authenticated.
  Failure stays visible in Settings / Backups and is retried. Seven most recently
  uploaded verified shift copies per device are retained privately. Excel files
  are not automatically deleted; monitor local disk space.
- SQLite migration 26 runs at normal startup. No Postgres migration required.
- The server copy contains the database, not separate local photo files.
  Excel files are readable exports, not a substitute for full DB restoration.
- AI recovery covers already-recognized rows/action IDs. A photo whose OCR
  response never arrived may need to be sent again; real-photo accuracy is not
  guaranteed by these tests.
- Still requires user/device availability: real two-PC LAN order/payment flow,
  physical printer checks and a full working-day UI soak. No claim of completion
  for these physical scenarios.
