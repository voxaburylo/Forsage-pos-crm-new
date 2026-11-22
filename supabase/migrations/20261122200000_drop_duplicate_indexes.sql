-- 22.11.2026: три пари однакових індексів (порадник Supabase, «Duplicate Index»). Визначення звірено в базі
-- перед видаленням — у кожній парі вони збігаються дослівно; лишаємо той, яким база справді користується.
-- Дані не змінюються; кожен запис у ці таблиці оновлюватиме на один індекс менше.

-- customer_cars (customer_id): лишається idx_customer_cars_customer (675 тис. звернень проти 0).
DROP INDEX IF EXISTS public.idx_customer_cars_cust_id;
-- loyalty_transactions (customer_id, created_at DESC): лишається idx_bonus_transactions_customer (207 проти 17).
DROP INDEX IF EXISTS public.idx_loyalty_customer;
-- supplier_payments (tenant_id, updated_at, id): лишається idx_sync_supplier_payments_tenant_updated_id (2730 проти 0).
DROP INDEX IF EXISTS public.idx_supplier_payments_tenant_updated;
