# DATABASE SPECIFICATION

## Supabase PostgreSQL Schema — Complete Reference

---

## CONVENTIONS

- All IDs: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- All tables: `tenant_id UUID NOT NULL REFERENCES tenants(id)`
- All tables: `created_at TIMESTAMPTZ DEFAULT now()`
- All tables: `updated_at TIMESTAMPTZ DEFAULT now()`
- All tables: `deleted_at TIMESTAMPTZ` (soft delete)
- Money: `INTEGER` (stored in kopecks, 1 UAH = 100 kopecks)
- Quantities: `NUMERIC(12,3)` (supports decimals for weight-based items)
- Enums: PostgreSQL native `CREATE TYPE ... AS ENUM`
- Text search: `tsvector` column + GIN index for searchable entities
- All foreign keys: `ON DELETE RESTRICT` (prevent accidental data loss)
- Timestamps: Always `TIMESTAMPTZ` (timezone-aware)

---

## CORE TABLES

### tenants

Multi-tenancy root. One row per business.

```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,       -- URL-safe identifier
  settings JSONB DEFAULT '{}',             -- tenant-level configuration
  subscription_plan VARCHAR(50) DEFAULT 'free',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### users

System users (staff who log in).

```sql
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  supabase_auth_id UUID UNIQUE,            -- link to Supabase Auth
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  full_name VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'cashier',
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  settings JSONB DEFAULT '{}',             -- user preferences
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, phone)
);

CREATE INDEX idx_users_tenant ON users(tenant_id) WHERE deleted_at IS NULL;
```

---

## CUSTOMER TABLES

### customers

```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  phone VARCHAR(20) NOT NULL,
  phone_secondary VARCHAR(20),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  company_name VARCHAR(255),               -- B2B
  tax_id VARCHAR(20),                      -- ЄДРПОУ for B2B
  customer_type VARCHAR(20) DEFAULT 'retail',  -- retail, wholesale, sto
  discount_percent NUMERIC(5,2) DEFAULT 0,
  debt_balance INTEGER DEFAULT 0,          -- kopecks, positive = customer owes
  bonus_balance INTEGER DEFAULT 0,         -- bonus points
  notes TEXT,
  tags TEXT[],                             -- ['VIP', 'problem', 'wholesale']
  telegram_id BIGINT,
  viber_id VARCHAR(100),
  source VARCHAR(50),                      -- walk_in, telegram, viber, phone, referral
  assigned_manager_id UUID REFERENCES users(id),
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, phone)
);

