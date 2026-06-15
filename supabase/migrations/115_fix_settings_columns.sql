-- 115_fix_settings_columns.sql
-- Усуваємо schema drift у shop_settings: фронтенд відправляв поля, для яких
-- бракувало колонок, через що PUT /api/v1/settings падав цілком і НІЧОГО
-- не зберігалось (швидкі відсотки, націнки, етикетки тощо).
--
-- Усі ALTER ідемпотентні (IF NOT EXISTS) — безпечно застосовувати повторно.

-- 1. quick_percents — швидкі відсотки націнки (PricingPage). Колонки НЕ існувало
--    в жодній попередній міграції — це і ламало збереження ціноутворення.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS quick_percents JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2. Підстраховка: колонки, що мали додаватись раніше, але могли не застосуватись
--    на хостованій БД (пор. латочні міграції 053/054).
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS markup_rules JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS pos_quick_items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS employee_discount_pct NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS label_settings JSONB NOT NULL DEFAULT '{
  "width_mm": 40, "height_mm": 30, "padding_mm": 2,
  "font_size": 7, "barcode_height": 28,
  "show_shop_name": true, "show_product_name": true, "show_barcode": true,
  "show_sku": true, "show_price": true, "show_storage_bin": true
}'::jsonb;

-- 3. КРИТИЧНО: PostgREST кешує схему. Без перезавантаження щойно додані колонки
--    лишаються "невидимими" і update далі падає з "column not found".
NOTIFY pgrst, 'reload schema';
