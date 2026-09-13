# Local diagnostic black box

The desktop app records technical events from the first launch of the new build.
Location: `%LOCALAPPDATA%\Forsage\logs\blackbox`.

## Recorded information

- App/build identity, start and orderly shutdown; an unclean previous session is detected at next launch.
- Main-window lifecycle, renderer/process failures, uncaught renderer errors and React boundary errors.
- Local frontend command name, sequence, user role, success/failure and duration. No command arguments or results.
- Top-level section changes only, without document IDs, query strings or search text.
- Main-thread heartbeat delays and periodic memory use. Sleep/resume events help distinguish sleep from stalls.

A separate worker writes JSONL files. The main queue is limited to 500 records; excess records are counted and dropped rather than blocking the till. Files rotate at 1 MiB, retaining at most 32 files and at most 14 days. Under heavy activity, history can be shorter than 14 days. A small session marker is kept separately.

## Privacy and limitations

No passwords, PINs, clipboard contents, photos, customer details, SQL, raw URLs or business payloads are recorded by this logger. Errors retain fingerprints, known technical categories and source-file line numbers, not raw error messages. The existing historical `desktop-errors.log` and business problem journal are not erased or rewritten by this change.

This is not a database backup, a memory dump, or a guarantee that every crash cause will be known. Full process termination or power loss can lose queued events. Disk failure can prevent recording; logging failure must not crash the app. A missing command-end record is not proof that a sale failed. Business outcomes must be checked against the local database before any correction. Direct internal/LAN backend calls are not all covered by the frontend command wrapper.

No logs are uploaded automatically. No automatic code edits, stock corrections, or scheduled review is enabled. The owner can request investigation for an approximate time or an entire day.

## Read-only daily review

```powershell
node apps/desktop/scripts/read-blackbox.cjs "$env:LOCALAPPDATA\Forsage\logs\blackbox" 2026-09-13
```

The date is a local calendar day; records use UTC timestamps. The report groups errors and lists slow/incomplete commands, without opening or changing the business database.

## Verification

- Unit tests: rotation, retention, clean/unclean sessions, malformed marker and privacy.
- `blackbox-smoke.cjs`: synthetic process exit, 21-second test-only event-loop stall, worker continuity, clean close and invalid output directory.
- `blackbox-ui-smoke.cjs`: hidden, isolated Electron window with sandbox/context isolation and blocked network; verifies the renderer bridge and redaction.
- Production sales and inventory are not used as crash-test data.

## Deferred web deployment

The local uploader checks `/api/v1/version` for `local_mirror_contract: 1` before sending signed local balance snapshots. Incompatible/unavailable servers leave these operations pending without spending their retry budget. This permits a local-only EXE update while Vercel deployment is deferred. It does not make the old web copy current or restore its deployment.
