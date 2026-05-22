-- 1. Списание на внутренние нужды сотрудников
CREATE OR REPLACE FUNCTION process_internal_consumption(
    p_tenant_id     UUID,
    p_employee_id   UUID,
    p_employee_name VARCHAR,
    p_items         JSONB,
    p_total_cost    INTEGER,
    p_note          TEXT,
    p_created_by    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_consumption_id UUID;
    v_item          JSONB;
    v_product_id    UUID;
    v_qty           NUMERIC;
    v_current_qty   NUMERIC;
    v_allow_neg     BOOLEAN;
    v_name          VARCHAR;
BEGIN
    -- Получаем настройки разрешения ухода в минус
    SELECT allow_negative_qty INTO v_allow_neg
    FROM shop_settings
    WHERE tenant_id = p_tenant_id
    LIMIT 1;
    
    IF NOT FOUND THEN 
        v_allow_neg := true;
    END IF;

    -- Блокируем строки товаров и проверяем доступность остатков
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_product_id := (v_item->>'product_id')::UUID;
        v_qty := (v_item->>'qty')::NUMERIC;

        IF v_product_id IS NOT NULL THEN
            SELECT qty_on_hand, name INTO v_current_qty, v_name 
            FROM products
            WHERE id = v_product_id AND deleted_at IS NULL
            FOR UPDATE;

            IF NOT FOUND THEN 
                RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар з ID % не знайдено', v_product_id; 
            END IF;
            
            IF v_current_qty < v_qty AND NOT v_allow_neg THEN 
                RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо залишку для "%": є %, потрібно %', v_name, v_current_qty, v_qty; 
            END IF;
        END IF;
    END LOOP;

    -- Создаем запись расхода
    INSERT INTO internal_consumptions (tenant_id, employee_id, employee_name, items, total_cost, note, created_by)
    VALUES (p_tenant_id, p_employee_id, p_employee_name, p_items, p_total_cost, p_note, p_created_by)
    RETURNING id INTO v_consumption_id;

    -- Обновляем остатки товаров
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_product_id := (v_item->>'product_id')::UUID;
        v_qty := (v_item->>'qty')::NUMERIC;

        IF v_product_id IS NOT NULL THEN
            UPDATE products 
            SET qty_on_hand = GREATEST(0, qty_on_hand - v_qty),
                updated_at = NOW()
            WHERE id = v_product_id;
        END IF;
    END LOOP;

    RETURN (SELECT row_to_json(ic)::jsonb FROM (SELECT * FROM internal_consumptions WHERE id = v_consumption_id) ic);
END;
$$;


-- 2. Списание брака / Акты списания
CREATE OR REPLACE FUNCTION process_writeoff(
    p_tenant_id     UUID,
    p_reason        VARCHAR,
    p_notes         TEXT,
    p_created_by    UUID,
    p_items         JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_writeoff_id   UUID;
    v_item          JSONB;
    v_product_id    UUID;
    v_qty           NUMERIC;
    v_current_qty   NUMERIC;
    v_name          VARCHAR;
    v_price         INTEGER;
BEGIN
    -- Проверяем остатки с блокировкой строк
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_product_id := (v_item->>'product_id')::UUID;
        v_qty := (v_item->>'qty')::NUMERIC;

        SELECT qty_on_hand, name INTO v_current_qty, v_name FROM products
        WHERE id = v_product_id AND deleted_at IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар не знайдено: %', v_product_id;
        END IF;

        IF v_current_qty < v_qty THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо залишку для "%": є %, потрібно %', v_name, v_current_qty, v_qty;
        END IF;
    END LOOP;

    -- Создаем акт списания
    INSERT INTO inventory_writeoffs (tenant_id, reason, notes, created_by)
    VALUES (p_tenant_id, p_reason::VARCHAR(50), p_notes, p_created_by)
    RETURNING id INTO v_writeoff_id;

    -- Создаем позиции акта и списываем баланс
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_product_id := (v_item->>'product_id')::UUID;
        v_qty := (v_item->>'qty')::NUMERIC;

        SELECT purchase_price INTO v_price FROM products WHERE id = v_product_id;

        INSERT INTO inventory_writeoff_items (writeoff_id, product_id, qty, cost_kopecks)
        VALUES (v_writeoff_id, v_product_id, v_qty, ROUND(v_price * v_qty)::INTEGER);

        UPDATE products
        SET qty_on_hand = qty_on_hand - v_qty,
            updated_at = NOW()
        WHERE id = v_product_id;
    END LOOP;

    RETURN (SELECT row_to_json(w)::jsonb FROM (SELECT * FROM inventory_writeoffs WHERE id = v_writeoff_id) w);
END;
$$;


-- 3. Проведение приходной накладной
CREATE OR REPLACE FUNCTION post_supply_invoice(
    p_invoice_id   UUID,
    p_user_id      UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_status       VARCHAR;
    v_item         RECORD;
    v_qty_on_hand  NUMERIC;
    v_current_price INTEGER;
BEGIN
    -- Блокируем накладную
    SELECT status INTO v_status FROM supply_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Накладну не знайдено';
    END IF;
    IF v_status <> 'draft' THEN
        RAISE EXCEPTION 'INVOICE_ALREADY_POSTED: Накладну вже проведено';
    END IF;

    -- Обновляем статус
    UPDATE supply_invoices
    SET status = 'posted',
        posted_at = NOW(),
        posted_by = p_user_id,
        updated_at = NOW()
    WHERE id = p_invoice_id;

    -- Обновляем остатки и закупочные цены
    FOR v_item IN 
        SELECT product_id, qty, purchase_price 
        FROM supply_invoice_items 
        WHERE invoice_id = p_invoice_id
    LOOP
        SELECT qty_on_hand, purchase_price INTO v_qty_on_hand, v_current_price 
        FROM products WHERE id = v_item.product_id FOR UPDATE;

        IF FOUND THEN
            UPDATE products
            SET qty_on_hand = qty_on_hand + v_item.qty,
                purchase_price = v_item.purchase_price,
                updated_at = NOW()
            WHERE id = v_item.product_id;
        END IF;
    END LOOP;

    RETURN (SELECT row_to_json(i)::jsonb FROM (SELECT * FROM supply_invoices WHERE id = p_invoice_id) i);
END;
$$;


-- 4. Отмена приходной накладной
CREATE OR REPLACE FUNCTION cancel_supply_invoice(
    p_invoice_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_status       VARCHAR;
    v_item         RECORD;
    v_qty_on_hand  NUMERIC;
BEGIN
    -- Блокируем накладную
    SELECT status INTO v_status FROM supply_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Накладну не знайдено';
    END IF;
    IF v_status = 'cancelled' THEN
        RAISE EXCEPTION 'ALREADY_CANCELLED: Накладну вже скасовано';
    END IF;

    -- Откатываем остатки, если накладная была проведена
    IF v_status = 'posted' THEN
        FOR v_item IN 
            SELECT product_id, qty 
            FROM supply_invoice_items 
            WHERE invoice_id = p_invoice_id
        LOOP
            SELECT qty_on_hand INTO v_qty_on_hand 
            FROM products WHERE id = v_item.product_id FOR UPDATE;

            IF FOUND THEN
                UPDATE products
                SET qty_on_hand = GREATEST(0, qty_on_hand - v_item.qty),
                    updated_at = NOW()
                WHERE id = v_item.product_id;
            END IF;
        END LOOP;
    END IF;

    -- Обновляем статус
    UPDATE supply_invoices
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE id = p_invoice_id;

    RETURN (SELECT row_to_json(i)::jsonb FROM (SELECT * FROM supply_invoices WHERE id = p_invoice_id) i);
END;
$$;


-- 5. Атомарный импорт товара
CREATE OR REPLACE FUNCTION upsert_product_import(
    p_tenant_id       UUID,
    p_sku             VARCHAR,
    p_barcode         VARCHAR,
    p_name            VARCHAR,
    p_retail_price    INTEGER,
    p_purchase_price  INTEGER,
    p_qty_on_hand     NUMERIC,
    p_unit            VARCHAR,
    p_storage_bin     VARCHAR,
    p_mode            VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_product_id      UUID;
    v_existing_qty    NUMERIC;
    v_new_qty         NUMERIC;
    v_is_new          BOOLEAN := false;
BEGIN
    -- Блокируем строку товара по артикулу или штрих-коду
    SELECT id, qty_on_hand INTO v_product_id, v_existing_qty 
    FROM products
    WHERE tenant_id = p_tenant_id 
      AND (sku = p_sku OR (p_barcode IS NOT NULL AND barcode = p_barcode))
      AND deleted_at IS NULL
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        IF p_mode = 'add' THEN
            v_new_qty := v_existing_qty + p_qty_on_hand;
        ELSE
            v_new_qty := p_qty_on_hand;
        END IF;

        UPDATE products
        SET name = p_name,
            retail_price = p_retail_price,
            purchase_price = p_purchase_price,
            qty_on_hand = v_new_qty,
            unit = p_unit,
            storage_bin = p_storage_bin,
            updated_at = NOW()
        WHERE id = v_product_id;
    ELSE
        v_is_new := true;
        INSERT INTO products (tenant_id, sku, name, barcode, retail_price, purchase_price, qty_on_hand, unit, storage_bin)
        VALUES (p_tenant_id, p_sku, p_name, p_barcode, p_retail_price, p_purchase_price, p_qty_on_hand, p_unit, p_storage_bin)
        RETURNING id INTO v_product_id;
    END IF;

    RETURN jsonb_build_object(
        'id', v_product_id,
        'is_new', v_is_new,
        'old_qty', COALESCE(v_existing_qty, 0),
        'new_qty', COALESCE(v_new_qty, p_qty_on_hand)
    );
END;
$$;

NOTIFY pgrst, 'reload schema';
