-- ============================================================
-- E-6: COGS snapshot — cost_price у sale_items + profit RPC
-- ============================================================

-- 1. Додаємо cost_price до sale_items (snapshot ціни закупки на момент продажу)
ALTER TABLE sale_items
    ADD COLUMN IF NOT EXISTS cost_price INTEGER NOT NULL DEFAULT 0;

-- 2. Оновлюємо process_sale_v2 — знімаємо snapshot purchase_price при продажу
CREATE OR REPLACE FUNCTION process_sale_v2(
    p_tenant_id         UUID,
    p_cashier_id        UUID,
    p_shift_id          UUID,
    p_items             JSONB,
    p_payment_method    VARCHAR(20),
    p_customer_id       UUID DEFAULT NULL,
    p_discount          INTEGER DEFAULT 0,
    p_notes             TEXT DEFAULT NULL,
    p_manager_id        UUID DEFAULT NULL,
    p_cash_amount       INTEGER DEFAULT 0,
    p_card_amount       INTEGER DEFAULT 0
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
    v_cost_price     INTEGER;
    v_allow_neg      BOOLEAN;
BEGIN
    SELECT COALESCE(allow_negative_qty, true) INTO v_allow_neg
    FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    IF NOT FOUND THEN v_allow_neg := true; END IF;

    v_sale_number := LPAD(nextval('sale_number_seq')::TEXT, 6, '0');

    -- Прохід 1: перевірка qty_available
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

    v_total := GREATEST(0, v_subtotal - p_discount);

    INSERT INTO sales (
        tenant_id, sale_number, customer_id, cashier_id, shift_id,
        status, subtotal, discount, total, payment_method,
        is_debt, notes, manager_id, cash_amount, card_amount
    ) VALUES (
        p_tenant_id, v_sale_number, p_customer_id, p_cashier_id, p_shift_id,
        'completed', v_subtotal, p_discount, v_total, p_payment_method,
        p_payment_method = 'debt', p_notes,
        COALESCE(p_manager_id, p_cashier_id),
        p_cash_amount, p_card_amount
    )
    RETURNING id INTO v_sale_id;

    -- Прохід 2: вставка sale_items з cost_price snapshot + декремент qty
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_unit_price    := (v_item->>'unit_price')::INTEGER;
        v_qty           := (v_item->>'qty')::NUMERIC;
        v_item_discount := COALESCE((v_item->>'discount')::INTEGER, 0);

        -- Snapshot ціни закупки (COGS)
        SELECT COALESCE(purchase_price, 0) INTO v_cost_price
        FROM products WHERE id = (v_item->>'product_id')::UUID;

        INSERT INTO sale_items (tenant_id, sale_id, product_id, qty, unit_price, discount, total, cost_price)
        VALUES (
            p_tenant_id, v_sale_id,
            (v_item->>'product_id')::UUID,
            v_qty, v_unit_price, v_item_discount,
            v_unit_price * v_qty::INTEGER - v_item_discount,
            v_cost_price
        );

        UPDATE products
        SET qty_on_hand = qty_on_hand - v_qty, updated_at = NOW()
        WHERE id = (v_item->>'product_id')::UUID;
    END LOOP;

    IF p_payment_method = 'debt' AND p_customer_id IS NOT NULL THEN
        UPDATE customers
        SET debt_balance = debt_balance + v_total, updated_at = NOW()
        WHERE id = p_customer_id;
    END IF;

    RETURN (SELECT row_to_json(s)::jsonb FROM (SELECT * FROM sales WHERE id = v_sale_id) s);
END;
$_$;

-- 3. RPC звіту прибутку (для reportService)
CREATE OR REPLACE FUNCTION report_profit(
    p_tenant_id UUID,
    p_from      TIMESTAMPTZ,
    p_to        TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_revenue    BIGINT := 0;
    v_cogs       BIGINT := 0;
    v_expenses   BIGINT := 0;
BEGIN
    -- Виручка та собівартість зі sale_items (лише продажі з cost_price)
    SELECT
        COALESCE(SUM(si.total), 0),
        COALESCE(SUM(si.cost_price::BIGINT * si.qty::BIGINT), 0)
    INTO v_revenue, v_cogs
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE s.tenant_id = p_tenant_id
      AND s.status = 'completed'
      AND s.completed_at >= p_from
      AND s.completed_at < p_to;

    -- OPEX витрати з expense_categories
    SELECT COALESCE(SUM(amount), 0)
    INTO v_expenses
    FROM cash_operations
    WHERE tenant_id = p_tenant_id
      AND type = 'out'
      AND created_at >= p_from
      AND created_at < p_to
      AND note NOT ILIKE '%зарплата%'
      AND note NOT ILIKE '%виплата%';

    RETURN jsonb_build_object(
        'from',          p_from,
        'to',            p_to,
        'revenue',       v_revenue,
        'cogs',          v_cogs,
        'gross_margin',  v_revenue - v_cogs,
        'expenses',      v_expenses,
        'net_profit',    v_revenue - v_cogs - v_expenses
    );
END;
$$;
