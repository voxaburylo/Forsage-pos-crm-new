-- Щоденний облік заробітку та зв'язок виплати зарплати з касою.

ALTER TABLE salary_payments
  ADD COLUMN IF NOT EXISTS work_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS cash_operation_id UUID REFERENCES cash_operations(id) ON DELETE SET NULL;

-- Для старих записів відновлюємо фактичний день, а не день застосування міграції.
UPDATE salary_payments
SET work_date = (created_at AT TIME ZONE 'Europe/Kyiv')::date
WHERE source = 'manual';

ALTER TABLE salary_payments DROP CONSTRAINT IF EXISTS salary_payments_source_check;
ALTER TABLE salary_payments ADD CONSTRAINT salary_payments_source_check
  CHECK (source IN ('manual', 'commission', 'commission_reversal', 'daily_rate', 'daily_payout'));

CREATE INDEX IF NOT EXISTS salary_payments_work_date_idx
  ON salary_payments(tenant_id, work_date, employee_id);

CREATE UNIQUE INDEX IF NOT EXISTS salary_daily_rate_once_idx
  ON salary_payments(tenant_id, employee_id, work_date)
  WHERE source = 'daily_rate';

NOTIFY pgrst, 'reload schema';
