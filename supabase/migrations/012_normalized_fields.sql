-- Migration 012: Нормалізовані поля для швидкого пошуку (ТЗ Search Fields #3, #4)
-- Додає колонки normalized_oem та normalized_supplier_article
-- Значення заповнюються на рівні додатку (productService)

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS normalized_oem VARCHAR(100) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS normalized_supplier_article VARCHAR(100) NOT NULL DEFAULT '';

-- Індекси для швидкого exact match по нормалізованих полях
CREATE INDEX IF NOT EXISTS idx_products_normalized_oem
  ON products(tenant_id, normalized_oem)
  WHERE normalized_oem != '';

CREATE INDEX IF NOT EXISTS idx_products_normalized_supplier_article
  ON products(tenant_id, normalized_supplier_article)
  WHERE normalized_supplier_article != '';

COMMENT ON COLUMN products.normalized_oem IS 'Нормалізований OEM-номер (без пробілів, тире, UPPERCASE)';
COMMENT ON COLUMN products.normalized_supplier_article IS 'Нормалізований артикул постачальника';