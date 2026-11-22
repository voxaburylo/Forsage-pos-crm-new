-- 22.11.2026, рішення власника: PIN і пароль працівника можна змінити з вебу й тоді, коли головний ПК вимкнено.
-- Сервер кладе касі лише хеш (pbkdf2), каса застосує його, коли зʼявиться в мережі (до 7 днів).
ALTER TABLE public.till_commands DROP CONSTRAINT IF EXISTS till_commands_command_check;
ALTER TABLE public.till_commands ADD CONSTRAINT till_commands_command_check
  CHECK (command IN ('product.update', 'shift.list', 'shift.close', 'order.save', 'invoice.draft', 'order.append', 'staff.secret'));
