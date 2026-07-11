const fs = require('node:fs');
const path = require('node:path');

const { LocalDatabase } = require('../dist/db/localDatabase.js');
const { DEFAULT_TENANT_ID } = require('../dist/db/localTypes.js');
const { LocalBootstrapRepository } = require('../dist/repositories/bootstrapRepository.js');
const { LocalCatalogRepository } = require('../dist/repositories/catalogRepository.js');
const { LocalPosRepository } = require('../dist/repositories/posRepository.js');
const { LocalSyncRepository } = require('../dist/repositories/syncRepository.js');

const baseDir = path.join('C:\\tmp', `forsage-desktop-smoke-${Date.now()}`);
fs.mkdirSync(baseDir, { recursive: true });

async function main() {
  const db = new LocalDatabase(baseDir);
  const bootstrap = new LocalBootstrapRepository(db);
  const catalog = new LocalCatalogRepository(db);
  const pos = new LocalPosRepository(db);
  const sync = new LocalSyncRepository(db);

  const bootstrapResult = bootstrap.importSnapshot({
    exported_at: new Date().toISOString(),
    tenant_id: DEFAULT_TENANT_ID,
    staff: [{ id: 'smoke-cashier', full_name: 'Smoke Cashier', role: 'cashier', is_active: true }],
    brands: [{ id: 'smoke-brand-1', name: 'Smoke Brand' }],
    categories: [{ id: 'smoke-category-1', name: 'Smoke Category', parent_id: null, sort_order: 1 }],
    suppliers: [{ id: 'smoke-supplier-1', name: 'Smoke Supplier', is_active: true }],
    products: [{
      id: 'bootstrap-product-1',
      sku: 'BOOT-001',
      name: 'Bootstrap imported product',
      barcode: '2111111111111',
      brand_id: 'smoke-brand-1',
      category_id: 'smoke-category-1',
      unit: 'шт',
      retail_price: 9900,
      purchase_price: 7000,
      qty_on_hand: 3,
      is_active: true,
      is_service: false,
    }],
    product_barcodes: [{
      id: 'bootstrap-barcode-1',
      product_id: 'bootstrap-product-1',
      barcode: '2111111111111',
      barcode_type: 'ean13',
      is_primary: true,
    }],
    product_aliases: [{ id: 'bootstrap-alias-1', product_id: 'bootstrap-product-1', alias: 'Imported alias' }],
    product_cross_numbers: [{
      id: 'bootstrap-cross-1',
      product_id: 'bootstrap-product-1',
      number: 'OE-BOOT-1',
      brand: 'Smoke OE',
      source: 'smoke',
      number_type: 'oe',
    }],
    customers: [{
      id: 'smoke-customer-1',
      full_name: 'Smoke Customer',
      phone: '+380000000000',
      card_barcode: '900000000001',
    }],
    customer_vehicles: [{
      id: 'smoke-vehicle-1',
      customer_id: 'smoke-customer-1',
      make: 'Daewoo',
      model: 'Lanos',
      year: 2007,
      vin: 'SMOKEVIN000000001',
    }],
  });

  const product = catalog.upsertProduct({
    id: 'smoke-product-1',
    sku: 'SMOKE-001',
    name: 'Smoke test product',
    barcode: '2000000000011',
    retail_price: 12500,
    purchase_price: 8000,
    qty_on_hand: 5,
  });
  const pullResult = sync.applyPullChanges({
    tenant_id: DEFAULT_TENANT_ID,
    cursor: new Date().toISOString(),
    products: [{
      id: 'smoke-product-1',
      tenant_id: DEFAULT_TENANT_ID,
      sku: 'SMOKE-001',
      name: 'Smoke test product updated by pull',
      barcode: '2000000000011',
      retail_price: 13000,
      purchase_price: 8000,
      qty_on_hand: 5,
      is_active: true,
      is_service: false,
      updated_at: new Date().toISOString(),
    }],
    customers: [],
    deleted_product_ids: [],
    deleted_customer_ids: [],
    categories: [],
    brands: [],
    suppliers: [{ id: 'smoke-supplier-1', name: 'Smoke Supplier updated', is_active: true }],
    deleted_supplier_ids: [],
    product_barcodes: [
      {
        id: 'bootstrap-barcode-1',
        product_id: 'bootstrap-product-1',
        barcode: '2111111111111',
        barcode_type: 'ean13',
        is_primary: true,
      },
      {
        id: 'smoke-extra-barcode-1',
        product_id: 'smoke-product-1',
        barcode: '2999999999999',
        barcode_type: 'ean13',
        is_primary: false,
      },
    ],
    product_aliases: [{ id: 'smoke-alias-1', product_id: 'smoke-product-1', alias: 'Smoke pull alias' }],
    product_cross_numbers: [{
      id: 'smoke-cross-1',
      product_id: 'smoke-product-1',
      number: 'OE-SMOKE-PULL',
      brand: 'Smoke OE',
      source: 'pull',
      number_type: 'oe',
    }],
    customer_vehicles: [{
      id: 'smoke-vehicle-1',
      customer_id: 'smoke-customer-1',
      make: 'Daewoo',
      model: 'Lanos',
      year: 2008,
      vin: 'SMOKEVIN000000001',
    }],
    references_included: true,
  });
  const foundByBarcode = catalog.findByBarcode('2000000000011');
  const foundByExtraBarcode = catalog.findByBarcode('2999999999999');
  const importedByBarcode = catalog.findByBarcode('2111111111111');
  const shiftId = pos.openShift({ cashier_id: 'smoke-cashier', opening_cash: 10000 });
  const sale = pos.checkout({
    cashier_id: 'smoke-cashier',
    shift_id: shiftId,
    items: [{ product_id: product.id, qty: 2 }],
    payments: [{ method: 'cash', amount: 26000 }],
  });

  db.prepare(`
    INSERT INTO sync_outbox(
      operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
      operation_type, payload_json, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    'smoke-corrupt-payload',
    DEFAULT_TENANT_ID,
    infoSafeDeviceId(db),
    'sale',
    'smoke-corrupt-sale',
    'sale.completed',
    '{broken-json',
    new Date().toISOString(),
  );
  const pendingAfterCorruptPayload = sync.listPending(10);
  const corruptOutboxRow = db.prepare(`
    SELECT status, attempts, last_error
    FROM sync_outbox
    WHERE operation_id = ?
  `).get('smoke-corrupt-payload');
  if (!pendingAfterCorruptPayload.some((operation) => operation.operation_id !== 'smoke-corrupt-payload')) {
    throw new Error('Corrupt outbox payload blocked valid pending operations');
  }
  if (corruptOutboxRow?.status !== 'failed' || !corruptOutboxRow.last_error) {
    throw new Error('Corrupt outbox payload was not marked as failed');
  }

  const info = db.info();
  const pullState = sync.getPullState();
  const backupPath = await db.backupNow();
  db.close();

  console.log(JSON.stringify({
    baseDir,
    databasePath: info.databasePath,
    deviceId: info.deviceId,
    schemaVersion: info.schemaVersion,
    pendingOperations: info.pendingOperations,
    bootstrapResult,
    pullResult,
    pullState,
    foundByBarcode: foundByBarcode?.id ?? null,
    foundByBarcodeName: foundByBarcode?.name ?? null,
    foundByExtraBarcode: foundByExtraBarcode?.id ?? null,
    importedByBarcode: importedByBarcode?.id ?? null,
    sale,
    pendingAfterCorruptPayload: pendingAfterCorruptPayload.length,
    corruptOutboxRow,
    backupPath,
    backupExists: fs.existsSync(backupPath),
  }, null, 2));
}

function infoSafeDeviceId(db) {
  try {
    return db.info().deviceId;
  } catch {
    return 'smoke-device';
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
