-- Use product_id from import preview as the strongest match key.
-- This prevents duplicates when the preview matched an existing product by
-- additional barcode, fuzzy name, or another normalized identifier while SKU
-- from the new price list differs from the stored SKU.

CREATE OR REPLACE FUNCTION upsert_products_import_bulk(
    p_tenant_id      UUID,
    p_items          JSONB,
    p_mode           VARCHAR DEFAULT 'replace',
    p_update_retail  BOOLEAN DEFAULT true,
    p_create_missing BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    it            JSONB;
    v_id          UUID;
    v_product_id  UUID;
    v_existing    NUMERIC;
    v_deleted     BOOLEAN;
    v_sku         VARCHAR;
    v_barcode     VARCHAR;
    v_qty         NUMERIC;
    v_category_id UUID;
    v_created     INT := 0;
    v_updated     INT := 0;
    v_restored    INT := 0;
    v_skipped     INT := 0;
    v_errors      INT := 0;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      BEGIN
        v_product_id  := NULLIF(it->>'product_id', '')::uuid;
        v_sku         := it->>'sku';
        v_barcode     := NULLIF(it->>'barcode', '');
        v_qty         := COALESCE((it->>'qty_on_hand')::numeric, 0);
        v_category_id := NULLIF(it->>'category_id', '')::uuid;
        v_id := NULL; v_existing := NULL; v_deleted := false;

        IF v_product_id IS NOT NULL THEN
          SELECT id, qty_on_hand, (deleted_at IS NOT NULL)
            INTO v_id, v_existing, v_deleted
            FROM products
           WHERE tenant_id = p_tenant_id AND id = v_product_id
           LIMIT 1 FOR UPDATE;
        END IF;

        IF v_id IS NULL AND v_sku IS NOT NULL THEN
          SELECT id, qty_on_hand, (deleted_at IS NOT NULL)
            INTO v_id, v_existing, v_deleted
            FROM products
           WHERE tenant_id = p_tenant_id AND sku = v_sku
           LIMIT 1 FOR UPDATE;
        END IF;

        IF v_id IS NULL AND v_barcode IS NOT NULL THEN
          SELECT id, qty_on_hand, (deleted_at IS NOT NULL)
            INTO v_id, v_existing, v_deleted
            FROM products
           WHERE tenant_id = p_tenant_id AND barcode = v_barcode
           LIMIT 1 FOR UPDATE;
        END IF;

        IF v_id IS NOT NULL THEN
          UPDATE products SET
            name           = it->>'name',
            retail_price   = CASE WHEN p_update_retail THEN (it->>'retail_price')::int ELSE retail_price END,
            purchase_price = (it->>'purchase_price')::int,
            qty_on_hand    = CASE WHEN p_mode = 'add' AND NOT v_deleted
                                  THEN COALESCE(v_existing, 0) + v_qty ELSE v_qty END,
            unit           = COALESCE(NULLIF(it->>'unit',''), unit, 'шт'),
            storage_bin    = COALESCE(NULLIF(it->>'storage_bin',''), storage_bin),
            category_id    = COALESCE(v_category_id, category_id),
            barcode        = COALESCE(v_barcode, barcode),
            deleted_at     = NULL,
            is_active      = true,
            updated_at     = NOW()
          WHERE id = v_id;
          IF v_deleted THEN v_restored := v_restored + 1; ELSE v_updated := v_updated + 1; END IF;
        ELSIF p_create_missing THEN
          INSERT INTO products (
            tenant_id, sku, name, barcode, retail_price, purchase_price,
            qty_on_hand, unit, storage_bin, category_id, is_active
          )
          VALUES (
            p_tenant_id, v_sku, it->>'name', v_barcode,
            (it->>'retail_price')::int, (it->>'purchase_price')::int, v_qty,
            COALESCE(NULLIF(it->>'unit',''), 'шт'), NULLIF(it->>'storage_bin',''),
            v_category_id, true
          );
          v_created := v_created + 1;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_errors := v_errors + 1;
      END;
    END LOOP;

    RETURN jsonb_build_object(
      'created',  v_created,
      'updated',  v_updated,
      'restored', v_restored,
      'skipped',  v_skipped,
      'errors',   v_errors
    );
END;
$$;
