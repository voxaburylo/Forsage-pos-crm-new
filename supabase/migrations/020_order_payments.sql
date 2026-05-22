-- 020_order_payments.sql
-- Журнал часткових оплат по замовленнях (ТЗ §17)

CREATE TABLE IF NOT EXISTS order_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  order_id    UUID NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  method      VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'mixed')),
  is_fiscal   BOOLEAN NOT NULL DEFAULT false,
  shift_id    UUID REFERENCES shifts(id),
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes       TEXT
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_tenant ON order_payments(tenant_id, created_at DESC);

ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_payments_all" ON order_payments;
CREATE POLICY "order_payments_all" ON order_payments FOR ALL USING (true);

ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS total_paid INTEGER NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
