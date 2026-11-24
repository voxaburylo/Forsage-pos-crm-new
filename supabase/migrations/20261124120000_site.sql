-- Сайт магазину (рішення власника 24.11.2026): сайт читає каталог із хмарної копії й передає замовлення в програму.
-- Усім керує власник у розділі «Сайт»: увімкнено чи ні, що показувати, ціни, прийом замовлень, тексти.
-- Сайт звертається до сервера зі своїм ключем; у базі зберігається лише відбиток ключа (sha256).
CREATE TABLE IF NOT EXISTS public.site_settings (
  tenant_id      uuid PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  api_key_hash   text UNIQUE CHECK (api_key_hash IS NULL OR api_key_hash ~ '^[a-f0-9]{64}$'),
  api_key_hint   text CHECK (api_key_hint IS NULL OR char_length(api_key_hint) <= 12),
  key_created_at timestamptz,
  -- Кому власник дав доступ до розділу «Сайт» (крім себе).
  access_user_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Замовлення, які прислав сайт. Гроші тут не рухаються: замовлення йде на касу командою order.save
-- (operation_id = id цього рядка), оплату приймає каса.
CREATE TABLE IF NOT EXISTS public.site_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  external_id    text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 64),
  customer_name  text NOT NULL CHECK (char_length(customer_name) <= 120),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^[0-9]{10,12}$'),
  delivery       text CHECK (delivery IS NULL OR char_length(delivery) <= 300),
  comment        text CHECK (comment IS NULL OR char_length(comment) <= 500),
  items          jsonb NOT NULL,
  total_amount   bigint NOT NULL CHECK (total_amount >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_site_orders_tenant ON public.site_orders (tenant_id, created_at DESC);
-- Сайт забирає зміни каталогу за часом оновлення картки.
CREATE INDEX IF NOT EXISTS idx_products_tenant_updated ON public.products (tenant_id, updated_at, id);

-- Доступ лише через сервер (service role); жодних прямих прав для anon/authenticated.
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.site_orders FROM PUBLIC, anon, authenticated;
