-- Append-only evidence for posted supplier-history transfers. No business data rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.supplier_merge_receipts
 ADD COLUMN operation_id uuid,
 ADD COLUMN device_id text,
 ADD COLUMN source_sequence bigint,
 ADD COLUMN history_payload jsonb,
 ADD CONSTRAINT supplier_merge_history_identity CHECK (
   (operation_id IS NULL AND device_id IS NULL AND source_sequence IS NULL AND history_payload IS NULL)
   OR (num_nonnulls(operation_id,device_id,source_sequence,history_payload)=4 AND length(btrim(device_id))>0 AND source_sequence>0
       AND history_payload IS NOT NULL AND jsonb_typeof(history_payload)='object'
       AND history_payload ?& ARRAY['history_version','primary_supplier_id','duplicate_supplier_id','invoices']
       AND history_payload->'history_version'='1'::jsonb
       AND history_payload->'primary_supplier_id'=to_jsonb(primary_id::text)
       AND history_payload->'duplicate_supplier_id'=to_jsonb(duplicate_id::text)
       AND jsonb_typeof(history_payload->'invoices')='array'));
CREATE UNIQUE INDEX supplier_merge_operation_identity ON public.supplier_merge_receipts(tenant_id,operation_id)
 WHERE operation_id IS NOT NULL;
ALTER TABLE public.supplier_invoice_copy_receipts
 DROP CONSTRAINT supplier_invoice_copy_receipts_operation_type_check,
 DROP CONSTRAINT supplier_invoice_terminal_hash_required;
ALTER TABLE public.supplier_invoice_copy_receipts
 ADD CONSTRAINT supplier_invoice_copy_receipts_operation_type_check CHECK (operation_type IN (
 'supplier_invoice.created','supplier_invoice.updated','supplier_invoice.posted',
 'supplier_invoice.cancelled','supplier_invoice.deleted','supplier_invoice.supplier_merged')),
 ADD CONSTRAINT supplier_invoice_terminal_hash_required CHECK (
 operation_type NOT IN ('supplier_invoice.cancelled','supplier_invoice.deleted','supplier_invoice.supplier_merged')
 OR lifecycle_hash IS NOT NULL);
ALTER TABLE public.supplier_merge_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_merge_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.supplier_merge_receipts TO service_role;
COMMIT;
