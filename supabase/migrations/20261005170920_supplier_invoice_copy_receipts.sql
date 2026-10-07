-- Durable acknowledgements for committed invoice copies, not a 24-hour cache.
-- Apply before deploying the copy writer. No business rows are rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_invoices_tenant_id
  ON public.supply_invoices(tenant_id,id);
CREATE TABLE public.supplier_invoice_copy_receipts (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  device_id text NOT NULL CHECK (length(device_id)>0),
  source_sequence bigint NOT NULL CHECK (source_sequence>0),
  invoice_id uuid NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN (
    'supplier_invoice.created','supplier_invoice.updated','supplier_invoice.posted')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  document_hash text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  receipt_no bigint GENERATED ALWAYS AS IDENTITY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,operation_id),
  FOREIGN KEY (tenant_id,invoice_id) REFERENCES public.supply_invoices(tenant_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_supplier_invoice_copy_receipts_document
  ON public.supplier_invoice_copy_receipts(tenant_id,invoice_id,receipt_no DESC);
ALTER TABLE public.supplier_invoice_copy_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_invoice_copy_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.supplier_invoice_copy_receipts TO service_role;
REVOKE ALL ON SEQUENCE public.supplier_invoice_copy_receipts_receipt_no_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SEQUENCE public.supplier_invoice_copy_receipts_receipt_no_seq TO service_role;
COMMIT;
