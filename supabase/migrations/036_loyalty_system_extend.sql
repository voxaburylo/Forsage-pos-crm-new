-- 036_loyalty_system_extend.sql
-- Розширення системи лояльності: швидкий баланс + бонуси в продажах

-- Додаємо bonus_balance до customers (швидкі запити замість SUM-transactions)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bonus_balance INTEGER NOT NULL DEFAULT 0;

-- Додаємо поля до sales
ALTER TABLE sales ADD COLUMN IF NOT EXISTS bonuses_earned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS bonuses_spent INTEGER NOT NULL DEFAULT 0;

-- Індекс для історії
CREATE INDEX IF NOT EXISTS idx_bonus_transactions_customer
  ON loyalty_transactions(customer_id, created_at DESC);
