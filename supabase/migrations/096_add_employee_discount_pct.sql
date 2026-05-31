-- 096_add_employee_discount_pct.sql
-- Add employee_discount_pct column to shop_settings

ALTER TABLE shop_settings 
ADD COLUMN IF NOT EXISTS employee_discount_pct NUMERIC DEFAULT 0;
