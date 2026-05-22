-- Improvement#5: update_customer_order_status completed — GREATEST(0, qty)
-- Захищає від від'ємних залишків при завершенні замовлення навіть якщо
-- qty_on_hand вже змінився зовнішніми операціями

CREATE OR REPLACE FUNCTION update_customer_order_status(
    p_tenant_id   UUID,
    p_order_id    UUID,
    p_status      VARCHAR,
    p_user_id     UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_current_status  VARCHAR;
    v_item            RECORD;
    v_qty_on_hand     NUMERIC;
    v_product_name    VARCHAR;
    v_allow_neg       BOOLEAN;
BEGIN
    SELECT status INTO v_current_status FROM customer_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Замовлення не знайдено'; END IF;

    IF v_current_status = p_status THEN
        RETURN (SELECT row_to_json(o)::jsonb FROM (SELECT * FROM customer_orders WHERE id = p_order_id) o);
    END IF;

    SELECT allow_negative_qty INTO v_allow_neg FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    v_allow_neg := COALESCE(v_allow_neg, true);

    IF p_status = 'completed' THEN
        FOR v_item IN
            SELECT product_id, qty FROM customer_order_items
            WHERE order_id = p_order_id AND source_type = 'warehouse'
              AND product_id IS NOT NULL
        LOOP
            SELECT qty_on_hand, name INTO v_qty_on_hand, v_product_name
            FROM products WHERE id = v_item.product_id FOR UPDATE;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар не знайдено: %', v_item.product_id;
            END IF;

            IF v_qty_on_hand < v_item.qty AND NOT v_allow_neg THEN
                RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо фізичного залишку для завершення "%": є %, потрібно %',
                    v_product_name, v_qty_on_hand, v_item.qty;
            END IF;

            -- GREATEST(0, ...) — захист від від'ємних залишків при allow_negative_qty=false
            UPDATE products
            SET qty_on_hand = GREATEST(0, qty_on_hand - v_item.qty),
                updated_at  = NOW()
            WHERE id = v_item.product_id;
        END LOOP;

        UPDATE inventory_reserves SET released_at = NOW() WHERE order_id = p_order_id AND released_at IS NULL;
        UPDATE customer_order_items SET item_status = 'handed' WHERE order_id = p_order_id;

    ELSIF p_status IN ('canceled', 'lead') THEN
        UPDATE inventory_reserves SET released_at = NOW() WHERE order_id = p_order_id AND released_at IS NULL;
        IF p_status = 'canceled' THEN
            UPDATE customer_order_items SET item_status = 'canceled' WHERE order_id = p_order_id;
        END IF;

    ELSIF p_status IN ('new', 'in_progress') THEN
        PERFORM reserve_order_items(p_tenant_id, p_order_id, p_user_id);
    END IF;

    UPDATE customer_orders SET status = p_status, updated_at = NOW() WHERE id = p_order_id;

    RETURN (SELECT row_to_json(o)::jsonb FROM (SELECT * FROM customer_orders WHERE id = p_order_id) o);
END;
$$;
