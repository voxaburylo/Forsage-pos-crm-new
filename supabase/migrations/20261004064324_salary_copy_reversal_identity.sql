-- Local reversals retain the original sale/order links. They must coexist
-- with the positive award while each original award and each return remain unique.
-- Include legacy non-reversal rows (source='manual') in the award guard.
-- No financial rows, dates or amounts are updated or deleted.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_sale_award
  ON public.salary_payments(tenant_id, employee_id, commission_source_sale_id)
  WHERE commission_source_sale_id IS NOT NULL AND source <> 'commission_reversal';
CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_order_award
  ON public.salary_payments(tenant_id, employee_id, commission_source_order_id)
  WHERE commission_source_order_id IS NOT NULL AND source <> 'commission_reversal';

-- Build replacement guards first: a validation/lock failure rolls everything back.
ALTER TABLE public.salary_payments
  DROP CONSTRAINT IF EXISTS salary_payments_sale_employee_comm_key,
  DROP CONSTRAINT IF EXISTS salary_payments_order_employee_comm_key,
  DROP CONSTRAINT IF EXISTS salary_payments_commission_source_order_id_key;

-- uq_salary_return_commission and salary_daily_rate_once_idx remain unchanged.
NOTIFY pgrst, 'reload schema';
COMMIT;