CREATE INDEX idx_customers_tenant ON customers(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_search ON customers USING GIN(search_vector);
CREATE INDEX idx_customers_telegram ON customers(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX idx_customers_debt ON customers(tenant_id, debt_balance) WHERE debt_balance > 0;
```

### customer_vehicles

```sql
CREATE TABLE customer_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  vin VARCHAR(17),
  plate_number VARCHAR(20),
  make VARCHAR(100),                       -- Toyota, Honda, BMW
  model VARCHAR(100),                      -- Camry, Civic, X5
  year INTEGER,
  engine_code VARCHAR(50),
  body_code VARCHAR(50),
  notes TEXT,
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_vehicles_customer ON customer_vehicles(customer_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_vehicles_vin ON customer_vehicles(vin) WHERE vin IS NOT NULL;
```

---

## PRODUCT TABLES

### categories

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  parent_id UUID REFERENCES categories(id),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, slug)
);
```

### brands

```sql
CREATE TYPE brand_tier AS ENUM ('original', 'premium', 'standard', 'budget');

CREATE TABLE brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  tier brand_tier DEFAULT 'standard',
  country VARCHAR(100),
  trust_score INTEGER DEFAULT 50,          -- 0-100
  logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, name)
);
```

### products

```sql
CREATE TYPE product_status AS ENUM ('active', 'inactive', 'discontinued', 'order_only');

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sku VARCHAR(50) NOT NULL,                -- internal store code
  name VARCHAR(500) NOT NULL,
  description TEXT,
  category_id UUID REFERENCES categories(id),
  brand_id UUID REFERENCES brands(id),
  
  -- Identification codes
  oem_number VARCHAR(100),                 -- original manufacturer number
  supplier_article VARCHAR(100),           -- supplier's own code
  
  -- Pricing (all in kopecks)
  purchase_price INTEGER DEFAULT 0,
  retail_price INTEGER DEFAULT 0,
  wholesale_price INTEGER DEFAULT 0,
  min_price INTEGER DEFAULT 0,             -- absolute floor, system enforced
  
  -- Stock
  qty_on_hand NUMERIC(12,3) DEFAULT 0,
  qty_reserved NUMERIC(12,3) DEFAULT 0,
  reorder_point NUMERIC(12,3) DEFAULT 0,
  
  -- Flags
  status product_status DEFAULT 'active',
  is_weight_based BOOLEAN DEFAULT false,   -- sold by kg
  is_quick_cash BOOLEAN DEFAULT false,     -- generic, minimal tracking
  is_order_only BOOLEAN DEFAULT false,     -- not stocked, only orderable
  allows_decimal_qty BOOLEAN DEFAULT false, -- 0.5 units allowed
  
  -- Physical
  weight_grams INTEGER,
  
  -- Media
  photo_urls TEXT[],
  
  -- Search
  search_vector TSVECTOR,
  
  -- Metadata
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, sku)
);

CREATE INDEX idx_products_tenant ON products(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_search ON products USING GIN(search_vector);
CREATE INDEX idx_products_oem ON products(oem_number) WHERE oem_number IS NOT NULL;
CREATE INDEX idx_products_supplier ON products(supplier_article) WHERE supplier_article IS NOT NULL;
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_brand ON products(brand_id);
CREATE INDEX idx_products_low_stock ON products(tenant_id) 
  WHERE qty_on_hand <= reorder_point AND status = 'active' AND deleted_at IS NULL;
```

### product_barcodes

Multiple barcodes per product.

```sql
CREATE TABLE product_barcodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  barcode VARCHAR(100) NOT NULL,
  barcode_type VARCHAR(20) DEFAULT 'ean13', -- ean13, ean8, custom, supplier
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, barcode)
);

CREATE INDEX idx_barcodes_barcode ON product_barcodes(barcode);
CREATE INDEX idx_barcodes_product ON product_barcodes(product_id);
```

### product_aliases

Informal names for search.

```sql
CREATE TABLE product_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  alias VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_aliases_product ON product_aliases(product_id);
```

### product_analogs

```sql
CREATE TABLE product_analogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  analog_product_id UUID NOT NULL REFERENCES products(id),
  analog_type VARCHAR(20) DEFAULT 'cross',  -- cross, substitute, upgrade, downgrade
  priority INTEGER DEFAULT 0,              -- higher = shown first
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, product_id, analog_product_id)
);
```

### product_supplier_codes

Which suppliers carry this product and at what code/price.

```sql
CREATE TABLE product_supplier_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  supplier_code VARCHAR(100) NOT NULL,     -- the supplier's own article
  supplier_price INTEGER DEFAULT 0,        -- kopecks
  lead_time_days INTEGER,                  -- typical delivery days
  is_preferred BOOLEAN DEFAULT false,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### product_price_history

```sql
CREATE TABLE product_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  price_type VARCHAR(20) NOT NULL,         -- purchase, retail, wholesale, min
  old_price INTEGER NOT NULL,
  new_price INTEGER NOT NULL,
  changed_by UUID REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_price_history_product ON product_price_history(product_id, created_at DESC);
```

### product_fitment

Which vehicles a product fits.

```sql
CREATE TABLE product_fitment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  make VARCHAR(100) NOT NULL,
  model VARCHAR(100),
  year_from INTEGER,
  year_to INTEGER,
  engine_code VARCHAR(50),
  body_code VARCHAR(50),
  notes TEXT,
  source VARCHAR(50) DEFAULT 'manual',     -- manual, tecdoc, api
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_fitment_product ON product_fitment(product_id);
CREATE INDEX idx_fitment_vehicle ON product_fitment(make, model);
```

---

## SUPPLIER TABLES

### suppliers

```sql
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  tax_id VARCHAR(20),
  payment_terms TEXT,                      -- e.g., "Net 30", "Prepaid"
  speed_score INTEGER DEFAULT 50,          -- 0-100, delivery speed rating
  reliability_score INTEGER DEFAULT 50,    -- 0-100
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, name)
);
```

---

## INVENTORY TABLES

### inventory_receipts

Incoming stock from suppliers.

```sql
CREATE TYPE receipt_status AS ENUM ('draft', 'confirmed', 'cancelled');

CREATE TABLE inventory_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  receipt_number VARCHAR(50) NOT NULL,
  supplier_id UUID REFERENCES suppliers(id),
  supplier_invoice_number VARCHAR(100),
  supplier_invoice_date DATE,
  supplier_invoice_url TEXT,               -- uploaded scan
  status receipt_status DEFAULT 'draft',
  total_amount INTEGER DEFAULT 0,          -- kopecks
  notes TEXT,
  received_by UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, receipt_number)
);
```

### inventory_receipt_items

```sql
CREATE TABLE inventory_receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  receipt_id UUID NOT NULL REFERENCES inventory_receipts(id),
  product_id UUID NOT NULL REFERENCES products(id),
  qty NUMERIC(12,3) NOT NULL,
  purchase_price INTEGER NOT NULL,         -- kopecks per unit
  total INTEGER NOT NULL,                  -- qty * purchase_price
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### inventory_writeoffs

