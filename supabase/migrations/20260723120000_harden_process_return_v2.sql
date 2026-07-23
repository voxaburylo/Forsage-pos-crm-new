-- Tenant-safe return processing. All mutable identifiers and prices are derived
-- from the original sale item; client values are integrity assertions only.
CREATE OR REPLACE FUNCTION process_return_v2(
    p_tenant_id         UUID,
    p_user_id           UUID,
    p_sale_id           UUID,
    p_reason            VARCHAR(50),
    p_refund_method     VARCHAR(20),
    p_items             JSONB,
    p_operation_id      UUID,
    p_customer_id       UUID DEFAULT NULL,
    p_reason_note       TEXT DEFAULT NULL,
    p_stock_action      VARCHAR(20) DEFAULT 'return_to_stock',
    p_fiscal_number     VARCHAR(128) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $return_v2$
DECLARE
    v_return_id          UUID;
    v_item               JSONB;
    v_sale_item_id       UUID;
    v_product_id         UUID;
    v_requested_product  UUID;
    v_unit_price         INTEGER;
    v_condition          TEXT;
    v_requested_qty      NUMERIC(12,3);
    v_original_qty       NUMERIC(12,3);
    v_already_returned   NUMERIC(12,3);
    v_already_refunded   INTEGER;
    v_total_refund       INTEGER := 0;
    v_line_refund        INTEGER;
    v_line_refundable    INTEGER;
    v_resolved_items     JSONB := '[]'::JSONB;
    v_sale_status        VARCHAR(20);
    v_sale_number        VARCHAR(20);
    v_sale_customer_id   UUID;
    v_sale_total         INTEGER;
    v_line_net_total     NUMERIC;
    v_core_total         NUMERIC;
    v_product_refund_pool INTEGER;
    v_product_name       TEXT;
    v_is_restricted      BOOLEAN;
    v_writeoff_id        UUID;
    v_total_items        BIGINT;
    v_fully_returned     BIGINT;
    v_balance_after      INTEGER;
    v_result             JSONB;
    v_existing_result    JSONB;
    v_idempotency_key    TEXT;
    v_request_fingerprint TEXT;
    v_canonical_items    JSONB;
    v_idempotency_status TEXT;
    v_idempotency_response JSONB;
    v_claimed            BOOLEAN;
BEGIN
    IF p_tenant_id IS NULL
       OR p_user_id IS NULL
       OR p_operation_id IS NULL
       OR p_sale_id IS NULL
       OR p_items IS NULL
       OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'INVALID_RETURN_ITEMS';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS e(item)
        GROUP BY e.item->>'sale_item_id'
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_ITEM';
    END IF;


    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'sale_item_id', e.item->>'sale_item_id',
                'product_id', e.item->>'product_id',
                'quantity', e.item->'quantity',
                'condition', COALESCE(e.item->>'condition', 'good')
            )
            ORDER BY e.item->>'sale_item_id'
        ),
        '[]'::JSONB
    )
      INTO v_canonical_items
    FROM jsonb_array_elements(p_items) AS e(item);

    v_request_fingerprint := md5(jsonb_build_object(
        'sale_id', p_sale_id,
        'reason', p_reason,
        'reason_note', p_reason_note,
        'refund_method', p_refund_method,
        'stock_action', p_stock_action,
        'customer_id', p_customer_id,
        'fiscal_number', p_fiscal_number,
        'items', v_canonical_items
    )::TEXT);
    v_idempotency_key := 'return:' || p_operation_id::TEXT;

    SELECT to_jsonb(r)
      INTO v_existing_result
    FROM returns r
    WHERE r.id = p_operation_id
      AND r.tenant_id = p_tenant_id;

    IF v_existing_result IS NOT NULL THEN
        IF v_existing_result->>'sale_id' IS DISTINCT FROM p_sale_id::TEXT
           OR v_existing_result->>'reason' IS DISTINCT FROM p_reason
           OR v_existing_result->>'refund_method' IS DISTINCT FROM p_refund_method
           OR v_existing_result->>'stock_action' IS DISTINCT FROM p_stock_action THEN
            RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
        END IF;
        RETURN v_existing_result || jsonb_build_object('_replayed', true);
    END IF;

    IF EXISTS (SELECT 1 FROM returns r WHERE r.id = p_operation_id) THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;

    INSERT INTO idempotency_keys (key, tenant_id, status, response)
    VALUES (
        v_idempotency_key,
        p_tenant_id,
        'processing',
        jsonb_build_object('kind', 'return', 'fingerprint', v_request_fingerprint)
    )
    ON CONFLICT (key, tenant_id) DO NOTHING
    RETURNING true INTO v_claimed;

    IF NOT COALESCE(v_claimed, false) THEN
        SELECT ik.status, ik.response
          INTO v_idempotency_status, v_idempotency_response
        FROM idempotency_keys ik
        WHERE ik.key = v_idempotency_key
          AND ik.tenant_id = p_tenant_id
        FOR UPDATE;

        IF v_idempotency_response->>'fingerprint' IS DISTINCT FROM v_request_fingerprint THEN
            RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
        END IF;
        IF v_idempotency_status = 'completed' AND v_idempotency_response ? 'result' THEN
            RETURN (v_idempotency_response->'result') || jsonb_build_object('_replayed', true);
        END IF;
        RAISE EXCEPTION 'RETURN_PROCESSING';
    END IF;


    SELECT s.status, s.sale_number, s.customer_id, s.total
      INTO v_sale_status, v_sale_number, v_sale_customer_id, v_sale_total
    FROM sales s
    WHERE s.id = p_sale_id
      AND s.tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SALE_NOT_FOUND';
    END IF;
    IF v_sale_status = 'returned' THEN
        RAISE EXCEPTION 'ALREADY_RETURNED';
    END IF;
    IF v_sale_status <> 'completed' THEN
        RAISE EXCEPTION 'SALE_NOT_COMPLETED';
    END IF;
    IF p_customer_id IS NOT NULL AND p_customer_id IS DISTINCT FROM v_sale_customer_id THEN
        RAISE EXCEPTION 'CUSTOMER_MISMATCH';
    END IF;
    IF p_refund_method IN ('debt_reduction', 'credit') AND v_sale_customer_id IS NULL THEN
        RAISE EXCEPTION 'CUSTOMER_REQUIRED';
    END IF;


    -- Звичайне повернення товару не повертає заставу за серцевину: вона має
    -- окремий життєвий цикл. Це виключає подвійне повернення вже виданої застави.
    SELECT COALESCE(SUM(
               GREATEST(
                   0::NUMERIC,
                   (si.unit_price::NUMERIC * si.qty) - COALESCE(si.discount, 0)
               )
           ), 0),
           COALESCE(SUM(
               GREATEST(0::NUMERIC, COALESCE(si.core_deposit_amount, 0)::NUMERIC * si.qty)
           ), 0)
      INTO v_line_net_total, v_core_total
    FROM sale_items si
    WHERE si.sale_id = p_sale_id
      AND si.tenant_id = p_tenant_id;

    IF v_sale_total IS NULL OR v_sale_total < 0 OR v_line_net_total < 0 THEN
        RAISE EXCEPTION 'INVALID_SALE_ITEM';
    END IF;

    v_product_refund_pool := LEAST(
        ROUND(v_line_net_total)::INTEGER,
        GREATEST(0, v_sale_total - ROUND(v_core_total)::INTEGER)
    );
    FOR v_item IN
        SELECT e.item
        FROM jsonb_array_elements(p_items) AS e(item)
        ORDER BY e.item->>'sale_item_id'
    LOOP
        BEGIN
            v_sale_item_id := (v_item->>'sale_item_id')::UUID;
            v_requested_qty := (v_item->>'quantity')::NUMERIC(12,3);
            v_requested_product := CASE
                WHEN NULLIF(v_item->>'product_id', '') IS NULL THEN NULL
                ELSE (v_item->>'product_id')::UUID
            END;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RAISE EXCEPTION 'INVALID_RETURN_ITEMS';
        END;

        IF v_requested_qty IS NULL
           OR v_requested_qty <= 0
           OR v_requested_qty::TEXT IN ('NaN', 'Infinity', '-Infinity') THEN
            RAISE EXCEPTION 'INVALID_RETURN_ITEMS';
        END IF;

        SELECT si.product_id,
               si.unit_price,
               si.qty,
               p.name,
               EXISTS (
                   SELECT 1
                   FROM categories c
                   WHERE c.id = p.category_id
                     AND c.tenant_id = p_tenant_id
                     AND c.name = 'Електроніка'
               )
          INTO v_product_id, v_unit_price, v_original_qty, v_product_name, v_is_restricted
        FROM sale_items si
        JOIN products p
          ON p.id = si.product_id
         AND p.tenant_id = p_tenant_id
        WHERE si.id = v_sale_item_id
          AND si.sale_id = p_sale_id
          AND si.tenant_id = p_tenant_id
        FOR UPDATE OF si;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'ITEM_NOT_FOUND';
        END IF;
        IF v_requested_product IS NOT NULL AND v_requested_product <> v_product_id THEN
            RAISE EXCEPTION 'PRODUCT_MISMATCH';
        END IF;
        IF v_unit_price IS NULL OR v_unit_price < 0 OR v_original_qty IS NULL OR v_original_qty <= 0 THEN
            RAISE EXCEPTION 'INVALID_SALE_ITEM';
        END IF;
        IF v_is_restricted THEN
            RAISE EXCEPTION 'CATEGORY_RESTRICTED';
        END IF;

        WITH line_weights AS (
            SELECT si.id,
                   GREATEST(
                       0::NUMERIC,
                       (si.unit_price::NUMERIC * si.qty) - COALESCE(si.discount, 0)
                   ) AS weight
            FROM sale_items si
            WHERE si.sale_id = p_sale_id
              AND si.tenant_id = p_tenant_id
        ),
        raw_allocations AS (
            SELECT lw.id,
                   CASE
                       WHEN v_line_net_total > 0
                       THEN (lw.weight * v_product_refund_pool) / v_line_net_total
                       ELSE 0::NUMERIC
                   END AS raw_amount
            FROM line_weights lw
        ),
        base_allocations AS (
            SELECT ra.id,
                   FLOOR(ra.raw_amount)::INTEGER AS base_amount,
                   ra.raw_amount - FLOOR(ra.raw_amount) AS fraction
            FROM raw_allocations ra
        ),
        ranked_allocations AS (
            SELECT ba.id,
                   ba.base_amount,
                   ROW_NUMBER() OVER (ORDER BY ba.fraction DESC, ba.id) AS remainder_rank,
                   SUM(ba.base_amount) OVER () AS base_sum
            FROM base_allocations ba
        )
        SELECT COALESCE(
                   ra.base_amount + CASE
                       WHEN ra.remainder_rank <= (v_product_refund_pool - ra.base_sum) THEN 1
                       ELSE 0
                   END,
                   0
               )
          INTO v_line_refundable
        FROM ranked_allocations ra
        WHERE ra.id = v_sale_item_id;

        SELECT COALESCE(SUM(ri.quantity), 0)::NUMERIC(12,3),
               COALESCE(SUM(ri.total_kopecks), 0)::INTEGER
          INTO v_already_returned, v_already_refunded
        FROM return_items ri
        JOIN returns r
          ON r.id = ri.return_id
         AND r.tenant_id = p_tenant_id
         AND r.sale_id = p_sale_id
        WHERE ri.sale_item_id = v_sale_item_id
          AND ri.tenant_id = p_tenant_id;

        IF v_already_returned < 0 OR v_already_refunded < 0 THEN
            RAISE EXCEPTION 'INVALID_SALE_ITEM';
        END IF;
        IF v_requested_qty > GREATEST(0, v_original_qty - v_already_returned) THEN
            RAISE EXCEPTION 'DUPLICATE_RETURN';
        END IF;

        v_condition := COALESCE(v_item->>'condition', 'good');
        IF v_condition NOT IN ('good', 'damaged', 'opened_packaging', 'defective')
           OR p_stock_action NOT IN ('return_to_stock', 'write_off', 'send_to_supplier')
           OR (v_condition = 'defective' AND p_stock_action = 'return_to_stock') THEN
            RAISE EXCEPTION 'INVALID_STOCK_ACTION';
        END IF;

        IF v_requested_qty >= GREATEST(0, v_original_qty - v_already_returned) THEN
            v_line_refund := GREATEST(0, v_line_refundable - v_already_refunded);
        ELSE
            v_line_refund := LEAST(
                GREATEST(0, v_line_refundable - v_already_refunded),
                ROUND(v_line_refundable * v_requested_qty / v_original_qty)::INTEGER
            );
        END IF;

        v_total_refund := v_total_refund + v_line_refund;
        v_resolved_items := v_resolved_items || jsonb_build_array(jsonb_build_object(
            'sale_item_id', v_sale_item_id,
            'product_id', v_product_id,
            'quantity', v_requested_qty,
            'condition', v_condition,
            'unit_price', v_unit_price,
            'line_refund', v_line_refund
        ));
    END LOOP;

    INSERT INTO returns (
        id, tenant_id, sale_id, customer_id, return_type,
        reason, reason_note, refund_method, refund_kopecks,
        refund_amount, stock_action, fiscal_number, status, created_by, approved_by
    ) VALUES (
        p_operation_id, p_tenant_id, p_sale_id, v_sale_customer_id, 'refund',
        p_reason, p_reason_note, p_refund_method, v_total_refund,
        v_total_refund, p_stock_action, p_fiscal_number, 'completed', p_user_id, p_user_id
    ) RETURNING id INTO v_return_id;

    FOR v_item IN
        SELECT e.item
        FROM jsonb_array_elements(v_resolved_items) AS e(item)
        ORDER BY e.item->>'sale_item_id'
    LOOP
        v_sale_item_id := (v_item->>'sale_item_id')::UUID;
        v_product_id := (v_item->>'product_id')::UUID;
        v_requested_qty := (v_item->>'quantity')::NUMERIC(12,3);
        v_unit_price := (v_item->>'unit_price')::INTEGER;
        v_line_refund := (v_item->>'line_refund')::INTEGER;
        v_condition := v_item->>'condition';

        INSERT INTO return_items (
            tenant_id, return_id, product_id, sale_item_id,
            quantity, unit_price_kopecks, total_kopecks, condition
        ) VALUES (
            p_tenant_id, v_return_id, v_product_id, v_sale_item_id,
            v_requested_qty, v_unit_price,
            v_line_refund,
            v_condition
        );

        IF p_stock_action = 'return_to_stock' THEN
            UPDATE products
            SET qty_on_hand = qty_on_hand + v_requested_qty,
                updated_at = NOW()
            WHERE id = v_product_id
              AND tenant_id = p_tenant_id;
        END IF;
    END LOOP;

    IF p_stock_action = 'write_off' THEN
        INSERT INTO inventory_writeoffs (tenant_id, reason, notes, created_by)
        VALUES (
            p_tenant_id,
            'damage',
            'Списання при поверненні, чек #' || v_sale_number,
            p_user_id
        )
        RETURNING id INTO v_writeoff_id;

        INSERT INTO inventory_writeoff_items (writeoff_id, product_id, qty)
        SELECT v_writeoff_id,
               (e.item->>'product_id')::UUID,
               (e.item->>'quantity')::NUMERIC(12,3)
        FROM jsonb_array_elements(v_resolved_items) AS e(item);
    END IF;

    IF p_refund_method = 'debt_reduction' THEN
        UPDATE customers
        SET debt_balance = debt_balance - v_total_refund,
            updated_at = NOW()
        WHERE id = v_sale_customer_id
          AND tenant_id = p_tenant_id
          AND COALESCE(debt_balance, 0) >= v_total_refund
        RETURNING debt_balance INTO v_balance_after;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'INSUFFICIENT_DEBT';
        END IF;
    ELSIF p_refund_method = 'credit' THEN
        UPDATE customers
        SET deposit_balance = COALESCE(deposit_balance, 0) + v_total_refund,
            updated_at = NOW()
        WHERE id = v_sale_customer_id
          AND tenant_id = p_tenant_id
        RETURNING deposit_balance INTO v_balance_after;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'CUSTOMER_REQUIRED';
        END IF;

        IF v_total_refund > 0 THEN
            INSERT INTO customer_deposit_transactions (
                id, tenant_id, customer_id, amount, balance_after, method,
                sale_id, notes, created_by
            ) VALUES (
                v_return_id, p_tenant_id, v_sale_customer_id, v_total_refund,
                v_balance_after, 'return_credit', p_sale_id,
                'Повернення за чеком #' || v_sale_number, p_user_id
            );
        END IF;
    END IF;

    SELECT COUNT(*) INTO v_total_items
    FROM sale_items
    WHERE sale_id = p_sale_id
      AND tenant_id = p_tenant_id;

    SELECT COUNT(*) INTO v_fully_returned
    FROM (
        SELECT si.id
        FROM sale_items si
        LEFT JOIN return_items ri
          ON ri.sale_item_id = si.id
         AND ri.tenant_id = p_tenant_id
        WHERE si.sale_id = p_sale_id
          AND si.tenant_id = p_tenant_id
        GROUP BY si.id, si.qty
        HAVING COALESCE(SUM(ri.quantity), 0) >= si.qty
    ) fully;

    IF v_total_items > 0 AND v_fully_returned >= v_total_items THEN
        UPDATE sales
        SET status = 'returned', updated_at = NOW()
        WHERE id = p_sale_id
          AND tenant_id = p_tenant_id;
    END IF;

    SELECT to_jsonb(r)
      INTO v_result
    FROM returns r
    WHERE r.id = v_return_id
      AND r.tenant_id = p_tenant_id;

    IF v_result IS NULL THEN
        RAISE EXCEPTION 'RETURN_RESULT_MISSING';
    END IF;

    UPDATE idempotency_keys
    SET status = 'completed',
        response = jsonb_build_object(
            'kind', 'return',
            'fingerprint', v_request_fingerprint,
            'result', v_result
        )
    WHERE key = v_idempotency_key
      AND tenant_id = p_tenant_id;

    RETURN v_result || jsonb_build_object('_replayed', false);
END;
$return_v2$;

REVOKE ALL ON FUNCTION public.process_return_v2(
    UUID, UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, UUID, TEXT, VARCHAR, VARCHAR
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_return_v2(
    UUID, UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, UUID, TEXT, VARCHAR, VARCHAR
) TO service_role;

REVOKE ALL ON FUNCTION public.process_return_v2(
    UUID, UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, UUID, TEXT, VARCHAR, VARCHAR
) FROM anon, authenticated;

-- The legacy RPC accepted client product identifiers and must not remain a
-- direct API surface after the safe version is deployed.
REVOKE ALL ON FUNCTION public.process_return(
    UUID, UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, TEXT, VARCHAR
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_return(
    UUID, UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, TEXT, VARCHAR
) TO service_role;

NOTIFY pgrst, 'reload schema';
