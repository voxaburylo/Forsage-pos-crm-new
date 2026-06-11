-- 108_supplier_core_debts_po_seq.sql
-- 1. Борги перед постачальниками за серцевини: лічильник повернутої кількості.
--    Статус виводиться з кількостей: 0 = новий, 0<x<qty = частково оплачений, >=qty = оплачений.
ALTER TABLE supply_invoice_items ADD COLUMN IF NOT EXISTS core_returned_qty NUMERIC(12,3) NOT NULL DEFAULT 0;

-- 2. Номер замовлення постачальнику: послідовність БД + унікальність
CREATE SEQUENCE IF NOT EXISTS supplier_po_number_seq;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_po_number ON supplier_purchase_orders(tenant_id, po_number);

NOTIFY pgrst, 'reload schema';
