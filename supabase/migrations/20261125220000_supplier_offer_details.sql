-- Опис товарів постачальника (слово власника 25.11.2026: «усе, що можна витягнути по API, — витягуй»).
-- Омега /product/details віддає пачкою: OE-номери з моделлю авто, застосовність (дерево авто), характеристики.
-- Записує лише сервер; запити — через спільний лічильник (takeCall).
CREATE TABLE IF NOT EXISTS public.supplier_offer_details (
  tenant_id      uuid NOT NULL,
  connection_id  uuid NOT NULL REFERENCES public.supplier_api_connections(id) ON DELETE CASCADE,
  external_id    text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 80),
  oe_codes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  applicability  jsonb NOT NULL DEFAULT '[]'::jsonb,
  specifications jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_id)
);
ALTER TABLE public.supplier_offer_details ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_offer_details FROM PUBLIC, anon, authenticated;

-- OE-номери окремо — щоб шукати товар постачальника за оригінальним номером (як кроси).
CREATE TABLE IF NOT EXISTS public.supplier_offer_oe (
  tenant_id     uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.supplier_api_connections(id) ON DELETE CASCADE,
  external_id   text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 80),
  code          text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 120),
  code_key      text NOT NULL CHECK (char_length(code_key) BETWEEN 1 AND 120),
  car_model     text NOT NULL DEFAULT '' CHECK (char_length(car_model) <= 200),
  PRIMARY KEY (connection_id, external_id, code_key, car_model)
);
CREATE INDEX IF NOT EXISTS idx_supplier_offer_oe_code ON public.supplier_offer_oe (tenant_id, code_key);
ALTER TABLE public.supplier_offer_oe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_offer_oe FROM PUBLIC, anon, authenticated;

ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS details_checked_at timestamptz;
