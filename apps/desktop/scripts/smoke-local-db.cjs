const fs = require('node:fs');
const path = require('node:path');

const { LocalDatabase } = require('../dist/db/localDatabase.js');
const { DEFAULT_TENANT_ID } = require('../dist/db/localTypes.js');
const { LocalBootstrapRepository } = require('../dist/repositories/bootstrapRepository.js');
const { LocalCatalogRepository } = require('../dist/repositories/catalogRepository.js');
const { LocalPosRepository } = require('../dist/repositories/posRepository.js');
const { LocalWarehouseRepository } = require('../dist/repositories/warehouseRepository.js');
const { LocalOrderRepository } = require('../dist/repositories/orderRepository.js');
const { LocalStaffRepository } = require('../dist/repositories/staffRepository.js');
const { LocalSyncRepository } = require('../dist/repositories/syncRepository.js');

const baseDir = path.join('C:\\tmp', `forsage-desktop-smoke-${Date.now()}`);
fs.mkdirSync(baseDir, { recursive: true });

async function main() {
  const db = new LocalDatabase(baseDir);
  const bootstrap = new LocalBootstrapRepository(db);
  const catalog = new LocalCatalogRepository(db);
  const pos = new LocalPosRepository(db);
  const warehouse = new LocalWarehouseRepository(db);
  const orders = new LocalOrderRepository(db);
  const staff = new LocalStaffRepository(db);
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
  const updatedCashier = staff.updateUser('smoke-cashier', { phone: '+380000000111', base_rate: 5000, rate_period: 'day' });
  staff.resetPassword('smoke-cashier', 'smoke-pass');
  const localLogin = staff.loginWithPassword('+380000000111', 'smoke-pass');
  let localLoginRejected = false;
  try { staff.loginWithPassword('+380000000111', 'bad-pass'); } catch { localLoginRejected = true; }
  if (localLogin.id !== 'smoke-cashier' || !localLoginRejected) throw new Error('Local password login failed');
  staff.setPin('smoke-cashier', '2468');
  const pinValid = staff.verifyPin('smoke-cashier', '2468');
  const pinInvalid = staff.verifyPin('smoke-cashier', '1111');
  if (!pinValid.valid || pinInvalid.valid) throw new Error('Local PIN verification failed');
  const commissionRule = staff.createCommissionRule({
    user_id: 'smoke-cashier',
    pct_from_revenue: 10,
    pct_from_profit: 0,
    rule_type: 'personal_sales',
  });
  const shiftId = pos.openShift({ cashier_id: 'smoke-cashier', opening_cash: 10000 });
  const saleAmount = product.retail_price * 2;
  const sale = pos.checkout({
    cashier_id: 'smoke-cashier',
    manager_id: 'smoke-cashier',
    shift_id: shiftId,
    items: [{ product_id: product.id, qty: 2 }],
    payments: [{ method: 'cash', amount: saleAmount }],
  });
  const recordedCommissions = staff.recordSaleCommissions(sale.sale_id, DEFAULT_TENANT_ID, 'smoke-cashier');
  if (recordedCommissions.length !== 1 || recordedCommissions[0].amount !== 2500) {
    throw new Error('Local sale commission was not calculated');
  }
  const draftOrder = orders.saveOrder({
    customer_id: 'smoke-customer-1',
    manager_id: 'smoke-cashier',
    source: 'walk_in',
    items: [{
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      source_type: 'warehouse',
      item_type: 'product',
      item_status: 'pending',
      buy_price: product.purchase_price,
      sell_price: product.retail_price,
      qty: 1,
    }],
  });
  const orderPayment = orders.addPayment(draftOrder.id, {
    user_id: 'smoke-cashier',
    amount: product.retail_price,
    method: 'card',
    shift_id: shiftId,
    notes: 'Smoke order full payment',
  });
  const completedOrderResult = orders.completeOrder(draftOrder.id, {
    user_id: 'smoke-cashier',
    shift_id: shiftId,
    payment_method: 'card',
  });
  const completedOrder = orders.getOrder(draftOrder.id);
  const productAfterOrder = catalog.findById(product.id);
  if (orderPayment.order?.total_paid !== product.retail_price) throw new Error('Local order payment was not linked to the order');
  if (!completedOrderResult.data.success || completedOrder?.status !== 'completed') throw new Error('Local order was not completed from cashdesk flow');
  if (!completedOrder.items.every((item) => item.item_status === 'handed')) throw new Error('Local order items were not handed');
  if (productAfterOrder?.qty_on_hand !== 2) throw new Error('Local order completion did not reduce product stock');
  const dailyPayout = staff.dailyPayout({
    employee_id: 'smoke-cashier',
    employee_name: 'Smoke Cashier',
    method: 'cash',
    shift_id: shiftId,
    work_date: new Date().toISOString().slice(0, 10),
    user_id: 'smoke-cashier',
  });
  if (dailyPayout.amount !== 7500) throw new Error('Local daily salary payout has incorrect amount');
  const expectedAfterSalary = pos.getExpectedCash('smoke-cashier');
  if (expectedAfterSalary?.expected_amount !== 27500) throw new Error('Salary payout did not reduce expected cash');
  const shiftReport = pos.getShiftReport('smoke-cashier');
  if (!shiftReport || shiftReport.total_sales !== 1 || shiftReport.by_method.cash !== saleAmount) {
    throw new Error('Local shift report did not include the completed cash sale');
  }
  const closeResult = pos.closeShift('smoke-cashier', 10000 + saleAmount - dailyPayout.amount, 'Smoke close');
  if (pos.getOpenShift('smoke-cashier') !== null) {
    throw new Error('Local shift remained open after closeShift');
  }
  const closeQueued = sync.listPending(100).some((operation) => operation.operation_type === 'shift.closed');
  if (!closeQueued) throw new Error('Local shift close was not queued for synchronization');
  const movement = warehouse.createMovement({
    product_id: product.id,
    qty: 2,
    to_bin: 'A-17',
    note: 'Smoke movement',
    user_id: 'smoke-cashier',
  });
  const reserve = warehouse.createReserve({
    product_id: product.id,
    qty: 1,
    customer_id: 'smoke-customer-1',
    user_id: 'smoke-cashier',
  });
  if (warehouse.listReserves().length !== 1) throw new Error('Local reserve was not created');
  warehouse.releaseReserve(reserve.id);
  if (warehouse.listReserves().length !== 0) throw new Error('Local reserve was not released');
  const writeoff = warehouse.createWriteoff({
    reason: 'damage',
    notes: 'Smoke writeoff',
    user_id: 'smoke-cashier',
    items: [{ product_id: product.id, qty: 1 }],
  });
  const productAfterWarehouse = catalog.findById(product.id);
  if (movement.to_bin !== 'A-17' || productAfterWarehouse?.storage_bin !== 'A-17') {
    throw new Error('Local warehouse movement did not update the storage bin');
  }
  if (productAfterWarehouse?.qty_on_hand !== 1) {
    throw new Error('Local writeoff did not reduce product stock');
  }
  if (writeoff.items?.length !== 1) throw new Error('Local writeoff item was not persisted');

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
  const pendingAfterCorruptPayload = sync.listPending(100);
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
    draftOrder,
    orderPayment,
    completedOrderResult,
    completedOrder,
    productAfterOrder,
    shiftReport,
    closeResult,
    closeQueued,
    updatedCashier,
    localLogin,
    localLoginRejected,
    pinValid,
    pinInvalid,
    commissionRule,
    recordedCommissions,
    dailyPayout,
    expectedAfterSalary,
    movement,
    reserveReleased: true,
    writeoff,
    productAfterWarehouse,
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

