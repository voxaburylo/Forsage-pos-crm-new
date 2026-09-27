# Existing customer-card barcodes — 2026-09-16

## Fixed

- Local customer creation previously returned a phone match before checking or saving the requested card barcode.
- New card input is normalized as text (leading zeros retained). The same normalization is used for exact card lookup.
- Creation with an existing phone and an empty stored card attaches the provided unused barcode to that customer. Other profile fields are not overwritten. Response metadata reports the attachment.
- Creation with no barcode preserves an existing card; repeated submission with the same barcode is a no-op. A different existing card requires deliberate editing. A barcode owned by another active customer is rejected.
- Phone/card uniqueness checks, customer writes, vehicle creation and outbox writes share one SQLite transaction. Failure rolls back the whole operation.
- Full create form, POS create dialog and customer editor share a clearly labelled barcode field. It accepts manual entry/paste/scanning. Scanner Enter does not submit the form; generation cannot overwrite nonempty input.
- Cashiers can edit a card barcode from the customer list and the full edit route. Existing financial-permission restrictions remain unchanged.

## Verification

- Desktop: 83 files / 488 tests passed, including 30 customer-card safety tests.
- Web: 84 files / 556 tests passed, including card field, permissions and local API regression tests.
- Desktop/web type checks and web lint passed. Git whitespace check passed.
- Tests used isolated temporary databases; no live customer or stock records were edited.

## Delivery state

Initially held back because the user was working. Later on 2026-09-16 the user explicitly authorized closing and rebuilding; these changes are included in the existing portable EXE rebuilt at 16:46 (see PRINT_BATCH_AND_INVOICE_QUANTITY_2026-09-16.md). Physical scanner verification remains a user check. No publication performed in this delivery.
