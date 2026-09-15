# Cashier status and receipt printing — 2026-09-15

## Customer status
Cashiers may create/edit client_status (client or sto), including quick creation and editing from POS. Desktop enforces roles and validates status. Bonus balance, cashback mode/rate, price tiers and risk/VIP settings remain protected.

## Receipt diagnosis
- Black box recorded desktop:print:html at 10:33 UTC with Invalid printer settings.
- POS-58-Series rejects Chromium printing with default, explicit 203 dpi and explicit 58 mm page settings. A diagnostic PrintBackendService toggle did not help and was not added to the app.
- Windows System.Drawing reports valid POS-58 settings and accepts a diagnostic bitmap print. Added a receipt-only GDI fallback, exclusively after explicit Invalid printer settings rejection, with the same printer name and queue postflight. No fallback after timeout, cancellation or uncertain submission; no label routing changes.
- Physical printing is NOT confirmed. Diagnostic job 5, Forsage-receipt-diagnostic, remained Printing/Retained, PagesPrinted=0. Cancellation was requested only for that exact test job; Windows left it Deleting/Printing/Retained. No user jobs removed and no global spooler restart performed.
- The user was asked to power-cycle POS-58 and close Forsage for replacement of the EXE.

## Verification
Typechecks passed (web/desktop/server/API), web lint passed, 14 focused web tests and 28 desktop tests passed. Desktop renderer and main code compiled successfully. Portable EXE replacement is pending application closure; existing EXE remains the prior cashier-discount build.
