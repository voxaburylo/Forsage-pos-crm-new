-- Migration 011: Індекси для системи каталогів та пошуку

-- Індекс для exact match по аліасах (використовується при пошуку по точному співпадінню)
-- Безпечно: тільки новий індекс, без змін таблиць або даних
CREATE INDEX IF NOT EXISTS idx_product_aliases_exact
  ON product_aliases(tenant_id, alias);

-- Індекс для пошуку по коду постачальника (supplier_code)
CREATE INDEX IF NOT EXISTS idx_supplier_codes_search
  ON product_supplier_codes(tenant_id, supplier_code);

-- Індекс для швидкого пошуку по VIN
CREATE INDEX IF NOT EXISTS idx_customer_vehicles_vin
  ON customer_vehicles(tenant_id, vin);

-- Коментарі до таблиць для документації
COMMENT ON TABLE product_aliases IS 'Псевдоніми товарів (народні назви, сленг, альтернативні найменування)';
COMMENT ON TABLE product_analogs IS 'Аналоги та замінники товарів (substitute, oem, cross)';
COMMENT ON TABLE product_fitment IS 'Сумісність товарів з авто (make, model, year, engine)';
COMMENT ON TABLE product_supplier_codes IS 'Коди товарів в системах постачальників';