-- Постачальник GPL (слово власника 25.11.2026: «ознайомся з іншим постачальником GPL… усе те саме: товари не
-- бʼються в базі й на касі, але доступні під замовлення; склади й уся інформація — менеджеру й на сайт»).
-- GPL входить логіном і паролем (а не ключем): сервер зберігає їх так само, як ключ Омеги, — лише в хмарі.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.supplier_api_connections'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%provider%' OR pg_get_constraintdef(oid) ILIKE '%api_key%')
  LOOP
    EXECUTE format('ALTER TABLE public.supplier_api_connections DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.supplier_api_connections ADD CONSTRAINT supplier_api_connections_provider_check CHECK (provider IN ('omega', 'gpl'));
ALTER TABLE public.supplier_api_connections ADD CONSTRAINT supplier_api_connections_api_key_check CHECK (char_length(api_key) BETWEEN 8 AND 600);
-- Що постачальник показав про себе (наприклад, назви цін у прайсі GPL і яку з них узято закупкою) — для власника.
ALTER TABLE public.supplier_api_connections ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Опис і категорія товару від постачальника (у GPL вони є прямо в прайсі).
ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS description text CHECK (description IS NULL OR char_length(description) <= 4000);
ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS category_name text CHECK (category_name IS NULL OR char_length(category_name) <= 200);
