import { SUPPLIER_CATALOG_SCHEMA_SQL } from './supplierCatalogSchema'

export const LOCAL_SCHEMA_VERSION = 21

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

const MIGRATION_005_RETURNS_SQL = `
  CREATE TABLE IF NOT EXISTS customer_returns (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    return_type TEXT NOT NULL DEFAULT 'customer_return',
    reason TEXT NOT NULL,
    reason_note TEXT,
    refund_method TEXT NOT NULL,
    refund_kopecks INTEGER NOT NULL DEFAULT 0,
    stock_action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    approved_by TEXT,
    fiscal_number TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customer_returns_tenant_created
    ON customer_returns(tenant_id, created_at DESC)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_customer_returns_sale
    ON customer_returns(sale_id)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS customer_return_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    return_id TEXT NOT NULL REFERENCES customer_returns(id) ON DELETE CASCADE,
    sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
    product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
    quantity NUMERIC NOT NULL,
    unit_price_kopecks INTEGER NOT NULL,
    total_kopecks INTEGER NOT NULL,
    condition TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customer_return_items_return
    ON customer_return_items(return_id);
  CREATE INDEX IF NOT EXISTS idx_customer_return_items_sale_item
    ON customer_return_items(sale_item_id);
`

const MIGRATION_006_BONUS_TRANSACTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS bonus_transactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    amount INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    source_sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
    description TEXT,
    created_by TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_bonus_transactions_customer
    ON bonus_transactions(tenant_id, customer_id, created_at DESC)
    WHERE deleted_at IS NULL;
`
const MIGRATION_007_WAREHOUSE_OPERATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS warehouse_movements (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    from_bin TEXT,
    to_bin TEXT NOT NULL,
    qty NUMERIC NOT NULL,
    note TEXT,
    created_by TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_warehouse_movements_tenant
    ON warehouse_movements(tenant_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS stock_reserves (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    order_id TEXT REFERENCES customer_orders(id) ON DELETE SET NULL,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    qty NUMERIC NOT NULL,
    reserved_by TEXT,
    expires_at TEXT,
    released_at TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_stock_reserves_active
    ON stock_reserves(tenant_id, product_id, released_at)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS writeoffs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    created_by TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_writeoffs_tenant
    ON writeoffs(tenant_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS writeoff_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    writeoff_id TEXT NOT NULL REFERENCES writeoffs(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty NUMERIC NOT NULL,
    cost_kopecks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_writeoff_items_writeoff
    ON writeoff_items(writeoff_id);
`
const MIGRATION_008_LOCAL_STAFF_SQL = `
  ALTER TABLE staff_users ADD COLUMN base_rate INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE staff_users ADD COLUMN rate_period TEXT NOT NULL DEFAULT 'day';
  ALTER TABLE staff_users ADD COLUMN pin_hash TEXT;
  ALTER TABLE staff_users ADD COLUMN password_hash TEXT;

  CREATE TABLE IF NOT EXISTS commission_rules (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT REFERENCES staff_users(id) ON DELETE CASCADE,
    brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
    category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
    pct_from_revenue NUMERIC NOT NULL DEFAULT 0,
    pct_from_profit NUMERIC NOT NULL DEFAULT 0,
    rule_type TEXT NOT NULL DEFAULT 'personal_sales',
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_commission_rules_tenant
    ON commission_rules(tenant_id, user_id, rule_type)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS salary_payments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    employee_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
    employee_name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('salary', 'bonus', 'advance', 'penalty')),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'transfer')),
    period TEXT NOT NULL,
    work_date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT,
    shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
    cash_operation_id TEXT REFERENCES cash_operations(id) ON DELETE SET NULL,
    commission_source_sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
    commission_source_order_id TEXT REFERENCES customer_orders(id) ON DELETE SET NULL,
    created_by TEXT,
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_salary_payments_period
    ON salary_payments(tenant_id, period, employee_id, created_at DESC)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_salary_payments_date
    ON salary_payments(tenant_id, work_date, employee_id)
    WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_daily_rate_once
    ON salary_payments(tenant_id, employee_id, work_date, source)
    WHERE source = 'daily_rate' AND deleted_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_sale_commission_once
    ON salary_payments(tenant_id, employee_id, commission_source_sale_id)
    WHERE commission_source_sale_id IS NOT NULL AND source = 'commission' AND deleted_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_order_commission_once
    ON salary_payments(tenant_id, employee_id, commission_source_order_id)
    WHERE commission_source_order_id IS NOT NULL AND source = 'commission' AND deleted_at IS NULL;
`
const MIGRATION_009_REPAIR_CUSTOMER_ORDERS_SQL = `
  -- Repair older/test local databases where order tables are missing while
  -- previous migrations may already be marked as applied. Safe: creates only
  -- missing order tables and indexes; does not delete or overwrite data.
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
`

