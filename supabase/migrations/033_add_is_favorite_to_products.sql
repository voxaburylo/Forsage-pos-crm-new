-- 033_add_is_favorite_to_products.sql
-- Додаємо is_favorite для "швидких товарів" на касі

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_products_favorite ON products(tenant_id, is_favorite) WHERE is_favorite = true AND deleted_at IS NULL;
