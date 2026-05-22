-- Категорії для кави/снеків
INSERT INTO categories (id, tenant_id, name, sort_order) VALUES
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Кава та напої', 900),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Снеки та хотдоги', 910)
ON CONFLICT (id) DO NOTHING;

-- Товари кави/напоїв
INSERT INTO products (tenant_id, sku, name, retail_price, purchase_price, qty_on_hand, unit, category_id,
  is_active)
SELECT
  '00000000-0000-0000-0000-000000000001',
  sku, name, price, cost, 999, 'шт',
  'a0000000-0000-0000-0000-000000000001',
  true
FROM (VALUES
  ('COF-001', 'Кава еспресо 50мл', 3000,  1500),
  ('COF-002', 'Кава американо 200мл', 4500, 2000),
  ('COF-003', 'Кава лате 300мл', 5500, 2500),
  ('COF-004', 'Кава капучино 300мл', 5500, 2500),
  ('COF-005', 'Чай чорний 200мл', 2500, 1000),
  ('COF-006', 'Чай зелений 200мл', 2500, 1000),
  ('COF-007', 'Какао 200мл', 4000, 2000)
) AS t(sku, name, price, cost)
WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = t.sku);

-- Товари снеків/хотдогів
INSERT INTO products (tenant_id, sku, name, retail_price, purchase_price, qty_on_hand, unit, category_id,
  is_active)
SELECT
  '00000000-0000-0000-0000-000000000001',
  sku, name, price, cost, 999, 'шт',
  'a0000000-0000-0000-0000-000000000002',
  true
FROM (VALUES
  ('SNK-001', 'Хотдог стандарт', 6500, 3500),
  ('SNK-002', 'Хотдог з сиром', 7500, 4000),
  ('SNK-003', 'Сендвіч з куркою', 7000, 4000),
  ('SNK-004', 'Вода 0.5л', 2500, 1200),
  ('SNK-005', 'Сік 0.2л', 3000, 1500),
  ('SNK-006', 'Печиво', 2000, 1000),
  ('SNK-007', 'Шоколадка', 3500, 2000)
) AS t(sku, name, price, cost)
WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = t.sku);
