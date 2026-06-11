-- 107_auto_parts_advanced_features.sql
-- Нові поля для бренд-тірів, застави за старі деталі, адресного зберігання та замовлень постачальникам

-- 1. Додаємо tier до таблиці brands
ALTER TABLE brands ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (tier IN ('original', 'premium', 'standard', 'budget'));

-- Прописуємо базові рівні брендів для деяких відомих виробників
UPDATE brands SET tier = 'original' WHERE UPPER(name) IN ('VAG', 'BMW', 'TOYOTA', 'MERCEDES', 'AUDI', 'FORD', 'RENAULT');
UPDATE brands SET tier = 'premium' WHERE UPPER(name) IN ('BOSCH', 'BREMBO', 'LEMFORDER', 'TRW', 'SACHS', 'ATE', 'MAHLE', 'KNECHT');
UPDATE brands SET tier = 'budget' WHERE UPPER(name) IN ('STARLINE', 'RIDER', 'PROFIT', 'KAMOKA');

-- 2. Додаємо поля для застави за старі деталі (Core Charge) до products
ALTER TABLE products ADD COLUMN IF NOT EXISTS requires_core_return BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS core_deposit_amount INTEGER NOT NULL DEFAULT 0;

-- 3. Додаємо поля для повернення серцевин до customer_order_items та sale_items
ALTER TABLE customer_order_items ADD COLUMN IF NOT EXISTS core_return_status VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (core_return_status IN ('none', 'pending', 'returned', 'refunded'));
ALTER TABLE customer_order_items ADD COLUMN IF NOT EXISTS core_deposit_amount INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS core_return_status VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (core_return_status IN ('none', 'pending', 'returned', 'refunded'));
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS core_deposit_amount INTEGER NOT NULL DEFAULT 0;

-- 4. Створюємо таблицю Замовлень постачальникам (supplier_purchase_orders)
CREATE TABLE IF NOT EXISTS supplier_purchase_orders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status      VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
  po_number   VARCHAR(30) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Створюємо індекси та вмикаємо RLS
CREATE INDEX IF NOT EXISTS idx_supplier_po_tenant ON supplier_purchase_orders(tenant_id, supplier_id);
ALTER TABLE supplier_purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supplier_purchase_orders_all" ON supplier_purchase_orders;
CREATE POLICY "supplier_purchase_orders_all" ON supplier_purchase_orders FOR ALL USING (tenant_id = app.user_tenant_id());

-- 5. Створюємо рядки замовлень постачальникам (supplier_purchase_order_items)
CREATE TABLE IF NOT EXISTS supplier_purchase_order_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  po_id                  UUID NOT NULL REFERENCES supplier_purchase_orders(id) ON DELETE CASCADE,
  product_id             UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty                    NUMERIC(12,3) NOT NULL,
  customer_order_item_id UUID REFERENCES customer_order_items(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_po_items ON supplier_purchase_order_items(tenant_id, po_id);
ALTER TABLE supplier_purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supplier_purchase_order_items_all" ON supplier_purchase_order_items;
CREATE POLICY "supplier_purchase_order_items_all" ON supplier_purchase_order_items FOR ALL USING (tenant_id = app.user_tenant_id());

NOTIFY pgrst, 'reload schema';
