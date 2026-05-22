-- 047_staff_pin_codes.sql
-- PIN-коди касирів для блокування екрану

-- Додаємо pin_code до auth.users user_metadata — це вже працює через admin API
-- Але для швидкого доступу додамо в окрему таблицю staff_pins
CREATE TABLE IF NOT EXISTS staff_pins (
  user_id    UUID PRIMARY KEY,
  pin_code   VARCHAR(4) NOT NULL DEFAULT '0000',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE staff_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff_pins_all" ON staff_pins FOR ALL USING (true);
