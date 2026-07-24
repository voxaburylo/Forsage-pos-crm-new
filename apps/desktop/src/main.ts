import path from 'node:path'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { LocalDatabase } from './db/localDatabase'
import type { LocalBootstrapSnapshot, LocalProductUpsert, LocalSaleCheckoutInput, LocalSyncPullChanges, LocalSyncPushResult } from './db/localTypes'
import { LocalBootstrapRepository } from './repositories/bootstrapRepository'
import { LocalCatalogRepository } from './repositories/catalogRepository'
import { LocalPosRepository } from './repositories/posRepository'
import { LocalSyncRepository } from './repositories/syncRepository'
import { LocalReadRepository } from './repositories/readRepository'
import {
  CashalotService,
  type CashalotConfigUpdate,
  type FiscalCheckItemInput,
  type FiscalCheckPayInput,
} from './fiscal/cashalotService'
import { printLabelsTspl, type TsplPrintOptions } from './print/tsplLabelPrinter'

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | null = null
let localDatabase: LocalDatabase | null = null
let localBootstrap: LocalBootstrapRepository | null = null
let localCatalog: LocalCatalogRepository | null = null
let localPos: LocalPosRepository | null = null
let localSync: LocalSyncRepository | null = null
let localRead: LocalReadRepository | null = null
let cashalot: CashalotService | null = null

interface DesktopPrintOptions {
  title?: string
  widthMm?: number
  heightMm?: number
  silent?: boolean
  showPreviewWindow?: boolean
  /** true — не задавати pageSize, друкувати на папері за налаштуванням драйвера
   * (для чекового рулону 58/80мм, де висота змінна). */
  useDriverPaper?: boolean
  /** Явний принтер (для preflight-очистки саме його черги). */
  deviceName?: string
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

function requireLocalRead(): LocalReadRepository {
  if (!localRead) throw new Error('LOCAL_READ_NOT_READY')
  return localRead
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

// Виконати PowerShell-скрипт керування чергами друку. Тихо, з таймаутом,
// без вікна. Помилки не кидаємо назовні — це «прибирання», яке не має валити друк.
function runPrintPowerShell(script: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true })
    let out = ''
    ps.stdout?.on('data', (c) => { out += String(c) })
    ps.on('error', () => resolve(''))
    const timer = setTimeout(() => { try { ps.kill() } catch { /* ignore */ } resolve(out) }, timeoutMs)
    ps.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}

// Прибрати завислі завдання (у стані помилки/блокування/видалення), які інакше
// «затикають» чергу і наступний друк стає за ними та висить. Безпечно: чіпаємо
// лише те, що вже не друкується. Якщо name задано — лише цей принтер.
async function cleanupStuckPrintJobs(printerName?: string): Promise<void> {
  const filter = printerName
    ? `Get-PrintJob -PrinterName '${printerName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`
    : `Get-Printer -ErrorAction SilentlyContinue | Get-PrintJob -ErrorAction SilentlyContinue`
  await runPrintPowerShell(
    `${filter} | Where-Object { $_.JobStatus -match 'Error|Blocked|Deleting|Offline|PaperOut|Paused' } ` +
    `| Remove-PrintJob -ErrorAction SilentlyContinue`,
    10000,
  )
}