const MIGRATION_010_CUSTOMER_BIRTH_DATE_SQL = `
  ALTER TABLE customers ADD COLUMN birth_date TEXT;
`

const MIGRATION_011_ORDER_SALE_LINK_SQL = `
  ALTER TABLE customer_orders ADD COLUMN sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_customer_orders_sale
    ON customer_orders(tenant_id, sale_id)
    WHERE sale_id IS NOT NULL;
`

const MIGRATION_012_FISCAL_SALE_INTENTS_SQL = `
  ALTER TABLE sales ADD COLUMN client_operation_id TEXT;
  ALTER TABLE sales ADD COLUMN client_payload_hash TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client_operation
    ON sales(tenant_id, client_operation_id)
    WHERE client_operation_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS fiscal_sale_intents (
    operation_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    cashier_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    checkout_hash TEXT NOT NULL,
    checkout_json TEXT NOT NULL,
    fiscal_items_json TEXT NOT NULL,
    fiscal_pay_json TEXT NOT NULL,
    fiscal_comment TEXT,
    state TEXT NOT NULL DEFAULT 'prepared'
      CHECK (state IN ('prepared', 'fiscalizing', 'fiscalized', 'unknown', 'completed')),
    fiscal_result_json TEXT,
    fiscal_number TEXT,
    fiscal_qr_url TEXT,
    sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
    checkout_result_json TEXT,
    last_error TEXT,
    fiscal_started_at TEXT,
    fiscalized_at TEXT,
    completed_at TEXT,
    manual_reset_count INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT,
    resolved_reason TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_fiscal_sale_intents_state
    ON fiscal_sale_intents(tenant_id, state, updated_at DESC);
`


