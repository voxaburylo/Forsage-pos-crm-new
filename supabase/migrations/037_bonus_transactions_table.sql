-- 037_bonus_transactions_table.sql
-- Створюємо bonus_transactions як аналог loyalty_transactions для сумісності

CREATE TABLE IF NOT EXISTS bonus_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  amount           INTEGER NOT NULL,             -- копійки (+ нарахування, - списання)
  transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('earn','spend','manual','expire')),
  source_sale_id   UUID REFERENCES sales(id),
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bonus_transactions_cust ON bonus_transactions(customer_id, created_at DESC);

ALTER TABLE bonus_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bonus_transactions_all" ON bonus_transactions FOR ALL USING (true);

-- Функція атомарного списання бонусів при створенні продажу
CREATE OR REPLACE FUNCTION process_bonus_spend(
  p_customer_id  UUID,
  p_amount       INTEGER,
  p_sale_id      UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  SELECT COALESCE(bonus_balance, 0) INTO v_balance
  FROM customers WHERE id = p_customer_id
  FOR UPDATE;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BONUS';
  END IF;

  UPDATE customers SET bonus_balance = bonus_balance - p_amount
  WHERE id = p_customer_id;

  INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description)
  VALUES ('00000000-0000-0000-0000-000000000001', p_customer_id, -p_amount, 'spend', p_sale_id, 'Списано при покупці');

  RETURN true;
END;
$$;

-- Функція атомарного нарахування бонусів
CREATE OR REPLACE FUNCTION process_bonus_earn(
  p_customer_id  UUID,
  p_amount       INTEGER,
  p_sale_id      UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_amount <= 0 THEN RETURN false; END IF;

  UPDATE customers SET bonus_balance = COALESCE(bonus_balance, 0) + p_amount
  WHERE id = p_customer_id;

  INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description)
  VALUES ('00000000-0000-0000-0000-000000000001', p_customer_id, p_amount, 'earn', p_sale_id, 'Нараховано за покупку');

  RETURN true;
END;
$$;
