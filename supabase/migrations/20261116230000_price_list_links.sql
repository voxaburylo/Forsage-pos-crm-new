-- Прайс для клієнта за посиланням (рішення власника 16.11.2026).
-- Посилання створюють у програмі на касі; клієнт бачить лише вибрані товари з ціною продажу
-- (зі знижкою посилання, але не нижче закупки) і наявністю. Закупка й залишки в штуках не показуються.
CREATE TABLE IF NOT EXISTS public.price_list_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  token        text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{32}$'),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  product_ids  uuid[] NOT NULL CHECK (cardinality(product_ids) BETWEEN 1 AND 500),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 50),
  show_stock   boolean NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_price_list_links_tenant ON public.price_list_links (tenant_id, created_at DESC);
-- Доступ лише через сервер (service role); жодних прямих прав для anon/authenticated.
ALTER TABLE public.price_list_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_list_links FROM PUBLIC, anon, authenticated;
