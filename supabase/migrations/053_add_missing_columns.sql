-- 053_add_missing_columns.sql
-- Фікс: додаємо колонки, які були пропущені в попередніх міграціях

-- 1. storage_bin для products (міграція 025)
ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_bin VARCHAR(50);

-- 2. default_debt_limit_kopecks для shop_settings (міграція 028)
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS default_debt_limit_kopecks INTEGER NOT NULL DEFAULT 100000;

-- 3. label_settings для shop_settings (міграція 029)
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS label_settings JSONB NOT NULL DEFAULT '{
  "width_mm": 58,
  "height_mm": 40,
  "padding_mm": 2,
  "font_size": 10,
  "barcode_height": 20,
  "show_shop_name": true,
  "show_product_name": true,
  "show_barcode": true,
  "show_sku": true,
  "show_price": true,
  "show_storage_bin": false
}';

-- 4. product_cobuy таблиця (міграція 042) — для CrossSellPanel
CREATE TABLE IF NOT EXISTS product_cobuy (
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  recommended_product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, recommended_product_id)
);

ALTER TABLE product_cobuy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_cobuy_all" ON product_cobuy FOR ALL USING (true);
