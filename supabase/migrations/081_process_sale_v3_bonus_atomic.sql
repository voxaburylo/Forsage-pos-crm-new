-- ============================================================
-- PL-02: process_sale_v3 — бонуси всередині транзакції
-- process_sale_v2 + атомарне списання/нарахування бонусів.
-- Якщо бонус-операція fail — весь продаж відкочується.
-- Вмикається через USE_BONUS_ATOMIC_SALE=true.
-- ============================================================

CREATE OR REPLACE FUNCTION process_sale_v3(
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
    p_card_amount       INTEGER DEFAULT 0,
    p_bonuses_spent     INTEGER DEFAULT 0,
    p_bonuses_earned    INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
AS $_$
DECLARE
    v_sale_id        UUID;
    v_sale_number    VARCHAR(20);
    v_subtotal       INTEGER := 0;
    v_total          INTEGER := 0;
    v_item           JSONB;
    v_unit_price     INTEGER;
    v_qty            NUMERIC;
    v_item_discount  INTEGER;
    v_qty_on_hand    NUMERIC;
    v_qty_reserved   NUMERIC;
    v_qty_available  NUMERIC;
    v_allow_neg      BOOLEAN;
    v_bonus_balance  INTEGER;
BEGIN
    -- Налаштування складу
    SELECT COALESCE(allow_negative_qty, true) INTO v_allow_neg
    FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    IF NOT FOUND THEN v_allow_neg := true; END IF;

    v_sale_number := LPAD(nextval('sale_number_seq')::TEXT, 6, '0');

    -- Прохід 1: перевірка qty_available (qty_on_hand - активні резерви)
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_unit_price    := (v_item->>'unit_price')::INTEGER;
        v_qty           := (v_item->>'qty')::NUMERIC;
        v_item_discount := COALESCE((v_item->>'discount')::INTEGER, 0);
        v_subtotal      := v_subtotal + (v_unit_price * v_qty::INTEGER);

        SELECT qty_on_hand INTO v_qty_on_hand
        FROM products
        WHERE id = (v_item->>'product_id')::UUID AND deleted_at IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар % не знайдено', (v_item->>'product_id')::TEXT;
        END IF;

        SELECT COALESCE(SUM(r.qty), 0) INTO v_qty_reserved
        FROM inventory_reserves r
        WHERE r.product_id = (v_item->>'product_id')::UUID
          AND r.released_at IS NULL
          AND (r.expires_at IS NULL OR r.expires_at > now());

        v_qty_available := v_qty_on_hand - v_qty_reserved;

        IF v_qty_available < v_qty AND NOT v_allow_neg THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо доступного залишку. Наявно: %, в резерві: %, доступно: %, потрібно: %',
                v_qty_on_hand, v_qty_reserved, v_qty_available, v_qty;
        END IF;
    END LOOP;

    -- Перевірка достатності бонусів ДО запису продажу
    IF p_bonuses_spent > 0 AND p_customer_id IS NOT NULL THEN
        SELECT COALESCE(bonus_balance, 0) INTO v_bonus_balance
        FROM customers WHERE id = p_customer_id FOR UPDATE;

        IF v_bonus_balance < p_bonuses_spent THEN
            RAISE EXCEPTION 'INSUFFICIENT_BONUS: Недостатньо бонусів. Є: %, потрібно: %',
                v_bonus_balance, p_bonuses_spent;
        END IF;
    END IF;

    v_total := GREATEST(0, v_subtotal - p_discount);

    -- Створення продажу
    INSERT INTO sales (
        tenant_id, sale_number, customer_id, cashier_id, shift_id,
        status, subtotal, discount, total, payment_method,
        is_debt, notes, manager_id, cash_amount, card_amount,
        bonuses_spent, bonuses_earned
    ) VALUES (
        p_tenant_id, v_sale_number, p_customer_id, p_cashier_id, p_shift_id,
        'completed', v_subtotal, p_discount, v_total, p_payment_method,
        p_payment_method = 'debt', p_notes,
        COALESCE(p_manager_id, p_cashier_id),
        p_cash_amount, p_card_amount,
        p_bonuses_spent, p_bonuses_earned
    )
    RETURNING id INTO v_sale_id;

    -- Прохід 2: вставка sale_items + декремент qty_on_hand
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_unit_price    := (v_item->>'unit_price')::INTEGER;
        v_qty           := (v_item->>'qty')::NUMERIC;
        v_item_discount := COALESCE((v_item->>'discount')::INTEGER, 0);

        INSERT INTO sale_items (tenant_id, sale_id, product_id, qty, unit_price, discount, total)
        VALUES (
            p_tenant_id, v_sale_id,
            (v_item->>'product_id')::UUID,
            v_qty, v_unit_price, v_item_discount,
            v_unit_price * v_qty::INTEGER - v_item_discount
        );

        UPDATE products
        SET qty_on_hand = qty_on_hand - v_qty, updated_at = NOW()
        WHERE id = (v_item->>'product_id')::UUID;
    END LOOP;

    -- Борг клієнта
    IF p_payment_method = 'debt' AND p_customer_id IS NOT NULL THEN
        UPDATE customers
        SET debt_balance = debt_balance + v_total, updated_at = NOW()
        WHERE id = p_customer_id;
    END IF;

    -- Атомарне списання бонусів (в тій же транзакції)
    IF p_bonuses_spent > 0 AND p_customer_id IS NOT NULL THEN
        UPDATE customers
        SET bonus_balance = bonus_balance - p_bonuses_spent
        WHERE id = p_customer_id;

        INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description)
        VALUES (p_tenant_id, p_customer_id, -p_bonuses_spent, 'spend', v_sale_id, 'Списано при покупці');
    END IF;

    -- Атомарне нарахування бонусів (в тій же транзакції)
    IF p_bonuses_earned > 0 AND p_customer_id IS NOT NULL THEN
        UPDATE customers
        SET bonus_balance = COALESCE(bonus_balance, 0) + p_bonuses_earned
        WHERE id = p_customer_id;

        INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description)
        VALUES (p_tenant_id, p_customer_id, p_bonuses_earned, 'earn', v_sale_id, 'Нараховано за покупку');
    END IF;

    RETURN (SELECT row_to_json(s)::jsonb FROM (SELECT * FROM sales WHERE id = v_sale_id) s);
END;
$_$;
