-- 23.11.2026: каса разом із «я на зв'язку» повідомляє стан своєї черги передачі на сервер.
-- Того дня 4 документи висіли з помилкою, і ніхто не знав (через це «не прив'язався» бот власника).
-- Сервер зберігає останній стан і попереджає власника в Telegram, якщо черга стоїть понад 30 хвилин.
ALTER TABLE public.till_presence
  ADD COLUMN IF NOT EXISTS outbox_waiting integer,
  ADD COLUMN IF NOT EXISTS outbox_oldest_at timestamptz,
  ADD COLUMN IF NOT EXISTS outbox_error text,
  ADD COLUMN IF NOT EXISTS outbox_reported_at timestamptz;
