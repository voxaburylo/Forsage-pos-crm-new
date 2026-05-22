-- 058_add_specs_to_products.sql
-- Add specs JSONB column to products (used for technical characteristics)
ALTER TABLE products ADD COLUMN IF NOT EXISTS specs JSONB;

COMMENT ON COLUMN products.specs IS 'Технічні характеристики товару (JSONB, ключ-значення)';
