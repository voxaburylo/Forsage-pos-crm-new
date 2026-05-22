-- Migration 009: Cash operations during shift
CREATE TABLE cash_operations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  shift_id   UUID NOT NULL REFERENCES shifts(id),
  type       VARCHAR(10) NOT NULL CHECK (type IN ('in','out')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  note       TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cash_ops_shift ON cash_operations(shift_id, created_at DESC);

ALTER TABLE cash_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cash_ops_all" ON cash_operations FOR ALL USING (true);