// Повне скидання зависання друку без перезавантаження ПК: зупинити службу,
// стерти всі завдання з усіх черг, знову запустити службу.
async function resetPrintSpooler(): Promise<{ success: true }> {
  await runPrintPowerShell(
    'Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue; ' +
    "Start-Sleep -Milliseconds 400; " +
    "Remove-Item -Path \"$env:SystemRoot\\System32\\spool\\PRINTERS\\*\" -Force -ErrorAction SilentlyContinue; " +
    'Start-Sleep -Milliseconds 300; ' +
    'Start-Service -Name Spooler -ErrorAction SilentlyContinue',
    30000,
  )
  return { success: true }
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
    show: options.showPreviewWindow === true,
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Preflight: приберемо завислі завдання, щоб новий друк не став у чергу за
  // застряглим (типова причина «друк завис» після помилкового принтера).
  await cleanupStuckPrintJobs(options.deviceName).catch(() => {})

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await printWindow.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => null))).then(() => true)',
      true,
    )
    if (options.showPreviewWindow === true) {
      printWindow.show()
      printWindow.focus()
    }
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Chromium приймає pageSize лише в портретній орієнтації (width <= height):
    // альбомний розмір на кшталт 40×30 він мовчки нормалізує сам, а контент
    // повертає поперек. Тому нормалізуємо явно і вмикаємо landscape.
    const landscape = widthMm > heightMm
    const pageSize = landscape
      ? { width: Math.round(heightMm * 1000), height: Math.round(widthMm * 1000) }
      : { width: Math.round(widthMm * 1000), height: Math.round(heightMm * 1000) }

    // Деякі драйвери (напр. етикетковий HL80) відхиляють комбінацію
    // pageSize+landscape з «Invalid printer settings». Тому пробуємо каскадом:
    // спершу ідеальні налаштування, а якщо драйвер їх не приймає — простіші,
    // щоб друк узагалі відбувся, а не падав.
    const minimalBase = {
      silent: options.silent === true,
      printBackground: true,
    }
    const base = {
      ...minimalBase,
      margins: { marginType: 'none' as const },
    }
    const attempts: Electron.WebContentsPrintOptions[] = options.useDriverPaper
      ? [
          { ...base },
          // Частина драйверів етикеток/чекових принтерів відхиляє навіть
          // margins: none як "Invalid printer settings". У такому випадку
          // віддаємо папір і поля повністю драйверу, щоб друк не падав.
          { ...minimalBase },
          { silent: options.silent === true },
          {},
        ]
      : [
          { ...base, pageSize, landscape },
          { ...base, pageSize },
          { ...base, landscape },
          { ...base },
          { ...minimalBase, pageSize, landscape },
          { ...minimalBase, pageSize },
          { ...minimalBase, landscape },
          { ...minimalBase },
          {},
        ]

    const printOnce = (opts: Electron.WebContentsPrintOptions) =>
      new Promise<void>((resolve, reject) => {
        // Якщо служба друку зависла, callback від Chromium може не прийти ніколи —
        // тоді Promise висів би вічно і блокував наступні друки. Обмежуємо часом.
        let done = false
        const timer = setTimeout(() => {
          if (done) return
          done = true
          reject(new Error('PRINT_TIMEOUT'))
        }, 25000)
        printWindow.webContents.print(opts, (success, failureReason) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (success || failureReason === 'cancelled') resolve()
          else reject(new Error(failureReason || 'PRINT_FAILED'))
        })
      })

    let lastError: unknown = null
    for (const opts of attempts) {
      try {
        await printOnce(opts)
        return { success: true }
      } catch (error) {
        lastError = error
        // «Invalid printer settings» / подібне — пробуємо наступний, простіший варіант
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PRINT_FAILED')
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
  localRead = new LocalReadRepository(localDatabase)
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
  ipcMain.handle('desktop:catalog:list-popular', (_event, limit?: number) =>
    requireLocalCatalog().listPopular(undefined, limit),
  )
  ipcMain.handle('desktop:pos:list-debtors', (_event, limit?: number) =>
    requireLocalPos().listDebtors(undefined, limit),
  )
  ipcMain.handle('desktop:pos:expected-cash', (_event, cashierId: string) =>
    requireLocalPos().getExpectedCash(cashierId),
  )
  ipcMain.handle('desktop:pos:shift-report', (_event, cashierId: string) =>
    requireLocalPos().getShiftReport(cashierId),
  )
  ipcMain.handle('desktop:pos:reconcile', (_event, cashierId: string, actualAmount: number, comment: string | null) =>
    requireLocalPos().reconcileShift(cashierId, actualAmount, comment),
  )
  ipcMain.handle('desktop:pos:close-shift', (_event, cashierId: string, actualAmount: number, comment: string | null) =>
    requireLocalPos().closeShift(cashierId, actualAmount, comment),
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
  ipcMain.handle('desktop:print:reset', () => resetPrintSpooler())
  // Локальне читання для офлайн-режиму (клієнти, чеки)
  ipcMain.handle('desktop:read:customers', (_e, params?: Record<string, string | number | undefined>) =>
    requireLocalRead().listCustomers(params ?? {}))
  ipcMain.handle('desktop:read:customer', (_e, id: string) =>
    requireLocalRead().getCustomer(id))
  ipcMain.handle('desktop:read:sales', (_e, params?: Record<string, string | number | undefined>) =>
    requireLocalRead().listSales(params ?? {}))
  ipcMain.handle('desktop:read:sale', (_e, id: string) =>
    requireLocalRead().getSale(id))
  ipcMain.handle('desktop:read:products', (_e, params?: Record<string, string | number | undefined>) =>
    requireLocalRead().listProducts(params ?? {}))
  ipcMain.handle('desktop:read:product', (_e, id: string) =>
    requireLocalRead().getProduct(id))
  ipcMain.handle('desktop:print:list-printers', async () => {
    if (!mainWindow) return []
    const printers = await mainWindow.webContents.getPrintersAsync()
    return printers.map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      isDefault: (printer as unknown as { isDefault?: boolean }).isDefault === true,
    }))
  })
  ipcMain.handle('desktop:print:labels-tspl', (_event, html: string, options: TsplPrintOptions) =>
    printLabelsTspl(html, options),
  )
  ipcMain.handle('desktop:fiscal:pick-folder', async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: 'Виберіть папку',
      defaultPath: defaultPath && defaultPath.trim() ? defaultPath : undefined,
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
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
