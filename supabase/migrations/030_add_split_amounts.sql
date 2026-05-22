-- 030_add_split_amounts.sql
-- Додаємо cash_amount та card_amount для змішаної оплати

ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_amount INTEGER NOT NULL DEFAULT 0;
