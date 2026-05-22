-- 049_cash_reconciliations.sql
-- Звірка каси (Cash Reconciliation)

CREATE TABLE IF NOT EXISTS cash_reconciliations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  shift_id          UUID NOT NULL REFERENCES shifts(id),
  user_id           UUID NOT NULL,
  expected_amount   INTEGER NOT NULL,
  actual_amount     INTEGER NOT NULL,
  difference_amount INTEGER NOT NULL,
  comment           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cash_reconciliations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cash_reconciliations_all" ON cash_reconciliations FOR ALL USING (true);