const MIGRATION_013_FISCAL_RETURN_INTENTS_SQL = `
  ALTER TABLE customer_returns ADD COLUMN client_operation_id TEXT;
  ALTER TABLE customer_returns ADD COLUMN client_payload_hash TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_returns_client_operation
    ON customer_returns(tenant_id, client_operation_id)
    WHERE client_operation_id IS NOT NULL;

  ALTER TABLE fiscal_sale_intents ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'sale';
  ALTER TABLE fiscal_sale_intents ADD COLUMN return_id TEXT REFERENCES customer_returns(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_fiscal_intents_kind_state
    ON fiscal_sale_intents(tenant_id, operation_kind, state, updated_at DESC);
`
const MIGRATION_014_SUPPLIER_CATALOG_SQL = SUPPLIER_CATALOG_SCHEMA_SQL
const MIGRATION_015_STOCK_INTEGRITY_SQL = `
  CREATE INDEX IF NOT EXISTS idx_inventory_movements_source
    ON inventory_movements(tenant_id, source_type, source_id, product_id);

  INSERT INTO inventory_movements (
    id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
    unit_cost, notes, remote_updated_at, dirty_at, created_at, updated_at
  )
  SELECT
    'legacy-deleted-cleanup-' || p.id,
    p.tenant_id,
    p.id,
    'legacy_deleted_cleanup',
    p.id,
    -p.qty_on_hand,
    0,
    p.purchase_price,
    'Очищення старого залишку видаленого товару',
    NULL,
    NULL,
    COALESCE(p.deleted_at, p.updated_at),
    COALESCE(p.deleted_at, p.updated_at)
  FROM products p
  WHERE p.deleted_at IS NOT NULL
    AND p.qty_on_hand <> 0
    AND NOT EXISTS (
      SELECT 1 FROM inventory_movements m
      WHERE m.id = 'legacy-deleted-cleanup-' || p.id
    );

  UPDATE products
  SET qty_on_hand = 0
  WHERE deleted_at IS NOT NULL AND qty_on_hand <> 0;

  INSERT INTO inventory_movements (
    id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
    unit_cost, notes, remote_updated_at, dirty_at, created_at, updated_at
  )
  SELECT
    'stock-rebase-' || p.id,
    p.tenant_id,
    p.id,
    'stock_rebase',
    p.id,
    p.qty_on_hand - COALESCE((
      SELECT m.qty_after FROM inventory_movements m
      WHERE m.tenant_id = p.tenant_id AND m.product_id = p.id AND m.deleted_at IS NULL
      ORDER BY datetime(m.created_at) DESC, m.rowid DESC LIMIT 1
    ), 0),
    p.qty_on_hand,
    p.purchase_price,
    'Звірка журналу рухів із поточним залишком',
    NULL,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM products p
  WHERE p.deleted_at IS NULL
    AND p.qty_on_hand <> COALESCE((
      SELECT m.qty_after FROM inventory_movements m
      WHERE m.tenant_id = p.tenant_id AND m.product_id = p.id AND m.deleted_at IS NULL
      ORDER BY datetime(m.created_at) DESC, m.rowid DESC LIMIT 1
    ), 0)
    AND NOT EXISTS (
      SELECT 1 FROM inventory_movements m WHERE m.id = 'stock-rebase-' || p.id
    );

  INSERT INTO inventory_count_entries (
    id, tenant_id, session_id, inventory_item_id, product_id,
    counted_by, qty, price_checked, observed_retail_price, created_at
  )
  SELECT
    'legacy-count-' || i.id,
    i.tenant_id,
    i.session_id,
    i.id,
    i.product_id,
    COALESCE(i.last_counted_by, s.started_by, 'legacy-import'),
    i.counted_stock,
    i.price_checked,
    i.observed_retail_price,
    i.updated_at
  FROM inventory_items i
  JOIN inventory_sessions s ON s.id = i.session_id AND s.tenant_id = i.tenant_id
  WHERE i.was_counted = 1
    AND i.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM inventory_count_entries e
      WHERE e.inventory_item_id = i.id AND e.deleted_at IS NULL
    );
`

const MIGRATION_016_FINANCIAL_INTEGRITY_SQL = `
  INSERT INTO app_meta(key, value_json, updated_at)
  VALUES (
    'shop_settings',
    '{"allow_negative_qty":false}',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(key) DO UPDATE SET
    value_json = CASE
      WHEN json_valid(app_meta.value_json)
      THEN json_set(app_meta.value_json, '$.allow_negative_qty', json('false'))
      ELSE '{"allow_negative_qty":false}'
    END,
    updated_at = excluded.updated_at;
`

