-- Додаткові поля для фіскалізації та термінала
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS fiscal_qr_url   TEXT,
  ADD COLUMN IF NOT EXISTS terminal_rrn    VARCHAR(50),
  ADD COLUMN IF NOT EXISTS pan_masked      VARCHAR(20);
