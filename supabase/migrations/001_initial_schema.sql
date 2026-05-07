-- ============================================================
-- Форсаж CRM — начальная схема БД
-- Миграция 001: основные таблицы
-- ВАЖНО: деньги хранятся в копейках (INTEGER), никогда float
-- ============================================================

-- Расширения
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Бренды
CREATE TABLE brands (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  name       VARCHAR(200) NOT NULL,
  country    VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Категории товаров (иерархические)
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  parent_id   UUID REFERENCES categories(id),
  name        VARCHAR(200) NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Товары
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  sku             VARCHAR(50) NOT NULL,
  name            VARCHAR(500) NOT NULL,
  barcode         VARCHAR(100),
  brand_id        UUID REFERENCES brands(id),
  category_id     UUID REFERENCES categories(id),
  unit            VARCHAR(20) NOT NULL DEFAULT 'шт',
  purchase_price  INTEGER NOT NULL DEFAULT 0,      -- копейки
  retail_price    INTEGER NOT NULL DEFAULT 0,      -- копейки
  qty_on_hand     NUMERIC(12,3) NOT NULL DEFAULT 0,
  reorder_point   NUMERIC(12,3) NOT NULL DEFAULT 0,
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, sku)
);

CREATE INDEX idx_products_sku      ON products(tenant_id, sku) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_barcode  ON products(tenant_id, barcode) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_search   ON products USING gin(to_tsvector('simple', name || ' ' || sku));

-- Клиенты
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  phone         VARCHAR(20) NOT NULL,
  full_name     VARCHAR(200),
  email         VARCHAR(255),
  debt_balance  INTEGER NOT NULL DEFAULT 0,        -- копейки
  notes         TEXT,
  tags          TEXT[] DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, phone)
);

CREATE INDEX idx_customers_phone ON customers(tenant_id, phone) WHERE deleted_at IS NULL;

-- Автомобили клиентов
CREATE TABLE customer_vehicles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  brand        VARCHAR(100) NOT NULL,
  model        VARCHAR(100) NOT NULL,
  year         SMALLINT,
  vin          VARCHAR(17),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Поставщики
CREATE TABLE suppliers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  name         VARCHAR(300) NOT NULL,
  phone        VARCHAR(20),
  email        VARCHAR(255),
  contact_name VARCHAR(200),
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

-- Кассовые смены
CREATE TABLE shifts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  cashier_id     UUID NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','closed')),
  opening_cash   INTEGER NOT NULL DEFAULT 0,       -- копейки
  closing_cash   INTEGER,                          -- копейки
  expected_cash  INTEGER,                          -- копейки
  cash_variance  INTEGER,                          -- копейки
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shifts_cashier ON shifts(tenant_id, cashier_id, status);

-- Продажи (чеки)
CREATE TABLE sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  sale_number    VARCHAR(20) NOT NULL,
  customer_id    UUID REFERENCES customers(id),
  cashier_id     UUID NOT NULL,
  shift_id       UUID NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  status         VARCHAR(20) NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('draft','completed','returned')),
  subtotal       INTEGER NOT NULL DEFAULT 0,       -- копейки
  discount       INTEGER NOT NULL DEFAULT 0,       -- копейки
  total          INTEGER NOT NULL DEFAULT 0,       -- копейки
  payment_method VARCHAR(20) NOT NULL
                   CHECK (payment_method IN ('cash','card','debt','mixed')),
  is_debt        BOOLEAN NOT NULL DEFAULT false,
  notes          TEXT,
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sales_shift    ON sales(shift_id);
CREATE INDEX idx_sales_customer ON sales(tenant_id, customer_id);
CREATE INDEX idx_sales_date     ON sales(tenant_id, completed_at DESC);

-- Строки чека
CREATE TABLE sale_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  sale_id     UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty         NUMERIC(12,3) NOT NULL,
  unit_price  INTEGER NOT NULL,                    -- копейки (на момент продажи)
  discount    INTEGER NOT NULL DEFAULT 0,          -- копейки
  total       INTEGER NOT NULL,                    -- копейки
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- Возвраты
CREATE TABLE returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  sale_id        UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  customer_id    UUID REFERENCES customers(id),
  reason         VARCHAR(50) NOT NULL
                   CHECK (reason IN (
                     'defective','wrong_part','customer_changed_mind','other'
                   )),
  reason_text    TEXT,
  refund_amount  INTEGER NOT NULL,                 -- копейки
  refund_method  VARCHAR(20) NOT NULL
                   CHECK (refund_method IN ('cash','debt_reduction')),
  status         VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_by     UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Приходные накладные
CREATE TABLE supply_invoices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  supplier_id    UUID REFERENCES suppliers(id),
  invoice_number VARCHAR(100),
  status         VARCHAR(20) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','posted','cancelled')),
  total          INTEGER NOT NULL DEFAULT 0,       -- копейки
  notes          TEXT,
  posted_by      UUID,
  posted_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Строки приходной накладной
CREATE TABLE supply_invoice_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  invoice_id      UUID NOT NULL REFERENCES supply_invoices(id) ON DELETE RESTRICT,
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty             NUMERIC(12,3) NOT NULL,
  purchase_price  INTEGER NOT NULL,                -- копейки
  total           INTEGER NOT NULL,                -- копейки
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
