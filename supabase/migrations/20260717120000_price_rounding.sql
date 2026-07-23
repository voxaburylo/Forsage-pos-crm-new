-- Округлення роздрібних цін у Матриці націнок.
-- Крок у копійках: 50 (0.50 грн), 100 (1 грн), 500 (5 грн), 1000 (10 грн).
-- Напрям: up (у більшу), down (у меншу), nearest (до найближчого).

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS price_rounding_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS price_rounding_step INTEGER NOT NULL DEFAULT 100;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS price_rounding_dir TEXT NOT NULL DEFAULT 'nearest';

-- Скидаємо кеш схеми PostgREST, щоб REST одразу побачив нові колонки.
NOTIFY pgrst, 'reload schema';