```sql
CREATE TYPE writeoff_reason AS ENUM ('damaged', 'expired', 'lost', 'defective', 'correction', 'other');

CREATE TABLE inventory_writeoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  qty NUMERIC(12,3) NOT NULL,
  reason writeoff_reason NOT NULL,
  notes TEXT,
  written_off_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### inventory_sessions

Full or partial stock counts.

```sql
CREATE TYPE session_status AS ENUM ('in_progress', 'completed', 'cancelled');

CREATE TABLE inventory_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  session_name VARCHAR(255),
  status session_status DEFAULT 'in_progress',
  started_by UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### inventory_session_items

```sql
CREATE TABLE inventory_session_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  session_id UUID NOT NULL REFERENCES inventory_sessions(id),
  product_id UUID NOT NULL REFERENCES products(id),
  expected_qty NUMERIC(12,3) NOT NULL,     -- system qty at count time
  counted_qty NUMERIC(12,3),               -- physically counted
  variance NUMERIC(12,3),                  -- counted - expected
  counted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### inventory_reserves

Items held for specific orders or customers.

```sql
CREATE TABLE inventory_reserves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  order_id UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  qty NUMERIC(12,3) NOT NULL,
  reserved_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## SALES TABLES

### sales

```sql
CREATE TYPE sale_status AS ENUM ('open', 'completed', 'returned', 'voided');

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sale_number VARCHAR(50) NOT NULL,
  customer_id UUID REFERENCES customers(id),
  cashier_id UUID NOT NULL REFERENCES users(id),
  
  status sale_status DEFAULT 'open',
  
  subtotal INTEGER NOT NULL DEFAULT 0,     -- before discount
  discount_amount INTEGER DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,        -- final amount
  
  is_debt_sale BOOLEAN DEFAULT false,
  is_suspended BOOLEAN DEFAULT false,      -- parked receipt
  
  notes TEXT,
  shift_id UUID REFERENCES shifts(id),
  
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, sale_number)
);

CREATE INDEX idx_sales_tenant_date ON sales(tenant_id, created_at DESC);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_cashier ON sales(cashier_id);
CREATE INDEX idx_sales_suspended ON sales(tenant_id) 
  WHERE is_suspended = true AND deleted_at IS NULL;
```

### sale_items

```sql
CREATE TABLE sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sale_id UUID NOT NULL REFERENCES sales(id),
  product_id UUID NOT NULL REFERENCES products(id),
  qty NUMERIC(12,3) NOT NULL,
  unit_price INTEGER NOT NULL,             -- price per unit at time of sale
  discount_percent NUMERIC(5,2) DEFAULT 0,
  discount_amount INTEGER DEFAULT 0,
  total INTEGER NOT NULL,
  is_return BOOLEAN DEFAULT false,         -- true if this is a returned item
  return_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### shifts

Cashier shift tracking.

```sql
CREATE TYPE shift_status AS ENUM ('open', 'closed');

CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cashier_id UUID NOT NULL REFERENCES users(id),
  status shift_status DEFAULT 'open',
  opening_cash INTEGER DEFAULT 0,          -- cash float at shift open
  closing_cash INTEGER,                    -- actual cash count at close
  expected_cash INTEGER,                   -- calculated expected cash
  cash_variance INTEGER,                   -- closing - expected
  opened_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## ORDER TABLES

### orders

```sql
CREATE TYPE order_status AS ENUM (
  'draft', 'quoted', 'prepaid', 'ordered_from_supplier',
  'arrived', 'issued', 'completed', 'cancelled', 'lost'
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  order_number VARCHAR(50) NOT NULL,
  customer_id UUID REFERENCES customers(id),
  manager_id UUID REFERENCES users(id),
  
  status order_status DEFAULT 'draft',
  source VARCHAR(50) DEFAULT 'manual',     -- manual, telegram, viber, phone
  
  -- Pricing
  quoted_total INTEGER DEFAULT 0,
  prepayment_amount INTEGER DEFAULT 0,
  final_total INTEGER DEFAULT 0,
  
  -- Promise tracking
  promised_date DATE,
  is_overdue BOOLEAN DEFAULT false,
  
  -- Supplier
  supplier_id UUID REFERENCES suppliers(id),
  supplier_order_number VARCHAR(100),
  
  -- Vehicle context
  vehicle_id UUID REFERENCES customer_vehicles(id),
  vin VARCHAR(17),
  
  -- Cancellation
  cancel_reason TEXT,
  lost_reason TEXT,
  
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, order_number)
);

CREATE INDEX idx_orders_tenant_status ON orders(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_overdue ON orders(tenant_id) 
  WHERE is_overdue = true AND status NOT IN ('completed', 'cancelled', 'lost');
```

### order_items

```sql
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  product_id UUID REFERENCES products(id), -- NULL if unknown/custom item
  custom_description TEXT,                 -- for unknown items
  oem_number VARCHAR(100),
  qty NUMERIC(12,3) NOT NULL DEFAULT 1,
  quoted_price INTEGER DEFAULT 0,
  purchase_price INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### order_attachments

Photos, VIN images, voice messages attached to orders.

```sql
CREATE TYPE attachment_type AS ENUM ('photo', 'vin_photo', 'voice', 'document', 'screenshot');

CREATE TABLE order_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  attachment_type attachment_type NOT NULL,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  file_size INTEGER,
  notes TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### order_status_history

```sql
CREATE TABLE order_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  old_status order_status,
  new_status order_status NOT NULL,
  changed_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## PAYMENT TABLES

### payments

```sql
CREATE TYPE payment_method AS ENUM ('cash', 'terminal', 'bank_transfer', 'card_transfer');
CREATE TYPE payment_type AS ENUM ('sale', 'order_prepayment', 'debt_repayment', 'cash_service', 'refund');

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  payment_number VARCHAR(50),
  sale_id UUID REFERENCES sales(id),
  order_id UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  
  payment_type payment_type NOT NULL,
  payment_method payment_method NOT NULL,
  amount INTEGER NOT NULL,                 -- kopecks
  
  -- For split payments, this links parts together
  group_id UUID,                           -- shared by split payment parts
  
  -- For bank transfer confirmation
  screenshot_url TEXT,
  
  shift_id UUID REFERENCES shifts(id),
  processed_by UUID REFERENCES users(id),
  
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_payments_sale ON payments(sale_id);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_payments_shift ON payments(shift_id);
CREATE INDEX idx_payments_date ON payments(tenant_id, created_at DESC);
```

### cash_operations

Non-sale cash movements (float, withdrawal, petty cash).

```sql
CREATE TYPE cash_operation_type AS ENUM ('cash_in', 'cash_out');

CREATE TABLE cash_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  operation_type cash_operation_type NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  shift_id UUID REFERENCES shifts(id),
  performed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## MESSAGING TABLES

### messages

