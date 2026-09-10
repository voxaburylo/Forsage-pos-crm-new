# Local remembered login

Opt-in checkbox on desktop login remembers permission for a fixed 24 hours.
Only the phone hint is stored in localStorage. The permission is encrypted by
Electron safeStorage (Windows protection); it contains no password or PIN.
PIN hashes remain in the existing staff credential store.

Restart, Windows lock/suspend and 5 minutes of OS inactivity require a PIN.
Main-process authorization blocks local operations, not just the screen.
Five incorrect PIN attempts revoke the permission, including across restarts.
Password/PIN/role/phone changes, disabled/deleted accounts and expiry revoke it.
Explicit logout clears permission. Open forms remain mounted during idle lock.
Browser login is unchanged. A remembered local login does not establish a new
cloud session; an existing matching cloud session may be reused.

Owner/admin can disable the PIN requirement in Settings > Login on this computer.
The default remains enabled. This device-only policy is not synced to other PCs.
When disabled, the login screen offers continuation without PIN and idle PIN lock
is disabled. Expiry, explicit logout, account revocation and encrypted storage
still apply. Re-enabling restores PIN verification; if no PIN exists, a new full
password login is needed to set one. This setting does not delete the staff PIN
used by other operations. Anyone with access to this Windows session can use a
remembered login while PIN is disabled; the settings UI displays that warning.

This is convenience protection on a trusted Windows account, not protection
against malware or an administrator controlling Windows/database files.
Tests exercise permission logic using injected crypto; actual Windows encrypted
storage and restart must still be smoke-tested in the rebuilt executable.
No executable rebuild or deployment has been performed for this feature yet.
