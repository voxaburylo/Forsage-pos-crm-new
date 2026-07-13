import path from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { LocalDatabase } from './db/localDatabase'
import type { LocalBootstrapSnapshot, LocalProductUpsert, LocalSaleCheckoutInput, LocalSyncPullChanges, LocalSyncPushResult } from './db/localTypes'
import { LocalBootstrapRepository } from './repositories/bootstrapRepository'
import { LocalCatalogRepository } from './repositories/catalogRepository'
import { LocalPosRepository } from './repositories/posRepository'
import { LocalSyncRepository } from './repositories/syncRepository'
import {
  CashalotService,
  type CashalotConfigUpdate,
  type FiscalCheckItemInput,
  type FiscalCheckPayInput,
} from './fiscal/cashalotService'

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | null = null
let localDatabase: LocalDatabase | null = null
let localBootstrap: LocalBootstrapRepository | null = null
let localCatalog: LocalCatalogRepository | null = null
let localPos: LocalPosRepository | null = null
let localSync: LocalSyncRepository | null = null
let cashalot: CashalotService | null = null

interface DesktopPrintOptions {
  title?: string
  widthMm?: number
  heightMm?: number
  silent?: boolean
}

function rendererIndexPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'index.html')
    : path.resolve(__dirname, '../../web/dist/index.html')
}

function requireLocalDatabase(): LocalDatabase {
  if (!localDatabase) throw new Error('LOCAL_DATABASE_NOT_READY')
  return localDatabase
}

function requireLocalCatalog(): LocalCatalogRepository {
  if (!localCatalog) throw new Error('LOCAL_CATALOG_NOT_READY')
  return localCatalog
}

function requireLocalBootstrap(): LocalBootstrapRepository {
  if (!localBootstrap) throw new Error('LOCAL_BOOTSTRAP_NOT_READY')
  return localBootstrap
}

function requireLocalPos(): LocalPosRepository {
  if (!localPos) throw new Error('LOCAL_POS_NOT_READY')
  return localPos
}

function requireLocalSync(): LocalSyncRepository {
  if (!localSync) throw new Error('LOCAL_SYNC_NOT_READY')
  return localSync
}

