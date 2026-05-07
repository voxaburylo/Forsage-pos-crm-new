-- ============================================================
-- Форсаж CRM — расширенная схема БД
-- Миграция 003: таблицы из всех SPEC файлов
-- Деньги: INTEGER (копейки), qty: NUMERIC(12,3)
-- ============================================================

-- -------------------------------------------------------
-- ТОВАРЫ (расширение 001)
-- -------------------------------------------------------

-- Несколько штрихкодов на один товар
CREATE TABLE product_barcodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  barcode      VARCHAR(100) NOT NULL,
  barcode_type VARCHAR(20) NOT NULL DEFAULT 'ean13',
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, barcode)
);
CREATE INDEX idx_product_barcodes ON product_barcodes(tenant_id, barcode);

-- Псевдонимы товара (как сотрудники его называют)
CREATE TABLE product_aliases (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  alias      VARCHAR(300) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_aliases ON product_aliases USING gin(to_tsvector('simple', alias));

-- Система аналогов
CREATE TABLE product_analogs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  analog_product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  analog_type       VARCHAR(30) NOT NULL DEFAULT 'substitute',
  priority          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, analog_product_id)
);

-- Коды поставщиков на товар
CREATE TABLE product_supplier_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  supplier_id    UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_code  VARCHAR(100) NOT NULL,
  supplier_price INTEGER NOT NULL DEFAULT 0,   -- копейки
  lead_time_days INTEGER,
  is_preferred   BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- История изменения цен
CREATE TABLE product_price_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_type  VARCHAR(20) NOT NULL,              -- retail/purchase/wholesale/min
  old_price   INTEGER NOT NULL,                  -- копейки
  new_price   INTEGER NOT NULL,                  -- копейки
  changed_by  UUID NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_price_history_product ON product_price_history(product_id, created_at DESC);

-- Совместимость с автомобилями
CREATE TABLE product_fitment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  make        VARCHAR(100) NOT NULL,
  model       VARCHAR(100),
  year_from   SMALLINT,
  year_to     SMALLINT,
  engine_code VARCHAR(50),
  body_code   VARCHAR(50),
  source      VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fitment_vehicle ON product_fitment(tenant_id, make, model, year_from, year_to);

-- -------------------------------------------------------
-- СКЛАД (расширение 001)
-- -------------------------------------------------------

-- Приёмка товара
CREATE TABLE inventory_receipts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  receipt_number          VARCHAR(30) NOT NULL,
  supplier_id             UUID REFERENCES suppliers(id),
  supplier_invoice_number VARCHAR(100),
  supplier_invoice_date   DATE,
  status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','confirmed','cancelled')),
  total_amount            INTEGER NOT NULL DEFAULT 0,   -- копейки
  received_by             UUID NOT NULL,
  confirmed_at            TIMESTAMPTZ,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ
);

CREATE TABLE inventory_receipt_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  receipt_id     UUID NOT NULL REFERENCES inventory_receipts(id) ON DELETE RESTRICT,
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty            NUMERIC(12,3) NOT NULL,
  purchase_price INTEGER NOT NULL,   -- копейки
  total          INTEGER NOT NULL,   -- копейки
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Списание товара
CREATE TABLE inventory_writeoffs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty           NUMERIC(12,3) NOT NULL,
  reason        VARCHAR(30) NOT NULL
                  CHECK (reason IN ('damaged','expired','lost','defective','correction','other')),
  reason_note   TEXT,
  written_off_by UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Инвентаризация
CREATE TABLE inventory_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  session_name VARCHAR(200) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress','completed','cancelled')),
  started_by   UUID NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_session_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  session_id   UUID NOT NULL REFERENCES inventory_sessions(id) ON DELETE RESTRICT,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  expected_qty NUMERIC(12,3) NOT NULL,
  counted_qty  NUMERIC(12,3),
  variance     NUMERIC(12,3) GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  counted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Резервы товара под заказы
