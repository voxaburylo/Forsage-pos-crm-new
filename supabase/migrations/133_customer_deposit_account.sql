-- 133: Рахунок клієнта (передплата) + режим лояльності «накопичення»
-- Гроші клієнт вносить ТІЛЬКИ на касі; з рахунку оплачуються замовлення.
-- loyalty_mode='cashback': відсоток цінової групи не знижує чек, а
-- нараховується грошима на рахунок клієнта після продажу.

-- 1. Баланс рахунку (копійки) + режим лояльності
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deposit_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_mode VARCHAR(10) NOT NULL DEFAULT 'discount';
DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_loyalty_mode_check
    CHECK (loyalty_mode IN ('discount', 'cashback'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Журнал руху коштів рахунку
CREATE TABLE IF NOT EXISTS customer_deposit_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,              -- + поповнення / - списання, копійки
  balance_after INTEGER NOT NULL,            -- баланс після операції (для звірки)
  method      VARCHAR(20),                   -- cash | card | transfer | account | cashback | correction
  order_id    UUID,                          -- якщо списання на замовлення
  sale_id     UUID,                          -- якщо кешбек з продажу
  shift_id    UUID,                          -- зміна каси (для готівки)
  notes       TEXT,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deposit_tx_customer ON customer_deposit_transactions(tenant_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_tx_order ON customer_deposit_transactions(order_id) WHERE order_id IS NOT NULL;

-- 3. Атомарна зміна балансу (блокує рядок клієнта, не дає піти в мінус)
CREATE OR REPLACE FUNCTION customer_deposit_change(
  p_tenant_id   UUID,
  p_customer_id UUID,
  p_amount      INTEGER,          -- + поповнення / - списання
  p_method      TEXT DEFAULT NULL,
  p_order_id    UUID DEFAULT NULL,
  p_sale_id     UUID DEFAULT NULL,
  p_shift_id    UUID DEFAULT NULL,
  p_notes       TEXT DEFAULT NULL,
  p_created_by  UUID DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'ZERO_AMOUNT';
  END IF;

  SELECT deposit_balance INTO v_balance
  FROM customers
  WHERE id = p_customer_id AND tenant_id = p_tenant_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;

  v_balance := v_balance + p_amount;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_DEPOSIT';
  END IF;

  UPDATE customers
  SET deposit_balance = v_balance, updated_at = now()
  WHERE id = p_customer_id;

  INSERT INTO customer_deposit_transactions
    (tenant_id, customer_id, amount, balance_after, method, order_id, sale_id, shift_id, notes, created_by)
  VALUES
    (p_tenant_id, p_customer_id, p_amount, v_balance, p_method, p_order_id, p_sale_id, p_shift_id, p_notes, p_created_by);

  RETURN v_balance;
END;
$$;

-- 4. Платежі замовлень: дозволяємо метод 'account' (списання з рахунку клієнта)
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_method_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_method_check
  CHECK (method IN ('cash', 'card', 'transfer', 'mixed', 'account'));

NOTIFY pgrst, 'reload schema';
