-- 21.11.2026: бонуси як передоплата замовлення (рішення власника 20.11.2026:
-- бонуси — гроші клієнта, ними можна оплатити 100% або внести передоплату).
-- 1. Платіж замовлення методом 'bonus' (списання з бонусного балансу клієнта).
ALTER TABLE public.order_payments DROP CONSTRAINT IF EXISTS order_payments_method_check;
ALTER TABLE public.order_payments ADD CONSTRAINT order_payments_method_check
  CHECK (method IN ('cash', 'card', 'transfer', 'mixed', 'account', 'bonus'));

-- 2. Повернення бонусів на баланс при скасуванні оплаченого бонусами замовлення.
ALTER TABLE public.bonus_transactions DROP CONSTRAINT IF EXISTS bonus_transactions_transaction_type_check;
ALTER TABLE public.bonus_transactions ADD CONSTRAINT bonus_transactions_transaction_type_check
  CHECK (transaction_type IN ('earn', 'spend', 'manual', 'expire', 'refund'));

NOTIFY pgrst, 'reload schema';
