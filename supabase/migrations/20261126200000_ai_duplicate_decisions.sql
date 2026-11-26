-- 26.11.2026, слово власника: «пошук дублів знаходить повторно дублі, які ми вже виправили». Обʼєднані картки пошук
-- уже не бачить (deleted_at), а пари, про які власник вирішив «це не дублі» (відхилив пропозицію чи не відмітив сумнівну
-- пару), програма не памʼятала й пропонувала знову. Тут — ці рішення: пара карток (a < b), хто й коли вирішив.
CREATE TABLE IF NOT EXISTS public.ai_duplicate_decisions (
  tenant_id uuid NOT NULL,
  product_a uuid NOT NULL,
  product_b uuid NOT NULL,
  decision text NOT NULL DEFAULT 'distinct' CHECK (decision IN ('distinct')),
  decided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_a, product_b),
  CHECK (product_a < product_b)
);
-- Пише й читає лише сервер програми (обхід RLS); з браузера напряму — нічого.
ALTER TABLE public.ai_duplicate_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_duplicate_decisions FROM anon, authenticated;
