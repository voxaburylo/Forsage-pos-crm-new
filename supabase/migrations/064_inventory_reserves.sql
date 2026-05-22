-- 064_inventory_reserves.sql
-- Резервування товарів та транзакційні статуси замовлень (Етап 3)

-- 1. Додаємо налаштування тривалості резерву в днях
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS reserve_duration_days INTEGER NOT NULL DEFAULT 3;

-- 2. Функція очищення прострочених резервів
CREATE OR REPLACE FUNCTION release_expired_reserves()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_released_count INTEGER;
BEGIN
    UPDATE inventory_reserves
    SET released_at = NOW()
    WHERE released_at IS NULL
      AND expires_at IS NOT NULL
      AND expires_at <= NOW();
      
    GET DIAGNOSTICS v_released_count = ROW_COUNT;
    RETURN v_released_count;
END;
$$;

-- 3. Функція резервування товарів замовлення
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

    -- Резервуємо товари зі складу (source_type = 'warehouse')
    FOR v_item IN 
        SELECT product_id, qty 
        FROM customer_order_items 
        WHERE order_id = p_order_id 
          AND source_type = 'warehouse' 
          AND product_id IS NOT NULL
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

-- 4. Функція оновлення статусу замовлення клієнта
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
    -- Отримуємо поточний статус з блокуванням рядка замовлення
    SELECT status INTO v_current_status FROM customer_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Замовлення не знайдено';
    END IF;

    IF v_current_status = p_status THEN
        RETURN (SELECT row_to_json(o)::jsonb FROM (SELECT * FROM customer_orders WHERE id = p_order_id) o);
    END IF;

    -- Отримуємо налаштування складу
    SELECT allow_negative_qty INTO v_allow_neg
    FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    v_allow_neg := COALESCE(v_allow_neg, true);

    -- ОБРОБКА ПЕРЕХОДІВ СТАТУСУ:
    
    -- А) Завершення замовлення (completed)
    IF p_status = 'completed' THEN
        -- Списуємо фізичні залишки товарів
        FOR v_item IN 
            SELECT product_id, qty 
            FROM customer_order_items 
            WHERE order_id = p_order_id 
              AND source_type = 'warehouse' 
              AND product_id IS NOT NULL
        LOOP
            SELECT qty_on_hand, name INTO v_qty_on_hand, v_product_name FROM products WHERE id = v_item.product_id FOR UPDATE;
            
            IF NOT FOUND THEN
                RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар не знайдено: %', v_item.product_id;
            END IF;

            IF v_qty_on_hand < v_item.qty AND NOT v_allow_neg THEN
                RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо фізичного залишку для завершення "%": є %, потрібно %', v_product_name, v_qty_on_hand, v_item.qty;
            END IF;

            UPDATE products
            SET qty_on_hand = qty_on_hand - v_item.qty,
                updated_at = NOW()
            WHERE id = v_item.product_id;
        END LOOP;

        -- Вивільняємо активні резерви цього замовлення
        UPDATE inventory_reserves SET released_at = NOW() WHERE order_id = p_order_id AND released_at IS NULL;
        
        -- Позначаємо всі товари виданими
        UPDATE customer_order_items SET item_status = 'handed' WHERE order_id = p_order_id;

    -- Б) Скасування (canceled) або повернення в ліди (lead)
    ELSIF p_status IN ('canceled', 'lead') THEN
        -- Вивільняємо активні резерви цього замовлення
        UPDATE inventory_reserves SET released_at = NOW() WHERE order_id = p_order_id AND released_at IS NULL;
        
        IF p_status = 'canceled' THEN
            UPDATE customer_order_items SET item_status = 'canceled' WHERE order_id = p_order_id;
        END IF;

    -- В) Вхід у статус з резервом (new, in_progress)
    ELSIF p_status IN ('new', 'in_progress') THEN
        -- Перераховуємо та бронюємо товари
        PERFORM reserve_order_items(p_tenant_id, p_order_id, p_user_id);
    END IF;

    -- Оновлюємо статус замовлення
    UPDATE customer_orders
    SET status = p_status,
        updated_at = NOW()
    WHERE id = p_order_id;

    RETURN (SELECT row_to_json(o)::jsonb FROM (SELECT * FROM customer_orders WHERE id = p_order_id) o);
END;
$$;

-- 5. Функція для ручного резервування
CREATE OR REPLACE FUNCTION create_manual_reserve(
    p_tenant_id     UUID,
    p_product_id    UUID,
    p_qty           NUMERIC,
    p_order_id      UUID,
    p_customer_id   UUID,
    p_expires_at    TIMESTAMPTZ,
    p_user_id       UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_reserve_id      UUID;
    v_qty_on_hand     NUMERIC;
    v_qty_reserved    NUMERIC;
    v_qty_available   NUMERIC;
    v_product_name    VARCHAR;
    v_allow_neg       BOOLEAN;
BEGIN
    -- Лочимо рядок товару
    SELECT qty_on_hand, name INTO v_qty_on_hand, v_product_name
    FROM products WHERE id = p_product_id AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар не знайдено';
    END IF;

    -- Отримуємо налаштування
    SELECT allow_negative_qty INTO v_allow_neg
    FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    v_allow_neg := COALESCE(v_allow_neg, true);

    -- Рахуємо резерви
    SELECT COALESCE(SUM(qty), 0) INTO v_qty_reserved
    FROM inventory_reserves
    WHERE product_id = p_product_id
      AND released_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW());

    v_qty_available := v_qty_on_hand - v_qty_reserved;

    IF v_qty_available < p_qty AND NOT v_allow_neg THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо доступного залишку для "%": є %, потрібно %', v_product_name, v_qty_available, p_qty;
    END IF;

    -- Створюємо резерв
    INSERT INTO inventory_reserves (tenant_id, product_id, order_id, customer_id, qty, reserved_by, expires_at)
    VALUES (p_tenant_id, p_product_id, p_order_id, p_customer_id, p_qty, p_user_id, p_expires_at)
    RETURNING id INTO v_reserve_id;

    RETURN (SELECT row_to_json(r)::jsonb FROM (SELECT * FROM inventory_reserves WHERE id = v_reserve_id) r);
END;
$$;
