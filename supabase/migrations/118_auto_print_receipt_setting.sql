-- 118_auto_print_receipt_setting.sql
-- Авто-друк чека після продажу (перемикач у Налаштуваннях).
-- Ідемпотентно (IF NOT EXISTS) — безпечно застосовувати повторно.

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS auto_print_receipt BOOLEAN NOT NULL DEFAULT false;

-- PostgREST кешує схему — без перезавантаження нова колонка лишається "невидимою"
-- і update /api/v1/settings падає з "column not found".
NOTIFY pgrst, 'reload schema';
