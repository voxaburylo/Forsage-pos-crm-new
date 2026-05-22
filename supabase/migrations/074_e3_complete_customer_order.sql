-- ============================================================
-- E-3: complete_customer_order — атомарне завершення замовлення
-- Створює sale-запис, декрементує qty, вивільняє резерви.
-- update_customer_order_status('completed') НЕ ЗМІНЮЄТЬСЯ (відкат).
-- ============================================================

-- 1. Додаємо sale_id до customer_orders (якщо ще нема)
ALTER TABLE customer_orders
    ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;

-- 2. RPC: complete_customer_order
CREATE OR REPLACE FUNCTION complete_customer_order(
    p_tenant_id      UUID,
    p_order_id       UUID,
    p_cashier_id     UUID,
    p_shift_id       UUID,
    p_payment_method VARCHAR(20),
    p_cash_amount    INTEGER DEFAULT 0,
    p_card_amount    INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_order          RECORD;
    v_item           RECORD;
    v_product        RECORD;
    v_sale_id        UUID;
    v_sale_number    VARCHAR(20);
    v_subtotal       INTEGER := 0;
    v_allow_neg      BOOLEAN;
    v_shift_id       UUID;
BEGIN
    -- Блокуємо рядок замовлення
    SELECT * INTO v_order FROM customer_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Замовлення % не знайдено', p_order_id;
    END IF;
    IF v_order.status = 'completed' THEN
        RAISE EXCEPTION 'ALREADY_COMPLETED: Замовлення вже завершено';
    END IF;

    -- Налаштування складу
    SELECT COALESCE(allow_negative_qty, true) INTO v_allow_neg
    FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    IF NOT FOUND THEN v_allow_neg := true; END IF;

    -- Зсув: якщо shift_id не передано — шукаємо відкриту зміну
    v_shift_id := p_shift_id;
    IF v_shift_id IS NULL THEN
        SELECT id INTO v_shift_id
        FROM shifts
        WHERE tenant_id = p_tenant_id AND status = 'open'
        ORDER BY opened_at DESC LIMIT 1;
    END IF;

    -- Прохід 1: перевірка залишків для warehouse-items
    FOR v_item IN
        SELECT * FROM customer_order_items
        WHERE order_id = p_order_id
          AND source_type = 'warehouse'
          AND product_id IS NOT NULL
          AND item_status NOT IN ('canceled', 'handed')
    LOOP
        SELECT qty_on_hand, name INTO v_product
        FROM products
        WHERE id = v_item.product_id AND deleted_at IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар % не знайдено', v_item.product_id;
        END IF;

        IF v_product.qty_on_hand < v_item.qty AND NOT v_allow_neg THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо залишку для "%": є %, потрібно %',
                v_product.name, v_product.qty_on_hand, v_item.qty;
        END IF;

        v_subtotal := v_subtotal + (v_item.sell_price * v_item.qty);
    END LOOP;

    -- Якщо нема warehouse-items — просто закрити замовлення без sale
    IF v_subtotal = 0 THEN
        UPDATE customer_orders
        SET status = 'completed', updated_at = NOW()
        WHERE id = p_order_id;

        UPDATE customer_order_items
        SET item_status = 'handed'
        WHERE order_id = p_order_id AND item_status NOT IN ('canceled', 'handed');

        RETURN jsonb_build_object(
            'sale_id', NULL,
            'sale_number', NULL,
            'order_id', p_order_id
        );
    END IF;

    -- Номер продажу
    v_sale_number := LPAD(nextval('sale_number_seq')::TEXT, 6, '0');

    -- Створення sale-запису
    INSERT INTO sales (
        tenant_id, sale_number, customer_id, cashier_id, shift_id,
        status, subtotal, discount, total,
        payment_method, is_debt, manager_id, cash_amount, card_amount
    ) VALUES (
        p_tenant_id, v_sale_number, v_order.customer_id,
        p_cashier_id, v_shift_id,
        'completed', v_subtotal, 0, v_subtotal,
        p_payment_method, false,
        COALESCE(v_order.manager_id, p_cashier_id),
        p_cash_amount, p_card_amount
    )
    RETURNING id INTO v_sale_id;

    -- Прохід 2: sale_items + декремент qty_on_hand
    FOR v_item IN
        SELECT * FROM customer_order_items
        WHERE order_id = p_order_id
          AND source_type = 'warehouse'
          AND product_id IS NOT NULL
          AND item_status NOT IN ('canceled', 'handed')
    LOOP
        INSERT INTO sale_items (
            tenant_id, sale_id, product_id, qty, unit_price, discount, total
        ) VALUES (
            p_tenant_id, v_sale_id, v_item.product_id,
            v_item.qty, v_item.sell_price, 0,
            v_item.sell_price * v_item.qty
        );

        UPDATE products
        SET qty_on_hand = qty_on_hand - v_item.qty, updated_at = NOW()
        WHERE id = v_item.product_id;
    END LOOP;

    -- Вивільняємо резерви замовлення
    UPDATE inventory_reserves
    SET released_at = NOW()
    WHERE order_id = p_order_id AND released_at IS NULL;

    -- Оновлюємо статус позицій
    UPDATE customer_order_items
    SET item_status = 'handed'
    WHERE order_id = p_order_id AND item_status NOT IN ('canceled', 'handed');

    -- Оновлюємо замовлення
    UPDATE customer_orders
    SET status    = 'completed',
        sale_id   = v_sale_id,
        updated_at = NOW()
    WHERE id = p_order_id;

    RETURN jsonb_build_object(
        'sale_id', v_sale_id,
        'sale_number', v_sale_number,
        'order_id', p_order_id
    );
END;
$$;
