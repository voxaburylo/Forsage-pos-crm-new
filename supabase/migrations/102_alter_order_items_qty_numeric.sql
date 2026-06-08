-- Alter qty in customer_order_items to be NUMERIC(12,3) to allow fractional quantities
ALTER TABLE customer_order_items ALTER COLUMN qty TYPE NUMERIC(12,3);

-- Alter customer_order_items table constraint to allow 'returned' status
ALTER TABLE customer_order_items DROP CONSTRAINT IF EXISTS customer_order_items_item_status_check;
ALTER TABLE customer_order_items ADD CONSTRAINT customer_order_items_item_status_check CHECK (item_status IN ('pending','ordered','arrived','handed','canceled','returned'));
