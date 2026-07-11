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
  },
  pos: {
    openShift: (input: { cashier_id: string; opening_cash?: number; notes?: string | null }) =>
      ipcRenderer.invoke('desktop:pos:open-shift', input),
    getOpenShift: (cashierId: string) =>
      ipcRenderer.invoke('desktop:pos:get-open-shift', cashierId),
    checkout: (input: unknown) => ipcRenderer.invoke('desktop:pos:checkout', input),
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
  },
})
