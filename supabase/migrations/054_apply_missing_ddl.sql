-- 054_apply_missing_ddl.sql
-- Apply all missing DDL that was never run on remote DB

-- 1. storage_bin for products
ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_bin VARCHAR(50);

-- 2. shop_settings columns
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS default_debt_limit_kopecks INTEGER NOT NULL DEFAULT 100000;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS label_settings JSONB NOT NULL DEFAULT '{"width_mm":58,"height_mm":40,"padding_mm":2,"font_size":10,"barcode_height":20,"show_shop_name":true,"show_product_name":true,"show_barcode":true,"show_sku":true,"show_price":true,"show_storage_bin":false}';
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS pos_quick_items JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 3. product_cobuy (cross-sell)
CREATE TABLE IF NOT EXISTS product_cobuy (
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  recommended_product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, recommended_product_id)
);
ALTER TABLE product_cobuy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_cobuy_all" ON product_cobuy;
CREATE POLICY "product_cobuy_all" ON product_cobuy FOR ALL USING (true);

-- 4. customer_orders (order management)
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
CREATE INDEX IF NOT EXISTS idx_cust_orders_status ON customer_orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_cust_orders_customer ON customer_orders(tenant_id, customer_id);
ALTER TABLE customer_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_orders_all" ON customer_orders;
CREATE POLICY "customer_orders_all" ON customer_orders FOR ALL USING (true);

-- 5. customer_order_items
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
CREATE INDEX IF NOT EXISTS idx_cust_order_items_order ON customer_order_items(order_id);
ALTER TABLE customer_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_order_items_all" ON customer_order_items;
CREATE POLICY "customer_order_items_all" ON customer_order_items FOR ALL USING (true);

-- 6. order_activity_log
CREATE TABLE IF NOT EXISTS order_activity_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  user_id    UUID,
  action     VARCHAR(50) NOT NULL,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_activity_order ON order_activity_log(order_id, created_at);
ALTER TABLE order_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_activity_log_all" ON order_activity_log;
CREATE POLICY "order_activity_log_all" ON order_activity_log FOR ALL USING (true);

-- 7. Telegram bot enhancements columns
ALTER TABLE telegram_messages ADD COLUMN IF NOT EXISTS from_id BIGINT;
ALTER TABLE telegram_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(30) NOT NULL DEFAULT 'text';
ALTER TABLE telegram_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE telegram_messages ADD COLUMN IF NOT EXISTS is_business BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE telegram_messages ADD COLUMN IF NOT EXISTS business_connection_id VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS card_barcode VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

-- 8. car_id index for orders (migration 024)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS car_id UUID REFERENCES customer_cars(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_car ON orders(car_id) WHERE car_id IS NOT NULL;

-- 9. Notify pgrst to reload schema
NOTIFY pgrst, 'reload schema';
