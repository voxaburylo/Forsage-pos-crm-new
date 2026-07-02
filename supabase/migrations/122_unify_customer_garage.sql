-- 122_unify_customer_garage.sql
-- Об'єднання двох «гаражів»: історично існували ДВІ таблиці авто клієнта —
-- customer_cars (пишуть Telegram-бот, AI-імпорт, роут /customer-cars) і
-- customer_vehicles (використовував фронт: форма замовлення, картка клієнта).
-- Через це авто, заведені ботом/ШІ, не було видно у формі замовлення.
-- Єдиним джерелом правди стає customer_cars; дані з customer_vehicles
-- переносимо (рядки з VIN, який уже є в customer_cars, пропускаємо — це той
-- самий автомобіль). Таблиця customer_vehicles лишається як страховка,
-- код на неї більше не посилається.

INSERT INTO customer_cars (tenant_id, customer_id, make, model, year, vin, notes, created_at)
SELECT v.tenant_id, v.customer_id, v.brand, v.model, v.year, v.vin, v.notes, v.created_at
FROM customer_vehicles v
WHERE v.vin IS NULL
   OR NOT EXISTS (SELECT 1 FROM customer_cars c WHERE c.vin = v.vin);
