-- 095_fix_inventory_tables.sql
-- Fix legacy inventory tables and mismatch in inventory_sessions / inventory_items

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_sessions' AND column_name='session_name') THEN
    ALTER TABLE inventory_sessions RENAME COLUMN session_name TO name;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_sessions' AND column_name='started_by') THEN
    ALTER TABLE inventory_sessions RENAME COLUMN started_by TO created_by;
  END IF;
END $$;

ALTER TABLE inventory_sessions ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE inventory_sessions DROP CONSTRAINT IF EXISTS inventory_sessions_status_check;
ALTER TABLE inventory_sessions ADD CONSTRAINT inventory_sessions_status_check CHECK (status IN ('draft', 'in_progress', 'completed'));

CREATE TABLE IF NOT EXISTS inventory_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES products(id),
  expected_stock INTEGER NOT NULL DEFAULT 0,
  counted_stock  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, product_id)
);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_items_all" ON inventory_items;
CREATE POLICY "inventory_items_all" ON inventory_items FOR ALL USING (true);
