BEGIN;

-- Imported and AI-recognized articles can legitimately exceed the original
-- 50-character limit. A rejected product blocks every dependent local outbox
-- operation, so keep one consistent capacity across catalog and documents.
DROP VIEW IF EXISTS public.products_low_stock;

ALTER TABLE public.products
  ALTER COLUMN sku TYPE VARCHAR(200);

ALTER TABLE public.customer_order_items
  ALTER COLUMN sku TYPE VARCHAR(200);

ALTER TABLE public.supplier_price_items
  ALTER COLUMN sku TYPE VARCHAR(200);

CREATE VIEW public.products_low_stock
WITH (security_invoker = true)
AS
SELECT
  id,
  tenant_id,
  sku,
  name,
  barcode,
  brand_id,
  category_id,
  unit,
  purchase_price,
  retail_price,
  qty_on_hand,
  reorder_point,
  notes,
  is_active,
  created_at,
  updated_at,
  deleted_at,
  normalized_oem,
  normalized_supplier_article,
  wholesale_price,
  min_price,
  status,
  photo_url,
  oem_number,
  storage_bin,
  is_favorite,
  additional_barcodes,
  specs,
  is_service,
  requires_core_return,
  core_deposit_amount
FROM public.products
WHERE deleted_at IS NULL AND qty_on_hand <= reorder_point;

REVOKE ALL ON public.products_low_stock FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.products_low_stock TO service_role;

COMMIT;
