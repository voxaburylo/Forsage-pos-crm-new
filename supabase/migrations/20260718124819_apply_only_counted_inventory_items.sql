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
    AND i.was_counted = true
    AND p.tenant_id = p_tenant_id
    AND p.qty_on_hand IS DISTINCT FROM i.counted_stock;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  UPDATE inventory_sessions
  SET status = 'completed', completed_at = now()
  WHERE id = p_session_id AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object('items_updated', v_updated);
END;
$$;