-- 043_customer_segmentation.sql
-- VIP рівні та Risk Profile для сегментації клієнтів

ALTER TABLE customers ADD COLUMN IF NOT EXISTS vip_level VARCHAR(20) NOT NULL DEFAULT 'standard'
  CHECK (vip_level IN ('standard','bronze','silver','gold'));

ALTER TABLE customers ADD COLUMN IF NOT EXISTS risk_profile VARCHAR(20) NOT NULL DEFAULT 'low'
  CHECK (risk_profile IN ('low','medium','high'));

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS vip_discount_bronze INTEGER NOT NULL DEFAULT 3;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS vip_discount_silver INTEGER NOT NULL DEFAULT 5;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS vip_discount_gold   INTEGER NOT NULL DEFAULT 10;
