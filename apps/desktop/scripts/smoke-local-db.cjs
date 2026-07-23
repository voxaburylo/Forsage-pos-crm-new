const fs = require('node:fs');
const path = require('node:path');

const { LocalDatabase } = require('../dist/db/localDatabase.js');
const { DEFAULT_TENANT_ID } = require('../dist/db/localTypes.js');
const { LocalBootstrapRepository } = require('../dist/repositories/bootstrapRepository.js');
const { LocalCatalogRepository } = require('../dist/repositories/catalogRepository.js');
const { LocalPosRepository } = require('../dist/repositories/posRepository.js');
const { LocalInventoryRepository } = require('../dist/repositories/inventoryRepository.js');
const { LocalWarehouseRepository } = require('../dist/repositories/warehouseRepository.js');
const { LocalOrderRepository } = require('../dist/repositories/orderRepository.js');
const { LocalStaffRepository } = require('../dist/repositories/staffRepository.js');
const { LocalSyncRepository } = require('../dist/repositories/syncRepository.js');

const baseDir = path.join('C:\\tmp', `forsage-desktop-smoke-${Date.now()}`);
fs.mkdirSync(baseDir, { recursive: true });

function runFiscalIntentSmoke() {
  const fiscalDb = new LocalDatabase(path.join(baseDir, 'fiscal-intents'));
  const bootstrap = new LocalBootstrapRepository(fiscalDb);
  const catalog = new LocalCatalogRepository(fiscalDb);
  let pos = new LocalPosRepository(fiscalDb);

  bootstrap.importSnapshot({
    exported_at: new Date().toISOString(),
    tenant_id: DEFAULT_TENANT_ID,
    staff: [{
      id: 'fiscal-smoke-cashier',
      full_name: 'Fiscal Smoke Cashier',
      role: 'cashier',
      is_active: true,
    }],
  });
  const product = catalog.upsertProduct({
    id: 'fiscal-smoke-product',
    sku: 'FISCAL-SMOKE',
    name: 'Fiscal safety product',
    barcode: '2777777777777',
    retail_price: 1500,
    purchase_price: 900,
    qty_on_hand: 3,
  });
  const shiftId = pos.openShift({
    cashier_id: 'fiscal-smoke-cashier',
    opening_cash: 0,
  });
  const saleOperationId = 'fiscal-smoke-sale-operation';
  const checkout = {
    tenant_id: DEFAULT_TENANT_ID,
    client_operation_id: saleOperationId,
    cashier_id: 'fiscal-smoke-cashier',
    shift_id: shiftId,
    items: [{ product_id: product.id, qty: 1 }],
    payments: [{ method: 'card', amount: 1500, is_fiscal: true, fiscal_number: null }],
    is_fiscal: true,
    fiscal_number: null,
    fiscal_qr_url: null,
  };
  const saleRequest = {
    operation_id: saleOperationId,
    checkout,
    items: [{
      name: product.name,
      vendor_code: product.sku,
      barcode: product.barcode,
      unit: product.unit,
      qty: 1,
      unit_price: 1500,
      amount: 1500,
      discount: 0,
    }],
    pay: { cash: 0, card: 1500, bank: 0, check_total: 1500 },
  };

  if (pos.prepareFiscalSaleIntent(saleRequest).state !== 'prepared') {
    throw new Error('Fiscal sale intent was not prepared');
  }
  pos.startFiscalSaleIntent(saleOperationId);
  pos = new LocalPosRepository(fiscalDb);
  if (pos.getFiscalSaleIntent(saleOperationId).state !== 'unknown') {
    throw new Error('Interrupted fiscal sale was not blocked after restart');
  }
  let unsafeResetRejected = false;
  try {
    pos.resolveUnknownFiscalSaleIntent(saleOperationId, {
      cashalot_checked: false,
      confirmed_by: 'fiscal-smoke-cashier',
      reason: 'Cashalot was not checked',
    });
  } catch {
    unsafeResetRejected = true;
  }
  if (!unsafeResetRejected) {
    throw new Error('Fiscal sale intent could be reset without checking Cashalot');
  }
  pos.resolveUnknownFiscalSaleIntent(saleOperationId, {
    cashalot_checked: true,
    confirmed_by: 'fiscal-smoke-cashier',
    reason: 'Cashalot history checked: receipt does not exist',
  });
  pos.startFiscalSaleIntent(saleOperationId);
  pos.markFiscalSaleIntentFiscalized(saleOperationId, {
    ReceiptFiscalNum: 'FISC-SALE-1',
    FSKOReceiptLink: 'https://example.invalid/fiscal-sale-1',
  });
  const completedCheckout = {
    ...checkout,
    fiscal_number: 'FISC-SALE-1',
    fiscal_qr_url: 'https://example.invalid/fiscal-sale-1',
    payments: checkout.payments.map((payment) => ({
      ...payment,
      fiscal_number: 'FISC-SALE-1',
    })),
  };
  const sale = pos.checkout(completedCheckout);
  const duplicateSale = pos.checkout(completedCheckout);
  const completedSaleIntent = pos.prepareFiscalSaleIntent(saleRequest);
  const productAfterSale = catalog.findById(product.id);
  const saleCount = fiscalDb.prepare(
    'SELECT COUNT(*) AS count FROM sales WHERE client_operation_id = ?',
  ).get(saleOperationId);
  if (sale.sale_id !== duplicateSale.sale_id || completedSaleIntent.state !== 'completed'
    || productAfterSale?.qty_on_hand !== 2 || saleCount?.count !== 1) {
    throw new Error('Fiscal sale retry duplicated the sale or stock movement');
  }

  const returnable = pos.getSaleForReturn(sale.sale_id);
  const returnOperationId = 'fiscal-smoke-return-operation';
  const returnInput = {
    tenant_id: DEFAULT_TENANT_ID,
    sale_id: sale.sale_id,
    approved_by: 'fiscal-smoke-cashier',
    shift_id: shiftId,
    reason: 'other',
    reason_note: 'Fiscal smoke return',
    refund_method: 'card',
    stock_action: 'return_to_stock',
    items: [{
      sale_item_id: returnable.items[0].id,
      product_id: product.id,
      quantity: 1,
      condition: 'good',
    }],
  };
  const returnRequest = {
    operation_id: returnOperationId,
    return_input: returnInput,
    original_fiscal_number: 'FISC-SALE-1',
    items: [{
      name: product.name,
      vendor_code: product.sku,
      barcode: product.barcode,
      unit: product.unit,
      qty: 1,
      unit_price: 1500,
      amount: 1500,
      discount: 0,
    }],
    pay: { cash: 0, card: 1500, bank: 0, check_total: 1500 },
  };

  const cancelledOperationId = 'fiscal-smoke-cancelled-return';
  const cancelledRequest = {
    ...returnRequest,
    operation_id: cancelledOperationId,
  };
  pos.prepareFiscalReturnIntent(cancelledRequest);
  const preparedReturns = pos.listUnresolvedFiscalReturnIntents({
    cashier_id: 'fiscal-smoke-cashier',
  });
  const hiddenFromOtherCashier = pos.listUnresolvedFiscalReturnIntents({
    cashier_id: 'different-cashier',
  });
  if (preparedReturns.length !== 1 || preparedReturns[0].operation_id !== cancelledOperationId
    || preparedReturns[0].state !== 'prepared' || preparedReturns[0].can_cancel !== true
    || hiddenFromOtherCashier.length !== 0) {
    throw new Error('Prepared fiscal return recovery list is not cashier-scoped');
  }
  let duplicateReturnFromOtherCashierRejected = false;
  try {
    pos.prepareFiscalReturnIntent({
      ...returnRequest,
      operation_id: 'fiscal-smoke-other-cashier-return',
      return_input: {
        ...returnInput,
        approved_by: 'different-cashier',
      },
    });
  } catch (error) {
    duplicateReturnFromOtherCashierRejected = String(error?.message || error)
      .startsWith('FISCAL_RETURN_PENDING|');
  }
  if (!duplicateReturnFromOtherCashierRejected) {
    throw new Error('Another cashier could prepare a duplicate fiscal return');
  }
  const stockBeforeCancel = catalog.findById(product.id)?.qty_on_hand;
  pos.cancelPreparedFiscalReturnIntent(cancelledOperationId, {
    cashier_id: 'fiscal-smoke-cashier',
    confirmed_by: 'fiscal-smoke-cashier',
    reason: 'Cashier cancelled the prepared return before Cashalot',
  });
  const cancelledIntentCount = fiscalDb.prepare(
    'SELECT COUNT(*) AS count FROM fiscal_sale_intents WHERE operation_id = ?',
  ).get(cancelledOperationId);
  const returnsAfterCancel = fiscalDb.prepare(
    'SELECT COUNT(*) AS count FROM customer_returns',
  ).get();
  if (cancelledIntentCount?.count !== 0 || returnsAfterCancel?.count !== 0
    || catalog.findById(product.id)?.qty_on_hand !== stockBeforeCancel) {
    throw new Error('Cancelling a prepared fiscal return changed stock or created a return');
  }

  pos.prepareFiscalReturnIntent(returnRequest);
  pos.startFiscalSaleIntent(returnOperationId);
  pos = new LocalPosRepository(fiscalDb);
  if (pos.getFiscalSaleIntent(returnOperationId).state !== 'unknown') {
    throw new Error('Interrupted fiscal return was not blocked after restart');
  }
  const unknownReturns = pos.listUnresolvedFiscalReturnIntents({
    cashier_id: 'fiscal-smoke-cashier',
  });
  if (unknownReturns.length !== 1 || unknownReturns[0].state !== 'unknown'
    || unknownReturns[0].can_cancel !== false) {
    throw new Error('Interrupted fiscal return is missing from startup recovery');
  }
  let unsafeReturnCancelRejected = false;
  try {
    pos.cancelPreparedFiscalReturnIntent(returnOperationId, {
      cashier_id: 'fiscal-smoke-cashier',
      confirmed_by: 'fiscal-smoke-cashier',
      reason: 'Unsafe cancellation after Cashalot request was started',
    });
  } catch {
    unsafeReturnCancelRejected = true;
  }
  if (!unsafeReturnCancelRejected) {
    throw new Error('Unknown fiscal return could be cancelled without resolution');
  }
  pos.resolveUnknownFiscalReturnIntent(returnOperationId, {
    cashier_id: 'fiscal-smoke-cashier',
    cashalot_checked: true,
    confirmed_by: 'fiscal-smoke-cashier',
    reason: 'Cashalot history checked: return receipt does not exist',
  });
  pos.startFiscalSaleIntent(returnOperationId);
  pos.markFiscalSaleIntentFiscalized(returnOperationId, {
    ReceiptFiscalNum: 'FISC-RETURN-1',
  });
  pos = new LocalPosRepository(fiscalDb);
  const fiscalizedReturns = pos.listUnresolvedFiscalReturnIntents({
    cashier_id: 'fiscal-smoke-cashier',
  });
  if (fiscalizedReturns.length !== 1 || fiscalizedReturns[0].state !== 'fiscalized'
    || fiscalizedReturns[0].can_cancel !== false) {
    throw new Error('Fiscalized return is not available for local-only recovery');
  }
  const recoveredRequest = pos.getFiscalReturnRequest(returnOperationId, {
    cashier_id: 'fiscal-smoke-cashier',
  });
  if (recoveredRequest.operation_id !== returnOperationId
    || recoveredRequest.original_fiscal_number !== 'FISC-SALE-1') {
    throw new Error('Stored fiscal return request could not be restored after restart');
  }
  const returnResult = pos.createReturn({
    ...recoveredRequest.return_input,
    client_operation_id: returnOperationId,
    is_fiscal: true,
    fiscal_number: 'FISC-RETURN-1',
  });
  const duplicateReturn = pos.createReturn({
    ...recoveredRequest.return_input,
    client_operation_id: returnOperationId,
    is_fiscal: true,
    fiscal_number: 'FISC-RETURN-1',
  });
  const completedReturnIntent = pos.prepareFiscalReturnIntent(returnRequest);
  const productAfterReturn = catalog.findById(product.id);
  const returnCount = fiscalDb.prepare(
    'SELECT COUNT(*) AS count FROM customer_returns WHERE client_operation_id = ?',
  ).get(returnOperationId);
  if (returnResult.id !== duplicateReturn.id || completedReturnIntent.state !== 'completed'
    || productAfterReturn?.qty_on_hand !== 3 || returnCount?.count !== 1) {
    throw new Error('Fiscal return retry duplicated the return or stock movement');
  }
  if (pos.listUnresolvedFiscalReturnIntents({
    cashier_id: 'fiscal-smoke-cashier',
  }).length !== 0) {
    throw new Error('Completed fiscal return remained in startup recovery');
  }

  return {
    sale_id: sale.sale_id,
    return_id: returnResult.id,
    interrupted_sale_blocked: true,
    interrupted_return_blocked: true,
    prepared_return_cancel_safe: true,
    unresolved_return_cashier_scoped: true,
    duplicate_return_cross_cashier_blocked: true,
    fiscalized_return_recovered_once: true,
  };
}

