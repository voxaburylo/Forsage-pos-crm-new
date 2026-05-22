-- 090: is_service — послуги/кава/снеки без обліку залишків
-- Для таких товарів: ціна є, qty_on_hand не відстежується, завжди доступні

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_service BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_is_service ON products(tenant_id, is_service)
  WHERE is_service = true;

-- Позначаємо кава/снеки як сервісні (вже існують з migration 051)
UPDATE products
SET is_service = true
WHERE sku LIKE 'COF-%' OR sku LIKE 'SNK-%';
