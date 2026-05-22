-- 008_pricing.sql
-- Додаємо price_tier_id до customers (TASK-302)

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS price_tier_id UUID REFERENCES price_tiers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_price_tier ON customers(price_tier_id);
