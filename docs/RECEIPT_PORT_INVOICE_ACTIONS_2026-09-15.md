# POS-58 port and cancelled-invoice UI — 2026-09-15

## Printer diagnosis
Windows had an installed POS-58-Series queue with driver POS-58-Series Driver, but it was bound to POS Printer PORT: (vendor monitor). Chromium rejected settings, and the GDI fallback submitted jobs which remained Printing/Retained without pages.

Read-only PnP and USB Monitor registry checks identified the present USB portable printer (VID_0456 PID_0808) as USB002. HL80 is VID_0471 PID_0055 / USB001, so it was not selected. The generic vendor monitor produced the printer-not-detected condition; changing receipt layout would not repair its transport.

With the owner's explicit approval:
- paused only POS-58 before canceling the two identified jobs (IDs 2 and 3; Forsage-receipt-66f7b43b and Forsage-receipt-9d116133);
- because deletion stuck, restarted Spooler after confirming all other queues empty and only the approved deleting jobs remained;
- verified the queue empty before assigning USB002, then resumed POS-58;
- confirmed receipt port USB002 and Normal status; no receipt resent, no sales/database changes, no label-printer configuration changes.
Physical test pending owner approval/confirmation.

## Invoice UI
Cancelled invoice detail offered Delete, Repost and Pay while the local repository correctly rejected deleting cancelled/paid documents and payment on a cancelled invoice. The debt shown was calculated without checking status.
Added tested action policy: Delete only for an unpaid draft; cancellation/edit-copy only for eligible unpaid posted documents; no payment/debt or repost button on cancelled documents. Kept one explicit Create copy action. Added clear cancellation/history notice and actual localized failure messages instead of generic errors.
No cancelled document or audit history was deleted. The earlier authorized duplicate correction remains documented in INVOICE_DRAFT_PRINT_FIX_2026-09-15.md.

## HL80 follow-up
- User reported label/thermal printing also unavailable. Current HL80 port remained HL80 USB: (not modified during POS58 repair). PnP identifies present 3INCH HiLabel Printer VID_0471 PID_0055 mapped to USB001.
- Jobs 2 (Forsage-label-8203500a) and 3 (Forsage-label-e5a479f5) remained queued with zero pages. First errored, second incorrectly reported completion.
- Reproduced the software error using the actual PowerShell postflight against a mocked queue (no device I/O): numeric JobStatus Normal=0 was assigned to failure, then treated as false. Fixed failure detection to use explicit null checks and a textual no-progress error. Tests cover enum zero, retained job, empty queue and positive progress.
- Both receipt/label preflight now include stale Normal/None queued jobs and recognize a paused printer as not ready.
- Eleven focused printing tests and desktop compilation passed. Changes are not yet in the installed EXE.
- HL80 port repair script is prepared and dry-run checked, but has not been applied; explicit owner approval pending. Physical test of either printer remains unconfirmed.

## EOF diagnosis and test, 16:05–16:12 local
- Owner authorized one technical print per printer. POS58 test was sent once via the production GDI path to USB002: Forsage-POS58-port-test-1789477512231. Postflight succeeded and queue is empty. Physical paper remains for owner to confirm. No sale was created.
- Read-only execution of the label helper preflight produced TSPL_QUEUE_STUCK; the two identified HL80 jobs remain queued. No label test was sent behind them and no HL80 port/job change was made pending approval.
- Found stdin error handling rejected on write EOF before the helper delivered its actual queue error. Shared subprocess completion now waits for stderr/close (bounded by timeout), preserves helper errors, checks exit and marker, handles abort, and never retries input. Used by RAW labels and GDI receipts.
- Added five subprocess tests; all 16 focused desktop printing tests pass, desktop compile and full typecheck pass. UI distinguishes unconfirmed output from definitely rejected preflight and translates old-build EOF errors.

- Final verification: all 438 desktop tests (77 files) passed; 10 label UI tests passed; web and desktop typechecks passed. POS58 queue remained empty after the single test. HL80 still has the two original jobs on HL80 USB:. Installed EXE remains unchanged because the application is open.

## Rebuilt after owner closed the app, 17:20 local
- Updated the existing apps/desktop/release/Forsage-0.1.0-portable.exe in place; no new desktop program folders or shortcuts. Existing ФОРСАЖ — КАСА shortcut verified against this exact target.
- EXE size 91,320,726 bytes; modified 2026-09-15 17:20:02 +03; SHA256 A051C2642A20618DFC9F3FE349D7B70A72B0FE3C45A3BE3E1EB7240AA5CE1033. Build exit 0. Verified printProcess, tsplLabelPrinter and receiptGdiPrinter fixes inside packaged app.asar using native Windows archive paths.
- Full web suite now 509 tests passed (77 files); isolated Electron native DB smoke passed. No live database operations or new paper tests during this rebuild.
- HL80 hardware repair is still pending explicit permission to remove its two old jobs/change its port. Port remains HL80 USB:, receipt printer remains USB002. No automatic app launch or printer retry.

## Hardware recovery confirmed after owner reconnected HL80
- After PC restart, read-only PnP showed UNKNOWN USB VID_0000 PID_0002, descriptor request failure, problem code 43 at Port_#0006.Hub_#0001. Its parent/location path exactly matched the formerly present HiLabel USB device; the installed HL80 queue alone did not prove physical availability.
- After owner disconnected printer power/USB and reconnected it, 3INCH HiLabel Printer VID_0471 PID_0055 returned with status OK, USBPRINT child on USB001 present, HL80 queue Normal and empty. Both old jobs disappeared from the queue without any explicit deletion by us. Their physical output is not known.
- HL80 vendor port HL80 USB: works after hardware recovery. DO NOT apply tmp/repair-hl80-port.ps1: the proposed port switch/queue cleanup is no longer required. No label port or driver was changed.
- Sent exactly one authorized technical label (40x25 mm, dimensions verified against local shop_settings.label_settings) using production printLabelsTspl. Result: success=true, labels=1, render_ms=892, spool_ms=1559, bytes=8110. Queue empty afterward; no retry. Log: tmp/hl80-connection-test.log. Physical test label remains for owner confirmation.
- POS58 remains USB002 / Normal / empty; earlier one-time receipt test was not repeated. No database mutation, sale, print of existing receipts or new EXE rebuild in this recovery step.
