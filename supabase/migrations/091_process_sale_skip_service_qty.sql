-- 091: process_sale_v2 і v3 — не списувати qty_on_hand для is_service=true товарів

CREATE OR REPLACE FUNCTION process_sale_v2(
    p_tenant_id         UUID,
    p_cashier_id        UUID,
    p_shift_id          UUID,
    p_items             JSONB,
    p_payment_method    VARCHAR(20),
    p_customer_id       UUID    DEFAULT NULL,
    p_discount          INTEGER DEFAULT 0,
    p_notes             TEXT    DEFAULT NULL,
    p_manager_id        UUID    DEFAULT NULL,
    p_cash_amount       INTEGER DEFAULT 0,
    p_card_amount       INTEGER DEFAULT 0
)
RETURNS JSONB LANGUAGE plpgsql AS $_$
#variable_conflict use_column
DECLARE
    v_sale_id       UUID;
    v_sale_number   VARCHAR(20);
    v_subtotal      INTEGER := 0;
    v_total         INTEGER := 0;
    v_item          JSONB;
    v_unit_price    INTEGER;
    v_qty           NUMERIC;
    v_item_discount INTEGER;
    v_qty_on_hand   NUMERIC;
    v_qty_reserved  NUMERIC;
    v_qty_available NUMERIC;
    v_cost_price    INTEGER;
    v_allow_neg     BOOLEAN;
    v_is_service    BOOLEAN;
BEGIN
    SELECT COALESCE(allow_negative_qty, true) INTO v_allow_neg
    FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    IF NOT FOUND THEN v_allow_neg := true; END IF;

    v_sale_number := LPAD(nextval('sale_number_seq')::TEXT, 6, '0');

    -- Прохід 1: перевірка qty_available (тільки для НЕ-сервісних)
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_unit_price    := (v_item->>'unit_price')::INTEGER;
        v_qty           := (v_item->>'qty')::NUMERIC;
        v_item_discount := COALESCE((v_item->>'discount')::INTEGER, 0);
        v_subtotal      := v_subtotal + (v_unit_price * v_qty::INTEGER);

        SELECT qty_on_hand, is_service INTO v_qty_on_hand, v_is_service
        FROM products
        WHERE id = (v_item->>'product_id')::UUID AND deleted_at IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар % не знайдено', (v_item->>'product_id')::TEXT;
        END IF;

        -- Сервісні товари (кава, снеки) — пропускаємо перевірку залишків
        IF NOT v_is_service THEN
            SELECT COALESCE(SUM(r.qty), 0) INTO v_qty_reserved
            FROM inventory_reserves r
            WHERE r.product_id = (v_item->>'product_id')::UUID
              AND r.released_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now());
            v_qty_available := v_qty_on_hand - v_qty_reserved;
            IF v_qty_available < v_qty AND NOT v_allow_neg THEN
                RAISE EXCEPTION 'INSUFFICIENT_STOCK: Наявно: %, в резерві: %, доступно: %, потрібно: %',
                    v_qty_on_hand, v_qty_reserved, v_qty_available, v_qty;
            END IF;
        END IF;
    END LOOP;

    v_total := GREATEST(0, v_subtotal - p_discount);

    INSERT INTO sales (tenant_id, sale_number, customer_id, cashier_id, shift_id,
        status, subtotal, discount, total, payment_method, is_debt, notes,
        manager_id, cash_amount, card_amount)
    VALUES (p_tenant_id, v_sale_number, p_customer_id, p_cashier_id, p_shift_id,
        'completed', v_subtotal, p_discount, v_total, p_payment_method,
        p_payment_method = 'debt', p_notes, COALESCE(p_manager_id, p_cashier_id),
        p_cash_amount, p_card_amount)
    RETURNING id INTO v_sale_id;

    -- Прохід 2: sale_items + декремент qty тільки для НЕ-сервісних
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_unit_price    := (v_item->>'unit_price')::INTEGER;
        v_qty           := (v_item->>'qty')::NUMERIC;
        v_item_discount := COALESCE((v_item->>'discount')::INTEGER, 0);

        SELECT COALESCE(purchase_price, 0), is_service INTO v_cost_price, v_is_service
        FROM products WHERE id = (v_item->>'product_id')::UUID;

        INSERT INTO sale_items (tenant_id, sale_id, product_id, qty, unit_price, discount, total, cost_price)
        VALUES (p_tenant_id, v_sale_id, (v_item->>'product_id')::UUID,
            v_qty, v_unit_price, v_item_discount,
            v_unit_price * v_qty::INTEGER - v_item_discount, v_cost_price);

        -- Тільки для звичайних товарів — списуємо залишок
        IF NOT v_is_service THEN
            UPDATE products SET qty_on_hand = qty_on_hand - v_qty, updated_at = NOW()
            WHERE id = (v_item->>'product_id')::UUID;
        END IF;
    END LOOP;

    IF p_payment_method = 'debt' AND p_customer_id IS NOT NULL THEN
        UPDATE customers SET debt_balance = debt_balance + v_total, updated_at = NOW()
        WHERE id = p_customer_id;
    END IF;

    RETURN (SELECT row_to_json(s)::jsonb FROM (SELECT * FROM sales WHERE id = v_sale_id) s);
END; $_$;
