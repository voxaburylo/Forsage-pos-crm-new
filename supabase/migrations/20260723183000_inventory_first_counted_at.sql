-- Стабільний порядок «доданих товарів» у ревізії.
--
-- Раніше список сортувався за updated_at, тож редагування кількості раніше
-- пробитого товару підкидало його вгору — порядок додавання ламався. Додаємо
-- окреме поле часу ПЕРШОГО підрахунку: воно ставиться один раз і більше не
-- змінюється, тож порядок стабільний.

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS first_counted_at TIMESTAMPTZ;

-- Бекфіл наявних ревізій: беремо час першого запису підрахунку, а якщо його
-- немає — updated_at, щоб уже пораховані товари теж отримали осмислений порядок.
UPDATE inventory_items i
SET first_counted_at = COALESCE(
  (SELECT MIN(e.created_at) FROM inventory_count_entries e
    WHERE e.inventory_item_id = i.id),
  i.updated_at
)
WHERE i.was_counted = true AND i.first_counted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_first_counted
  ON inventory_items(session_id, first_counted_at);

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
    last_counted_by, was_counted, price_checked, observed_retail_price,
    first_counted_at, updated_at
  )
  VALUES (
    p_session_id, p_product_id, COALESCE(v_expected, 0), p_qty,
    p_user_id, true, p_price_checked, p_observed_retail_price,
    now(), now()
  )
  ON CONFLICT (session_id, product_id) DO UPDATE SET
    expected_stock = CASE
      WHEN inventory_items.was_counted = false THEN COALESCE(v_expected, 0)
      ELSE inventory_items.expected_stock
    END,
    counted_stock = inventory_items.counted_stock + EXCLUDED.counted_stock,
    last_counted_by = p_user_id,
    was_counted = true,
    price_checked = inventory_items.price_checked OR p_price_checked,
    observed_retail_price = COALESCE(p_observed_retail_price, inventory_items.observed_retail_price),
    -- фіксуємо час першого підрахунку лише раз
    first_counted_at = COALESCE(inventory_items.first_counted_at, now()),
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
