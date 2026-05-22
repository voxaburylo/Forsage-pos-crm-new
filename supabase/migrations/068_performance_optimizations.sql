-- Migration 068: Оптимізація продуктивності (Індекси та запити)

-- Увімкнення розширення pg_trgm для підтримки індексів триграм (потрібно для швидкого ILIKE '%...%')
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Триграмні GIN індекси для таблиці products (пошук за sku, name, oem_number)
CREATE INDEX IF NOT EXISTS idx_products_sku_trgm
  ON products USING gin (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
  ON products USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_oem_number_trgm
  ON products USING gin (oem_number gin_trgm_ops);

-- 2. Триграмний GIN індекс для таблиці product_supplier_codes (пошук за supplier_code)
CREATE INDEX IF NOT EXISTS idx_supplier_codes_supplier_code_trgm
  ON product_supplier_codes USING gin (supplier_code gin_trgm_ops);

-- 3. Триграмний GIN індекс для таблиці product_aliases (пошук за alias)
CREATE INDEX IF NOT EXISTS idx_product_aliases_alias_trgm
  ON product_aliases USING gin (alias gin_trgm_ops);

-- 4. Триграмний GIN індекс для таблиці customer_vehicles (пошук за vin)
CREATE INDEX IF NOT EXISTS idx_customer_vehicles_vin_trgm
  ON customer_vehicles USING gin (vin gin_trgm_ops);

-- 5. B-tree індекс на normalized_supplier_article для швидкого точного пошуку
CREATE INDEX IF NOT EXISTS idx_supplier_codes_normalized_article
  ON product_supplier_codes (tenant_id, normalized_supplier_article);

-- 6. Складені (composite) індекси для аналітичних запитів
-- Таблиця sales: фільтрація по tenant_id, status та сортування по completed_at DESC
CREATE INDEX IF NOT EXISTS idx_sales_tenant_status_date
  ON sales (tenant_id, status, completed_at DESC);

-- Таблиця customer_orders: фільтрація по tenant_id, status та сортування по updated_at DESC
CREATE INDEX IF NOT EXISTS idx_customer_orders_tenant_status_date
  ON customer_orders (tenant_id, status, updated_at DESC);

-- Таблиця cash_operations: фільтрація по tenant_id, type, наявності категорії витрат та сортування по created_at
CREATE INDEX IF NOT EXISTS idx_cash_operations_analytics
  ON cash_operations (tenant_id, type, expense_category_id, created_at DESC);

-- 7. Частковий (partial) індекс на активні та невидалені товари для швидкого виведення списку товарів
CREATE INDEX IF NOT EXISTS idx_products_tenant_active
  ON products (tenant_id, is_active)
  WHERE deleted_at IS NULL;
