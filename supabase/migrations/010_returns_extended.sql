-- Migration 010: Extend returns with full enum values

-- Fix reason CHECK (add warranty, duplicate, rename customer_changed_mind -> changed_mind)
ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_reason_check;
ALTER TABLE returns ADD CONSTRAINT returns_reason_check
  CHECK (reason IN ('defective','wrong_part','changed_mind','customer_changed_mind','warranty','duplicate','other'));

-- Fix refund_method CHECK (add terminal, credit)
ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_refund_method_check;
ALTER TABLE returns ADD CONSTRAINT returns_refund_method_check
  CHECK (refund_method IN ('cash','terminal','debt_reduction','credit'));

-- Fix condition CHECK in return_items (add opened_packaging)
ALTER TABLE return_items DROP CONSTRAINT IF EXISTS return_items_condition_check;
ALTER TABLE return_items ADD CONSTRAINT return_items_condition_check
  CHECK (condition IN ('good','defective','damaged','opened_packaging'));

-- Ensure stock_action column exists with correct values
ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_stock_action_check;
ALTER TABLE returns ADD CONSTRAINT returns_stock_action_check
  CHECK (stock_action IN ('return_to_stock','write_off','send_to_supplier'));
