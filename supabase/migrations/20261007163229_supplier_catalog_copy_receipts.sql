-- Apply before the catalog copy writer. Historical receipts survive price-list
-- replacement/deletion and supplier merge; no business rows are rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE public.supplier_catalog_copy_receipts (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN (
    'supplier_catalog.item_upserted','supplier_catalog.item_deleted','supplier_catalog.imported')),
  device_id text NOT NULL CHECK (length(btrim(device_id))>0),
  source_sequence bigint NOT NULL CHECK (source_sequence>0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  scope_keys text[] NOT NULL CHECK (cardinality(scope_keys)<=2 AND array_position(scope_keys,NULL) IS NULL),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,operation_id),
  UNIQUE (tenant_id,device_id,source_sequence)
);
CREATE INDEX idx_supplier_catalog_copy_receipts_aggregate
  ON public.supplier_catalog_copy_receipts(tenant_id,device_id,aggregate_id,source_sequence DESC);
CREATE INDEX idx_supplier_catalog_copy_receipts_scope
  ON public.supplier_catalog_copy_receipts USING gin(scope_keys);
ALTER TABLE public.supplier_catalog_copy_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_catalog_copy_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.supplier_catalog_copy_receipts TO service_role;
COMMIT;
