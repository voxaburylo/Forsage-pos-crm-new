-- 21.11.2026 (прохання власника): закрити незакриту зміну з вебу, коли головна каса в мережі.
-- Веб ставить команду, каса сама читає відкриті зміни (shift.list) і закриває зміну у своїй базі (shift.close).
-- Сервер приймає ці команди лише від власника або адміністратора.
ALTER TABLE public.till_commands DROP CONSTRAINT IF EXISTS till_commands_command_check;
ALTER TABLE public.till_commands ADD CONSTRAINT till_commands_command_check
  CHECK (command IN ('product.update', 'shift.list', 'shift.close'));
