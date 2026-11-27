-- 27.11.2026: база вичерпала запас дискових операцій (Disk IO Budget) — сайт не міг забрати каталог (57014),
-- веб і каса чекали по 25–100 с на оновлення одного рядка. Ця міграція — лише додає; нічого не видаляє й не змінює даних.

-- 1. Вивантаження сайту (site_catalog_export) читає товари сторінками:
--    where (p.updated_at, p.id) > (p_since, p_after_id) order by p.updated_at, p.id limit N.
--    Обидва наявні індекси за updated_at починаються з tenant_id, а в запиті tenant_id немає — щоразу читалась і
--    сортувалась уся таблиця. З цим індексом сторінка — це N рядків з індексу. Саму функцію не змінюємо (її веде сайт).
CREATE INDEX IF NOT EXISTS idx_products_updated_id ON public.products (updated_at, id);

-- 2. «Бачили в прайсі» — окрема вузька таблиця. Раніше кожен прохід прайсу (Омега — кожні 3 год, 80 тис. товарів; GPL —
--    безперервно) переписував seen_at у КОЖНОМУ рядку supplier_offers, навіть коли товар не змінився; рядок широкий, на
--    таблиці 11 індексів (серед них пошуковий на 31 МБ) — це й зʼїдало диск. Тепер supplier_offers пишеться лише коли
--    товар справді змінився, а позначка «бачили в цьому проході» лягає сюди: один маленький рядок і один індекс.
--    fillfactor 50 — щоб оновлення позначки лишалось у тій самій сторінці й не чіпало індекс.
CREATE TABLE IF NOT EXISTS public.supplier_offer_seen (
  connection_id uuid NOT NULL REFERENCES public.supplier_api_connections(id) ON DELETE CASCADE,
  external_id   text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 80),
  seen_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_id)
) WITH (fillfactor = 50);
ALTER TABLE public.supplier_offer_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_offer_seen FROM PUBLIC, anon, authenticated;
