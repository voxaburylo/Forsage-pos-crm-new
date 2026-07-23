-- Supplier draft catalog must carry the source barcode into desktop sync.
-- deleted_at enables incremental pull of removals instead of periodic full-table replacement.

ALTER TABLE supplier_price_items
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(100),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_supplier_price_items_barcode
  ON supplier_price_items(tenant_id, barcode)
  WHERE deleted_at IS NULL AND barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_price_items_updated
  ON supplier_price_items(tenant_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_supplier_price_items_deleted
  ON supplier_price_items(tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
