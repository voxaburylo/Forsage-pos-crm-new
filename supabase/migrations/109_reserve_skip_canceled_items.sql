-- 109_reserve_skip_canceled_items.sql
-- Скасовані позиції замовлення не повинні тримати складський резерв:
-- reserve_order_items тепер пропускає item_status = 'canceled'.
CREATE OR REPLACE FUNCTION reserve_order_items(
    p_tenant_id   UUID,
    p_order_id    UUID,
    p_user_id     UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_allow_neg       BOOLEAN;
    v_duration_days   INTEGER;
    v_customer_id     UUID;
    v_item            RECORD;
    v_qty_on_hand     NUMERIC;
    v_qty_reserved    NUMERIC;
    v_qty_available   NUMERIC;
    v_product_name    VARCHAR;
BEGIN
    -- Налаштування складу
    SELECT allow_negative_qty, reserve_duration_days
    INTO v_allow_neg, v_duration_days
    FROM shop_settings
    WHERE tenant_id = p_tenant_id
    LIMIT 1;

    v_allow_neg := COALESCE(v_allow_neg, true);
    v_duration_days := COALESCE(v_duration_days, 3);

    -- Дані клієнта
    SELECT customer_id INTO v_customer_id
    FROM customer_orders
    WHERE id = p_order_id;

    -- Спочатку вивільняємо старі активні резерви цього замовлення (для перерахунку)
    UPDATE inventory_reserves
    SET released_at = NOW()
    WHERE order_id = p_order_id AND released_at IS NULL;

    -- Резервуємо товари зі складу (source_type = 'warehouse'), крім скасованих позицій
    FOR v_item IN
        SELECT product_id, qty
        FROM customer_order_items
        WHERE order_id = p_order_id
          AND source_type = 'warehouse'
          AND product_id IS NOT NULL
          AND item_status != 'canceled'
    LOOP
        -- Лочимо рядок товару
        SELECT qty_on_hand, name INTO v_qty_on_hand, v_product_name
        FROM products WHERE id = v_item.product_id FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар не знайдено: %', v_item.product_id;
        END IF;

        -- Рахуємо інші активні резерви (без урахування щойно вивільнених по цьому замовленню)
        SELECT COALESCE(SUM(qty), 0) INTO v_qty_reserved
        FROM inventory_reserves
        WHERE product_id = v_item.product_id
          AND released_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW());

        v_qty_available := v_qty_on_hand - v_qty_reserved;

        -- Перевірка залишків
        IF v_qty_available < v_item.qty AND NOT v_allow_neg THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо доступного залишку для "%": є %, потрібно % (зарезервовано %)', v_product_name, v_qty_available, v_item.qty, v_qty_reserved;
        END IF;

        -- Створюємо запис резерву
        INSERT INTO inventory_reserves (tenant_id, product_id, order_id, customer_id, qty, reserved_by, expires_at)
        VALUES (p_tenant_id, v_item.product_id, p_order_id, v_customer_id, v_item.qty, p_user_id, NOW() + (v_duration_days || ' days')::INTERVAL);
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
