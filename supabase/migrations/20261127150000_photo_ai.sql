-- «Пошук фото з ШІ» (слово власника 27.11.2026: функцію перенесено із сайту в програму).
-- Усі таблиці живуть лише в хмарі й доступні лише серверу (service role). Каса їх не зберігає:
-- у картку товару адресу фото ставить головний ПК звичайним шляхом, і вона їде на сайт звичайним обміном.
-- Таблиці малі, запис — по кілька рядків на товар: базу це не навантажує.

-- Налаштування й ключ пошуку. Ключ Serper.dev лежить зашифрованим (той самий спосіб, що й ключ помічника),
-- назовні не віддається ніколи; вставляє його власник. Фото перевіряє помічник програми (Claude Sonnet) своїм ключем.
CREATE TABLE IF NOT EXISTS public.photo_ai_settings (
  tenant_id            uuid PRIMARY KEY,
  serper_key_encrypted text CHECK (serper_key_encrypted IS NULL OR char_length(serper_key_encrypted) <= 1000),
  photos_per_product   integer NOT NULL DEFAULT 3 CHECK (photos_per_product BETWEEN 1 AND 5),
  require_white        boolean NOT NULL DEFAULT true,
  forbid_text          boolean NOT NULL DEFAULT true,
  min_size             integer NOT NULL DEFAULT 600 CHECK (min_size BETWEEN 200 AND 2000),
  night_only           boolean NOT NULL DEFAULT false,
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Партія масового пошуку: «на перевірку» (review) або «автоматично» (auto).
CREATE TABLE IF NOT EXISTS public.photo_ai_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  created_by   uuid,
  mode         text NOT NULL CHECK (mode IN ('review', 'auto')),
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopped', 'done')),
  stop_reason  text CHECK (stop_reason IS NULL OR char_length(stop_reason) <= 40),
  total        integer NOT NULL DEFAULT 0,
  done         integer NOT NULL DEFAULT 0,
  found        integer NOT NULL DEFAULT 0,
  serper_calls integer NOT NULL DEFAULT 0,
  ai_calls     integer NOT NULL DEFAULT 0,
  ai_usd       numeric(12,4) NOT NULL DEFAULT 0,
  retry_at     timestamptz,
  retries      integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_photo_ai_jobs_tenant ON public.photo_ai_jobs (tenant_id, created_at DESC);

-- Товари партії. Назву, артикул і бренд передає каса (вона головна): у хмарі про фото на касі не знають.
CREATE TABLE IF NOT EXISTS public.photo_ai_items (
  job_id     uuid NOT NULL REFERENCES public.photo_ai_jobs(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  position   integer NOT NULL,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 500),
  sku        text CHECK (sku IS NULL OR char_length(sku) <= 200),
  brand      text CHECK (brand IS NULL OR char_length(brand) <= 200),
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'found', 'none', 'failed')),
  note       text CHECK (note IS NULL OR char_length(note) <= 300),
  claimed_at timestamptz,
  done_at    timestamptz,
  PRIMARY KEY (job_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_photo_ai_items_queue ON public.photo_ai_items (job_id, state, position);

-- Памʼять: коли товар шукали й чи знайшли. Без підхожого фото товар не шукаємо знову 30 днів.
CREATE TABLE IF NOT EXISTS public.photo_ai_searches (
  tenant_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  searched_at timestamptz NOT NULL DEFAULT now(),
  found       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, product_id)
);

-- Знайдені й збережені у нашому сховищі фото. pending — чекає людини, approved — можна ставити в картку,
-- applied — стоїть у картці, rejected — відхилено, skipped — у картці вже було своє фото (його не чіпаємо).
CREATE TABLE IF NOT EXISTS public.photo_ai_finds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  job_id      uuid REFERENCES public.photo_ai_jobs(id) ON DELETE SET NULL,
  position    integer NOT NULL DEFAULT 0,
  url         text NOT NULL CHECK (char_length(url) <= 600),
  thumb_url   text NOT NULL CHECK (char_length(thumb_url) <= 600),
  source_url  text CHECK (source_url IS NULL OR char_length(source_url) <= 1500),
  source_page text CHECK (source_page IS NULL OR char_length(source_page) <= 1500),
  product_name text CHECK (product_name IS NULL OR char_length(product_name) <= 500),
  verdict     jsonb,
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'applied', 'rejected', 'skipped')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_photo_ai_finds_state ON public.photo_ai_finds (tenant_id, state, product_id, position);

-- Лічильник платних запитів за днями.
CREATE TABLE IF NOT EXISTS public.photo_ai_usage (
  tenant_id    uuid NOT NULL,
  day          date NOT NULL,
  serper_calls integer NOT NULL DEFAULT 0,
  ai_calls     integer NOT NULL DEFAULT 0,
  ai_usd       numeric(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE public.photo_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_ai_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_ai_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_ai_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_ai_finds    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_ai_usage    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.photo_ai_settings, public.photo_ai_jobs, public.photo_ai_items, public.photo_ai_searches, public.photo_ai_finds, public.photo_ai_usage
  FROM PUBLIC, anon, authenticated;
