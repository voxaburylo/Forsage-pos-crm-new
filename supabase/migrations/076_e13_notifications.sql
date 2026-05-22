-- ============================================================
-- E-13: Multi-channel Notifications
-- in_app_notifications + notification_templates
-- ============================================================

-- 1. In-App сповіщення
CREATE TABLE IF NOT EXISTS in_app_notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    event_type  VARCHAR(100) NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    link        TEXT,
    is_read     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_in_app_notif_user ON in_app_notifications(tenant_id, user_id, is_read, created_at DESC);

ALTER TABLE in_app_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "in_app_notifications_all" ON in_app_notifications FOR ALL USING (true);

-- 2. Шаблони сповіщень
CREATE TABLE IF NOT EXISTS notification_templates (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    event_type     VARCHAR(100) NOT NULL,
    channel        VARCHAR(50) NOT NULL DEFAULT 'in_app',
    title_template TEXT NOT NULL DEFAULT '',
    body_template  TEXT NOT NULL DEFAULT '',
    is_active      BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, event_type, channel)
);

ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_templates_all" ON notification_templates FOR ALL USING (true);

-- 3. Seed: базові шаблони
INSERT INTO notification_templates (event_type, channel, title_template, body_template) VALUES
  ('order_ready',     'in_app', 'Замовлення готове',   'Замовлення {{order_id}} готове до видачі'),
  ('order_completed', 'in_app', 'Замовлення видано',   'Замовлення {{order_id}} успішно видано'),
  ('low_stock',       'in_app', 'Малий залишок',       'Товар {{product_name}} закінчується ({{qty}} шт)'),
  ('order_overdue',   'in_app', 'Прострочене замовлення', 'Замовлення {{order_id}} прострочено на {{days}} днів')
ON CONFLICT (tenant_id, event_type, channel) DO NOTHING;
