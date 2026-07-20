-- Keep the shared barcode index in sync with products.barcode.
-- This makes every product creation/update path searchable through the same
-- product_barcodes table used by barcode search, desktop sync, and imports.

CREATE OR REPLACE FUNCTION sync_product_primary_barcode_index()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.barcode IS NOT NULL
     AND OLD.barcode IS DISTINCT FROM NEW.barcode THEN
    UPDATE product_barcodes
       SET is_primary = false,
           deleted_at = COALESCE(deleted_at, NOW()),
           updated_at = NOW()
     WHERE tenant_id = NEW.tenant_id
       AND product_id = NEW.id
       AND barcode = OLD.barcode
       AND is_primary = true;
  END IF;

  IF NEW.deleted_at IS NOT NULL OR NEW.is_active = false THEN
    UPDATE product_barcodes
       SET deleted_at = COALESCE(NEW.deleted_at, NOW()),
           updated_at = NOW()
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
    WHERE product_barcodes.product_id = EXCLUDED.product_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_product_primary_barcode_index ON products;
CREATE TRIGGER trg_sync_product_primary_barcode_index
AFTER INSERT OR UPDATE OF barcode, deleted_at, is_active ON products
FOR EACH ROW
EXECUTE FUNCTION sync_product_primary_barcode_index();

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



