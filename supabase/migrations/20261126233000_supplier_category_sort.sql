-- 26.11.2026, слово власника: «помічник має вміти сортувати по категоріях: товари, що прийшли по API й ще прийдуть, не
-- розсортовані, і на сайті вони невідомо як показуватимуться». У хмарі: без категорії 62 937 товарів постачальників.
-- Розкладка «за видом товару»: помічник один раз вирішує, до якої НАШОЇ категорії належить вид («свічка запалювання»,
-- категорія постачальника «Повітряні фільтри»), правило запамʼятовується — і всі такі товари, теперішні й майбутні,
-- лягають у категорію без нового запиту до ШІ. Нові обʼєкти лише програми; обʼєкти розробника сайту не зачіпаються.

-- 'ai' — категорію поставив помічник за правилом; 'ai_none' — помічник не певен, товар лишився без категорії (не питати знову);
-- 'ai_wait' — для виду потрібна НОВА категорія, товар чекає, поки каса її створить.
ALTER TABLE public.supplier_offers DROP CONSTRAINT IF EXISTS supplier_offers_category_source_check;
ALTER TABLE public.supplier_offers ADD CONSTRAINT supplier_offers_category_source_check
  CHECK (category_source IS NULL OR category_source IN ('auto', 'manual', 'ai', 'ai_none', 'ai_wait'));
CREATE INDEX IF NOT EXISTS idx_supplier_offers_unsorted ON public.supplier_offers (tenant_id, connection_id, external_id)
  WHERE category_id IS NULL AND category_source IS NULL;

-- Правило: вид товару → наша категорія (NULL — «не певен», такі товари лишаються без категорії).
CREATE TABLE IF NOT EXISTS public.supplier_category_rules (
  tenant_id   uuid NOT NULL,
  key         text NOT NULL CHECK (char_length(key) BETWEEN 3 AND 200),
  category_id uuid,
  sample      text CHECK (sample IS NULL OR char_length(sample) <= 300),
  -- Немає підхожої категорії: назва нової (new_final — уже зведена з іншими пропозиціями й замовлена касі).
  new_name    text CHECK (new_name IS NULL OR char_length(new_name) BETWEEN 3 AND 60),
  new_final   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Вимикач і підсумки розкладки для магазину.
CREATE TABLE IF NOT EXISTS public.supplier_category_sort (
  tenant_id  uuid PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT false,
  started_by uuid,
  cost_usd   numeric(12,4) NOT NULL DEFAULT 0,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.supplier_category_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_category_sort ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_category_rules, public.supplier_category_sort FROM PUBLIC, anon, authenticated;

-- Категорії — дані каси (головний ПК): нову категорію створює каса за командою сервера й сама передає її в хмару.
ALTER TABLE public.till_commands DROP CONSTRAINT IF EXISTS till_commands_command_check;
ALTER TABLE public.till_commands ADD CONSTRAINT till_commands_command_check
  CHECK (command IN ('product.update', 'shift.list', 'shift.close', 'order.save', 'invoice.draft', 'order.append', 'staff.secret', 'category.create'));
