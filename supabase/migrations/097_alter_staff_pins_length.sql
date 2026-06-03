-- 097_alter_staff_pins_length.sql
-- Увеличиваем длину pin_code с VARCHAR(4) до VARCHAR(255) для хранения хешей
ALTER TABLE staff_pins ALTER COLUMN pin_code TYPE VARCHAR(255);
