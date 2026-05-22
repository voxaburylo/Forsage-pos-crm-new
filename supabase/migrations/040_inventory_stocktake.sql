-- 040_inventory_stocktake.sql
-- Таблиці для інвентаризації (ревізії складу)

CREATE TABLE IF NOT EXISTS inventory_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  name        VARCHAR(200) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','in_progress','completed')),
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES products(id),
  expected_stock INTEGER NOT NULL DEFAULT 0,
  counted_stock  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_items_session ON inventory_items(session_id);
CREATE INDEX IF NOT EXISTS idx_inv_sessions_tenant ON inventory_sessions(tenant_id, created_at DESC);

ALTER TABLE inventory_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_sessions_all" ON inventory_sessions;
CREATE POLICY "inventory_sessions_all" ON inventory_sessions FOR ALL USING (true);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_items_all" ON inventory_items;
CREATE POLICY "inventory_items_all" ON inventory_items FOR ALL USING (true);
