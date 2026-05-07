# SPEC_DATABASE — ADDENDUM v2
# Нові таблиці для модулів доданих після першої версії

> Читати разом із SPEC_DATABASE.md.
> Цей файл містить ТІЛЬКИ нові таблиці яких немає в основному файлі.
> Конвенції ті самі: tenant_id скрізь, гроші INTEGER копійки, кількість NUMERIC(12,3), м'яке видалення через deleted_at.

---

## Зміни в існуючих таблицях

```sql
-- tenants: нові налаштування
ALTER TABLE tenants
  ADD COLUMN owner_pin VARCHAR(6),
  ADD COLUMN min_price_override_requires_pin BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN allow_negative_stock BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN negative_stock_requires_pin BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN dead_stock_threshold_days INT NOT NULL DEFAULT 90,
  ADD COLUMN loyalty_enabled BOOLEAN NOT NULL DEFAULT false;

-- customers: рівень цін, бонуси, ризик
ALTER TABLE customers
  ADD COLUMN price_tier_id UUID REFERENCES price_tiers(id),
  ADD COLUMN personal_discount_pct NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN bonus_balance_kopecks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN risk_note TEXT,
  ADD COLUMN risk_updated_at TIMESTAMPTZ,
  ADD COLUMN risk_updated_by UUID REFERENCES users(id),
  ADD COLUMN debt_limit_kopecks INTEGER DEFAULT 0;

-- products: нова схема цін + склад
ALTER TABLE products
  ADD COLUMN purchase_price_kopecks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN price_kopecks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN min_price_kopecks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN markup_pct NUMERIC(5,2),
  ADD COLUMN warehouse_location TEXT;

-- shifts: звірка каси
ALTER TABLE shifts
  ADD COLUMN expected_cash_kopecks INTEGER DEFAULT 0,
  ADD COLUMN actual_cash_kopecks INTEGER DEFAULT 0,
  ADD COLUMN cash_difference_note TEXT,
  ADD COLUMN cash_difference_confirmed_by UUID REFERENCES users(id);

-- suppliers: маппінг для парсера
ALTER TABLE suppliers ADD COLUMN import_column_map JSONB;

-- inventory_receipts: режим і зв'язок з імпортом
ALTER TABLE inventory_receipts
  ADD COLUMN import_session_id UUID REFERENCES import_sessions(id),
  ADD COLUMN receipt_mode TEXT DEFAULT 'standard';
```

---

## Нові таблиці: Ціноутворення

```sql
CREATE TABLE price_tiers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  UNIQUE(tenant_id, name)
);

CREATE TABLE volume_discounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  price_tier_id UUID REFERENCES price_tiers(id),
  product_id    UUID REFERENCES products(id),
  category_id   UUID REFERENCES categories(id),
  min_quantity  NUMERIC(12,3) NOT NULL,
  discount_pct  NUMERIC(5,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE category_markups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  category_id    UUID NOT NULL REFERENCES categories(id),
  markup_pct     NUMERIC(5,2) NOT NULL,
  min_markup_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, category_id)
);
```

---

## Нові таблиці: Журнал постачальників

```sql
CREATE TABLE supplier_purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  supplier_id    UUID NOT NULL REFERENCES suppliers(id),
  receipt_id     UUID REFERENCES inventory_receipts(id),
  invoice_number TEXT,
  invoice_date   DATE NOT NULL,
  total_kopecks  INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE TABLE supplier_purchase_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id),
  supplier_purchase_id UUID NOT NULL REFERENCES supplier_purchases(id),
  product_id           UUID REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  article_snapshot     TEXT,
  quantity             NUMERIC(12,3) NOT NULL,
  unit_price_kopecks   INTEGER NOT NULL,
  total_kopecks        INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  supplier_id    UUID NOT NULL REFERENCES suppliers(id),
  purchase_id    UUID REFERENCES supplier_purchases(id),
  return_date    DATE NOT NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  refund_kopecks INTEGER DEFAULT 0,
  note           TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE TABLE supplier_return_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  supplier_return_id UUID NOT NULL REFERENCES supplier_returns(id),
  product_id         UUID REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  quantity           NUMERIC(12,3) NOT NULL,
  unit_price_kopecks INTEGER NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_warranty_claims (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  supplier_id    UUID NOT NULL REFERENCES suppliers(id),
  product_id     UUID REFERENCES products(id),
  purchase_id    UUID REFERENCES supplier_purchases(id),
  customer_id    UUID REFERENCES customers(id),
  sale_id        UUID REFERENCES sales(id),
  claim_date     DATE NOT NULL,
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  resolution     TEXT,
  resolved_at    TIMESTAMPTZ,
  note           TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
```

---

## Нові таблиці: Імпорт накладної

