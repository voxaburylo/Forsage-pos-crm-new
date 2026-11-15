-- Directional evidence for explicit price-list reassignments. Existing receipts
-- remain historical facts; no ownership is inferred/backfilled from scope order.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.supplier_catalog_copy_receipts
 ADD COLUMN ownership_changed boolean NOT NULL DEFAULT false,
 ADD COLUMN previous_supplier_id uuid,
 ADD COLUMN next_supplier_id uuid,
 ADD CONSTRAINT supplier_catalog_ownership_proof CHECK (
   (NOT ownership_changed AND previous_supplier_id IS NULL AND next_supplier_id IS NULL)
   OR (ownership_changed AND operation_type='supplier_catalog.item_upserted'
     AND previous_supplier_id IS DISTINCT FROM next_supplier_id));
CREATE INDEX idx_supplier_catalog_ownership_proof
 ON public.supplier_catalog_copy_receipts(tenant_id,device_id,aggregate_id,source_sequence)
 WHERE ownership_changed;
-- Keep server-only, append-only access after adding the evidence columns.
ALTER TABLE public.supplier_catalog_copy_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_catalog_copy_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.supplier_catalog_copy_receipts TO service_role;
COMMIT;
