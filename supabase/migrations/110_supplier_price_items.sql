-- 110_supplier_price_items.sql
-- Таблиця для збереження прайс-листів постачальників

CREATE TABLE IF NOT EXISTS supplier_price_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  supplier_id    UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  sku            VARCHAR(100) NOT NULL,
  brand          VARCHAR(100),
  name           VARCHAR(500) NOT NULL,
  price_kopecks  INTEGER NOT NULL DEFAULT 0,
  qty            VARCHAR(50) NOT NULL DEFAULT '0',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE supplier_price_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supplier_price_items_all" ON supplier_price_items;
CREATE POLICY "supplier_price_items_all" ON supplier_price_items FOR ALL USING (tenant_id = app.user_tenant_id());

CREATE INDEX IF NOT EXISTS idx_supplier_price_items_sku ON supplier_price_items(tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_supplier_price_items_search_trgm ON supplier_price_items USING gin ((sku || ' ' || name) gin_trgm_ops);

NOTIFY pgrst, 'reload schema';