```sql
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE message_channel AS ENUM ('telegram', 'viber', 'manual', 'system');
CREATE TYPE message_content_type AS ENUM ('text', 'photo', 'voice', 'document', 'location');

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  customer_id UUID REFERENCES customers(id),
  lead_id UUID REFERENCES leads(id),
  
  direction message_direction NOT NULL,
  channel message_channel NOT NULL,
  content_type message_content_type DEFAULT 'text',
  
  text_content TEXT,
  media_url TEXT,
  
  -- Channel-specific IDs
  external_message_id VARCHAR(100),
  external_chat_id VARCHAR(100),
  
  sent_by UUID REFERENCES users(id),       -- NULL for inbound
  read_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_messages_customer ON messages(customer_id, created_at DESC);
CREATE INDEX idx_messages_lead ON messages(lead_id);
```

### leads

```sql
CREATE TYPE lead_status AS ENUM ('new', 'assigned', 'in_progress', 'converted', 'closed', 'spam');

CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  customer_id UUID REFERENCES customers(id),
  
  status lead_status DEFAULT 'new',
  channel message_channel NOT NULL,
  
  assigned_to UUID REFERENCES users(id),
  assigned_at TIMESTAMPTZ,
  
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  response_time_seconds INTEGER,           -- time to first response
  
  converted_to_order_id UUID REFERENCES orders(id),
  
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_leads_status ON leads(tenant_id, status) WHERE status IN ('new', 'assigned');
CREATE INDEX idx_leads_unprocessed ON leads(tenant_id, created_at) WHERE status = 'new';
```

---

## REPORTING VIEWS

These are database views, not tables, for efficient report generation.

```sql
-- Daily sales summary
CREATE VIEW v_daily_sales AS
SELECT 
  tenant_id,
  DATE(created_at) as sale_date,
  COUNT(*) as sale_count,
  SUM(total) as total_revenue,
  SUM(discount_amount) as total_discounts,
  COUNT(DISTINCT customer_id) as unique_customers
FROM sales
WHERE status = 'completed' AND deleted_at IS NULL
GROUP BY tenant_id, DATE(created_at);

-- Outstanding debts
CREATE VIEW v_outstanding_debts AS
SELECT 
  c.tenant_id,
  c.id as customer_id,
  c.name,
  c.phone,
  c.debt_balance,
  MAX(s.created_at) as last_debt_sale,
  COUNT(s.id) as debt_sale_count
FROM customers c
LEFT JOIN sales s ON s.customer_id = c.id AND s.is_debt_sale = true
WHERE c.debt_balance > 0 AND c.deleted_at IS NULL
GROUP BY c.tenant_id, c.id, c.name, c.phone, c.debt_balance;

-- Low stock items
CREATE VIEW v_low_stock AS
SELECT 
  p.tenant_id,
  p.id as product_id,
  p.sku,
  p.name,
  p.qty_on_hand,
  p.reorder_point,
  p.qty_on_hand - p.reorder_point as deficit
FROM products p
WHERE p.qty_on_hand <= p.reorder_point 
  AND p.status = 'active' 
  AND p.deleted_at IS NULL
ORDER BY deficit ASC;
```

---

## RLS POLICIES

Applied to every table:

```sql
-- Template for all tables:
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_{table_name}" ON {table_name}
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::UUID);
```

---

## TRIGGERS

```sql
-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at:
CREATE TRIGGER set_updated_at BEFORE UPDATE ON {table_name}
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-update product search_vector
CREATE OR REPLACE FUNCTION update_product_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector = 
    setweight(to_tsvector('simple', COALESCE(NEW.sku, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.oem_number, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.supplier_article, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.description, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_search_update BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_product_search_vector();

-- Auto-update customer search_vector
CREATE OR REPLACE FUNCTION update_customer_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector = 
    setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.phone, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.company_name, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_search_update BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_customer_search_vector();
```

---

## MIGRATION FILE NAMING

```
supabase/migrations/
  20260501000001_create_tenants.sql
  20260501000002_create_users.sql
  20260501000003_create_customers.sql
  20260501000004_create_products.sql
  20260501000005_create_inventory.sql
  20260501000006_create_sales.sql
  20260501000007_create_orders.sql
  20260501000008_create_payments.sql
  20260501000009_create_messages.sql
  20260501000010_create_views.sql
  20260501000011_create_rls_policies.sql
  20260501000012_create_triggers.sql
  20260501000013_create_indexes.sql
  20260501000014_seed_initial_data.sql
```

Each migration file is forward-only and includes a comment block explaining what it does and its rollback SQL.
