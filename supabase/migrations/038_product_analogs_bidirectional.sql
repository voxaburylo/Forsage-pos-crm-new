-- 038_product_analogs_bidirectional.sql
-- Додаємо тригер для двостороннього зв'язку аналогів

-- Видаляємо старе UNIQUE обмеження (якщо було на (product_id, analog_product_id))
-- і створюємо нове з tenant_id
ALTER TABLE product_analogs DROP CONSTRAINT IF EXISTS product_analogs_pkey;
ALTER TABLE product_analogs DROP CONSTRAINT IF EXISTS product_analogs_product_id_analog_product_id_key;

-- Функція: при вставці аналога автоматично створює зворотний зв'язок
CREATE OR REPLACE FUNCTION auto_mirror_analog()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Якщо зворотного зв'язку ще немає — створюємо
  IF NOT EXISTS (
    SELECT 1 FROM product_analogs
    WHERE product_id = NEW.analog_product_id AND analog_product_id = NEW.product_id
  ) THEN
    INSERT INTO product_analogs (tenant_id, product_id, analog_product_id, analog_type, priority)
    VALUES (NEW.tenant_id, NEW.analog_product_id, NEW.product_id, NEW.analog_type, NEW.priority);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_auto_mirror_analog
  AFTER INSERT ON product_analogs
  FOR EACH ROW
  EXECUTE FUNCTION auto_mirror_analog();

-- Функція: при видаленні аналога видаляє і зворотний зв'язок
CREATE OR REPLACE FUNCTION auto_unmirror_analog()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM product_analogs
  WHERE product_id = OLD.analog_product_id AND analog_product_id = OLD.product_id;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER trg_auto_unmirror_analog
  AFTER DELETE ON product_analogs
  FOR EACH ROW
  EXECUTE FUNCTION auto_unmirror_analog();
