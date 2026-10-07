-- Extend durable acknowledgements to terminal invoice copies.
-- No business document or stock is rewritten; existing acknowledgement hashes remain valid.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.supplier_invoice_copy_receipts
  ADD COLUMN lifecycle_hash text CHECK (lifecycle_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE public.supplier_invoice_copy_receipts
  DROP CONSTRAINT supplier_invoice_copy_receipts_operation_type_check;
ALTER TABLE public.supplier_invoice_copy_receipts
  ADD CONSTRAINT supplier_invoice_copy_receipts_operation_type_check CHECK (operation_type IN (
    'supplier_invoice.created','supplier_invoice.updated','supplier_invoice.posted',
    'supplier_invoice.cancelled','supplier_invoice.deleted')),
  ADD CONSTRAINT supplier_invoice_terminal_hash_required CHECK (
    operation_type NOT IN ('supplier_invoice.cancelled','supplier_invoice.deleted') OR lifecycle_hash IS NOT NULL);
-- Explicitly preserve the server-only, append-only access model.
ALTER TABLE public.supplier_invoice_copy_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_invoice_copy_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.supplier_invoice_copy_receipts TO service_role;
COMMIT;
