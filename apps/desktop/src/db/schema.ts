export const LOCAL_SCHEMA_VERSION = 4

const MIGRATION_001_CORE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    scope TEXT PRIMARY KEY,
    pull_cursor TEXT,
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sending', 'failed', 'synced')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    synced_at TEXT,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
    ON sync_outbox(status, next_attempt_at, sequence);

  CREATE TABLE IF NOT EXISTS audit_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_log_entity
    ON audit_log(entity_type, entity_id, sequence DESC);
`

const MIGRATION_002_BUSINESS_SQL = `
  CREATE TABLE IF NOT EXISTS local_sequences (
    scope TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS staff_users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier',
    phone TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_staff_users_tenant_role
    ON staff_users(tenant_id, role, is_active);

  CREATE TABLE IF NOT EXISTS brands (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    country TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (tenant_id, name)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    parent_id TEXT REFERENCES categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_categories_parent
    ON categories(tenant_id, parent_id, sort_order);

  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    contact_name TEXT,
    notes TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_suppliers_name
    ON suppliers(tenant_id, name);

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    barcode TEXT,
    brand_id TEXT REFERENCES brands(id),
    category_id TEXT REFERENCES categories(id),
    unit TEXT NOT NULL DEFAULT 'шт',
    purchase_price INTEGER NOT NULL DEFAULT 0,
    retail_price INTEGER NOT NULL DEFAULT 0,
    qty_on_hand NUMERIC NOT NULL DEFAULT 0,
    reorder_point NUMERIC NOT NULL DEFAULT 0,
    notes TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_service INTEGER NOT NULL DEFAULT 0,
    storage_bin TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    photo_url TEXT,
    specs_json TEXT NOT NULL DEFAULT '{}',
    requires_core_return INTEGER NOT NULL DEFAULT 0,
    core_deposit_amount INTEGER NOT NULL DEFAULT 0,
    search_text TEXT NOT NULL DEFAULT '',
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (tenant_id, sku)
  );

  CREATE INDEX IF NOT EXISTS idx_products_sku
    ON products(tenant_id, sku)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_products_barcode
    ON products(tenant_id, barcode)
    WHERE deleted_at IS NULL AND barcode IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_products_category
    ON products(tenant_id, category_id, is_active)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_products_search_text
    ON products(tenant_id, search_text)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS product_barcodes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    barcode TEXT NOT NULL,
    barcode_type TEXT NOT NULL DEFAULT 'ean13',
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (tenant_id, barcode)
  );

  CREATE INDEX IF NOT EXISTS idx_product_barcodes_product
    ON product_barcodes(product_id);

  CREATE TABLE IF NOT EXISTS product_aliases (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    alias TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_product_aliases_alias
    ON product_aliases(tenant_id, alias);

  CREATE TABLE IF NOT EXISTS product_cross_numbers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    cross_number TEXT NOT NULL,
    brand TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (tenant_id, product_id, cross_number)
  );

  CREATE INDEX IF NOT EXISTS idx_product_cross_numbers_lookup
    ON product_cross_numbers(tenant_id, cross_number);

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    phone TEXT,
    full_name TEXT,
    email TEXT,
    debt_balance INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    price_tier_id TEXT,
    bonus_balance INTEGER NOT NULL DEFAULT 0,
    vip_level TEXT NOT NULL DEFAULT 'standard',
    risk_profile TEXT NOT NULL DEFAULT 'low',
    discount_pct NUMERIC NOT NULL DEFAULT 0,
    client_status TEXT NOT NULL DEFAULT 'client',
    card_barcode TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customers_phone
    ON customers(tenant_id, phone)
    WHERE deleted_at IS NULL AND phone IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_customers_card_barcode
    ON customers(tenant_id, card_barcode)
    WHERE deleted_at IS NULL AND card_barcode IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_customers_name
    ON customers(tenant_id, full_name)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS customer_vehicles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    brand TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    year INTEGER,
    vin TEXT,
    notes TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customer_vehicles_customer
    ON customer_vehicles(customer_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_customer_vehicles_vin
    ON customer_vehicles(tenant_id, vin)
    WHERE deleted_at IS NULL AND vin IS NOT NULL;

  CREATE TABLE IF NOT EXISTS customer_orders (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    order_number INTEGER,
    kp_number TEXT,
    customer_id TEXT REFERENCES customers(id),
    chat_id TEXT,
    manager_id TEXT,
    vehicle_info_json TEXT,
    status TEXT NOT NULL DEFAULT 'lead',
    prepayment INTEGER NOT NULL DEFAULT 0,
    prepayment_method TEXT,
    prepayment_is_fiscal INTEGER NOT NULL DEFAULT 0,
    total_amount INTEGER NOT NULL DEFAULT 0,
    total_paid INTEGER NOT NULL DEFAULT 0,
    discount_amount INTEGER NOT NULL DEFAULT 0,
    pickup_deadline_at TEXT,
    pickup_cell TEXT,
    comment TEXT,
    source TEXT NOT NULL DEFAULT 'walk_in',
    sent_to_telegram_at TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customer_orders_status
    ON customer_orders(tenant_id, status, updated_at DESC)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_customer_orders_number
    ON customer_orders(tenant_id, order_number)
    WHERE deleted_at IS NULL AND order_number IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_customer_orders_customer
    ON customer_orders(tenant_id, customer_id, updated_at DESC)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS customer_order_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    order_id TEXT NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT,
    product_id TEXT REFERENCES products(id),
    supplier_id TEXT REFERENCES suppliers(id),
    source_type TEXT NOT NULL DEFAULT 'warehouse',
    item_type TEXT NOT NULL DEFAULT 'product',
    item_status TEXT NOT NULL DEFAULT 'pending',
    buy_price INTEGER NOT NULL DEFAULT 0,
    sell_price INTEGER NOT NULL DEFAULT 0,
    qty NUMERIC NOT NULL DEFAULT 1,
    expected_date TEXT,
    core_deposit_amount INTEGER NOT NULL DEFAULT 0,
    core_return_status TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customer_order_items_order
    ON customer_order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_customer_order_items_product
    ON customer_order_items(product_id);

  CREATE TABLE IF NOT EXISTS order_payments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    order_id TEXT NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    is_fiscal INTEGER NOT NULL DEFAULT 0,
    shift_id TEXT,
    created_by TEXT,
    notes TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_order_payments_order
    ON order_payments(order_id, created_at);

  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    cashier_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'closed')),
    opening_cash INTEGER NOT NULL DEFAULT 0,
    closing_cash INTEGER,
    expected_cash INTEGER,
    cash_variance INTEGER,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    notes TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_shifts_open
    ON shifts(tenant_id, cashier_id, status);

  CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sale_number TEXT NOT NULL,
    customer_id TEXT REFERENCES customers(id),
    cashier_id TEXT NOT NULL,
    manager_id TEXT,
    shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'completed'
      CHECK (status IN ('draft', 'suspended', 'completed', 'returned', 'voided', 'cancelled', 'ready_for_pickup')),
    subtotal INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'cash'
      CHECK (payment_method IN ('cash', 'card', 'debt', 'mixed', 'transfer')),
    is_debt INTEGER NOT NULL DEFAULT 0,
    is_fiscal INTEGER NOT NULL DEFAULT 0,
    fiscal_number TEXT,
    fiscal_qr_url TEXT,
    bank_auth_code TEXT,
    terminal_rrn TEXT,
    cash_amount INTEGER NOT NULL DEFAULT 0,
    card_amount INTEGER NOT NULL DEFAULT 0,
    transfer_amount INTEGER NOT NULL DEFAULT 0,
    debt_amount INTEGER NOT NULL DEFAULT 0,
    pickup_cell TEXT,
    notes TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (tenant_id, sale_number)
  );

  CREATE INDEX IF NOT EXISTS idx_sales_shift
    ON sales(shift_id, completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sales_customer
    ON sales(tenant_id, customer_id, completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sales_status
    ON sales(tenant_id, status, completed_at DESC);

  CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
    product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
    description TEXT,
    sku TEXT,
    qty NUMERIC NOT NULL,
    unit_price INTEGER NOT NULL,
    purchase_price INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    core_deposit_amount INTEGER NOT NULL DEFAULT 0,
    core_return_status TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sale_items_sale
    ON sale_items(sale_id);
  CREATE INDEX IF NOT EXISTS idx_sale_items_product
    ON sale_items(product_id);

  CREATE TABLE IF NOT EXISTS sale_payments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
    method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'debt', 'transfer')),
    amount INTEGER NOT NULL,
    is_fiscal INTEGER NOT NULL DEFAULT 0,
    fiscal_number TEXT,
    bank_auth_code TEXT,
    terminal_rrn TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sale_payments_sale
    ON sale_payments(sale_id);

  CREATE TABLE IF NOT EXISTS cash_operations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
    user_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('sale_cash', 'return_cash', 'cash_in', 'cash_out', 'salary_payout', 'supplier_payment', 'correction')),
    source TEXT NOT NULL DEFAULT 'cashbox'
      CHECK (source IN ('cashbox', 'owner_funds', 'change_fund', 'bank_account', 'business_card', 'other')),
    amount INTEGER NOT NULL,
    sale_id TEXT REFERENCES sales(id),
    supplier_id TEXT REFERENCES suppliers(id),
    employee_id TEXT,
    notes TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cash_operations_shift
    ON cash_operations(tenant_id, shift_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS inventory_movements (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    source_type TEXT NOT NULL,
    source_id TEXT,
    qty_delta NUMERIC NOT NULL,
    qty_after NUMERIC NOT NULL,
    unit_cost INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_movements_product
    ON inventory_movements(product_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS inventory_sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    session_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'in_progress', 'completed', 'cancelled')),
    started_by TEXT,
    started_at TEXT,
    completed_at TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    expected_stock NUMERIC NOT NULL DEFAULT 0,
    counted_stock NUMERIC NOT NULL DEFAULT 0,
    was_counted INTEGER NOT NULL DEFAULT 0,
    price_checked INTEGER NOT NULL DEFAULT 0,
    observed_retail_price INTEGER,
    last_counted_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (session_id, product_id)
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_items_session
    ON inventory_items(session_id, was_counted, updated_at DESC);

  CREATE TABLE IF NOT EXISTS inventory_count_entries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
    inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    counted_by TEXT NOT NULL,
    qty NUMERIC NOT NULL CHECK (qty >= 0),
    price_checked INTEGER NOT NULL DEFAULT 0,
    observed_retail_price INTEGER,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_entries_session_created
    ON inventory_count_entries(session_id, created_at DESC);
`

const MIGRATION_003_SUPPLY_INVOICES_SQL = `
  CREATE TABLE IF NOT EXISTS supply_invoices (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    supplier_id TEXT REFERENCES suppliers(id),
    invoice_number TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'posted', 'cancelled')),
    total INTEGER NOT NULL DEFAULT 0,
    paid_amount INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT,
    notes TEXT,
    posted_by TEXT,
    posted_at TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_supply_invoices_tenant_status
    ON supply_invoices(tenant_id, status, created_at DESC)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_supply_invoices_supplier
    ON supply_invoices(tenant_id, supplier_id, created_at DESC)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS supply_invoice_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL REFERENCES supply_invoices(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty NUMERIC NOT NULL,
    purchase_price INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_supply_invoice_items_invoice
    ON supply_invoice_items(invoice_id);
  CREATE INDEX IF NOT EXISTS idx_supply_invoice_items_product
    ON supply_invoice_items(product_id);

  CREATE TABLE IF NOT EXISTS supplier_payments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL REFERENCES supply_invoices(id) ON DELETE CASCADE,
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    amount INTEGER NOT NULL,
    payment_method TEXT NOT NULL,
    fund_source TEXT NOT NULL DEFAULT 'cashbox',
    shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
    note TEXT,
    created_by TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_supplier_payments_invoice
    ON supplier_payments(invoice_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supplier_payments_tenant
    ON supplier_payments(tenant_id, created_at DESC);
`

const MIGRATION_004_CUSTOMER_DEPOSITS_SQL = `
  ALTER TABLE customers ADD COLUMN deposit_balance INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE customers ADD COLUMN loyalty_mode TEXT NOT NULL DEFAULT 'discount';

  CREATE TABLE IF NOT EXISTS customer_deposit_transactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT 'cash',
    order_id TEXT REFERENCES customer_orders(id) ON DELETE SET NULL,
    sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
    shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
    notes TEXT,
    created_by TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customer_deposit_transactions_customer
    ON customer_deposit_transactions(tenant_id, customer_id, created_at DESC);
`
export interface LocalMigration {
  version: number
  sql: string
}

export const LOCAL_MIGRATIONS: LocalMigration[] = [
  { version: 1, sql: MIGRATION_001_CORE_SQL },
  { version: 2, sql: MIGRATION_002_BUSINESS_SQL },
  { version: 3, sql: MIGRATION_003_SUPPLY_INVOICES_SQL },
  { version: 4, sql: MIGRATION_004_CUSTOMER_DEPOSITS_SQL },
]
