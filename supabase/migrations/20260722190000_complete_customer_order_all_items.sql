-- Complete every active linked order line as a real receipt.
-- Payments and cash operations are recorded when payment is added; this RPC
-- only creates the receipt and therefore never records the money a second time.

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
    v_order            RECORD;
    v_item             RECORD;
    v_product          RECORD;
    v_sale_id          UUID;
    v_sale_number      VARCHAR(20);
    v_shift_id         UUID;
    v_subtotal         INTEGER := 0;
    v_discount         INTEGER := 0;
    v_allow_negative   BOOLEAN := true;
    v_active_count     INTEGER := 0;
    v_unlinked_name    TEXT;
    v_cash_amount       INTEGER := 0;
    v_card_amount       INTEGER := 0;
    v_transfer_amount   INTEGER := 0;
    v_mixed_amount      INTEGER := 0;
    v_payment_method    VARCHAR(20) := 'cash';
    v_is_fiscal         BOOLEAN := false;
BEGIN
    SELECT *
      INTO v_order
      FROM customer_orders
     WHERE id = p_order_id
       AND tenant_id = p_tenant_id
       AND deleted_at IS NULL
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Замовлення не знайдено';
    END IF;

    IF v_order.status = 'completed' AND v_order.sale_id IS NOT NULL THEN
        SELECT sale_number INTO v_sale_number
          FROM sales
         WHERE id = v_order.sale_id
           AND tenant_id = p_tenant_id;

        UPDATE customer_order_items
           SET item_status = 'handed'
         WHERE order_id = p_order_id
           AND item_status NOT IN ('canceled', 'handed');

        UPDATE inventory_reserves
           SET released_at = COALESCE(released_at, NOW())
         WHERE order_id = p_order_id
           AND tenant_id = p_tenant_id
           AND released_at IS NULL;

        RETURN jsonb_build_object(
            'sale_id', v_order.sale_id,
            'sale_number', v_sale_number,
            'order_id', p_order_id,
            'replayed', true
        );
    END IF;

    IF v_order.status IN ('canceled', 'archived') THEN
        RAISE EXCEPTION 'INVALID_STATUS: Скасоване або архівне замовлення не можна видати';
    END IF;

    IF GREATEST(COALESCE(v_order.total_paid, 0), COALESCE(v_order.prepayment, 0))
       < GREATEST(0, COALESCE(v_order.total_amount, 0) - COALESCE(v_order.discount_amount, 0)) THEN
        RAISE EXCEPTION 'INCOMPLETE_PAYMENT: Не всі оплати проведено';
    END IF;

    SELECT
        COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0)::INTEGER,
        COALESCE(SUM(amount) FILTER (WHERE method = 'card'), 0)::INTEGER,
        COALESCE(SUM(amount) FILTER (WHERE method IN ('transfer', 'account')), 0)::INTEGER,
        COALESCE(SUM(amount) FILTER (WHERE method = 'mixed'), 0)::INTEGER,
        COALESCE(BOOL_OR(is_fiscal), false)
      INTO v_cash_amount, v_card_amount, v_transfer_amount, v_mixed_amount, v_is_fiscal
      FROM order_payments
     WHERE order_id = p_order_id
       AND tenant_id = p_tenant_id;

    -- Old callers may pass an explicit split. Prefer it only when it contains data;
    -- otherwise use the already-recorded order payments and never create them again.
    IF COALESCE(p_cash_amount, 0) + COALESCE(p_card_amount, 0) > 0 THEN
        v_cash_amount := COALESCE(p_cash_amount, 0);
        v_card_amount := COALESCE(p_card_amount, 0);
        v_transfer_amount := 0;
        v_mixed_amount := 0;
    ELSIF v_cash_amount + v_card_amount + v_transfer_amount + v_mixed_amount = 0
          AND GREATEST(COALESCE(v_order.total_paid, 0), COALESCE(v_order.prepayment, 0)) > 0 THEN
        IF COALESCE(v_order.prepayment_method, p_payment_method) = 'card' THEN
            v_card_amount := GREATEST(COALESCE(v_order.total_paid, 0), COALESCE(v_order.prepayment, 0));
        ELSIF COALESCE(v_order.prepayment_method, p_payment_method) IN ('transfer', 'account') THEN
            v_transfer_amount := GREATEST(COALESCE(v_order.total_paid, 0), COALESCE(v_order.prepayment, 0));
        ELSIF COALESCE(v_order.prepayment_method, p_payment_method) = 'mixed' THEN
            v_mixed_amount := GREATEST(COALESCE(v_order.total_paid, 0), COALESCE(v_order.prepayment, 0));
        ELSE
            v_cash_amount := GREATEST(COALESCE(v_order.total_paid, 0), COALESCE(v_order.prepayment, 0));
        END IF;
    END IF;

    IF v_mixed_amount > 0
       OR ((v_cash_amount > 0)::INTEGER + (v_card_amount > 0)::INTEGER + (v_transfer_amount > 0)::INTEGER) > 1 THEN
        v_payment_method := 'mixed';
    ELSIF v_card_amount > 0 THEN
        v_payment_method := 'card';
    ELSIF v_transfer_amount > 0 THEN
        v_payment_method := 'transfer';
    ELSIF v_cash_amount > 0 THEN
        v_payment_method := 'cash';
    ELSIF p_payment_method IN ('cash', 'card', 'transfer', 'debt', 'mixed') THEN
        v_payment_method := p_payment_method;
    ELSE
        v_payment_method := 'cash';
    END IF;


    SELECT COUNT(*)
      INTO v_active_count
      FROM customer_order_items
     WHERE order_id = p_order_id
       AND item_status <> 'canceled';

    IF v_active_count = 0 THEN
        RAISE EXCEPTION 'EMPTY_ORDER: У замовленні немає активних позицій для видачі';
    END IF;

    SELECT name
      INTO v_unlinked_name
      FROM customer_order_items
     WHERE order_id = p_order_id
       AND item_status <> 'canceled'
       AND product_id IS NULL
     ORDER BY created_at
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'ITEM_NOT_LINKED: Позицію "%" не прив''язано до картки товару. Виберіть товар перед видачею.',
            COALESCE(v_unlinked_name, 'Без назви');
    END IF;

    SELECT COALESCE(allow_negative_qty, true)
      INTO v_allow_negative
      FROM shop_settings
     WHERE tenant_id = p_tenant_id
     LIMIT 1;
    IF NOT FOUND THEN
        v_allow_negative := true;
    END IF;

    v_shift_id := p_shift_id;
    IF v_shift_id IS NULL THEN
        SELECT id
          INTO v_shift_id
          FROM shifts
         WHERE tenant_id = p_tenant_id
           AND status = 'open'
         ORDER BY opened_at DESC
         LIMIT 1;
    ELSE
        PERFORM 1
          FROM shifts
         WHERE id = v_shift_id
           AND tenant_id = p_tenant_id
           AND status = 'open';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'OPEN_SHIFT_REQUIRED: Касову зміну не відкрито';
        END IF;
    END IF;

    IF v_shift_id IS NULL THEN
        RAISE EXCEPTION 'OPEN_SHIFT_REQUIRED: Спочатку відкрийте касову зміну';
    END IF;

    FOR v_item IN
        SELECT *
          FROM customer_order_items
         WHERE order_id = p_order_id
           AND item_status <> 'canceled'
         ORDER BY created_at
    LOOP
        SELECT id, name, sku, qty_on_hand, is_service, purchase_price,
               requires_core_return, core_deposit_amount
          INTO v_product
          FROM products
         WHERE id = v_item.product_id
           AND tenant_id = p_tenant_id
           AND deleted_at IS NULL
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар "%" не знайдено',
                COALESCE(v_item.name, v_item.product_id::TEXT);
        END IF;

        IF v_item.qty <= 0 THEN
            RAISE EXCEPTION 'INVALID_QTY: Некоректна кількість у позиції "%"',
                COALESCE(v_item.name, v_product.name);
        END IF;

        IF NOT v_product.is_service
           AND NOT v_allow_negative
           AND v_product.qty_on_hand < v_item.qty THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо залишку для "%": є %, потрібно %',
                v_product.name, v_product.qty_on_hand, v_item.qty;
        END IF;

        v_subtotal := v_subtotal + ROUND(
            (
                v_item.sell_price
                + COALESCE(
                    v_item.core_deposit_amount,
                    CASE WHEN v_product.requires_core_return
                         THEN v_product.core_deposit_amount ELSE 0 END,
                    0
                )
            ) * v_item.qty
        )::INTEGER;
    END LOOP;

    v_sale_id := gen_random_uuid();
    v_sale_number := LPAD(nextval('sale_number_seq')::TEXT, 6, '0');
    v_discount := GREATEST(0, COALESCE(v_order.discount_amount, 0));

    INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id,
        status, subtotal, discount, total, payment_method, is_debt,
        manager_id, cash_amount, card_amount, transfer_amount, is_fiscal, pickup_cell,
        completed_at, created_at, updated_at
    ) VALUES (
        v_sale_id, p_tenant_id, v_sale_number, v_order.customer_id,
        p_cashier_id, v_shift_id, 'completed', v_subtotal, v_discount,
        GREATEST(0, v_subtotal - v_discount), v_payment_method, false,
        COALESCE(v_order.manager_id, p_cashier_id),
        v_cash_amount + v_mixed_amount, v_card_amount, v_transfer_amount, v_is_fiscal,
        v_order.pickup_cell, NOW(), NOW(), NOW()
    );

    FOR v_item IN
        SELECT *
          FROM customer_order_items
         WHERE order_id = p_order_id
           AND item_status <> 'canceled'
         ORDER BY created_at
    LOOP
        SELECT id, is_service, purchase_price, requires_core_return, core_deposit_amount
          INTO v_product
          FROM products
         WHERE id = v_item.product_id
           AND tenant_id = p_tenant_id
           AND deleted_at IS NULL;

        INSERT INTO sale_items (
            tenant_id, sale_id, product_id, qty, unit_price, discount, total,
            cost_price, core_deposit_amount, core_return_status
        ) VALUES (
            p_tenant_id, v_sale_id, v_item.product_id, v_item.qty,
            v_item.sell_price, 0,
            ROUND(
                (
                    v_item.sell_price
                    + COALESCE(
                        v_item.core_deposit_amount,
                        CASE WHEN v_product.requires_core_return
                             THEN v_product.core_deposit_amount ELSE 0 END,
                        0
                    )
                ) * v_item.qty
            )::INTEGER,
            COALESCE(v_item.buy_price, v_product.purchase_price, 0),
            COALESCE(
                v_item.core_deposit_amount,
                CASE WHEN v_product.requires_core_return
                     THEN v_product.core_deposit_amount ELSE 0 END,
                0
            ),
            CASE
                WHEN COALESCE(
                    v_item.core_deposit_amount,
                    CASE WHEN v_product.requires_core_return
                         THEN v_product.core_deposit_amount ELSE 0 END,
                    0
                ) > 0
                AND COALESCE(v_item.core_return_status, 'none') = 'none'
                THEN 'pending'
                ELSE COALESCE(v_item.core_return_status, 'none')
            END
        );

        IF NOT v_product.is_service THEN
            UPDATE products
               SET qty_on_hand = qty_on_hand - v_item.qty,
                   updated_at = NOW()
             WHERE id = v_item.product_id
               AND tenant_id = p_tenant_id;
        END IF;
    END LOOP;

    UPDATE inventory_reserves
       SET released_at = COALESCE(released_at, NOW())
     WHERE order_id = p_order_id
       AND tenant_id = p_tenant_id
       AND released_at IS NULL;

    UPDATE customer_order_items
       SET item_status = 'handed'
     WHERE order_id = p_order_id
       AND item_status NOT IN ('canceled', 'handed');

    UPDATE customer_orders
       SET status = 'completed',
           sale_id = v_sale_id,
           updated_at = NOW()
     WHERE id = p_order_id
       AND tenant_id = p_tenant_id;

    RETURN jsonb_build_object(
        'sale_id', v_sale_id,
        'sale_number', v_sale_number,
        'order_id', p_order_id,
        'replayed', false
    );
END;
$$;

NOTIFY pgrst, 'reload schema';
