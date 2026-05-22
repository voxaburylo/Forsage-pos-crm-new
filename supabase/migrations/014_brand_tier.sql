-- Migration 014: Brand Tier (ТЗ Analog System — Brand Tier)
-- Додає колонку tier до brands для групування аналогів по якості

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (tier IN ('original', 'premium', 'standard', 'budget'));

COMMENT ON COLUMN brands.tier IS 'Рівень бренду: original (OEM), premium, standard, budget';