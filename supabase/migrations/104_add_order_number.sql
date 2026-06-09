-- Migration 104: Людський порядковий номер замовлення (ORD-8)
-- Додає customer_orders.order_number — короткий зростаючий номер (#1043),
-- який легко продиктувати/знайти. Технічний UUID лишається в id.

-- 1. Послідовність номерів замовлень
CREATE SEQUENCE IF NOT EXISTS customer_order_number_seq;

-- 2. Колонка номера
ALTER TABLE customer_orders
    ADD COLUMN IF NOT EXISTS order_number BIGINT;

-- 3. Бекфіл існуючих замовлень за датою створення
WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
    FROM customer_orders
    WHERE order_number IS NULL
)
UPDATE customer_orders co
SET order_number = o.rn
FROM ordered o
WHERE co.id = o.id;

-- 4. Зсуваємо послідовність так, щоб наступний номер ішов після максимального
SELECT setval(
    'customer_order_number_seq',
    (SELECT COALESCE(MAX(order_number), 0) FROM customer_orders) + 1,
    false
);

-- 5. Автоприсвоєння номера новим замовленням
ALTER TABLE customer_orders
    ALTER COLUMN order_number SET DEFAULT nextval('customer_order_number_seq');

-- 6. Індекс для пошуку за номером
CREATE INDEX IF NOT EXISTS idx_cust_orders_number
    ON customer_orders(tenant_id, order_number);
