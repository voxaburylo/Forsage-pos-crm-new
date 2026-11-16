-- Помічник переходить з Gemini на Claude Sonnet 5.5 (рішення власника 16.11.2026: Gemini прибрати повністю).
-- Ключ Gemini з Anthropic не працює, тому збережений ключ очищається: власник вводить ключ Anthropic
-- у Налаштування → ШІ. Поле те саме (ai_api_key_encrypted, AES-256-GCM), клієнту не віддається.
UPDATE shop_settings
   SET ai_api_key_encrypted = NULL
 WHERE ai_model IS NULL OR ai_model NOT LIKE 'claude-%';
UPDATE shop_settings SET ai_model = 'claude-sonnet-5-5' WHERE ai_model IS DISTINCT FROM 'claude-sonnet-5-5';
ALTER TABLE shop_settings ALTER COLUMN ai_model SET DEFAULT 'claude-sonnet-5-5';
