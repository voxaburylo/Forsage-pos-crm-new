# Lifecycle stability pass — 2026-09-16

Scope: prevent repeat failures around employee access, archive/restore, partial saves, and stale asynchronous login responses. Preserve local stock authority and all business history. No production-data repair without a specific verified target.

## Plan and acceptance gates

1. Employee lifecycle: archive and explicit restore of the same ID; normalized phone uniqueness; prevent removal of the last owner; transactional local changes and their outbox.
2. Authentication: distinguish disabled/deleted/missing local credentials in diagnostics; prevent disabled accounts from online fallback; prevent an old background login from switching the active cashier.
3. Adjacent partial-save cases: validate payroll rules before writing; replace local employee profile and managed commission rules together, with rollback tests.
4. Server compatibility: keep employee history on archive; mirror active/deleted/login flags consistently; no changes to stock authority.
5. Regression evidence: isolated databases, mocked network failures, restart/offline lifecycle, type checks and full suites. Never send test sales or printer jobs to production.
6. Delivery: build the existing EXE and inspect its packaged assets. Replace only while the user is not working; no duplicate Desktop application.

## Implemented

- Employee archive and explicit restore retain identity, password hash, PIN and business history. Normalized phone comparison catches equivalent phone formats. Only owner/admin may manage the lifecycle; self-removal and disabling/demoting the last local owner are rejected.
- Account state errors distinguish archived, disabled, missing local credentials and wrong password. The black box receives static reason codes, never credentials or phone numbers.
- Delayed cloud sign-in events cannot switch the verified local user, change their local role/shop, or log them in again after explicit logout. Cloud disconnects do not close a verified local till session. API tokens must belong to the current local user and shop.
- Local employee profile, managed salary rules and their outgoing events commit together. A simulated failure after deletion of old rules restores the entire previous state. Scoped category/brand rules are retained.
- Salary settings cannot be saved from an incompletely loaded form. Employee directory remains available if a payroll query fails. Staff month navigation uses local calendar dates rather than UTC month rollover.
- Monthly salary totals now include all records, not the last 200. The existing detailed history list remains capped at 200; the total is no longer calculated from that truncated display list.
- Supplier, category and brand edits and outgoing events commit together. Recreating an archived brand restores its existing identity rather than failing the name uniqueness constraint. Category renames reject normalized duplicates.
- Server source uses soft archive rather than deleting employee history, restores access flags consistently, normalizes legacy local-phone login addresses, and replaces employee commission rules in one transaction. The last-owner guard covers explicit deactivation too.
- Windows CI now also exercises compiled Electron/SQLite staff lifecycle and sandboxed diagnostic delivery, not only source-level tests.

## Verification and delivery

- Web: 86 files / 575 tests passed.
- Desktop: 86 files / 511 tests passed.
- Server: 64 files / 294 tests passed (rerun after the final server changes).
- Total: 1,380 tests. Type checks including API and web lint passed; final server type check passed.
- Compiled Electron lifecycle smoke passed: create, login, settings, archive, close/reopen DB, restore, offline password and PIN login.
- Sandboxed preload/black-box smoke passed with network blocked and secret exclusion verified.
- Existing portable EXE rebuilt in place: `apps/desktop/release/Forsage-0.1.0-portable.exe`, 2026-09-16 23:17:32 local, 91,344,677 bytes.
- SHA-256: `3D1F68CB65E906A729656A4C5321A3D7E33C75545D8326493BB4BCFB3EB778FB`.
- Packaged ASAR inspected: staff repository, preload and previous print guards match compiled files; archive UI and incomplete-payroll protection present.
- Existing Desktop shortcut still points to this EXE. No duplicate Desktop folder/shortcut created. No live stock, document, payment or employee records modified by this pass; tests used isolated databases or mocked/embedded servers.

## Boundaries / follow-up

- No Git push or production server deployment in this pass. Server changes and CI changes become active only after publication. No database migration is required for these changes.
- Creating a new server account or resetting its password still requires the existing online provisioning step; it is not a distributed atomic transaction. A remote success followed by local failure needs explicit recovery, not silent repeated account creation.
- Concurrent owner deactivation across multiple cloud instances is not serialized by the Auth API. The authoritative local last-owner check is transactional; the server check is a defensive read/check.
- No physical printer, two-PC simultaneous work, production-account login or power-loss testing was performed. Passing these tests reduces known regressions; it does not prove that every possible defect is absent.
