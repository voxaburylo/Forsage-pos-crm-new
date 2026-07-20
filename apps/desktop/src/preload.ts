import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('forsageDesktop', {
  getRuntimeInfo: () => ipcRenderer.invoke('desktop:get-runtime-info'),
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
    listProducts: (options?: unknown) =>
      ipcRenderer.invoke('desktop:catalog:list-products', options),
    searchProducts: (query: string, limit?: number) =>
      ipcRenderer.invoke('desktop:catalog:search-products', query, limit),
    upsertProduct: (product: unknown) =>
      ipcRenderer.invoke('desktop:catalog:upsert-product', product),
    saveProduct: (product: unknown) =>
      ipcRenderer.invoke('desktop:catalog:save-product', product),
    deleteProduct: (id: string) =>
      ipcRenderer.invoke('desktop:catalog:delete-product', id),
    listPopular: (limit?: number) =>
      ipcRenderer.invoke('desktop:catalog:list-popular', limit),
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
    labels: (sessionId: string, tenantId?: string) => ipcRenderer.invoke('desktop:inventory:labels', sessionId, tenantId),
    applyPrice: (sessionId: string, input: unknown) => ipcRenderer.invoke('desktop:inventory:apply-price', sessionId, input),
    complete: (sessionId: string, input?: unknown) => ipcRenderer.invoke('desktop:inventory:complete', sessionId, input),
  },
  orders: {
    listReady: (input?: unknown) => ipcRenderer.invoke('desktop:orders:list-ready', input),
    get: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:get', id, tenantId),
    listPayments: (orderId: string, tenantId?: string) => ipcRenderer.invoke('desktop:orders:list-payments', orderId, tenantId),
    addPayment: (orderId: string, input: unknown) => ipcRenderer.invoke('desktop:orders:add-payment', orderId, input),
    complete: (orderId: string, input?: unknown) => ipcRenderer.invoke('desktop:orders:complete', orderId, input),
  },
  supply: {
    listSuppliers: (input?: unknown) => ipcRenderer.invoke('desktop:supply:list-suppliers', input),
    getSupplier: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:get-supplier', id, tenantId),
    listInvoices: (input?: unknown) => ipcRenderer.invoke('desktop:supply:list-invoices', input),
    getInvoice: (id: string, tenantId?: string) => ipcRenderer.invoke('desktop:supply:get-invoice', id, tenantId),
    createInvoice: (input: unknown) => ipcRenderer.invoke('desktop:supply:create-invoice', input),
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
    listDebtors: (limit?: number) => ipcRenderer.invoke('desktop:pos:list-debtors', limit),
    searchCustomers: (input?: unknown) => ipcRenderer.invoke('desktop:pos:search-customers', input),
    getCustomerDeposit: (customerId: string, tenantId?: string) => ipcRenderer.invoke('desktop:pos:get-customer-deposit', customerId, tenantId),
    payDebt: (input: unknown) => ipcRenderer.invoke('desktop:pos:pay-debt', input),
    addCustomerDeposit: (input: unknown) => ipcRenderer.invoke('desktop:pos:add-customer-deposit', input),
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
    registerCheck: (items: unknown[], pay: unknown, comment?: string | null) =>
      ipcRenderer.invoke('desktop:fiscal:register-check', items, pay, comment),
    registerReturn: (items: unknown[], pay: unknown, originalFiscalNumber: string) =>
      ipcRenderer.invoke('desktop:fiscal:register-return', items, pay, originalFiscalNumber),
  },
})
