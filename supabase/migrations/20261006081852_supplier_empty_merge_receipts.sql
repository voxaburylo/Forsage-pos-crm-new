-- Empty-duplicate merges only. This receipt is not a history rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_tenant_id ON public.suppliers(tenant_id,id);
CREATE TABLE public.supplier_merge_receipts (
  tenant_id uuid NOT NULL,
  duplicate_id uuid NOT NULL,
  primary_id uuid NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object' AND result ? 'id' AND result->>'id'=primary_id::text),
  merged_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,duplicate_id),
  CHECK (primary_id<>duplicate_id),
  FOREIGN KEY (tenant_id,duplicate_id) REFERENCES public.suppliers(tenant_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id,primary_id) REFERENCES public.suppliers(tenant_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_supplier_merge_receipts_primary ON public.supplier_merge_receipts(tenant_id,primary_id);
ALTER TABLE public.supplier_merge_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_merge_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.supplier_merge_receipts TO service_role;
COMMIT;
