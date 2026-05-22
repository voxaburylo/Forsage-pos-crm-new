-- 007_writeoffs.sql
-- Переробляємо inventory_writeoffs: стара таблиця з 003 мала структуру
-- "один запис = один товар". Нова структура: header + items (як накладні).

-- Видаляємо стару таблицю з 003 (CASCADE прибирає всі залежності)
DROP TABLE IF EXISTS inventory_writeoffs CASCADE;

-- Головна таблиця акту списання
CREATE TABLE inventory_writeoffs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  reason     VARCHAR(50) NOT NULL
               CHECK (reason IN ('damage','expiry','loss','audit','other')),
  notes      TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Позиції акту списання
CREATE TABLE inventory_writeoff_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  writeoff_id  UUID NOT NULL REFERENCES inventory_writeoffs(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty          NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  cost_kopecks INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Індекси
CREATE INDEX idx_writeoffs_tenant    ON inventory_writeoffs(tenant_id);
CREATE INDEX idx_writeoffs_reason    ON inventory_writeoffs(reason);
CREATE INDEX idx_writeoffs_created   ON inventory_writeoffs(created_at DESC);
CREATE INDEX idx_writeoff_items_woff ON inventory_writeoff_items(writeoff_id);
CREATE INDEX idx_writeoff_items_prod ON inventory_writeoff_items(product_id);

-- RLS
ALTER TABLE inventory_writeoffs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_writeoff_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "writeoffs_all"      ON inventory_writeoffs      FOR ALL USING (true);
CREATE POLICY "writeoff_items_all" ON inventory_writeoff_items FOR ALL USING (true);
