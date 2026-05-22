-- 048_create_waitlist.sql
-- Лист очікування для сповіщення клієнтів про появу товару

CREATE TABLE IF NOT EXISTS product_waitlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting','notified','fulfilled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ,
  UNIQUE (product_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_product ON product_waitlist(product_id, status);
CREATE INDEX IF NOT EXISTS idx_waitlist_customer ON product_waitlist(customer_id);

ALTER TABLE product_waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_waitlist_all" ON product_waitlist FOR ALL USING (true);
