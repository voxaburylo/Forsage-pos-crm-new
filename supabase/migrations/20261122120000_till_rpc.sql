-- 22.11.2026, рішення власника: «веб повний, але робота тільки через головний ПК».
-- Веб не пише в базу сервера сам: кожна дія — запит до головного ПК, який виконує її у своїй базі
-- тим самим кодом і правами працівника, що й ПК менеджера. Сервер лише передає запит і відповідь.
-- Без черги: запит, який каса не забрала за 30 с, не виконується ніколи (status = 'expired').

CREATE TABLE IF NOT EXISTS public.till_rpc (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel ~ '^desktop:[a-z0-9:-]{1,120}$'),
  args jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired')),
  result jsonb,
  error text,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_till_rpc_pending ON public.till_rpc (tenant_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_till_rpc_created ON public.till_rpc (created_at);

-- Лише сервер (service role) читає й пише; браузерам доступу немає.
ALTER TABLE public.till_rpc ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.till_rpc FROM anon, authenticated;