function requireCashalot(): CashalotService {
  if (!cashalot) throw new Error('FISCAL_SERVICE_NOT_READY')
  return cashalot
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: 'Forsage',
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const developmentUrl = process.env.FORSAGE_WEB_URL
  if (!app.isPackaged && developmentUrl) await mainWindow.loadURL(developmentUrl)
  else await mainWindow.loadFile(rendererIndexPath())

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

function sanitizePageMm(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

async function printHtmlDocument(html: string, options: DesktopPrintOptions = {}): Promise<{ success: true }> {
  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new Error('PRINT_HTML_EMPTY')
  }

  const widthMm = sanitizePageMm(options.widthMm, 40, 10, 300)
  const heightMm = sanitizePageMm(options.heightMm, 30, 10, 300)
  const printWindow = new BrowserWindow({
    title: options.title ?? 'Друк',
    width: Math.max(360, Math.round(widthMm * 10)),
    height: Math.max(320, Math.round(heightMm * 12)),
    show: false,
    parent: mainWindow ?? undefined,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await printWindow.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => null))).then(() => true)',
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Chromium приймає pageSize лише в портретній орієнтації (width <= height):
    // альбомний розмір на кшталт 40×30 він мовчки нормалізує сам, а контент
    // повертає поперек. Тому нормалізуємо явно і вмикаємо landscape.
    const landscape = widthMm > heightMm
    const pageSize = landscape
      ? { width: Math.round(heightMm * 1000), height: Math.round(widthMm * 1000) }
      : { width: Math.round(widthMm * 1000), height: Math.round(heightMm * 1000) }

    await new Promise<void>((resolve, reject) => {
      printWindow.webContents.print({
        silent: options.silent === true,
        printBackground: true,
        margins: { marginType: 'none' },
        pageSize,
        landscape,
        scaleFactor: 100,
      }, (success, failureReason) => {
        if (success || failureReason === 'cancelled') resolve()
        else reject(new Error(failureReason || 'PRINT_FAILED'))
      })
    })
    return { success: true }
  } finally {
    if (!printWindow.isDestroyed()) printWindow.close()
  }
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  app.setName('Forsage')
  const dataRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Forsage')
    : app.getPath('userData')
  localDatabase = new LocalDatabase(dataRoot)
  localBootstrap = new LocalBootstrapRepository(localDatabase)
  localCatalog = new LocalCatalogRepository(localDatabase)
  localPos = new LocalPosRepository(localDatabase)
  localSync = new LocalSyncRepository(localDatabase)
  cashalot = new CashalotService(dataRoot)

  ipcMain.handle('desktop:get-runtime-info', () => requireLocalDatabase().info())
  ipcMain.handle('desktop:backup-now', () => requireLocalDatabase().backupNow())
  ipcMain.handle('desktop:bootstrap:import-snapshot', (_event, snapshot: LocalBootstrapSnapshot) =>
    requireLocalBootstrap().importSnapshot(snapshot),
  )
  ipcMain.handle('desktop:catalog:find-by-barcode', (_event, barcode: string) =>
    requireLocalCatalog().findByBarcode(barcode),
  )
  ipcMain.handle('desktop:catalog:search-products', (_event, query: string, limit?: number) =>
    requireLocalCatalog().searchProducts(query, undefined, limit),
  )
  ipcMain.handle('desktop:catalog:upsert-product', (_event, product: LocalProductUpsert) =>
    requireLocalCatalog().upsertProduct(product),
  )
  ipcMain.handle('desktop:pos:open-shift', (_event, input: {
    cashier_id: string
    opening_cash?: number
    notes?: string | null
  }) => requireLocalPos().openShift(input))
  ipcMain.handle('desktop:pos:get-open-shift', (_event, cashierId: string) =>
    requireLocalPos().getOpenShift(cashierId),
  )
  ipcMain.handle('desktop:pos:checkout', (_event, input: LocalSaleCheckoutInput) =>
    requireLocalPos().checkout(input),
  )
  ipcMain.handle('desktop:sync:list-pending', (_event, limit?: number) =>
    requireLocalSync().listPending(limit),
  )
  ipcMain.handle('desktop:sync:get-pull-state', () =>
    requireLocalSync().getPullState(),
  )
  ipcMain.handle('desktop:sync:apply-pull-changes', (_event, changes: LocalSyncPullChanges) =>
    requireLocalSync().applyPullChanges(changes),
  )
  ipcMain.handle('desktop:sync:mark-pull-failed', (_event, error: string) =>
    requireLocalSync().markPullFailed(error),
  )
  ipcMain.handle('desktop:sync:apply-push-results', (_event, results: LocalSyncPushResult[]) =>
    requireLocalSync().applyPushResults(results),
  )
  ipcMain.handle('desktop:sync:mark-batch-failed', (_event, sequences: number[], error: string) =>
    requireLocalSync().markBatchFailed(sequences, error),
  )
  ipcMain.handle('desktop:print:html', (_event, html: string, options?: DesktopPrintOptions) =>
    printHtmlDocument(html, options),
  )
  ipcMain.handle('desktop:fiscal:get-config', () => requireCashalot().getPublicConfig())
  ipcMain.handle('desktop:fiscal:set-config', (_event, update: CashalotConfigUpdate) =>
    requireCashalot().updateConfig(update),
  )
  ipcMain.handle('desktop:fiscal:register-com', () => requireCashalot().registerCom())
  ipcMain.handle('desktop:fiscal:status', () => requireCashalot().getStatus())
  ipcMain.handle('desktop:fiscal:open-shift', () => requireCashalot().openShift())
  ipcMain.handle('desktop:fiscal:close-shift', () => requireCashalot().closeShift())
  ipcMain.handle('desktop:fiscal:x-report', () => requireCashalot().xReport())
  ipcMain.handle('desktop:fiscal:service-cash', (_event, amount: number, direction: 'in' | 'out') =>
    requireCashalot().serviceCash(amount, direction),
  )
  ipcMain.handle('desktop:fiscal:register-check', (
    _event,
    items: FiscalCheckItemInput[],
    pay: FiscalCheckPayInput,
    comment?: string | null,
  ) => requireCashalot().fiscalizeCheck(items, pay, comment))
  ipcMain.handle('desktop:fiscal:register-return', (
    _event,
    items: FiscalCheckItemInput[],
    pay: FiscalCheckPayInput,
    originalFiscalNumber: string,
  ) => requireCashalot().fiscalizeReturnCheck(items, pay, originalFiscalNumber))

  await createWindow()
}).catch((error: unknown) => {
  console.error('Forsage desktop startup failed', error)
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  cashalot?.stopWorker()
  cashalot = null
  localDatabase?.close()
  localDatabase = null
  localBootstrap = null
  localCatalog = null
  localPos = null
  localSync = null
})
