export const SUPPLIER_CATALOG_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS supplier_price_imports (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'add' CHECK (mode IN ('replace', 'add')),
    warehouse_name TEXT,
    status TEXT NOT NULL DEFAULT 'completed'
      CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    total_rows INTEGER NOT NULL DEFAULT 0,
    processed_rows INTEGER NOT NULL DEFAULT 0,
    errors_json TEXT NOT NULL DEFAULT '[]',
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_supplier_price_imports_history
    ON supplier_price_imports(tenant_id, created_at DESC)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS supplier_price_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    sku TEXT NOT NULL,
    barcode TEXT,
    brand TEXT,
    name TEXT NOT NULL,
    price_kopecks INTEGER NOT NULL DEFAULT 0,
    qty NUMERIC NOT NULL DEFAULT 0,
    warehouse_name TEXT,
    matched_product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    match_kind TEXT CHECK (match_kind IS NULL OR match_kind IN ('barcode', 'sku', 'name')),
    match_error TEXT,
    search_text TEXT NOT NULL DEFAULT '',
    remote_updated_at TEXT,
    dirty_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_supplier_price_items_scope
    ON supplier_price_items(tenant_id, supplier_id, warehouse_name, updated_at DESC)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_supplier_price_items_barcode
    ON supplier_price_items(tenant_id, barcode)
    WHERE deleted_at IS NULL AND barcode IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_supplier_price_items_sku
    ON supplier_price_items(tenant_id, sku)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_supplier_price_items_search
    ON supplier_price_items(tenant_id, search_text)
    WHERE deleted_at IS NULL;
`
