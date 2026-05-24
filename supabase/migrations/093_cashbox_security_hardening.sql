-- 093_cashbox_security_hardening.sql
CREATE SCHEMA IF NOT EXISTS app;

-- Переконуємось у наявності допоміжних функцій для RLS
CREATE OR REPLACE FUNCTION app.user_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::UUID,
    '00000000-0000-0000-0000-000000000001'::UUID
  );
$$;

CREATE OR REPLACE FUNCTION app.has_role(required_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'role') = ANY(required_roles),
    false
  );
$$;

-- 1. Модифікація таблиці idempotency_keys
ALTER TABLE idempotency_keys ALTER COLUMN response DROP NOT NULL;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'completed';

-- Додаємо CHECK constraint для статусу, якщо його немає
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'chk_idempotency_status'
  ) THEN
    ALTER TABLE idempotency_keys 
      ADD CONSTRAINT chk_idempotency_status 
      CHECK (status IN ('processing', 'completed', 'failed'));
  END IF;
END;
$$;

-- 2. Посилення RLS політик на staff_pins
ALTER TABLE staff_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_pins_all" ON staff_pins;
DROP POLICY IF EXISTS "staff_pins_select" ON staff_pins;
DROP POLICY IF EXISTS "staff_pins_insert" ON staff_pins;
DROP POLICY IF EXISTS "staff_pins_update" ON staff_pins;
DROP POLICY IF EXISTS "staff_pins_delete" ON staff_pins;

CREATE POLICY "staff_pins_select" ON staff_pins FOR SELECT
  USING (user_id = auth.uid() OR app.has_role(ARRAY['owner', 'admin']));

CREATE POLICY "staff_pins_insert" ON staff_pins FOR INSERT
  WITH CHECK (user_id = auth.uid() OR app.has_role(ARRAY['owner', 'admin']));

CREATE POLICY "staff_pins_update" ON staff_pins FOR UPDATE
  USING (user_id = auth.uid() OR app.has_role(ARRAY['owner', 'admin']))
  WITH CHECK (user_id = auth.uid() OR app.has_role(ARRAY['owner', 'admin']));

CREATE POLICY "staff_pins_delete" ON staff_pins FOR DELETE
  USING (user_id = auth.uid() OR app.has_role(ARRAY['owner', 'admin']));

-- 3. Посилення RLS політик на cash_operations (внесення/вилучення грошей)
ALTER TABLE cash_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cash_ops_all" ON cash_operations;
DROP POLICY IF EXISTS "cash_ops_select" ON cash_operations;
DROP POLICY IF EXISTS "cash_ops_insert" ON cash_operations;
DROP POLICY IF EXISTS "cash_ops_update" ON cash_operations;
DROP POLICY IF EXISTS "cash_ops_delete" ON cash_operations;

CREATE POLICY "cash_ops_select" ON cash_operations FOR SELECT
  USING (tenant_id = app.user_tenant_id());

CREATE POLICY "cash_ops_insert" ON cash_operations FOR INSERT
  WITH CHECK (tenant_id = app.user_tenant_id());

CREATE POLICY "cash_ops_update" ON cash_operations FOR UPDATE
  USING (tenant_id = app.user_tenant_id() AND app.has_role(ARRAY['owner']))
  WITH CHECK (tenant_id = app.user_tenant_id() AND app.has_role(ARRAY['owner']));

CREATE POLICY "cash_ops_delete" ON cash_operations FOR DELETE
  USING (tenant_id = app.user_tenant_id() AND app.has_role(ARRAY['owner']));

NOTIFY pgrst, 'reload schema';
