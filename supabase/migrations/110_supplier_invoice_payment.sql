-- 110_supplier_invoice_payment.sql
-- Оплата постачальнику по прихідній накладній + основа для боргів постачальникам.
-- paid_amount: скільки вже оплачено постачальнику по цій накладній (копійки).
-- Борг по постачальнику = SUM(total - paid_amount) по проведених накладних.
ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS paid_amount    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'card', 'transfer'));

-- Прискорення вибірки боргів по постачальнику
CREATE INDEX IF NOT EXISTS idx_supply_invoices_supplier_status
  ON supply_invoices(tenant_id, supplier_id, status);

NOTIFY pgrst, 'reload schema';