```sql
CREATE TABLE import_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  supplier_id  UUID REFERENCES suppliers(id),
  source_type  TEXT NOT NULL, -- 'excel' / 'csv' / 'clipboard_text'
  raw_content  TEXT,
  total_rows   INT DEFAULT 0,
  matched_rows INT DEFAULT 0,
  fuzzy_rows   INT DEFAULT 0,
  new_rows     INT DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft / confirmed / cancelled
  receipt_id   UUID REFERENCES inventory_receipts(id),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE import_session_rows (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  import_session_id  UUID NOT NULL REFERENCES import_sessions(id),
  row_number         INT NOT NULL,
  raw_article        TEXT,
  raw_name           TEXT,
  raw_quantity       TEXT,
  raw_price          TEXT,
  normalized_article TEXT,
  quantity           NUMERIC(12,3),
  price_kopecks      INTEGER,
  match_type         TEXT, -- 'exact' / 'fuzzy' / 'new' / 'skipped'
  matched_product_id UUID REFERENCES products(id),
  confidence_score   NUMERIC(4,2),
  user_decision      TEXT, -- 'accepted' / 'rejected' / 'create_new'
  new_product_name   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_import_rows_session ON import_session_rows(import_session_id);
```

---

## Нові таблиці: Повернення від клієнта

```sql
CREATE TABLE customer_returns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  customer_id       UUID REFERENCES customers(id),
  sale_id           UUID REFERENCES sales(id),
  order_id          UUID REFERENCES orders(id),
  return_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  return_type       TEXT NOT NULL, -- 'refund' / 'exchange' / 'credit' / 'warranty_supplier'
  reason            TEXT NOT NULL, -- 'wrong_part' / 'defective' / 'changed_mind' / 'warranty'
  reason_note       TEXT,
  status            TEXT NOT NULL DEFAULT 'draft', -- draft / approved / rejected / completed
  refund_method     TEXT, -- 'cash' / 'terminal' / 'debt_reduction'
  refund_kopecks    INTEGER DEFAULT 0,
  stock_action      TEXT NOT NULL DEFAULT 'return_to_stock',
  -- 'return_to_stock' / 'write_off' / 'send_to_supplier'
  warranty_claim_id UUID REFERENCES supplier_warranty_claims(id),
  approved_by       UUID REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  note              TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE TABLE customer_return_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  return_id          UUID NOT NULL REFERENCES customer_returns(id),
  product_id         UUID NOT NULL REFERENCES products(id),
  sale_item_id       UUID REFERENCES sale_items(id),
  quantity           NUMERIC(12,3) NOT NULL,
  unit_price_kopecks INTEGER NOT NULL,
  total_kopecks      INTEGER NOT NULL,
  condition          TEXT NOT NULL DEFAULT 'good',
  -- 'good' / 'damaged' / 'opened_packaging' / 'defective'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_returns_customer ON customer_returns(customer_id) WHERE deleted_at IS NULL;
```

---

## Нові таблиці: Лояльність і нотатки

```sql
CREATE TABLE loyalty_settings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) UNIQUE,
  is_enabled           BOOLEAN NOT NULL DEFAULT false,
  accrual_pct          NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  max_redeem_pct       NUMERIC(5,2) NOT NULL DEFAULT 30.0,
  expiry_days          INT DEFAULT NULL,
  min_purchase_kopecks INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  customer_id    UUID NOT NULL REFERENCES customers(id),
  type           TEXT NOT NULL,
  -- 'accrual' / 'redemption' / 'expiry' / 'manual_add' / 'manual_sub'
  amount_kopecks INTEGER NOT NULL,
  sale_id        UUID REFERENCES sales(id),
  order_id       UUID REFERENCES orders(id),
  note           TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_loyalty_customer ON loyalty_transactions(customer_id, created_at DESC);

CREATE TABLE customer_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  text        TEXT NOT NULL,
  is_pinned   BOOLEAN NOT NULL DEFAULT false,
  color       TEXT DEFAULT 'yellow', -- 'yellow' / 'red' / 'green' / 'blue'
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_customer_notes ON customer_notes(customer_id) WHERE deleted_at IS NULL;
```

---

## Нові таблиці: Захист і лог

```sql
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  user_id     UUID REFERENCES users(id),
  user_name   TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   UUID,
  entity_label TEXT,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  INET,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_tenant_created ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);

CREATE TABLE product_not_duplicate_pairs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  product_a    UUID NOT NULL REFERENCES products(id),
  product_b    UUID NOT NULL REFERENCES products(id),
  confirmed_by UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, product_a, product_b)
);

CREATE TABLE notification_triggers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  event_type  TEXT NOT NULL,
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  delay_hours INT DEFAULT 0,
  template    TEXT NOT NULL,
  recipient   TEXT NOT NULL DEFAULT 'customer',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Зведення: всі зміни

| Що | Кількість |
|---|---|
| Нових таблиць | 18 |
| Змінених таблиць | 6 (tenants, customers, products, suppliers, shifts, inventory_receipts) |
| Нових індексів | 8 |
