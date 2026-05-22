-- 039_additional_barcodes_and_merge.sql
-- Додаткові штрих-коди + RPC для злиття дублікатів

ALTER TABLE products ADD COLUMN IF NOT EXISTS additional_barcodes JSONB DEFAULT '[]'::jsonb;

-- RPC: атомарне злиття дублікатів товарів
CREATE OR REPLACE FUNCTION merge_products(
  p_primary_id      UUID,
  p_duplicate_id    UUID
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_primary      RECORD;
  v_duplicate    RECORD;
  v_additional   JSONB;
BEGIN
  -- Перевіряємо що обидва товари існують
  SELECT * INTO v_primary   FROM products WHERE id = p_primary_id   AND deleted_at IS NULL;
  SELECT * INTO v_duplicate FROM products WHERE id = p_duplicate_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 1. Переносимо sale_items
  UPDATE sale_items SET product_id = p_primary_id
  WHERE product_id = p_duplicate_id;

  -- 2. Переносимо return_items
  UPDATE return_items SET product_id = p_primary_id
  WHERE product_id = p_duplicate_id;

  -- 3. Сумуємо залишки
  UPDATE products SET
    qty_on_hand = v_primary.qty_on_hand + v_duplicate.qty_on_hand,
    updated_at  = NOW()
  WHERE id = p_primary_id;

  -- 4. Об'єднуємо штрих-коди
  v_additional := '[]'::jsonb;
  IF v_primary.barcode IS NOT NULL THEN
    -- Додаємо штрих-код дубліката як additional (якщо він відрізняється)
    IF v_duplicate.barcode IS NOT NULL AND v_duplicate.barcode <> v_primary.barcode THEN
      -- Збираємо існуючі additional + новий
      SELECT jsonb_agg(distinct val) INTO v_additional
      FROM (
        SELECT jsonb_array_elements_text(v_primary.additional_barcodes) AS val
        UNION
        SELECT v_duplicate.barcode
      ) sub;
    END IF;
  END IF;

  UPDATE products SET additional_barcodes = v_additional WHERE id = p_primary_id;

  -- 5. Soft-delete дубліката
  UPDATE products SET
    deleted_at    = NOW(),
    is_active     = false,
    sku           = sku || '_merged_' || p_primary_id::text,
    updated_at    = NOW()
  WHERE id = p_duplicate_id;

  -- Повертаємо оновлений основний товар
  RETURN (SELECT row_to_json(p)::jsonb FROM (SELECT * FROM products WHERE id = p_primary_id) p);
END;
$$;
