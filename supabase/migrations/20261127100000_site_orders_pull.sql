-- 27.11.2026: замовлення із сайту зберігаються в програмі. Сервер раз на хвилину забирає їх у сайту через шлюз
-- (orders.list), пише в site_orders (external_id = номер замовлення на сайті) і ставить касі команду створити звичайне
-- замовлення з джерелом 'site' — ЛИШЕ коли менеджер натисне «Створити замовлення в програмі» (рішення власника: сайт і
-- касу не змішувати автоматично). Скасовані на сайті теж зберігаються — з позначкою. Двічі те саме не записується
-- (UNIQUE (tenant_id, external_id) уже є).

-- 1. Що сайт каже про замовлення: статус, чи скасоване, коли створене на сайті, повна відповідь сайту.
ALTER TABLE public.site_orders
  ADD COLUMN IF NOT EXISTS site_status     text CHECK (site_status IS NULL OR char_length(site_status) <= 40),
  ADD COLUMN IF NOT EXISTS canceled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS site_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS raw             jsonb,
  ADD COLUMN IF NOT EXISTS program_order_id     uuid,
  ADD COLUMN IF NOT EXISTS program_order_number text CHECK (program_order_number IS NULL OR char_length(program_order_number) <= 40),
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();

-- Покупець на сайті міг лишити телефон у довільному вигляді або не лишити взагалі — замовлення все одно зберігаємо.
ALTER TABLE public.site_orders DROP CONSTRAINT IF EXISTS site_orders_customer_phone_check;
ALTER TABLE public.site_orders ADD CONSTRAINT site_orders_customer_phone_check CHECK (customer_phone ~ '^[0-9]{0,15}$');

-- 2. Звичайне замовлення з джерелом «сайт».
ALTER TABLE public.customer_orders DROP CONSTRAINT IF EXISTS customer_orders_source_check;
ALTER TABLE public.customer_orders ADD CONSTRAINT customer_orders_source_check
  CHECK (source IN ('walk_in', 'messenger', 'telegram_bot', 'mobile_draft', 'phone', 'site'));

-- 3. Для якого магазину забирати замовлення й від чийого імені ставити команди касі. Рядок зʼявляється сам, коли власник
--    відкриває розділ «Сайт»; тут же — час і помилка останнього проходу.
CREATE TABLE IF NOT EXISTS public.site_order_sync (
  tenant_id   uuid PRIMARY KEY,
  started_by  uuid NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.site_order_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_order_sync FROM PUBLIC, anon, authenticated;

-- 4. Команда касі: замовлення скасували на сайті вже після того, як каса його створила.
ALTER TABLE public.till_commands DROP CONSTRAINT IF EXISTS till_commands_command_check;
ALTER TABLE public.till_commands ADD CONSTRAINT till_commands_command_check
  CHECK (command IN ('product.update', 'shift.list', 'shift.close', 'order.save', 'invoice.draft', 'order.append', 'staff.secret', 'category.create', 'order.site_cancel'));
