-- Keep the shared barcode index in sync with products.barcode.
-- This makes every product creation/update path searchable through the same
-- product_barcodes table used by barcode search, desktop sync, and imports.

ALTER TABLE product_barcodes
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION sync_product_primary_barcode_index()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_indexed_product_id UUID;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.barcode IS NOT NULL
     AND OLD.barcode IS DISTINCT FROM NEW.barcode THEN
    DELETE FROM product_barcodes
     WHERE tenant_id = NEW.tenant_id
       AND product_id = NEW.id
       AND barcode = OLD.barcode
       AND is_primary = true;
  END IF;

  IF NEW.deleted_at IS NOT NULL OR NEW.is_active = false THEN
    DELETE FROM product_barcodes
     WHERE tenant_id = NEW.tenant_id
       AND product_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NULLIF(BTRIM(COALESCE(NEW.barcode, '')), '') IS NOT NULL THEN
    INSERT INTO product_barcodes (
      id, tenant_id, product_id, barcode, barcode_type, is_primary,
      created_at, updated_at, deleted_at
    ) VALUES (
      gen_random_uuid(), NEW.tenant_id, NEW.id, BTRIM(NEW.barcode), 'ean13', true,
      NOW(), NOW(), NULL
    )
    ON CONFLICT (tenant_id, barcode) DO UPDATE SET
      is_primary = true,
      updated_at = EXCLUDED.updated_at,
      deleted_at = NULL
    WHERE product_barcodes.product_id = EXCLUDED.product_id
    RETURNING product_id INTO v_indexed_product_id;

    IF v_indexed_product_id IS NULL THEN
      RAISE EXCEPTION 'BARCODE_ALREADY_EXISTS: Штрихкод % вже належить іншому товару', BTRIM(NEW.barcode);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_product_primary_barcode_index ON products;
CREATE TRIGGER trg_sync_product_primary_barcode_index
AFTER INSERT OR UPDATE OF barcode, deleted_at, is_active ON products
FOR EACH ROW
EXECUTE FUNCTION sync_product_primary_barcode_index();

-- Earlier development versions of the trigger soft-deleted rows. Production
-- lookup code also has legacy reads without a deleted_at filter, so remove
-- stale rows before rebuilding the canonical active index.
DELETE FROM product_barcodes
WHERE deleted_at IS NOT NULL;

DELETE FROM product_barcodes b
USING products p
WHERE b.tenant_id = p.tenant_id
  AND b.product_id = p.id
  AND (p.deleted_at IS NOT NULL OR p.is_active = false);

-- Do not leave a product unsearchable when legacy data contains a duplicate.
-- Fail the migration with a Ukrainian diagnostic so the conflict can be merged
-- deliberately instead of silently skipping one of the products.
DO $$
DECLARE
  v_conflict RECORD;
BEGIN
  SELECT tenant_id, BTRIM(barcode) AS barcode, ARRAY_AGG(id ORDER BY id) AS product_ids
    INTO v_conflict
    FROM products
   WHERE deleted_at IS NULL
     AND is_active = true
     AND NULLIF(BTRIM(COALESCE(barcode, '')), '') IS NOT NULL
   GROUP BY tenant_id, BTRIM(barcode)
  HAVING COUNT(DISTINCT id) > 1
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'BARCODE_ALREADY_EXISTS: Штрихкод % вказано у кількох товарах: %',
      v_conflict.barcode, ARRAY_TO_STRING(v_conflict.product_ids, ', ');
  END IF;

  SELECT p.tenant_id, BTRIM(p.barcode) AS barcode, p.id AS product_id, b.product_id AS indexed_product_id
    INTO v_conflict
    FROM products p
    JOIN product_barcodes b
      ON b.tenant_id = p.tenant_id
     AND b.barcode = BTRIM(p.barcode)
     AND b.product_id <> p.id
     AND b.deleted_at IS NULL
   WHERE p.deleted_at IS NULL
     AND p.is_active = true
     AND NULLIF(BTRIM(COALESCE(p.barcode, '')), '') IS NOT NULL
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'BARCODE_ALREADY_EXISTS: Штрихкод % товару % вже належить товару %',
      v_conflict.barcode, v_conflict.product_id, v_conflict.indexed_product_id;
  END IF;
END;
$$;

INSERT INTO product_barcodes (
  id, tenant_id, product_id, barcode, barcode_type, is_primary,
  created_at, updated_at, deleted_at
)
SELECT gen_random_uuid(), tenant_id, id, BTRIM(barcode), 'ean13', true,
       COALESCE(created_at, NOW()), NOW(), NULL
FROM products
WHERE deleted_at IS NULL
  AND is_active = true
  AND NULLIF(BTRIM(COALESCE(barcode, '')), '') IS NOT NULL
ON CONFLICT (tenant_id, barcode) DO UPDATE SET
  is_primary = true,
  updated_at = EXCLUDED.updated_at,
  deleted_at = NULL
WHERE product_barcodes.product_id = EXCLUDED.product_id;



