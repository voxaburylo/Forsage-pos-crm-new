-- 032_add_prro_terminal_fiscal.sql
-- Додаємо: transfer payment, fiscal поля, налаштування ПРРО та термінала

-- 1. Розширюємо payment_method (додаємо transfer)
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('cash','card','transfer','debt','mixed'));

-- 2. Фіскальні поля
ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_fiscal       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS fiscal_number   VARCHAR(50);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS bank_auth_code  VARCHAR(50);

-- 3. Налаштування ПРРО та банківського термінала в shop_settings
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS prro_enabled          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS bank_terminal_enabled BOOLEAN NOT NULL DEFAULT false;
