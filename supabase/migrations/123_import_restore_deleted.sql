-- 123_import_restore_deleted.sql
-- Проблема: при імпорті каталогу товари «нічого не вносяться». Причина:
-- upsert_product_import шукав наявний товар лише серед НЕвидалених
-- (deleted_at IS NULL), не знаходив і робив INSERT. Але UNIQUE(tenant_id, sku)
-- враховує й видалені рядки — тому INSERT артикулу, що є серед soft-deleted,
-- падав з помилкою, і кожен рядок імпорту зараховувався як помилка.
--
-- Рішення: шукати товар НЕЗАЛЕЖНО від deleted_at і при збігу ВІДНОВЛЮВАТИ його
-- (deleted_at = NULL, is_active = true) + оновлювати дані. Так повторний імпорт
-- повертає раніше видалені товари в каталог, а не падає.
--
-- ДОДАТКОВО (окремий, старіший баг): існували ДВІ версії функції — на 10 і на
-- 11 аргументів. Сервер викликає з 10 параметрами (без p_category_id), тому
-- Postgres не міг однозначно обрати перевантаження -> "function ... is not
-- unique" -> КОЖЕН рядок імпорту падав, у каталог не додавалось нічого.
-- Прибираємо стару 10-аргументну версію, лишаємо єдину.

DROP FUNCTION IF EXISTS upsert_product_import(
    uuid, character varying, character varying, character varying,
    integer, integer, numeric, character varying, character varying, character varying
);

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
    p_mode            VARCHAR,
    p_category_id     UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_product_id      UUID;
    v_existing_qty    NUMERIC;
    v_was_deleted     BOOLEAN := false;
    v_new_qty         NUMERIC;
    v_is_new          BOOLEAN := false;
BEGIN
    -- Пошук за артикулом НЕЗАЛЕЖНО від deleted_at (щоб не конфліктувати з UNIQUE)
    SELECT id, qty_on_hand, (deleted_at IS NOT NULL)
      INTO v_product_id, v_existing_qty, v_was_deleted
    FROM products
    WHERE tenant_id = p_tenant_id AND sku = p_sku
    LIMIT 1
    FOR UPDATE;

    -- Якщо за артикулом не знайшли — пробуємо за штрихкодом
    IF NOT FOUND AND p_barcode IS NOT NULL THEN
        SELECT id, qty_on_hand, (deleted_at IS NOT NULL)
          INTO v_product_id, v_existing_qty, v_was_deleted
        FROM products
        WHERE tenant_id = p_tenant_id AND barcode = p_barcode
        LIMIT 1
        FOR UPDATE;
    END IF;

    IF FOUND THEN
        -- Кількість: у видаленого товару старий залишок не додаємо (починаємо з нового)
        IF p_mode = 'add' AND NOT v_was_deleted THEN
            v_new_qty := COALESCE(v_existing_qty, 0) + p_qty_on_hand;
        ELSE
            v_new_qty := p_qty_on_hand;
        END IF;

        UPDATE products
        SET name           = p_name,
            retail_price   = p_retail_price,
            purchase_price = p_purchase_price,
            qty_on_hand    = v_new_qty,
            unit           = p_unit,
            storage_bin    = p_storage_bin,
            category_id    = COALESCE(p_category_id, category_id),
            barcode        = COALESCE(p_barcode, barcode),
            deleted_at     = NULL,   -- відновлюємо, якщо був видалений
            is_active      = true,
            updated_at     = NOW()
        WHERE id = v_product_id;
    ELSE
        v_is_new := true;
        INSERT INTO products (tenant_id, sku, name, barcode, retail_price, purchase_price, qty_on_hand, unit, storage_bin, category_id, is_active)
        VALUES (p_tenant_id, p_sku, p_name, p_barcode, p_retail_price, p_purchase_price, p_qty_on_hand, p_unit, p_storage_bin, p_category_id, true)
        RETURNING id INTO v_product_id;
    END IF;

    RETURN jsonb_build_object(
        'id',       v_product_id,
        'is_new',   v_is_new,
        'restored', (v_was_deleted AND NOT v_is_new),
        'old_qty',  COALESCE(v_existing_qty, 0),
        'new_qty',  COALESCE(v_new_qty, p_qty_on_hand)
    );
END;
$$;
