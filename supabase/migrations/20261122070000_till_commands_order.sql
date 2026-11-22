-- 22.11.2026 (етап 8 плану замовлень): замовлення з вебу (телефон) через касу.
-- Веб ставить команду order.save, каса створює замовлення у своїй базі під тим самим номером операції.
-- Грошей у команді немає: передоплата, оплата й видача — тільки на касі.
ALTER TABLE public.till_commands DROP CONSTRAINT IF EXISTS till_commands_command_check;
ALTER TABLE public.till_commands ADD CONSTRAINT till_commands_command_check
  CHECK (command IN ('product.update', 'shift.list', 'shift.close', 'order.save'));