async function main() {
  const db = new LocalDatabase(baseDir);
  const bootstrap = new LocalBootstrapRepository(db);
  const catalog = new LocalCatalogRepository(db);
  const pos = new LocalPosRepository(db);
  const inventory = new LocalInventoryRepository(db);
  const warehouse = new LocalWarehouseRepository(db);
  const orders = new LocalOrderRepository(db);
  const staff = new LocalStaffRepository(db);
  const sync = new LocalSyncRepository(db);
  const fiscalSafety = runFiscalIntentSmoke();

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
  const serviceProduct = catalog.upsertProduct({
    id: 'smoke-service-1',
    sku: 'SMOKE-SERVICE',
    name: 'Smoke service',
    retail_price: 3000,
    purchase_price: 0,
    qty_on_hand: 0,
    is_service: true,
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
  const maskedPurchasePullResult = sync.applyPullChanges({
    tenant_id: DEFAULT_TENANT_ID,
    cursor: new Date().toISOString(),
    products: [{
      id: 'bootstrap-product-1',
      tenant_id: DEFAULT_TENANT_ID,
      sku: 'BOOT-001',
      name: 'Bootstrap product without privileged fields',
      barcode: '2111111111111',
      retail_price: 10100,
      qty_on_hand: 3,
      is_active: true,
      is_service: false,
      updated_at: new Date().toISOString(),
    }],
  });
  const maskedPurchaseProduct = catalog.findById('bootstrap-product-1');
  if (maskedPurchaseProduct?.purchase_price !== 7000) {
    throw new Error('Restricted product pull erased the local purchase price');
  }
  const remoteCostTimestamp = new Date().toISOString();
  sync.applyPullChanges({
    tenant_id: DEFAULT_TENANT_ID,
    cursor: remoteCostTimestamp,
    shifts: [{
      id: 'smoke-remote-shift-cost',
      cashier_id: 'smoke-cashier',
      status: 'closed',
      opening_cash: 0,
      opened_at: remoteCostTimestamp,
      closed_at: remoteCostTimestamp,
      created_at: remoteCostTimestamp,
    }],
    sales: [{
      id: 'smoke-remote-sale-cost',
      sale_number: 'REMOTE-COST-1',
      cashier_id: 'smoke-cashier',
      shift_id: 'smoke-remote-shift-cost',
      status: 'completed',
      total: 10100,
      payment_method: 'cash',
      cash_amount: 10100,
      completed_at: remoteCostTimestamp,
      created_at: remoteCostTimestamp,
      updated_at: remoteCostTimestamp,
    }],
    sale_items: [{
      id: 'smoke-remote-sale-item-cost',
      sale_id: 'smoke-remote-sale-cost',
      product_id: 'bootstrap-product-1',
      qty: 1,
      unit_price: 10100,
      total: 10100,
      cost_price: 7000,
      created_at: remoteCostTimestamp,
    }],
    customer_orders: [{
      id: 'smoke-remote-order-cost',
      order_number: 'REMOTE-ORDER-COST-1',
      customer_id: 'smoke-customer-1',
      manager_id: 'smoke-cashier',
      status: 'ready',
      total_amount: 10100,
      total_paid: 0,
      created_at: remoteCostTimestamp,
      updated_at: remoteCostTimestamp,
    }],
    customer_order_items: [{
      id: 'smoke-remote-order-item-cost',
      order_id: 'smoke-remote-order-cost',
      product_id: 'bootstrap-product-1',
      name: 'Bootstrap imported product',
      sku: 'BOOT-001',
      source_type: 'warehouse',
      item_type: 'product',
      item_status: 'ready',
      buy_price: 6500,
      sell_price: 10100,
      qty: 1,
      created_at: remoteCostTimestamp,
      updated_at: remoteCostTimestamp,
    }],
  });
  sync.applyPullChanges({
    tenant_id: DEFAULT_TENANT_ID,
    cursor: new Date().toISOString(),
    sale_items: [{
      id: 'smoke-remote-sale-item-cost',
      sale_id: 'smoke-remote-sale-cost',
      product_id: 'bootstrap-product-1',
      qty: 1,
      unit_price: 10100,
      total: 10100,
      created_at: remoteCostTimestamp,
    }],
    customer_orders: [{
      id: 'smoke-remote-order-cost',
      order_number: 'REMOTE-ORDER-COST-1',
      customer_id: 'smoke-customer-1',
      manager_id: 'smoke-cashier',
      status: 'ready',
      total_amount: 10100,
      total_paid: 0,
      created_at: remoteCostTimestamp,
      updated_at: new Date().toISOString(),
    }],
    customer_order_items: [{
      id: 'smoke-remote-order-item-cost',
      order_id: 'smoke-remote-order-cost',
      product_id: 'bootstrap-product-1',
      name: 'Bootstrap imported product',
      sku: 'BOOT-001',
      source_type: 'warehouse',
      item_type: 'product',
      item_status: 'ready',
      sell_price: 10100,
      qty: 1,
      created_at: remoteCostTimestamp,
      updated_at: new Date().toISOString(),
    }],
  });
  const preservedSaleCost = db.prepare('SELECT purchase_price FROM sale_items WHERE id = ?')
    .get('smoke-remote-sale-item-cost');
  const preservedOrderCost = db.prepare('SELECT buy_price FROM customer_order_items WHERE id = ?')
    .get('smoke-remote-order-item-cost');
  if (preservedSaleCost?.purchase_price !== 7000 || preservedOrderCost?.buy_price !== 6500) {
    throw new Error('Masked cashier pull erased historical purchase cost');
  }
  sync.applyPullChanges({
    tenant_id: DEFAULT_TENANT_ID,
    cursor: new Date().toISOString(),
    stock_reserves: [{
      id: 'smoke-remote-reserve-1',
      tenant_id: DEFAULT_TENANT_ID,
      product_id: 'bootstrap-product-1',
      customer_id: 'smoke-customer-1',
      qty: 2,
      reserved_by: 'smoke-cashier',
      created_at: new Date().toISOString(),
    }],
    stock_reserves_snapshot_included: true,
  });
  const productWithRemoteReserve = catalog.findById('bootstrap-product-1');
  if (productWithRemoteReserve?.qty_reserved !== 2 || productWithRemoteReserve?.qty_available !== 1) {
    throw new Error('Remote reserve was not reflected in local available stock');
  }

  sync.applyPullChanges({
    tenant_id: DEFAULT_TENANT_ID,
    cursor: new Date().toISOString(),
    stock_reserves: [{
      id: 'smoke-remote-reserve-1',
      tenant_id: DEFAULT_TENANT_ID,
      product_id: 'bootstrap-product-1',
      customer_id: 'smoke-customer-1',
      qty: 2,
      reserved_by: 'smoke-cashier',
      released_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }],
  });
  const staleReferenceProduct = catalog.saveProduct({
    id: 'smoke-stale-reference-product',
    sku: 'STALE-REF-001',
    name: 'Stale reference product',
    category_id: 'missing-category-id',
    brand_id: 'missing-brand-id',
    retail_price: 1000,
    purchase_price: 500,
    qty_on_hand: 1,
  });
  const staleReferencePayloadRow = db.prepare(`
    SELECT payload_json FROM sync_outbox
    WHERE aggregate_id = ? AND operation_type = 'product.upsert'
    ORDER BY created_at DESC LIMIT 1
  `).get(staleReferenceProduct.id);
  const staleReferencePayload = JSON.parse(staleReferencePayloadRow?.payload_json ?? '{}');
  const phantomCategories = db.prepare('SELECT COUNT(*) AS count FROM categories WHERE id = ?')
    .get('missing-category-id');
  if (staleReferenceProduct.category_id !== null || staleReferenceProduct.brand_id !== null
    || staleReferencePayload.category_id !== null || staleReferencePayload.brand_id !== null
    || phantomCategories?.count !== 0) {
    throw new Error('Stale product references created a phantom category/brand or leaked to outbox');
  }
  const foundByBarcode = catalog.findByBarcode('2000000000011');
  const foundByExtraBarcode = catalog.findByBarcode('2999999999999');
  const importedByBarcode = catalog.findByBarcode('2111111111111');
  const updatedCashier = staff.updateUser('smoke-cashier', { phone: '+380000000111', base_rate: 5000, rate_period: 'day' });
  staff.saveServerPassword('smoke-cashier', 'smoke-pass');
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
  const orderSaleAmount = product.retail_price + serviceProduct.retail_price;
  const draftOrder = orders.saveOrder({
    customer_id: 'smoke-customer-1',
    manager_id: 'smoke-cashier',
    source: 'walk_in',
    items: [{
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      source_type: 'supplier',
      item_type: 'product',
      item_status: 'pending',
      buy_price: product.purchase_price,
      sell_price: product.retail_price,
      qty: 1,
    }, {
      product_id: serviceProduct.id,
      sku: serviceProduct.sku,
      name: serviceProduct.name,
      source_type: 'supplier',
      item_type: 'service',
      item_status: 'pending',
      buy_price: serviceProduct.purchase_price,
      sell_price: serviceProduct.retail_price,
      qty: 1,
    }],
  });
  const orderPaymentId = '88888888-8888-4888-8888-888888888888';
  const orderPaymentInput = {
    payment_id: orderPaymentId,
    user_id: 'smoke-cashier',
    amount: orderSaleAmount,
    method: 'card',
    shift_id: shiftId,
    notes: 'Smoke order full payment',
  };
  const orderPayment = orders.addPayment(draftOrder.id, orderPaymentInput);
  const completedOrderResult = orders.completeOrder(draftOrder.id, {
    user_id: 'smoke-cashier',
    shift_id: shiftId,
    payment_method: 'card',
  });
  const replayedOrderPayment = orders.addPayment(draftOrder.id, orderPaymentInput);
  const repeatedCompletedOrderResult = orders.completeOrder(draftOrder.id, {
    user_id: 'smoke-cashier',
    shift_id: shiftId,
    payment_method: 'card',
  });
  const completedOrder = orders.getOrder(draftOrder.id);
  const orderPaymentCount = db.prepare('SELECT COUNT(*) AS count FROM order_payments WHERE id = ?').get(orderPaymentId);
  const orderSaleCount = db.prepare('SELECT COUNT(*) AS count FROM sales WHERE id = ?').get(completedOrderResult.data.sale_id);
  const productAfterOrder = catalog.findById(product.id);
  const serviceAfterOrder = catalog.findById(serviceProduct.id);
  const completedSale = db.prepare(`
    SELECT id, sale_number, total, payment_method, cash_amount, card_amount
    FROM sales WHERE id = ? AND tenant_id = ?
  `).get(completedOrderResult.data.sale_id, DEFAULT_TENANT_ID);
  const completedSaleItems = db.prepare(`
    SELECT id, product_id, qty, unit_price, total
    FROM sale_items WHERE sale_id = ? AND tenant_id = ?
  `).all(completedOrderResult.data.sale_id, DEFAULT_TENANT_ID);
  const duplicateSalePayments = db.prepare(`
    SELECT COUNT(*) AS count FROM sale_payments WHERE sale_id = ?
  `).get(completedOrderResult.data.sale_id);
  const duplicateSaleCashOperations = db.prepare(`
    SELECT COUNT(*) AS count FROM cash_operations WHERE sale_id = ?
  `).get(completedOrderResult.data.sale_id);
  if (orderPayment.order?.total_paid !== orderSaleAmount) throw new Error('Local order payment was not linked to the order');
  if (replayedOrderPayment.data?.id !== orderPaymentId || orderPaymentCount?.count !== 1) {
    throw new Error('Retrying a local order payment created a duplicate ledger row');
  }
  if (repeatedCompletedOrderResult.data.sale_id !== completedOrderResult.data.sale_id
    || repeatedCompletedOrderResult.data.sale_number !== completedOrderResult.data.sale_number
    || orderSaleCount?.count !== 1) {
    throw new Error('Retrying local order completion created a duplicate sale');
  }
  if (!completedOrderResult.data.success || completedOrder?.status !== 'completed') throw new Error('Local order was not completed from cashdesk flow');
  if (completedOrder.sale_id !== completedOrderResult.data.sale_id) throw new Error('Completed order was not linked to its local sale');
  if (!completedOrder.items.every((item) => item.item_status === 'handed')) throw new Error('Local order items were not handed');
  if (productAfterOrder?.qty_on_hand !== 2) throw new Error('Local order completion did not reduce product stock');
  if (serviceAfterOrder?.qty_on_hand !== 0) throw new Error('Local order completion changed service stock');
  if (completedSale?.total !== orderSaleAmount || completedSale?.payment_method !== 'card' || completedSale?.card_amount !== orderSaleAmount) {
    throw new Error('Completed order sale has incorrect payment totals');
  }
  if (completedSaleItems.length !== 2
    || !completedSaleItems.some((item) => item.product_id === product.id)
    || !completedSaleItems.some((item) => item.product_id === serviceProduct.id)) {
    throw new Error('Completed order did not create every product and service sale item');
  }
  if (duplicateSalePayments?.count !== 0 || duplicateSaleCashOperations?.count !== 0) {
    throw new Error('Completed order duplicated already-recorded payment operations');
  }
  const unlinkedOrder = orders.saveOrder({
    customer_id: 'smoke-customer-1',
    manager_id: 'smoke-cashier',
    source: 'walk_in',
    items: [{
      product_id: null,
      sku: null,
      name: 'Unlinked smoke item',
      source_type: 'supplier',
      item_type: 'product',
      item_status: 'pending',
      buy_price: 0,
      sell_price: 0,
      qty: 1,
    }],
  });
  let unlinkedOrderError = '';
  try {
    orders.completeOrder(unlinkedOrder.id, { user_id: 'smoke-cashier', shift_id: shiftId });
  } catch (error) {
    unlinkedOrderError = String(error?.message ?? error);
  }
  if (!unlinkedOrderError.includes("Не прив'язано до картки товару")) {
    throw new Error('Unlinked order item did not produce the Ukrainian explanation');
  }
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
  if (!shiftReport || shiftReport.total_sales !== 2 || shiftReport.by_method.cash !== saleAmount
    || shiftReport.by_method.card !== orderSaleAmount) {
    throw new Error('Local shift report did not include both POS and completed-order sales');
  }
  const closeResult = pos.closeShift('smoke-cashier', 10000 + saleAmount - dailyPayout.amount, 'Smoke close');
  if (pos.getOpenShift('smoke-cashier') !== null) {
    throw new Error('Local shift remained open after closeShift');
  }
  const closeQueued = sync.listPending(100).some((operation) => operation.operation_type === 'shift.closed');
  if (!closeQueued) throw new Error('Local shift close was not queued for synchronization');
  const noShiftOrder = orders.saveOrder({
    customer_id: 'smoke-customer-1',
    manager_id: 'smoke-cashier',
    source: 'walk_in',
    items: [{
      product_id: null,
      sku: null,
      name: 'Cash payment without shift',
      source_type: 'supplier',
      item_type: 'product',
      item_status: 'pending',
      buy_price: 500,
      sell_price: 1000,
      qty: 1,
    }],
  });
  const noShiftPaymentId = '99999999-9999-4999-8999-999999999999';
  let noShiftPaymentError = '';
  try {
    orders.addPayment(noShiftOrder.id, {
      payment_id: noShiftPaymentId,
      user_id: 'smoke-cashier',
      amount: 1000,
      method: 'cash',
      shift_id: null,
    });
  } catch (error) {
    noShiftPaymentError = String(error?.message ?? error);
  }
  const noShiftPaymentCount = db.prepare('SELECT COUNT(*) AS count FROM order_payments WHERE id = ?').get(noShiftPaymentId);
  const noShiftCashCount = db.prepare('SELECT COUNT(*) AS count FROM cash_operations WHERE id = ?').get(noShiftPaymentId);
  if (!noShiftPaymentError.includes('відкрийте касову зміну')
    || noShiftPaymentCount?.count !== 0 || noShiftCashCount?.count !== 0) {
    throw new Error('Cash order payment without an open shift wrote a partial movement');
  }
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

  const zeroInventoryProduct = catalog.upsertProduct({
    id: 'smoke-inventory-zero',
    sku: 'INV-ZERO',
    name: 'Inventory intentional zero',
    retail_price: 1000,
    purchase_price: 500,
    qty_on_hand: 7,
  });
  const removedInventoryProduct = catalog.upsertProduct({
    id: 'smoke-inventory-removed',
    sku: 'INV-REMOVED',
    name: 'Inventory removed row',
    retail_price: 1000,
    purchase_price: 500,
    qty_on_hand: 9,
  });
  const inventorySession = inventory.createSession({ name: 'Smoke inventory', created_by: 'smoke-cashier' });
  inventory.startSession(inventorySession.id, { user_id: 'smoke-cashier' });
  const zeroCount = inventory.countProduct(inventorySession.id, {
    user_id: 'smoke-cashier',
    product_id: zeroInventoryProduct.id,
    qty: 1,
    price_checked: true,
  });
  inventory.setItemQty(inventorySession.id, zeroCount.data.item_id, { counted_stock: 0 });
  const removedCount = inventory.countProduct(inventorySession.id, {
    user_id: 'smoke-cashier',
    product_id: removedInventoryProduct.id,
    qty: 1,
    price_checked: true,
  });
  const sessionBeforeRemoval = inventory.getSessionData(inventorySession.id);
  if (!sessionBeforeRemoval.items.some((item) => item.id === zeroCount.data.item_id && item.counted_stock === 0)) {
    throw new Error('Intentional zero disappeared from active inventory');
  }
  inventory.removeItem(inventorySession.id, removedCount.data.item_id);
  const inventoryComplete = inventory.complete(inventorySession.id, { user_id: 'smoke-cashier' });
  const zeroInventoryAfter = catalog.findById(zeroInventoryProduct.id);
  const removedInventoryAfter = catalog.findById(removedInventoryProduct.id);
  const inventoryOutboxRow = db.prepare(`
    SELECT payload_json FROM sync_outbox
    WHERE aggregate_id = ? AND operation_type = 'inventory.completed'
    ORDER BY created_at DESC LIMIT 1
  `).get(inventorySession.id);
  const inventoryOutboxPayload = JSON.parse(inventoryOutboxRow?.payload_json ?? '{}');
  if (inventoryComplete.items_updated !== 1 || zeroInventoryAfter?.qty_on_hand !== 0
    || removedInventoryAfter?.qty_on_hand !== 9
    || inventoryOutboxPayload.items?.length !== 1
    || inventoryOutboxPayload.items[0]?.product_id !== zeroInventoryProduct.id
    || inventoryOutboxPayload.items[0]?.counted_stock !== 0) {
    throw new Error('Inventory zero/removal semantics are incorrect');
  }
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
    serviceAfterOrder,
    completedSale,
    completedSaleItems,
    duplicateSalePayments,
    duplicateSaleCashOperations,
    unlinkedOrderError,
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
    productWithRemoteReserve,
    staleReferenceProduct,
    inventoryComplete,
    zeroInventoryAfter,
    fiscalSafety,
    removedInventoryAfter,
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

