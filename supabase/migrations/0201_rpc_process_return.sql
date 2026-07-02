-- 020_rpc_process_return.sql
-- Атомарна транзакція повернення товару.
-- В одній транзакції: створення return + return_items + оновлення stock + debt + sale status.
-- Містить перевірку заборонених категорій (Електроніка).

CREATE OR REPLACE FUNCTION process_return(
    p_tenant_id         UUID,
    p_user_id           UUID,
    p_sale_id           UUID,
    p_reason            VARCHAR(50),
    p_refund_method     VARCHAR(20),
    p_items             JSONB,
    p_customer_id       UUID DEFAULT NULL,
    p_reason_note       TEXT DEFAULT NULL,
    p_stock_action      VARCHAR(20) DEFAULT 'return_to_stock'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $BODY$
DECLARE
    v_return_id         UUID;
    v_item              JSONB;
    v_unit_price        INTEGER;
    v_total_refund      INTEGER := 0;
    v_already_returned  INTEGER;
    v_orig_qty          NUMERIC(12,3);
    v_sale_status       VARCHAR(20);
    v_restricted_count  BIGINT;
    v_woff_id           UUID;
    v_full_count        BIGINT;
    v_total_items       BIGINT;
    v_sale_number       VARCHAR(20);
BEGIN
    -- ==================================================================
    -- 1. Отримуємо інформацію про продаж (з блокуванням рядка)
    -- ==================================================================
    SELECT s.status, s.sale_number INTO v_sale_status, v_sale_number
    FROM sales s WHERE s.id = p_sale_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SALE_NOT_FOUND';
    END IF;

    IF v_sale_status = 'returned' THEN
        RAISE EXCEPTION 'ALREADY_RETURNED';
    END IF;

    -- ==================================================================
    -- 2. Перевірка заборонених категорій
    -- ==================================================================
    SELECT COUNT(*) INTO v_restricted_count
    FROM jsonb_array_elements(p_items) AS j(item)
    JOIN products p ON p.id = (j.item->>'product_id')::UUID
    JOIN categories c ON c.id = p.category_id AND c.name = 'Електроніка';

    IF v_restricted_count > 0 THEN
        RAISE EXCEPTION 'CATEGORY_RESTRICTED';
    END IF;

    -- ==================================================================
    -- 3. Обчислюємо суму повернення та валідуємо дублікати
    --     Блокуємо рядки товарів FOR UPDATE щоб уникнути race condition
    -- ==================================================================
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        -- Ціна з моменту продажу + блокування позиції чека
        SELECT si.unit_price, si.qty INTO v_unit_price, v_orig_qty
        FROM sale_items si WHERE si.id = (v_item->>'sale_item_id')::UUID
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'ITEM_NOT_FOUND';
        END IF;

        -- Скільки вже повернуто
        SELECT COALESCE(SUM(ri.quantity), 0)::INTEGER INTO v_already_returned
        FROM return_items ri WHERE ri.sale_item_id = (v_item->>'sale_item_id')::UUID;

        IF (v_already_returned + (v_item->>'quantity')::INTEGER) > v_orig_qty THEN
            RAISE EXCEPTION 'DUPLICATE_RETURN';
        END IF;

        v_total_refund := v_total_refund + (v_unit_price * (v_item->>'quantity')::INTEGER);
    END LOOP;

    -- ==================================================================
    -- 4. Створюємо запис повернення
    -- ==================================================================
    INSERT INTO returns (
        tenant_id, sale_id, customer_id, return_type,
        reason, reason_note, refund_method, refund_kopecks,
        refund_amount, stock_action, status, approved_by
    ) VALUES (
        p_tenant_id, p_sale_id, p_customer_id, 'refund',
        p_reason, p_reason_note, p_refund_method, v_total_refund,
        v_total_refund, p_stock_action, 'completed', p_user_id
    ) RETURNING id INTO v_return_id;

    -- ==================================================================
    -- 5. Вставляємо return_items
    -- ==================================================================
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        SELECT si.unit_price INTO v_unit_price
        FROM sale_items si WHERE si.id = (v_item->>'sale_item_id')::UUID;

        INSERT INTO return_items (
            tenant_id, return_id, product_id, sale_item_id,
            quantity, unit_price_kopecks, total_kopecks, condition
        ) VALUES (
            p_tenant_id, v_return_id,
            (v_item->>'product_id')::UUID,
            (v_item->>'sale_item_id')::UUID,
            (v_item->>'quantity')::INTEGER,
            v_unit_price,
            v_unit_price * (v_item->>'quantity')::INTEGER,
            COALESCE(v_item->>'condition', 'good')
        );

        -- ==================================================================
        -- 5a. Оновлюємо залишок (return_to_stock)
        -- ==================================================================
        IF p_stock_action = 'return_to_stock' THEN
            UPDATE products SET
                qty_on_hand = qty_on_hand + (v_item->>'quantity')::NUMERIC,
                updated_at = NOW()
            WHERE id = (v_item->>'product_id')::UUID;
        END IF;
    END LOOP;

    -- ==================================================================
    -- 5b. Списання браку (write_off)
    -- ==================================================================
    IF p_stock_action = 'write_off' THEN
        INSERT INTO inventory_writeoffs (tenant_id, reason, notes, created_by)
        VALUES (
            p_tenant_id, 'damage',
            'Списання при поверненні, чек #' || v_sale_number,
            p_user_id
        )
        RETURNING id INTO v_woff_id;

        INSERT INTO inventory_writeoff_items (writeoff_id, product_id, qty)
        SELECT v_woff_id, (item->>'product_id')::UUID, (item->>'quantity')::INTEGER
        FROM jsonb_array_elements(p_items) AS item;
    END IF;

    -- ==================================================================
    -- 6. Зменшення боргу клієнта (debt_reduction)
    -- ==================================================================
    IF p_refund_method = 'debt_reduction' AND p_customer_id IS NOT NULL THEN
        UPDATE customers SET
            debt_balance = GREATEST(0, debt_balance - v_total_refund),
            updated_at = NOW()
        WHERE id = p_customer_id;
    END IF;

    -- ==================================================================
    -- 7. Перевіряємо чи всі позиції чека повернуті → status = 'returned'
    -- ==================================================================
    SELECT COUNT(*) INTO v_total_items
    FROM sale_items WHERE sale_id = p_sale_id;

    SELECT COUNT(*) INTO v_full_count FROM (
        SELECT si.id
        FROM sale_items si
        LEFT JOIN return_items ri ON ri.sale_item_id = si.id
        WHERE si.sale_id = p_sale_id
        GROUP BY si.id, si.qty
        HAVING COALESCE(SUM(ri.quantity), 0) >= si.qty
    ) fully;

    IF v_total_items > 0 AND v_full_count >= v_total_items THEN
        UPDATE sales SET status = 'returned', updated_at = NOW()
        WHERE id = p_sale_id;
    END IF;

    -- ==================================================================
    -- 8. Повертаємо створений запис
    -- ==================================================================
    RETURN (SELECT row_to_json(r)::jsonb FROM (
        SELECT * FROM returns WHERE id = v_return_id
    ) r);
END;
$BODY$;
