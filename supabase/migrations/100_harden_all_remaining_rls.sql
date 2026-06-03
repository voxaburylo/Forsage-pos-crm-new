-- 100_harden_all_remaining_rls.sql
-- Пересоздаем RLS политики с проверки USING (true) на строгую изоляцию тенэнтов

-- 1. Таблицы с колонкой tenant_id
-- messenger_channels
DROP POLICY IF EXISTS "messenger_channels_all" ON messenger_channels;
CREATE POLICY "messenger_channels_all" ON messenger_channels FOR ALL USING (tenant_id = app.user_tenant_id());

-- messenger_chats
DROP POLICY IF EXISTS "messenger_chats_all" ON messenger_chats;
CREATE POLICY "messenger_chats_all" ON messenger_chats FOR ALL USING (tenant_id = app.user_tenant_id());

-- bonus_transactions
DROP POLICY IF EXISTS "bonus_transactions_all" ON bonus_transactions;
CREATE POLICY "bonus_transactions_all" ON bonus_transactions FOR ALL USING (tenant_id = app.user_tenant_id());

-- inventory_sessions
DROP POLICY IF EXISTS "inventory_sessions_all" ON inventory_sessions;
CREATE POLICY "inventory_sessions_all" ON inventory_sessions FOR ALL USING (tenant_id = app.user_tenant_id());

-- expense_categories
DROP POLICY IF EXISTS "expense_categories_all" ON expense_categories;
CREATE POLICY "expense_categories_all" ON expense_categories FOR ALL USING (tenant_id = app.user_tenant_id());

-- product_waitlist
DROP POLICY IF EXISTS "product_waitlist_all" ON product_waitlist;
CREATE POLICY "product_waitlist_all" ON product_waitlist FOR ALL USING (tenant_id = app.user_tenant_id());

-- cash_reconciliations
DROP POLICY IF EXISTS "cash_reconciliations_all" ON cash_reconciliations;
CREATE POLICY "cash_reconciliations_all" ON cash_reconciliations FOR ALL USING (tenant_id = app.user_tenant_id());

-- customer_orders
DROP POLICY IF EXISTS "customer_orders_all" ON customer_orders;
CREATE POLICY "customer_orders_all" ON customer_orders FOR ALL USING (tenant_id = app.user_tenant_id());

-- customer_groups
DROP POLICY IF EXISTS "customer_groups_all" ON customer_groups;
CREATE POLICY "customer_groups_all" ON customer_groups FOR ALL USING (tenant_id = app.user_tenant_id());

-- salary_payments
DROP POLICY IF EXISTS "salary_payments_all" ON salary_payments;
CREATE POLICY "salary_payments_all" ON salary_payments FOR ALL USING (tenant_id = app.user_tenant_id());

-- internal_consumptions
DROP POLICY IF EXISTS "internal_consumptions_all" ON internal_consumptions;
CREATE POLICY "internal_consumptions_all" ON internal_consumptions FOR ALL USING (tenant_id = app.user_tenant_id());

-- commission_rules
DROP POLICY IF EXISTS "commission_rules_all" ON commission_rules;
CREATE POLICY "commission_rules_all" ON commission_rules FOR ALL USING (tenant_id = app.user_tenant_id());

-- supplier_price_imports
DROP POLICY IF EXISTS "supplier_price_imports_all" ON supplier_price_imports;
CREATE POLICY "supplier_price_imports_all" ON supplier_price_imports FOR ALL USING (tenant_id = app.user_tenant_id());

-- warehouse_movements
DROP POLICY IF EXISTS "warehouse_movements_all" ON warehouse_movements;
CREATE POLICY "warehouse_movements_all" ON warehouse_movements FOR ALL USING (tenant_id = app.user_tenant_id());

-- staff_kpi_targets
DROP POLICY IF EXISTS "staff_kpi_targets_all" ON staff_kpi_targets;
CREATE POLICY "staff_kpi_targets_all" ON staff_kpi_targets FOR ALL USING (tenant_id = app.user_tenant_id());

-- in_app_notifications
DROP POLICY IF EXISTS "in_app_notifications_all" ON in_app_notifications;
CREATE POLICY "in_app_notifications_all" ON in_app_notifications FOR ALL USING (tenant_id = app.user_tenant_id());

-- notification_templates
DROP POLICY IF EXISTS "notification_templates_all" ON notification_templates;
CREATE POLICY "notification_templates_all" ON notification_templates FOR ALL USING (tenant_id = app.user_tenant_id());

-- print_jobs
DROP POLICY IF EXISTS "print_jobs_all" ON print_jobs;
CREATE POLICY "print_jobs_all" ON print_jobs FOR ALL USING (tenant_id = app.user_tenant_id());

-- auto_purchase_rules
DROP POLICY IF EXISTS "auto_purchase_rules_all" ON auto_purchase_rules;
CREATE POLICY "auto_purchase_rules_all" ON auto_purchase_rules FOR ALL USING (tenant_id = app.user_tenant_id());

-- customer_notification_preferences
DROP POLICY IF EXISTS "customer_notification_preferences_all" ON customer_notification_preferences;
CREATE POLICY "customer_notification_preferences_all" ON customer_notification_preferences FOR ALL USING (tenant_id = app.user_tenant_id());


-- 2. Дочерние таблицы без tenant_id (изолируются через связи с родительскими таблицами)

-- messenger_messages
DROP POLICY IF EXISTS "messenger_messages_all" ON messenger_messages;
CREATE POLICY "messenger_messages_all" ON messenger_messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messenger_chats c 
    WHERE c.id = messenger_messages.chat_id AND c.tenant_id = app.user_tenant_id()
  )
);

-- inventory_items
DROP POLICY IF EXISTS "inventory_items_all" ON inventory_items;
CREATE POLICY "inventory_items_all" ON inventory_items FOR ALL USING (
  EXISTS (
    SELECT 1 FROM inventory_sessions s 
    WHERE s.id = inventory_items.session_id AND s.tenant_id = app.user_tenant_id()
  )
);

-- customer_order_items
DROP POLICY IF EXISTS "customer_order_items_all" ON customer_order_items;
CREATE POLICY "customer_order_items_all" ON customer_order_items FOR ALL USING (
  EXISTS (
    SELECT 1 FROM customer_orders o 
    WHERE o.id = customer_order_items.order_id AND o.tenant_id = app.user_tenant_id()
  )
);

-- order_activity_log
DROP POLICY IF EXISTS "order_activity_log_all" ON order_activity_log;
CREATE POLICY "order_activity_log_all" ON order_activity_log FOR ALL USING (
  EXISTS (
    SELECT 1 FROM customer_orders o 
    WHERE o.id = order_activity_log.order_id AND o.tenant_id = app.user_tenant_id()
  )
);

-- customer_group_members
DROP POLICY IF EXISTS "customer_group_members_all" ON customer_group_members;
CREATE POLICY "customer_group_members_all" ON customer_group_members FOR ALL USING (
  EXISTS (
    SELECT 1 FROM customer_groups g 
    WHERE g.id = customer_group_members.group_id AND g.tenant_id = app.user_tenant_id()
  )
);

-- product_cobuy
DROP POLICY IF EXISTS "product_cobuy_all" ON product_cobuy;
CREATE POLICY "product_cobuy_all" ON product_cobuy FOR ALL USING (
  EXISTS (
    SELECT 1 FROM products p 
    WHERE p.id = product_cobuy.product_id AND p.tenant_id = app.user_tenant_id()
  )
);
