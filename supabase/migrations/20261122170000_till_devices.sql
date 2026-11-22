-- 22.11.2026, «головний ПК — тимчасовий сервер магазину; сервер у хмарі — лише передавач».
-- Досі веб працював через головний ПК, лише поки в програмі хтось увійшов: увечері, після перезапуску
-- чи вимкнення світла зв'язок зникав до ранку. Тепер сам ПК має власний ключ зв'язку: програма забирає
-- запити вебу й на екрані входу. Права, як і раніше, перевіряє каса у своїй базі за працівником із вебу.
-- Тут зберігається лише хеш ключа; сам ключ знає тільки програма на касі (у захищеному сховищі Windows).

CREATE TABLE IF NOT EXISTS public.till_devices (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  token_hash text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  PRIMARY KEY (tenant_id, device_id)
);

-- Ключ шукається за пристроєм: один пристрій — один магазин.
CREATE UNIQUE INDEX IF NOT EXISTS idx_till_devices_device ON public.till_devices (device_id);

-- Лише сервер (service role) читає й пише; браузерам доступу немає.
ALTER TABLE public.till_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.till_devices FROM anon, authenticated;
