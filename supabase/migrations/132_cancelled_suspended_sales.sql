-- A suspended sale is a cart snapshot, not a financial operation. Once it is
-- restored to the POS or discarded, keep it as cancelled for audit/history
-- while removing it from the active suspended list.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check;

ALTER TABLE sales ADD CONSTRAINT sales_status_check
  CHECK (status IN (
    'draft',
    'completed',
    'returned',
    'suspended',
    'ready_for_pickup',
    'cancelled'
  ));
