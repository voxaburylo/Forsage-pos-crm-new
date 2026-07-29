-- Supplier merges change historical payment ownership. A mutable timestamp is
-- required so local-first clients can receive those existing rows in delta pull.
ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_supplier_payments_tenant_updated
  ON supplier_payments(tenant_id, updated_at, id);

NOTIFY pgrst, 'reload schema';
