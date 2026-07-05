-- Спільна інвентаризація з багатьох телефонів:
-- повний знімок складу, атомарне додавання кількості та журнал кожного підрахунку.

ALTER TABLE inventory_sessions
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_by UUID;

ALTER TABLE inventory_items
  ALTER COLUMN expected_stock TYPE NUMERIC(12,3) USING expected_stock::numeric,
  ALTER COLUMN counted_stock TYPE NUMERIC(12,3) USING counted_stock::numeric;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_counted_by UUID,
  ADD COLUMN IF NOT EXISTS was_counted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_checked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS observed_retail_price INTEGER;

CREATE TABLE IF NOT EXISTS inventory_count_entries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  session_id            UUID NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  inventory_item_id     UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  product_id            UUID NOT NULL REFERENCES products(id),
  counted_by            UUID NOT NULL,
  qty                   NUMERIC(12,3) NOT NULL CHECK (qty >= 0),
  price_checked         BOOLEAN NOT NULL DEFAULT false,
  observed_retail_price INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inventory_count_entries
  DROP CONSTRAINT IF EXISTS inventory_count_entries_qty_check;
ALTER TABLE inventory_count_entries
  ADD CONSTRAINT inventory_count_entries_qty_check CHECK (qty >= 0);

CREATE INDEX IF NOT EXISTS idx_inventory_entries_session_created
  ON inventory_count_entries(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_entries_user
  ON inventory_count_entries(counted_by, created_at DESC);

ALTER TABLE inventory_count_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_count_entries_tenant" ON inventory_count_entries;
CREATE POLICY "inventory_count_entries_tenant" ON inventory_count_entries
  FOR ALL USING (tenant_id = app.user_tenant_id())
  WITH CHECK (tenant_id = app.user_tenant_id());

CREATE OR REPLACE FUNCTION start_inventory_session(
  p_session_id UUID,
  p_tenant_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR;
  v_total INTEGER;
BEGIN
  SELECT status INTO v_status
  FROM inventory_sessions
  WHERE id = p_session_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND'; END IF;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'SESSION_ALREADY_STARTED'; END IF;

  INSERT INTO inventory_items (session_id, product_id, expected_stock, counted_stock)
  SELECT p_session_id, p.id, COALESCE(p.qty_on_hand, 0), 0
  FROM products p
  WHERE p.tenant_id = p_tenant_id
    AND p.deleted_at IS NULL
    AND p.is_active = true
    AND COALESCE(p.is_service, false) = false
  ON CONFLICT (session_id, product_id) DO NOTHING;

  GET DIAGNOSTICS v_total = ROW_COUNT;

  UPDATE inventory_sessions
  SET status = 'in_progress', started_at = now(), started_by = p_user_id
  WHERE id = p_session_id AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object('total_products', v_total);
END;
$$;

CREATE OR REPLACE FUNCTION add_inventory_count(
  p_session_id UUID,
  p_tenant_id UUID,
  p_product_id UUID,
  p_user_id UUID,
  p_qty NUMERIC,
  p_price_checked BOOLEAN DEFAULT false,
  p_observed_retail_price INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_item inventory_items%ROWTYPE;
  v_entry_id UUID;
  v_expected NUMERIC;
BEGIN
  IF p_qty < 0 THEN RAISE EXCEPTION 'INVALID_QTY'; END IF;

  PERFORM 1 FROM inventory_sessions
  WHERE id = p_session_id AND tenant_id = p_tenant_id AND status = 'in_progress'
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_ACTIVE'; END IF;

  SELECT qty_on_hand INTO v_expected
  FROM products
  WHERE id = p_product_id AND tenant_id = p_tenant_id
    AND deleted_at IS NULL AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;

  INSERT INTO inventory_items (
    session_id, product_id, expected_stock, counted_stock,
    last_counted_by, was_counted, price_checked, observed_retail_price, updated_at
  )
  VALUES (
    p_session_id, p_product_id, COALESCE(v_expected, 0), p_qty,
    p_user_id, true, p_price_checked, p_observed_retail_price, now()
  )
  ON CONFLICT (session_id, product_id) DO UPDATE SET
    counted_stock = inventory_items.counted_stock + EXCLUDED.counted_stock,
    last_counted_by = p_user_id,
    was_counted = true,
    price_checked = inventory_items.price_checked OR p_price_checked,
    observed_retail_price = COALESCE(p_observed_retail_price, inventory_items.observed_retail_price),
    updated_at = now()
  RETURNING * INTO v_item;

  INSERT INTO inventory_count_entries (
    tenant_id, session_id, inventory_item_id, product_id, counted_by,
    qty, price_checked, observed_retail_price
  )
  VALUES (
    p_tenant_id, p_session_id, v_item.id, p_product_id, p_user_id,
    p_qty, p_price_checked, p_observed_retail_price
  )
  RETURNING id INTO v_entry_id;

  RETURN jsonb_build_object(
    'entry_id', v_entry_id,
    'item_id', v_item.id,
    'counted_stock', v_item.counted_stock,
    'expected_stock', v_item.expected_stock,
    'price_checked', v_item.price_checked,
    'observed_retail_price', v_item.observed_retail_price
  );
END;
$$;

CREATE OR REPLACE FUNCTION undo_inventory_count(
  p_entry_id UUID,
  p_session_id UUID,
  p_tenant_id UUID,
  p_user_id UUID,
  p_allow_any_user BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry inventory_count_entries%ROWTYPE;
  v_new_count NUMERIC;
BEGIN
  PERFORM 1 FROM inventory_sessions
  WHERE id = p_session_id AND tenant_id = p_tenant_id AND status = 'in_progress'
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_ACTIVE'; END IF;

  SELECT * INTO v_entry
  FROM inventory_count_entries
  WHERE id = p_entry_id AND session_id = p_session_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'ENTRY_NOT_FOUND'; END IF;
  IF NOT p_allow_any_user AND v_entry.counted_by <> p_user_id THEN
    RAISE EXCEPTION 'ENTRY_FORBIDDEN';
  END IF;

  DELETE FROM inventory_count_entries WHERE id = p_entry_id;

  UPDATE inventory_items
  SET counted_stock = GREATEST(0, counted_stock - v_entry.qty),
      was_counted = EXISTS (
        SELECT 1 FROM inventory_count_entries e
        WHERE e.inventory_item_id = v_entry.inventory_item_id
      ),
      price_checked = EXISTS (
        SELECT 1 FROM inventory_count_entries e
        WHERE e.inventory_item_id = v_entry.inventory_item_id AND e.price_checked = true
      ),
      observed_retail_price = (
        SELECT e.observed_retail_price
        FROM inventory_count_entries e
        WHERE e.inventory_item_id = v_entry.inventory_item_id
          AND e.observed_retail_price IS NOT NULL
        ORDER BY e.created_at DESC
        LIMIT 1
      ),
      updated_at = now()
  WHERE id = v_entry.inventory_item_id
  RETURNING counted_stock INTO v_new_count;
  RETURN jsonb_build_object('item_id', v_entry.inventory_item_id, 'counted_stock', v_new_count);
END;
$$;

CREATE OR REPLACE FUNCTION complete_inventory_session(
  p_session_id UUID,
  p_tenant_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  PERFORM 1 FROM inventory_sessions
  WHERE id = p_session_id AND tenant_id = p_tenant_id AND status = 'in_progress'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_ACTIVE'; END IF;

  UPDATE products p
  SET qty_on_hand = i.counted_stock, updated_at = now()
  FROM inventory_items i
  WHERE i.session_id = p_session_id
    AND i.product_id = p.id
    AND p.tenant_id = p_tenant_id
    AND p.qty_on_hand IS DISTINCT FROM i.counted_stock;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  UPDATE inventory_sessions
  SET status = 'completed', completed_at = now()
  WHERE id = p_session_id AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object('items_updated', v_updated);
END;
$$;

CREATE OR REPLACE FUNCTION get_inventory_session_summary(
  p_session_id UUID,
  p_tenant_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total_products', COUNT(*),
    'counted_products', COUNT(*) FILTER (WHERE was_counted = true),
    'matching_products', COUNT(*) FILTER (WHERE was_counted = true AND counted_stock = expected_stock),
    'discrepancy_products', COUNT(*) FILTER (WHERE was_counted = true AND counted_stock <> expected_stock),
    'price_checked_products', COUNT(*) FILTER (
      WHERE price_checked = true OR observed_retail_price IS NOT NULL
    ),
    'price_mismatch_products', COUNT(*) FILTER (
      WHERE observed_retail_price IS NOT NULL
        AND observed_retail_price <> p.retail_price
    ),
    'participants', (
      SELECT COUNT(DISTINCT e.counted_by)
      FROM inventory_count_entries e
      WHERE e.session_id = p_session_id
    ),
    'total_expected_units', COALESCE(SUM(expected_stock), 0),
    'total_counted_units', COALESCE(SUM(counted_stock), 0)
  )
  FROM inventory_items i
  JOIN inventory_sessions s ON s.id = i.session_id
  JOIN products p ON p.id = i.product_id
  WHERE i.session_id = p_session_id AND s.tenant_id = p_tenant_id;
$$;
