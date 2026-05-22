-- 055_orders_extend.sql
-- Фаза 1.1: Додаємо колонки для передоплати та нові статуси

-- =============================================================
-- 1. Нові колонки
-- =============================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepayment_method    VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepayment_is_fiscal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_deadline_at   TIMESTAMPTZ;

-- =============================================================
-- 2. Розширюємо CHECK-обмеження статусів (додаємо нові, залишаємо старі)
-- =============================================================
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    -- Нові статуси (ТЗ)
    'lead', 'quoting', 'approved', 'ordered', 'arrived', 'ready',
    -- Старі статуси (сумісність)
    'draft', 'quoted', 'prepaid', 'ordered_from_supplier', 'issued',
    -- Термінальні
    'completed', 'cancelled', 'lost'
  ));

-- =============================================================
-- 3. Індекс для фільтрації лідів
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_orders_lead_status
  ON orders(tenant_id, created_at DESC)
  WHERE status = 'lead';

NOTIFY pgrst, 'reload schema';
