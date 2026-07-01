-- 121_customer_phone_optional.sql
-- Дозволяємо клієнтів без телефону (реальні списки авто-магазину часто мають лише
-- імʼя + авто/VIN без контакту). UNIQUE(tenant_id, phone) лишається — у Postgres
-- кілька NULL-значень вважаються різними, тож багато безтелефонних клієнтів дозволені.
-- Ідемпотентно.

ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
