-- 057_salary_and_internal.sql
-- Додає таблиці для зарплати та внутрішнього відпуску

-- ============================================================
-- salary_payments — нарахування зарплатні, бонусів, авансів, штрафів
-- ============================================================
CREATE TABLE IF NOT EXISTS salary_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  employee_id   UUID NOT NULL,
  employee_name TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  type          VARCHAR(20) NOT NULL DEFAULT 'salary',
  method        VARCHAR(20) NOT NULL DEFAULT 'cash',
  period        VARCHAR(7),
  note          TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS salary_payments_tenant_idx
  ON salary_payments(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS salary_payments_employee_idx
  ON salary_payments(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS salary_payments_period_idx
  ON salary_payments(tenant_id, period);

ALTER TABLE salary_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "salary_payments_all" ON salary_payments;
CREATE POLICY "salary_payments_all" ON salary_payments FOR ALL USING (true);

-- ============================================================
-- internal_consumptions — відпуск запчастин по собівартості
-- ============================================================
CREATE TABLE IF NOT EXISTS internal_consumptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  employee_id   UUID NOT NULL,
  employee_name TEXT NOT NULL,
  items         JSONB NOT NULL DEFAULT '[]',
  total_cost    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_consumptions_tenant_idx
  ON internal_consumptions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS internal_consumptions_employee_idx
  ON internal_consumptions(tenant_id, employee_id);

ALTER TABLE internal_consumptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "internal_consumptions_all" ON internal_consumptions;
CREATE POLICY "internal_consumptions_all" ON internal_consumptions FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
