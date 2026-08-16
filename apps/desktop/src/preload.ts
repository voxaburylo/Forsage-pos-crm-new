import { contextBridge, ipcRenderer as electronIpcRenderer } from 'electron'
import { localizeDesktopIpcError } from './ipcError'

const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    try {
      return await electronIpcRenderer.invoke(channel, ...args)
    } catch (error) {
      throw localizeDesktopIpcError(error)
    }
  },
}


contextBridge.exposeInMainWorld('forsageDesktop', {
  auth: {
    login: (phone: string, password: string) => ipcRenderer.invoke('desktop:auth:login', phone, password),
    loginOnline: (phone: string, password: string) => ipcRenderer.invoke('desktop:auth:login-online', phone, password),
    logout: () => ipcRenderer.invoke('desktop:auth:logout'),
  },
  getRuntimeInfo: () => ipcRenderer.invoke('desktop:get-runtime-info'),
  lan: {
    getStatus: () => ipcRenderer.invoke('desktop:lan:get-status'),
    update: (input: unknown) => ipcRenderer.invoke('desktop:lan:update', input),
    test: () => ipcRenderer.invoke('desktop:lan:test'),
  },
  backupNow: () => ipcRenderer.invoke('desktop:backup-now'),
  bootstrap: {
    importSnapshot: (snapshot: unknown) =>
      ipcRenderer.invoke('desktop:bootstrap:import-snapshot', snapshot),
  },
  catalog: {
    findByBarcode: (barcode: string) =>
      ipcRenderer.invoke('desktop:catalog:find-by-barcode', barcode),
    findById: (id: string) =>
      ipcRenderer.invoke('desktop:catalog:find-by-id', id),
    findBySku: (sku: string) =>
      ipcRenderer.invoke('desktop:catalog:find-by-sku', sku),
    listProducts: (options?: unknown) =>
      ipcRenderer.invoke('desktop:catalog:list-products', options),
    listProductBarcodes: () =>
      ipcRenderer.invoke('desktop:catalog:list-product-barcodes'),
    listCategories: () =>
      ipcRenderer.invoke('desktop:catalog:list-categories'),
    listBrands: () =>
      ipcRenderer.invoke('desktop:catalog:list-brands'),
    createCategory: (name: string, sortOrder?: number) =>
      ipcRenderer.invoke('desktop:catalog:create-category', name, sortOrder),
    updateCategory: (id: string, name: string) =>
      ipcRenderer.invoke('desktop:catalog:update-category', id, name),
    deleteCategory: (id: string) =>
      ipcRenderer.invoke('desktop:catalog:delete-category', id),
    createBrand: (name: string, country?: string | null) =>
      ipcRenderer.invoke('desktop:catalog:create-brand', name, country),
    updateBrand: (id: string, input: unknown) =>
      ipcRenderer.invoke('desktop:catalog:update-brand', id, input),
    deleteBrand: (id: string) =>
      ipcRenderer.invoke('desktop:catalog:delete-brand', id),
    generateBarcode: () =>
      ipcRenderer.invoke('desktop:catalog:generate-barcode'),
    listStaff: () =>
      ipcRenderer.invoke('desktop:catalog:list-staff'),
    getSettings: () =>
      ipcRenderer.invoke('desktop:catalog:get-settings'),
    updateSettings: (input: unknown) =>
      ipcRenderer.invoke('desktop:catalog:update-settings', input),
    searchProducts: (query: string, limit?: number) =>
      ipcRenderer.invoke('desktop:catalog:search-products', query, limit),
    upsertProduct: (product: unknown) =>
      ipcRenderer.invoke('desktop:catalog:upsert-product', product),
    saveProduct: (product: unknown, options?: { reuseExistingSku?: boolean }) =>
      ipcRenderer.invoke('desktop:catalog:save-product', product, options),
    savePhoto: (folder: string, bytes: ArrayBuffer) =>
      ipcRenderer.invoke('desktop:catalog:save-photo', folder, bytes),
    deletePhoto: (photoUrl: string) =>
      ipcRenderer.invoke('desktop:catalog:delete-photo', photoUrl),
    deleteProduct: (id: string) =>
      ipcRenderer.invoke('desktop:catalog:delete-product', id),
    listPopular: (limit?: number) =>
      ipcRenderer.invoke('desktop:catalog:list-popular', limit),
    listCrossNumbers: (productId: string) =>
      ipcRenderer.invoke('desktop:catalog:list-cross-numbers', productId),
  },
  supplierCatalog: {
    list: (options?: unknown) =>
      ipcRenderer.invoke('desktop:supplier-catalog:list', options),
    listImports: (tenantId?: string, limit?: number) =>
      ipcRenderer.invoke('desktop:supplier-catalog:list-imports', tenantId, limit),
    getImport: (id: string, tenantId?: string) =>
      ipcRenderer.invoke('desktop:supplier-catalog:get-import', id, tenantId),
    create: (input: unknown) =>
      ipcRenderer.invoke('desktop:supplier-catalog:create', input),
    update: (id: string, input: unknown, tenantId?: string) =>
      ipcRenderer.invoke('desktop:supplier-catalog:update', id, input, tenantId),
    delete: (id: string, tenantId?: string) =>
      ipcRenderer.invoke('desktop:supplier-catalog:delete', id, tenantId),
    importRows: (filename: string, rows: unknown[], options: unknown) =>
      ipcRenderer.invoke('desktop:supplier-catalog:import-rows', filename, rows, options),
  },
  staff: {
    listUsers: () => ipcRenderer.invoke('desktop:staff:list-users'),
    saveServerUser: (input: unknown, password?: string) => ipcRenderer.invoke('desktop:staff:save-server-user', input, password),
    updateUser: (id: string, input: unknown) => ipcRenderer.invoke('desktop:staff:update-user', id, input),
    deleteUser: (id: string) => ipcRenderer.invoke('desktop:staff:delete-user', id),
    saveServerPassword: (id: string, password: string) => ipcRenderer.invoke('desktop:staff:save-server-password', id, password),
    setPin: (userId: string, pin: string) => ipcRenderer.invoke('desktop:staff:set-pin', userId, pin),
    verifyPin: (userId: string, pin: string) => ipcRenderer.invoke('desktop:staff:verify-pin', userId, pin),
    listCommissionRules: () => ipcRenderer.invoke('desktop:staff:list-commission-rules'),
    createCommissionRule: (input: unknown) => ipcRenderer.invoke('desktop:staff:create-commission-rule', input),
    deleteCommissionRule: (id: string) => ipcRenderer.invoke('desktop:staff:delete-commission-rule', id),
    listSalary: (input?: unknown) => ipcRenderer.invoke('desktop:staff:list-salary', input),
    salarySummary: (period?: string) => ipcRenderer.invoke('desktop:staff:salary-summary', period),
    dailySummary: (workDate?: string) => ipcRenderer.invoke('desktop:staff:daily-summary', workDate),
    tireServiceReport: (workDate?: string) => ipcRenderer.invoke('desktop:staff:tire-service-report', workDate),
    tireCashHandover: (input: unknown) => ipcRenderer.invoke('desktop:staff:tire-cash-handover', input),
    createSalary: (input: unknown) => ipcRenderer.invoke('desktop:staff:create-salary', input),
    dailyPayout: (input: unknown) => ipcRenderer.invoke('desktop:staff:daily-payout', input),
    deleteSalary: (id: string) => ipcRenderer.invoke('desktop:staff:delete-salary', id),
  },  warehouse: {
    listMovements: (input?: unknown) => ipcRenderer.invoke('desktop:warehouse:list-movements', input),
    createMovement: (input: unknown) => ipcRenderer.invoke('desktop:warehouse:create-movement', input),
    listReserves: (tenantId?: string) => ipcRenderer.invoke('desktop:warehouse:list-reserves', tenantId),
    createReserve: (input: unknown) => ipcRenderer.invoke('desktop:warehouse:create-reserve', input),
    releaseReserve: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:warehouse:release-reserve', id, tenantId),
    listWriteoffs: (input?: unknown) => ipcRenderer.invoke('desktop:warehouse:list-writeoffs', input),
    getWriteoff: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:warehouse:get-writeoff', id, tenantId),
    createWriteoff: (input: unknown) => ipcRenderer.invoke('desktop:warehouse:create-writeoff', input),
  },
  inventory: {
    listSessions: (input?: unknown) => ipcRenderer.invoke('desktop:inventory:list-sessions', input),
    createSession: (input: unknown) => ipcRenderer.invoke('desktop:inventory:create-session', input),
    startSession: (sessionId: string, input?: unknown) => ipcRenderer.invoke('desktop:inventory:start-session', sessionId, input),
    deleteSession: (sessionId: string, tenantId?: string) => ipcRenderer.invoke('desktop:inventory:delete-session', sessionId, tenantId),
    getSession: (sessionId: string, input?: unknown) => ipcRenderer.invoke('desktop:inventory:get-session', sessionId, input),
    findProduct: (sessionId: string, input: unknown) => ipcRenderer.invoke('desktop:inventory:find-product', sessionId, input),
    count: (sessionId: string, input: unknown) => ipcRenderer.invoke('desktop:inventory:count', sessionId, input),
    scan: (sessionId: string, input: unknown) => ipcRenderer.invoke('desktop:inventory:scan', sessionId, input),
    setItemQty: (sessionId: string, itemId: string, input: unknown) => ipcRenderer.invoke('desktop:inventory:set-item-qty', sessionId, itemId, input),
    removeItem: (sessionId: string, itemId: string, tenantId?: string) => ipcRenderer.invoke('desktop:inventory:remove-item', sessionId, itemId, tenantId),
    labels: (sessionId: string, tenantId?: string) => ipcRenderer.invoke('desktop:inventory:labels', sessionId, tenantId),
    applyPrice: (sessionId: string, input: unknown) => ipcRenderer.invoke('desktop:inventory:apply-price', sessionId, input),
    complete: (sessionId: string, input?: unknown) => ipcRenderer.invoke('desktop:inventory:complete', sessionId, input),
  },
  orders: {
    listReady: (input?: unknown) => ipcRenderer.invoke('desktop:orders:list-ready', input),
    list: (input?: unknown) => ipcRenderer.invoke('desktop:orders:list', input),
    save: (input: unknown, id?: string) => ipcRenderer.invoke('desktop:orders:save', input, id),
    delete: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:delete', id, tenantId),
    updateStatus: (id: string, status: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:update-status', id, status, tenantId),
    updateItemStatus: (orderId: string, itemId: string, status: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:update-item-status', orderId, itemId, status, tenantId),
    cancel: (id: string, input?: unknown) => ipcRenderer.invoke('desktop:orders:cancel', id, input),
    pendingItems: (supplierId: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:pending-items', supplierId, tenantId),
    bulkArrival: (itemIds: string[], tenantId?: string) => ipcRenderer.invoke('desktop:orders:bulk-arrival', itemIds, tenantId),
    get: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:get', id, tenantId),
    listPayments: (orderId: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:list-payments', orderId, tenantId),
    listPaymentsByPeriod: (input?: unknown) => ipcRenderer.invoke('desktop:orders:list-payments-period', input),
    addPayment: (orderId: string, input: unknown) => ipcRenderer.invoke('desktop:orders:add-payment', orderId, input),
    complete: (orderId: string, input?: unknown) => ipcRenderer.invoke('desktop:orders:complete', orderId, input),
  },
  supply: {
    listSuppliers: (input?: unknown) => ipcRenderer.invoke('desktop:supply:list-suppliers', input),
    getSupplier: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:get-supplier', id, tenantId),
    saveSupplier: (input: unknown, id?: string) => ipcRenderer.invoke('desktop:supply:save-supplier', input, id),
    deleteSupplier: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:delete-supplier', id, tenantId),
    mergeSuppliers: (primaryId: string, duplicateId: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:merge-suppliers', primaryId, duplicateId, tenantId),
    getDebts: (tenantId?: string) => ipcRenderer.invoke('desktop:supply:get-debts', tenantId),
    listInvoices: (input?: unknown) => ipcRenderer.invoke('desktop:supply:list-invoices', input),
    getInvoice: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:get-invoice', id, tenantId),
    createInvoice: (input: unknown) => ipcRenderer.invoke('desktop:supply:create-invoice', input),
    createInvoiceFromAi: (input: unknown) => ipcRenderer.invoke('desktop:supply:create-invoice-from-ai', input),
    updateInvoice: (id: string, input: unknown) => ipcRenderer.invoke('desktop:supply:update-invoice', id, input),
    payInvoice: (id: string, input: unknown) => ipcRenderer.invoke('desktop:supply:pay-invoice', id, input),
    postInvoice: (id: string, input?: unknown) => ipcRenderer.invoke('desktop:supply:post-invoice', id, input),
    cancelInvoice: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:cancel-invoice', id, tenantId),
    deleteInvoice: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:delete-invoice', id, tenantId),
  },
  pos: {
    openShift: (input: { cashier_id: string; opening_cash?: number; notes?: string | null }) =>
      ipcRenderer.invoke('desktop:pos:open-shift', input),
    getOpenShift: (cashierId: string) =>
      ipcRenderer.invoke('desktop:pos:get-open-shift', cashierId),
    checkout: (input: unknown) => ipcRenderer.invoke('desktop:pos:checkout', input),
    listSales: (input?: unknown) => ipcRenderer.invoke('desktop:pos:list-sales', input),
    dashboardSummary: (input: unknown) => ipcRenderer.invoke('desktop:pos:dashboard-summary', input),
    soldItemsReport: (input: unknown) => ipcRenderer.invoke('desktop:pos:sold-items-report', input),
    listReturns: (input?: unknown) => ipcRenderer.invoke('desktop:pos:list-returns', input),
    getReturn: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:get-return', id, tenantId),
    getSaleForReturn: (saleId: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:get-sale-for-return', saleId, tenantId),
    createReturn: (input: unknown) => ipcRenderer.invoke('desktop:pos:create-return', input),
    getSale: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:get-sale', id, tenantId),
    calculatePrices: (items: unknown[], tenantId?: string) => ipcRenderer.invoke('desktop:pos:calculate-prices', items, tenantId),
    suspendSale: (input: unknown) => ipcRenderer.invoke('desktop:pos:suspend-sale', input),
    listSuspended: (tenantId?: string) => ipcRenderer.invoke('desktop:pos:list-suspended', tenantId),
    resumeSale: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:resume-sale', id, tenantId),
    confirmResumeSale: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:confirm-resume-sale', id, tenantId),
    discardSuspendedSale: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:discard-suspended-sale', id, tenantId),
    checkSaleAfterPayment: (shiftId: string, after: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:check-sale-after-payment', shiftId, after, tenantId),
    listDebtors: (limit?: number) => ipcRenderer.invoke('desktop:pos:list-debtors', limit),
    searchCustomers: (input?: unknown) => ipcRenderer.invoke('desktop:pos:search-customers', input),
    listCustomers: (input?: unknown) => ipcRenderer.invoke('desktop:pos:list-customers', input),
    findCustomerByBarcode: (barcode: string) =>
      ipcRenderer.invoke('desktop:pos:find-customer-by-barcode', barcode),
    getCustomer: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:get-customer', id, tenantId),
    getCustomerSales: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:get-customer-sales', id, tenantId),
    saveCustomer: (input: unknown, id?: string) => ipcRenderer.invoke('desktop:pos:save-customer', input, id),
    deleteCustomer: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:delete-customer', id, tenantId),
    listCustomerVehicles: (customerId: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:list-customer-vehicles', customerId, tenantId),
    saveCustomerVehicle: (customerId: string, input: unknown, vehicleId?: string) => ipcRenderer.invoke('desktop:pos:save-customer-vehicle', customerId, input, vehicleId),
    deleteCustomerVehicle: (customerId: string, vehicleId: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:delete-customer-vehicle', customerId, vehicleId, tenantId),
    getCustomerDeposit: (customerId: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:get-customer-deposit', customerId, tenantId),
    payDebt: (input: unknown) => ipcRenderer.invoke('desktop:pos:pay-debt', input),
    addCustomerDeposit: (input: unknown) => ipcRenderer.invoke('desktop:pos:add-customer-deposit', input),
    payOutCustomerDeposit: (input: unknown) => ipcRenderer.invoke('desktop:pos:payout-customer-deposit', input),
    createCashOperation: (input: unknown) => ipcRenderer.invoke('desktop:pos:create-cash-operation', input),
    listCashOperations: (shiftId: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:list-cash-operations', shiftId, tenantId),
    cashOperationSummary: (shiftId: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:cash-operation-summary', shiftId, tenantId),
    expectedCash: (cashierId: string) => ipcRenderer.invoke('desktop:pos:expected-cash', cashierId),
    shiftReport: (cashierId: string) => ipcRenderer.invoke('desktop:pos:shift-report', cashierId),
    reconcile: (cashierId: string, actualAmount: number, comment: string | null) =>
      ipcRenderer.invoke('desktop:pos:reconcile', cashierId, actualAmount, comment),
    closeShift: (cashierId: string, actualAmount: number, comment: string | null) =>
      ipcRenderer.invoke('desktop:pos:close-shift', cashierId, actualAmount, comment),
  },
  sync: {
    listPending: (limit?: number) =>
      ipcRenderer.invoke('desktop:sync:list-pending', limit),
    getPullState: () =>
      ipcRenderer.invoke('desktop:sync:get-pull-state'),
    status: () =>
      ipcRenderer.invoke('desktop:sync:status'),
    applyPullChanges: (changes: unknown) =>
      ipcRenderer.invoke('desktop:sync:apply-pull-changes', changes),
    markPullFailed: (error: string) =>
      ipcRenderer.invoke('desktop:sync:mark-pull-failed', error),
    applyPushResults: (results: unknown[]) =>
      ipcRenderer.invoke('desktop:sync:apply-push-results', results),
    markBatchFailed: (sequences: number[], error: string) =>
      ipcRenderer.invoke('desktop:sync:mark-batch-failed', sequences, error),
  },
  print: {
    html: (html: string, options?: unknown) =>
      ipcRenderer.invoke('desktop:print:html', html, options),
    listPrinters: () => ipcRenderer.invoke('desktop:print:list-printers'),
    labelsTspl: (html: string, options: unknown) =>
      ipcRenderer.invoke('desktop:print:labels-tspl', html, options),
  },
  fiscal: {
    pickFolder: (defaultPath?: string) => ipcRenderer.invoke('desktop:fiscal:pick-folder', defaultPath),
    getConfig: () => ipcRenderer.invoke('desktop:fiscal:get-config'),
    setConfig: (update: unknown) => ipcRenderer.invoke('desktop:fiscal:set-config', update),
    registerCom: () => ipcRenderer.invoke('desktop:fiscal:register-com'),
    status: () => ipcRenderer.invoke('desktop:fiscal:status'),
    openShift: () => ipcRenderer.invoke('desktop:fiscal:open-shift'),
    closeShift: () => ipcRenderer.invoke('desktop:fiscal:close-shift'),
    xReport: () => ipcRenderer.invoke('desktop:fiscal:x-report'),
    serviceCash: (amount: number, direction: 'in' | 'out') =>
      ipcRenderer.invoke('desktop:fiscal:service-cash', amount, direction),
    fiscalizeSale: (request: unknown) =>
      ipcRenderer.invoke('desktop:fiscal:fiscalize-sale', request),
    getSaleIntent: (operationId: string) =>
      ipcRenderer.invoke('desktop:fiscal:get-sale-intent', operationId),
    resolveUnknownSale: (operationId: string, resolution: unknown) =>
      ipcRenderer.invoke('desktop:fiscal:resolve-unknown-sale', operationId, resolution),
    fiscalizeReturn: (request: unknown) =>
      ipcRenderer.invoke('desktop:fiscal:fiscalize-return', request),
    listUnresolvedReturns: (scope: unknown) =>
      ipcRenderer.invoke('desktop:fiscal:list-unresolved-returns', scope),
    resumeReturn: (operationId: string, scope: unknown) =>
      ipcRenderer.invoke('desktop:fiscal:resume-return', operationId, scope),
    resolveUnknownReturn: (operationId: string, resolution: unknown) =>
      ipcRenderer.invoke('desktop:fiscal:resolve-unknown-return', operationId, resolution),
    cancelPreparedReturn: (operationId: string, input: unknown) =>
      ipcRenderer.invoke('desktop:fiscal:cancel-prepared-return', operationId, input),
  },
})