CREATE TABLE inventory_reserves (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id    UUID,
  customer_id UUID REFERENCES customers(id),
  qty         NUMERIC(12,3) NOT NULL,
  reserved_by UUID NOT NULL,
  expires_at  TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------
-- ЗАКАЗЫ (orders)
-- -------------------------------------------------------

CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  order_number     VARCHAR(30) NOT NULL,
  customer_id      UUID REFERENCES customers(id),
  manager_id       UUID NOT NULL,
  status           VARCHAR(30) NOT NULL DEFAULT 'draft'
                     CHECK (status IN (
                       'draft','quoted','prepaid','ordered_from_supplier',
                       'arrived','issued','completed','cancelled','lost'
                     )),
  source           VARCHAR(30) NOT NULL DEFAULT 'manual',
  quoted_total     INTEGER NOT NULL DEFAULT 0,         -- копейки
  prepayment_amount INTEGER NOT NULL DEFAULT 0,        -- копейки
  final_total      INTEGER NOT NULL DEFAULT 0,         -- копейки
  promised_date    DATE,
  is_overdue       BOOLEAN NOT NULL DEFAULT false,
  supplier_id      UUID REFERENCES suppliers(id),
  supplier_order_number VARCHAR(100),
  vehicle_id       UUID,
  vin              VARCHAR(17),
  cancel_reason    TEXT,
  lost_reason      VARCHAR(50),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX idx_orders_customer ON orders(tenant_id, customer_id);
CREATE INDEX idx_orders_status ON orders(tenant_id, status);

CREATE TABLE order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id       UUID REFERENCES products(id),
  custom_description TEXT,
  oem_number       VARCHAR(100),
  qty              NUMERIC(12,3) NOT NULL,
  quoted_price     INTEGER NOT NULL,    -- копейки
  purchase_price   INTEGER,             -- копейки (заполняется при поставке)
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_status_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  old_status VARCHAR(30),
  new_status VARCHAR(30) NOT NULL,
  changed_by UUID NOT NULL,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------
-- ЦЕНООБРАЗОВАНИЕ
-- -------------------------------------------------------

CREATE TABLE price_tiers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  name         VARCHAR(100) NOT NULL,
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE volume_discounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  price_tier_id UUID REFERENCES price_tiers(id),
  product_id    UUID REFERENCES products(id),
  category_id   UUID REFERENCES categories(id),
  min_quantity  NUMERIC(12,3) NOT NULL,
  discount_pct  NUMERIC(5,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE category_markups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  markup_pct  NUMERIC(5,2) NOT NULL,
  min_markup_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, category_id)
);

-- -------------------------------------------------------
-- ВОЗВРАТЫ (расширение 001)
-- -------------------------------------------------------

