-- 041_add_markup_rules.sql
-- Додаємо markup_rules для матриці націнок

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS markup_rules JSONB DEFAULT '[
  {"minPrice": 0, "maxPrice": 2000, "markupPct": 200},
  {"minPrice": 2000, "maxPrice": 3000, "markupPct": 100},
  {"minPrice": 3000, "maxPrice": 30000, "markupPct": 30}
]'::jsonb;
