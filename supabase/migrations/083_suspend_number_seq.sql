-- PL-15: Sequence для унікальних номерів відкладених чеків
-- Замість timestamp-base36 (не гарантує унікальність при навантаженні)

CREATE SEQUENCE IF NOT EXISTS suspend_number_seq
  START 1 INCREMENT 1 MINVALUE 1 NO MAXVALUE CACHE 1;

-- Функція генерації номера: S-000001, S-000002 ...
CREATE OR REPLACE FUNCTION next_suspend_number()
RETURNS TEXT
LANGUAGE sql
AS $$
  SELECT 'S-' || LPAD(nextval('suspend_number_seq')::TEXT, 6, '0');
$$;
