-- 050_order_management.sql
-- Модуль управління замовленнями (Фаза 8)

CREATE TABLE IF NOT EXISTS customer_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  customer_id          UUID REFERENCES customers(id),
  manager_id           UUID NOT NULL,
  vehicle_info         JSONB,
  status               VARCHAR(20) NOT NULL DEFAULT 'lead'
                         CHECK (status IN ('lead','new','in_progress','ready','completed','canceled')),
  prepayment           INTEGER NOT NULL DEFAULT 0,
  prepayment_method    VARCHAR(20),
  prepayment_is_fiscal BOOLEAN NOT NULL DEFAULT false,
  total_amount         INTEGER NOT NULL DEFAULT 0,
  comment              TEXT,
  source               VARCHAR(30) DEFAULT 'walk_in'
                         CHECK (source IN ('walk_in','messenger','telegram_bot','mobile_draft','phone')),
  pickup_deadline_at   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id),
  sku             VARCHAR(100),
  name            VARCHAR(500) NOT NULL,
  supplier_id     UUID REFERENCES suppliers(id),
  source_type     VARCHAR(20) NOT NULL DEFAULT 'supplier'
                    CHECK (source_type IN ('warehouse','supplier')),
  item_status     VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (item_status IN ('pending','ordered','arrived','handed','canceled')),
  buy_price       INTEGER NOT NULL DEFAULT 0,
  sell_price      INTEGER NOT NULL DEFAULT 0,
  qty             INTEGER NOT NULL DEFAULT 1,
  expected_date   DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_activity_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  user_id    UUID,
  action     VARCHAR(50) NOT NULL,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Індекси
CREATE INDEX IF NOT EXISTS idx_cust_orders_status ON customer_orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_cust_orders_customer ON customer_orders(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_cust_order_items_order ON customer_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_activity_order ON order_activity_log(order_id, created_at);

-- RLS
ALTER TABLE customer_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_orders_all" ON customer_orders FOR ALL USING (true);
ALTER TABLE customer_order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_order_items_all" ON customer_order_items FOR ALL USING (true);
ALTER TABLE order_activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_activity_log_all" ON order_activity_log FOR ALL USING (true);
