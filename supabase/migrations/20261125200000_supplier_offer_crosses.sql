-- Крос-номери (аналоги) товарів постачальника (слово власника 25.11.2026: «хочу використовувати крос-номери Омеги
-- в програмі для підбору аналогів — там велика база, і на сайті теж»). Омега віддає кроси одним запитом на товар
-- (/product/getAllCrosses), тому їх беремо на вимогу (шукають артикул) і заздалегідь — лише для наших карток.
-- Записує лише сервер; ліміт запитів спільний із прайсом і фото (takeCall).
CREATE TABLE IF NOT EXISTS public.supplier_offer_crosses (
  tenant_id        uuid NOT NULL,
  connection_id    uuid NOT NULL REFERENCES public.supplier_api_connections(id) ON DELETE CASCADE,
  external_id      text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 80),
  code             text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 120),
  code_key         text NOT NULL CHECK (char_length(code_key) BETWEEN 1 AND 120),
  brand            text NOT NULL DEFAULT '' CHECK (char_length(brand) <= 120),
  replacement_type text CHECK (replacement_type IS NULL OR char_length(replacement_type) <= 120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_id, code_key, brand)
);
-- Порожній бренд зберігається як '' (бренд — частина ключа).
CREATE INDEX IF NOT EXISTS idx_supplier_offer_crosses_code ON public.supplier_offer_crosses (tenant_id, code_key);
ALTER TABLE public.supplier_offer_crosses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_offer_crosses FROM PUBLIC, anon, authenticated;

-- Коли питали кроси в постачальника (null — ще не питали).
ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS crosses_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_supplier_offers_crosses_queue ON public.supplier_offers (connection_id)
  WHERE product_id IS NOT NULL AND crosses_checked_at IS NULL;