const MIGRATION_017_DOCUMENT_INTEGRITY_SQL = `
  ALTER TABLE customer_orders ADD COLUMN exchange_source_order_id TEXT REFERENCES customer_orders(id) ON DELETE RESTRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_orders_exchange_source
    ON customer_orders(tenant_id, exchange_source_order_id)
    WHERE exchange_source_order_id IS NOT NULL AND deleted_at IS NULL;

  DELETE FROM inventory_sessions
  WHERE status = 'completed'
    AND NOT EXISTS (SELECT 1 FROM inventory_items i WHERE i.session_id = inventory_sessions.id)
    AND NOT EXISTS (SELECT 1 FROM inventory_count_entries e WHERE e.session_id = inventory_sessions.id);

  DELETE FROM writeoffs
  WHERE NOT EXISTS (SELECT 1 FROM writeoff_items i WHERE i.writeoff_id = writeoffs.id);

  UPDATE customer_orders
  SET status = 'archived',
      comment = CASE
        WHEN COALESCE(comment, '') = '' THEN 'Автоматично архівовано: стара версія завершила заказ без чека.'
        ELSE comment || char(10) || 'Автоматично архівовано: стара версія завершила заказ без чека.'
      END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE status = 'completed' AND sale_id IS NULL;

  UPDATE stock_reserves
  SET released_at = COALESCE(released_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE released_at IS NULL
    AND EXISTS (
      SELECT 1 FROM customer_orders o
      WHERE o.id = stock_reserves.order_id
        AND o.tenant_id = stock_reserves.tenant_id
        AND o.status = 'archived'
    );

  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
  WHERE status = 'failed'
    AND (
      (operation_type = 'category.deleted' AND last_error LIKE '%FOREIGN KEY%')
      OR operation_type IN ('staff_user.created', 'staff_user.updated')
    );

  UPDATE shifts
  SET dirty_at = NULL
  WHERE dirty_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM sync_outbox o
      WHERE o.tenant_id = shifts.tenant_id
        AND o.aggregate_type = 'shift'
        AND o.aggregate_id = shifts.id
        AND o.status IN ('pending', 'sending', 'failed')
    );
`

const MIGRATION_018_CUSTOMER_LOYALTY_SALARY_INTEGRITY_SQL = `
  ALTER TABLE salary_payments
    ADD COLUMN commission_source_return_id TEXT REFERENCES customer_returns(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_return_commission_once
    ON salary_payments(tenant_id, employee_id, commission_source_return_id)
    WHERE commission_source_return_id IS NOT NULL
      AND source = 'commission_reversal' AND deleted_at IS NULL;

  UPDATE customers
  SET deleted_at = NULL,
      dirty_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE deleted_at IS NOT NULL
    AND (COALESCE(debt_balance, 0) <> 0
      OR COALESCE(deposit_balance, 0) <> 0
      OR COALESCE(bonus_balance, 0) <> 0);

  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
  WHERE operation_type = 'return.created' AND status = 'failed'
    AND (
      last_error LIKE '%Касов%змін%'
      OR last_error LIKE '%касов%змін%'
      OR last_error LIKE '%SHIFT_REQUIRED%'
      OR last_error LIKE '%SHIFT_INVALID%'
    );
`;

const MIGRATION_019_RETRY_PRODUCT_NUMERIC_SYNC_SQL = `
  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
  WHERE operation_type = 'product.upsert'
    AND status = 'failed'
    AND last_error LIKE '%qty_on_hand%numeric%text%';
`;

