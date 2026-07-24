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
    searchProducts: (query: string, limit?: number) =>
      ipcRenderer.invoke('desktop:catalog:search-products', query, limit),
    upsertProduct: (product: unknown) =>
      ipcRenderer.invoke('desktop:catalog:upsert-product', product),
    listPopular: (limit?: number) =>
      ipcRenderer.invoke('desktop:catalog:list-popular', limit),
  },
  pos: {
    openShift: (input: { cashier_id: string; opening_cash?: number; notes?: string | null }) =>
      ipcRenderer.invoke('desktop:pos:open-shift', input),
    getOpenShift: (cashierId: string) =>
      ipcRenderer.invoke('desktop:pos:get-open-shift', cashierId),
    checkout: (input: unknown) => ipcRenderer.invoke('desktop:pos:checkout', input),
    listDebtors: (limit?: number) => ipcRenderer.invoke('desktop:pos:list-debtors', limit),
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
    // Скинути завислий друк без перезавантаження ПК: чистить черги і
    // перезапускає службу друку Windows.
    resetSpooler: () => ipcRenderer.invoke('desktop:print:reset'),
  },
  // Локальне читання даних для офлайн-режиму.
  read: {
    customers: (params?: unknown) => ipcRenderer.invoke('desktop:read:customers', params),
    customer: (id: string) => ipcRenderer.invoke('desktop:read:customer', id),
    sales: (params?: unknown) => ipcRenderer.invoke('desktop:read:sales', params),
    sale: (id: string) => ipcRenderer.invoke('desktop:read:sale', id),
    products: (params?: unknown) => ipcRenderer.invoke('desktop:read:products', params),
    product: (id: string) => ipcRenderer.invoke('desktop:read:product', id),
    suppliers: (params?: unknown) => ipcRenderer.invoke('desktop:read:suppliers', params),
    supplier: (id: string) => ipcRenderer.invoke('desktop:read:supplier', id),
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
