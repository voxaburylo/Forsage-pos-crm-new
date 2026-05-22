-- 024_customer_cars.sql
-- Таблиця автомобілів клієнта ("Гараж") + прив'язка до замовлень

CREATE TABLE IF NOT EXISTS customer_cars (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  make         VARCHAR(100) NOT NULL,             -- марка (Toyota, BMW)
  model        VARCHAR(100) NOT NULL,             -- модель (Camry, X5)
  year         SMALLINT,                          -- рік випуску
  vin          VARCHAR(17) UNIQUE,                -- VIN-код (унікальний)
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_cars_customer ON customer_cars(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_cars_vin ON customer_cars(vin) WHERE vin IS NOT NULL;

ALTER TABLE customer_cars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_cars_all" ON customer_cars;
CREATE POLICY "customer_cars_all" ON customer_cars FOR ALL USING (true);

-- Додаємо car_id до orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS car_id UUID REFERENCES customer_cars(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_car ON orders(car_id) WHERE car_id IS NOT NULL;