const MIGRATION_020_SYNC_QUEUE_RECOVERY_SQL = `
  -- A cancelled local invoice that never reached the server is already in its
  -- correct final state. Do not replay its invalid create/post operations.
  UPDATE sync_outbox
  SET status = 'synced',
      synced_at = COALESCE(synced_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      next_attempt_at = NULL,
      last_error = 'Скасовану локальну накладну не потрібно відправляти на сервер'
  WHERE aggregate_type = 'supply_invoice'
    AND status = 'failed'
    AND EXISTS (
      SELECT 1 FROM supply_invoices invoice
      WHERE invoice.id = sync_outbox.aggregate_id
        AND invoice.tenant_id = sync_outbox.tenant_id
        AND invoice.status = 'cancelled'
    );

  -- Server INSERT previously received the UPDATE-only 24th parameter.
  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
  WHERE operation_type = 'product.upsert'
    AND status = 'failed'
    AND last_error LIKE 'bind message supplies 24 parameters%requires 23';

  -- A posted invoice may legitimately arrive after its cash shift was closed.
  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
  WHERE aggregate_type = 'supply_invoice'
    AND operation_type IN ('supplier_invoice.created', 'supplier_invoice.posted')
    AND status = 'failed'
    AND EXISTS (
      SELECT 1 FROM supply_invoices invoice
      WHERE invoice.id = sync_outbox.aggregate_id
        AND invoice.tenant_id = sync_outbox.tenant_id
        AND invoice.status = 'posted'
    )
    AND (
      last_error LIKE '%Касова зміна%'
      OR last_error LIKE '%Накладну не знайдено%'
      OR last_error LIKE '%SHIFT_REQUIRED%'
    );

  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
  WHERE operation_type = 'return.created'
    AND status = 'failed'
    AND last_error LIKE '%сторнувати комісію%';

  -- This legacy revision has no expected_stock and is older than subsequent
  -- stock changes. Replaying it would overwrite newer balances.
  UPDATE sync_outbox
  SET status = 'synced',
      synced_at = COALESCE(synced_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      next_attempt_at = NULL,
      last_error = 'Застарілу ревізію без базового залишку пропущено без повторного застосування'
  WHERE operation_type = 'inventory.completed'
    AND status = 'failed'
    AND last_error LIKE '%не містить базового залишку%';

  -- Old desktop builds created provisional employees without a server password.
  -- Current staff creation is server-first and remaps the local record safely.
  UPDATE sync_outbox
  SET status = 'synced',
      synced_at = COALESCE(synced_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      next_attempt_at = NULL,
      last_error = 'Старий локальний запис працівника залишено локально; нові працівники створюються через сервер'
  WHERE operation_type IN ('staff_user.created', 'staff_user.updated')
    AND status = 'failed'
    AND attempts >= 30;

  UPDATE staff_users
  SET dirty_at = NULL
  WHERE dirty_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM sync_outbox operation
      WHERE operation.aggregate_type = 'staff_user'
        AND operation.aggregate_id = staff_users.id
        AND operation.status IN ('pending', 'sending', 'failed')
    );
`;
const MIGRATION_022_TIRE_CASH_HANDOVER_SQL = `
  ALTER TABLE cash_operations ADD COLUMN work_date TEXT;
  CREATE INDEX IF NOT EXISTS idx_cash_operations_tire_handover
    ON cash_operations(tenant_id, employee_id, work_date, created_at DESC)
    WHERE type = 'cash_in' AND employee_id IS NOT NULL AND work_date IS NOT NULL;
`;
const MIGRATION_021_LEGACY_QUEUE_CLEANUP_SQL = `
  -- Revisions created by legacy builds did not record expected_stock. Applying
  -- them now could overwrite balances changed by newer sales or revisions.
  UPDATE sync_outbox
  SET status = 'synced',
      synced_at = COALESCE(synced_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      next_attempt_at = NULL,
      last_error = 'Застарілу ревізію без базового залишку пропущено без повторного застосування'
  WHERE operation_type = 'inventory.completed'
    AND status IN ('pending', 'failed')
    AND json_valid(payload_json)
    AND EXISTS (
      SELECT 1
      FROM json_each(json_extract(sync_outbox.payload_json, '$.items')) item
      WHERE json_type(item.value, '$.expected_stock') IS NULL
    );

  -- The return can be replayed safely after the server-side commission fix.
  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
  WHERE operation_type = 'return.created'
    AND status = 'failed'
    AND last_error LIKE '%сторнувати комісію%';
`;

