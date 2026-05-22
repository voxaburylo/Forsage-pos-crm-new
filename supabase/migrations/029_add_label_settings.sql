-- 029_add_label_settings.sql
-- Додаємо JSONB поле для збереження конфігурації етикеток

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS label_settings JSONB NOT NULL DEFAULT '{
  "width_mm": 40,
  "height_mm": 30,
  "padding_mm": 2,
  "font_size": 7,
  "barcode_height": 28,
  "show_shop_name": true,
  "show_product_name": true,
  "show_barcode": true,
  "show_sku": true,
  "show_price": true,
  "show_storage_bin": true
}';
