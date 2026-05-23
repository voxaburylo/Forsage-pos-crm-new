-- ============================================================
-- E-13: Customer Notification Preferences
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_notification_preferences (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    channel        VARCHAR(50) NOT NULL, -- 'telegram', 'sms'
    event_type     VARCHAR(100) NOT NULL, -- 'order_ready', 'order_completed', etc.
    is_enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, customer_id, channel, event_type)
);

CREATE INDEX idx_customer_notif_pref ON customer_notification_preferences(tenant_id, customer_id);

ALTER TABLE customer_notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_notification_preferences_all" ON customer_notification_preferences FOR ALL USING (true);
