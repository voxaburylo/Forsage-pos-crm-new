-- Джерело грошей для касових операцій та детальний журнал оплат постачальникам.

ALTER TABLE cash_operations
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'cashbox';

ALTER TABLE cash_operations DROP CONSTRAINT IF EXISTS cash_operations_source_check;
ALTER TABLE cash_operations ADD CONSTRAINT cash_operations_source_check
  CHECK (source IN ('cashbox', 'owner_funds', 'change_fund', 'bank_account', 'business_card', 'other'));

CREATE TABLE IF NOT EXISTS supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  invoice_id UUID NOT NULL REFERENCES supply_invoices(id) ON DELETE RESTRICT,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'card', 'transfer')),
  fund_source VARCHAR(30) NOT NULL CHECK (fund_source IN ('cashbox', 'owner_funds', 'bank_account', 'business_card')),
  shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
  note TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_invoice
  ON supplier_payments(tenant_id, invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_tenant
  ON supplier_payments(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier
  ON supplier_payments(tenant_id, supplier_id, created_at DESC)
  WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_payments_shift
  ON supplier_payments(tenant_id, shift_id, created_at DESC)
  WHERE shift_id IS NOT NULL;

ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_payments_tenant_policy ON supplier_payments;
CREATE POLICY supplier_payments_tenant_policy ON supplier_payments
  FOR ALL
  TO authenticated
  USING (tenant_id = app.user_tenant_id())
  WITH CHECK (tenant_id = app.user_tenant_id());

NOTIFY pgrst, 'reload schema';
