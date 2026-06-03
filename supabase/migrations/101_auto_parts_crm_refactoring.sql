-- 101_auto_parts_crm_refactoring.sql
-- Clean up legacy orders tables and add fields for drafts & variants selection flow

-- 1. Drop legacy unused tables (from phase 003)
DROP TABLE IF EXISTS order_status_history CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;

-- 2. Add parent_draft_id to customer_orders to track draft conversions
ALTER TABLE customer_orders 
  ADD COLUMN IF NOT EXISTS parent_draft_id UUID REFERENCES customer_orders(id) ON DELETE SET NULL;

-- 3. Update customer_orders status constraint to include 'archived'
ALTER TABLE customer_orders
  DROP CONSTRAINT IF EXISTS customer_orders_status_check;

ALTER TABLE customer_orders
  ADD CONSTRAINT customer_orders_status_check
  CHECK (status IN (
    'lead', 'new', 'in_progress', 'ordered', 'arrived',
    'called', 'no_answer', 'ready', 'completed', 'canceled', 'archived'
  ));

-- 4. Create index on parent_draft_id
CREATE INDEX IF NOT EXISTS idx_cust_orders_parent_draft ON customer_orders(parent_draft_id) WHERE parent_draft_id IS NOT NULL;

-- 5. Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
