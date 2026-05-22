-- 027_customer_vehicles_cascade.sql
-- Виправляємо ON DELETE RESTRICT → CASCADE для зручності
-- Додаємо UPDATED_AT для синхронізації

ALTER TABLE customer_vehicles DROP CONSTRAINT IF EXISTS customer_vehicles_customer_id_fkey,
  ADD CONSTRAINT customer_vehicles_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE customer_vehicles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