CREATE TABLE customer_returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  sale_id        UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  order_id       UUID REFERENCES orders(id),
  customer_id    UUID REFERENCES customers(id),
  return_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  return_type    VARCHAR(30) NOT NULL DEFAULT 'refund'
                   CHECK (return_type IN ('refund','exchange','credit','warranty_supplier')),
  reason         VARCHAR(30) NOT NULL
                   CHECK (reason IN ('wrong_part','defective','changed_mind','warranty','duplicate','other')),
  reason_note    TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'completed',
  refund_method  VARCHAR(20)
                   CHECK (refund_method IN ('cash','terminal','debt_reduction','credit')),
  refund_kopecks INTEGER NOT NULL DEFAULT 0,
  stock_action   VARCHAR(30) NOT NULL DEFAULT 'return_to_stock'
                   CHECK (stock_action IN ('return_to_stock','write_off','send_to_supplier')),
  warranty_claim_id UUID,
  approved_by    UUID NOT NULL,
  approved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_return_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  return_id        UUID NOT NULL REFERENCES customer_returns(id) ON DELETE RESTRICT,
  product_id       UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sale_item_id     UUID REFERENCES sale_items(id),
  quantity         NUMERIC(12,3) NOT NULL,
  unit_price_kopecks INTEGER NOT NULL,
  total_kopecks    INTEGER NOT NULL,
  condition        VARCHAR(30) NOT NULL DEFAULT 'good'
                     CHECK (condition IN ('good','damaged','opened_packaging','defective')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------
-- ЖУРНАЛ ПОСТАВЩИКОВ
-- -------------------------------------------------------

CREATE TABLE supplier_purchases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  supplier_id   UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  receipt_id    UUID REFERENCES inventory_receipts(id),
  invoice_number VARCHAR(100),
  invoice_date  DATE,
  total_kopecks INTEGER NOT NULL DEFAULT 0,
  created_by    UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_purchase_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id) ON DELETE RESTRICT,
  product_id           UUID REFERENCES products(id),
  product_name_snapshot VARCHAR(500) NOT NULL,
  article_snapshot     VARCHAR(100),
  quantity             NUMERIC(12,3) NOT NULL,
  unit_price_kopecks   INTEGER NOT NULL,
  total_kopecks        INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  supplier_id    UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_id    UUID REFERENCES supplier_purchases(id),
  return_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  reason         TEXT NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','accepted','rejected','refunded')),
  refund_kopecks INTEGER NOT NULL DEFAULT 0,
  created_by     UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_warranty_claims (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  product_id  UUID REFERENCES products(id),
  purchase_id UUID REFERENCES supplier_purchases(id),
  customer_id UUID REFERENCES customers(id),
  sale_id     UUID REFERENCES sales(id),
  claim_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','sent','waiting','resolved_replaced','resolved_refunded','resolved_denied')),
  resolution  TEXT,
  resolved_at TIMESTAMPTZ,
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------
-- ЛОЯЛЬНОСТЬ
-- -------------------------------------------------------

CREATE TABLE loyalty_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL UNIQUE,
  is_enabled      BOOLEAN NOT NULL DEFAULT false,
  accrual_pct     NUMERIC(5,2) NOT NULL DEFAULT 2,
  max_redeem_pct  NUMERIC(5,2) NOT NULL DEFAULT 30,
  expiry_days     INTEGER,
  min_purchase_kopecks INTEGER NOT NULL DEFAULT 10000,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  type           VARCHAR(20) NOT NULL CHECK (type IN ('accrual','redemption','expiry','correction')),
  amount_kopecks INTEGER NOT NULL,
  sale_id        UUID REFERENCES sales(id),
  order_id       UUID REFERENCES orders(id),
  note           TEXT,
  expires_at     TIMESTAMPTZ,
  created_by     UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_loyalty_customer ON loyalty_transactions(customer_id, created_at DESC);

-- -------------------------------------------------------
-- ЗАМЕТКИ КЛИЕНТОВ
-- -------------------------------------------------------

CREATE TABLE customer_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  text        TEXT NOT NULL,
  is_pinned   BOOLEAN NOT NULL DEFAULT false,
  color       VARCHAR(10) NOT NULL DEFAULT 'yellow'
                CHECK (color IN ('yellow','red','green','blue')),
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_notes ON customer_notes(customer_id, is_pinned DESC);

-- -------------------------------------------------------
-- AUDIT LOG
-- -------------------------------------------------------

CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  user_id     UUID NOT NULL,
  user_name   VARCHAR(200) NOT NULL,
  action      VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id   UUID,
  entity_label VARCHAR(300),
  old_value   JSONB,
  new_value   JSONB,
  ip_address  INET,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_entity ON audit_log(tenant_id, entity_type, entity_id);
CREATE INDEX idx_audit_log_user ON audit_log(tenant_id, user_id, created_at DESC);
CREATE INDEX idx_audit_log_date ON audit_log(tenant_id, created_at DESC);

-- -------------------------------------------------------
-- RLS для новых таблиц
-- -------------------------------------------------------

ALTER TABLE product_barcodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_barcodes_all" ON product_barcodes FOR ALL USING (true);

ALTER TABLE product_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_aliases_all" ON product_aliases FOR ALL USING (true);

ALTER TABLE product_analogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_analogs_all" ON product_analogs FOR ALL USING (true);

ALTER TABLE product_supplier_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_supplier_codes_all" ON product_supplier_codes FOR ALL USING (true);

ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_price_history_all" ON product_price_history FOR ALL USING (true);

ALTER TABLE product_fitment ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_fitment_all" ON product_fitment FOR ALL USING (true);

ALTER TABLE inventory_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_receipts_all" ON inventory_receipts FOR ALL USING (true);

ALTER TABLE inventory_receipt_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_receipt_items_all" ON inventory_receipt_items FOR ALL USING (true);

ALTER TABLE inventory_writeoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_writeoffs_all" ON inventory_writeoffs FOR ALL USING (true);

ALTER TABLE inventory_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_sessions_all" ON inventory_sessions FOR ALL USING (true);

ALTER TABLE inventory_session_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_session_items_all" ON inventory_session_items FOR ALL USING (true);

ALTER TABLE inventory_reserves ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_reserves_all" ON inventory_reserves FOR ALL USING (true);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders_all" ON orders FOR ALL USING (true);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_items_all" ON order_items FOR ALL USING (true);

ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_status_history_all" ON order_status_history FOR ALL USING (true);

ALTER TABLE price_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "price_tiers_all" ON price_tiers FOR ALL USING (true);

ALTER TABLE volume_discounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "volume_discounts_all" ON volume_discounts FOR ALL USING (true);

ALTER TABLE category_markups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "category_markups_all" ON category_markups FOR ALL USING (true);

ALTER TABLE customer_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_returns_all" ON customer_returns FOR ALL USING (true);

ALTER TABLE customer_return_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_return_items_all" ON customer_return_items FOR ALL USING (true);

ALTER TABLE supplier_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_purchases_all" ON supplier_purchases FOR ALL USING (true);

ALTER TABLE supplier_purchase_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_purchase_items_all" ON supplier_purchase_items FOR ALL USING (true);

ALTER TABLE supplier_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_returns_all" ON supplier_returns FOR ALL USING (true);

ALTER TABLE supplier_warranty_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_warranty_claims_all" ON supplier_warranty_claims FOR ALL USING (true);

ALTER TABLE loyalty_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_settings_all" ON loyalty_settings FOR ALL USING (true);

ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_transactions_all" ON loyalty_transactions FOR ALL USING (true);

ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_notes_all" ON customer_notes FOR ALL USING (true);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_all" ON audit_log FOR ALL USING (true);
