-- 088: Розширені налаштування ПРРО (Кашалот) та термінала (ПриватБанк)

-- ПРРО
ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS prro_provider          TEXT NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS kashalot_license_key   TEXT,
  ADD COLUMN IF NOT EXISTS kashalot_pin           TEXT,
  ADD COLUMN IF NOT EXISTS kashalot_cashier_id    TEXT,
  ADD COLUMN IF NOT EXISTS kashalot_active_shift  TEXT;  -- ID відкритої зміни в Кашалоті

-- Банківський термінал
ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS terminal_provider      TEXT NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS privatbank_terminal_ip   TEXT DEFAULT '127.0.0.1',
  ADD COLUMN IF NOT EXISTS privatbank_terminal_port INTEGER DEFAULT 8082,
  ADD COLUMN IF NOT EXISTS privatbank_merchant_id   TEXT;
