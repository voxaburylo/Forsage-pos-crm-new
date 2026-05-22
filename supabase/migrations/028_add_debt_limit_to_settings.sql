-- 028_add_debt_limit_to_settings.sql
-- Додаємо default_debt_limit_kopecks до shop_settings

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS default_debt_limit_kopecks INTEGER NOT NULL DEFAULT 100000;
