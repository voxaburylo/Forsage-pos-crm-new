-- Додаємо таблицю return_items для позицій повернень
CREATE TABLE IF NOT EXISTS return_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  return_id           UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_id          UUID NOT NULL REFERENCES products(id),
  sale_item_id        UUID REFERENCES sale_items(id),
  quantity            INTEGER NOT NULL,
  unit_price_kopecks  INTEGER NOT NULL,
  total_kopecks       INTEGER NOT NULL,
  condition           VARCHAR(20) DEFAULT 'good'
                        CHECK (condition IN ('good','defective','damaged')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS для return_items
ALTER TABLE return_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_return_items"
  ON return_items AS PERMISSIVE
  FOR ALL
  USING (true);

-- Додаємо колонки до returns (якщо їх немає - PostgreSQL ігнорує IF NOT EXISTS для колонок)
ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_type VARCHAR(20) DEFAULT 'refund';
ALTER TABLE returns ADD COLUMN IF NOT EXISTS reason_note TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS refund_kopecks INTEGER;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS stock_action VARCHAR(20) DEFAULT 'return_to_stock';
ALTER TABLE returns ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
