-- 099_add_missing_indexes.sql
-- Создаем индексы для внешних ключей, чтобы избежать полного сканирования таблиц при JOIN и фильтрации

CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_tenant_id ON sale_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_returns_sale_id ON returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_returns_customer_id ON returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_supply_invoice_items_invoice_id ON supply_invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_supply_invoice_items_product_id ON supply_invoice_items(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_reserves_product_id ON inventory_reserves(product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_bonus_transactions_tenant_id ON bonus_transactions(tenant_id);