const MIGRATION_023_PROBLEM_LOG_SQL = `
  -- Каса мовчала про свої збої: помилки синхронізації, друку й ПРРО жили тільки
  -- в консолі розробника, а після 30 спроб операція ставала dead-letter без сліду.
  -- Журнал збирає їх в одному місці, згортаючи повтори однієї й тієї ж проблеми.
  CREATE TABLE IF NOT EXISTS problem_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    source TEXT NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'error',
    title TEXT NOT NULL,
    detail TEXT,
    entity_type TEXT,
    entity_id TEXT,
    context_json TEXT,
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT
  );

  -- Одна відкрита проблема на сутність: повтор інкрементує лічильник,
  -- а не засмічує список тисячею однакових рядків.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_problem_log_open
    ON problem_log(tenant_id, source, code, COALESCE(entity_type, ''), COALESCE(entity_id, ''))
    WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_problem_log_recent
    ON problem_log(tenant_id, resolved_at, last_seen_at DESC);

  -- Оживлення ланцюжка, який стояв через заборонений касиру brand.upsert:
  -- бренд не долітав -> товар падав на products_brand_id_fkey -> прихід падав
  -- на товарі -> проведення не знаходило накладну. Усі ці операції на сервері
  -- НЕ застосовувались жодного разу, тому повтор нічого не подвоїть.
  UPDATE sync_outbox
  SET status = 'pending', attempts = 0, next_attempt_at = NULL
  WHERE status = 'failed'
    AND last_error IS NOT NULL
    AND (
      (operation_type IN ('brand.upsert', 'category.upsert')
        AND last_error LIKE '%Недостатньо прав%')
      OR last_error LIKE '%products_brand_id_fkey%'
      OR last_error LIKE '%products_category_id_fkey%'
      OR last_error LIKE '%supply_invoice_items_product_id_fkey%'
      OR (operation_type LIKE 'supplier_invoice.%' AND last_error LIKE '%Накладну не знайдено%')
    );
`;

export interface LocalMigration {
  version: number
  sql: string
}

export const LOCAL_MIGRATIONS: LocalMigration[] = [
  { version: 1, sql: MIGRATION_001_CORE_SQL },
  { version: 2, sql: MIGRATION_002_BUSINESS_SQL },
  { version: 3, sql: MIGRATION_003_SUPPLY_INVOICES_SQL },
  { version: 4, sql: MIGRATION_004_CUSTOMER_DEPOSITS_SQL },
  { version: 5, sql: MIGRATION_005_RETURNS_SQL },
  { version: 6, sql: MIGRATION_006_BONUS_TRANSACTIONS_SQL },
  { version: 7, sql: MIGRATION_007_WAREHOUSE_OPERATIONS_SQL },
  { version: 8, sql: MIGRATION_008_LOCAL_STAFF_SQL },
  { version: 9, sql: MIGRATION_009_REPAIR_CUSTOMER_ORDERS_SQL },
  { version: 10, sql: MIGRATION_010_CUSTOMER_BIRTH_DATE_SQL },
  { version: 11, sql: MIGRATION_011_ORDER_SALE_LINK_SQL },
  { version: 12, sql: MIGRATION_012_FISCAL_SALE_INTENTS_SQL },
  { version: 13, sql: MIGRATION_013_FISCAL_RETURN_INTENTS_SQL },
  { version: 14, sql: MIGRATION_014_SUPPLIER_CATALOG_SQL },
  { version: 15, sql: MIGRATION_015_STOCK_INTEGRITY_SQL },
  { version: 16, sql: MIGRATION_016_FINANCIAL_INTEGRITY_SQL },
  { version: 17, sql: MIGRATION_017_DOCUMENT_INTEGRITY_SQL },
  { version: 18, sql: MIGRATION_018_CUSTOMER_LOYALTY_SALARY_INTEGRITY_SQL },
  { version: 19, sql: MIGRATION_019_RETRY_PRODUCT_NUMERIC_SYNC_SQL },
  { version: 20, sql: MIGRATION_020_SYNC_QUEUE_RECOVERY_SQL },
  { version: 21, sql: MIGRATION_021_LEGACY_QUEUE_CLEANUP_SQL },
  { version: 22, sql: MIGRATION_022_TIRE_CASH_HANDOVER_SQL },
  { version: 23, sql: MIGRATION_023_PROBLEM_LOG_SQL },
]
