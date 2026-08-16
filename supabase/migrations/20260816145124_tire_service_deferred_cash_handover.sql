-- Link a later cash handover to the tire worker and the actual work date.
-- The operation still belongs to the shift in which the money was physically received.
ALTER TABLE public.cash_operations
  ADD COLUMN IF NOT EXISTS employee_id UUID,
  ADD COLUMN IF NOT EXISTS work_date DATE;

CREATE INDEX IF NOT EXISTS idx_cash_operations_tire_handover
  ON public.cash_operations (tenant_id, employee_id, work_date, created_at DESC)
  WHERE type = 'in' AND employee_id IS NOT NULL AND work_date IS NOT NULL;

NOTIFY pgrst, 'reload schema';

