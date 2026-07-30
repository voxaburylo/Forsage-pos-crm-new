import path from 'node:path'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, net, shell, type IpcMainInvokeEvent } from 'electron'
import { LocalDatabase } from './db/localDatabase'
import { DEFAULT_TENANT_ID } from './db/localTypes'
import type {
  LocalBootstrapSnapshot,
  LocalFiscalIntentResolution,
  LocalFiscalReturnIntentCancelInput,
  LocalFiscalReturnIntentResolution,
  LocalFiscalReturnIntentScope,
  LocalFiscalSaleRequest,
  LocalFiscalReturnRequest,
  LocalProductUpsert,
  LocalSaleCheckoutInput,
  LocalSyncPullChanges,
  LocalSyncPushResult,
} from './db/localTypes'
import { LocalBootstrapRepository } from './repositories/bootstrapRepository'
import { LocalCatalogRepository } from './repositories/catalogRepository'
import { LocalInventoryRepository } from './repositories/inventoryRepository'
import { LocalOrderRepository } from './repositories/orderRepository'
import { LocalPosRepository } from './repositories/posRepository'
import { LocalSupplyRepository } from './repositories/supplyRepository'
import { LocalStaffRepository } from './repositories/staffRepository'
import { LocalWarehouseRepository } from './repositories/warehouseRepository'
import { LocalSyncRepository } from './repositories/syncRepository'
import { LocalSupplierCatalogRepository } from './repositories/supplierCatalogRepository'
import {
  CashalotService,
  type CashalotConfigUpdate,
} from './fiscal/cashalotService'
import { printLabelsTspl, type TsplPrintOptions } from './print/tsplLabelPrinter'
import { isSpoolerGuardError, postflightPrinter, preflightPrinter } from './print/spoolerGuard'
import { desktopTenantArgumentPositions, isDesktopChannelAllowed, PUBLIC_DESKTOP_CHANNELS } from './security/desktopAuthorization'

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | null = null
let localDatabase: LocalDatabase | null = null
let localBootstrap: LocalBootstrapRepository | null = null
let localCatalog: LocalCatalogRepository | null = null
let localInventory: LocalInventoryRepository | null = null
let localOrders: LocalOrderRepository | null = null
let localPos: LocalPosRepository | null = null
let localSupply: LocalSupplyRepository | null = null
let localStaff: LocalStaffRepository | null = null
let localWarehouse: LocalWarehouseRepository | null = null
let localSync: LocalSyncRepository | null = null
let localSupplierCatalog: LocalSupplierCatalogRepository | null = null
let cashalot: CashalotService | null = null
let desktopDataRoot: string | null = null
let rendererCrashTimes: number[] = []
let desktopAuthSession: { id: string; tenant_id: string; role: string } | null = null

function diagnosticValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  try { return JSON.stringify(value) } catch { return String(value) }
}

function writeDesktopDiagnostic(event: string, details: unknown): void {
  try {
    const dataRoot = desktopDataRoot
      ?? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Forsage') : app.getPath('userData'))
    const logDir = path.join(dataRoot, 'logs')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(
      path.join(logDir, 'desktop-errors.log'),
      `[${new Date().toISOString()}] ${event}\n${diagnosticValue(details)}\n\n`,
      'utf8',
    )
  } catch {
    // Діагностика не повинна сама зупиняти касу.
  }
}
interface DesktopPrintOptions {
  title?: string
  widthMm?: number
  heightMm?: number
  /** Ім'я принтера у Windows. Задаємо ЗАВЖДИ, щоб чек не поїхав на етикетковий
   * (і навпаки) через зміну «принтера за замовчуванням». */
  deviceName?: string
  silent?: boolean
  showPreviewWindow?: boolean
  /** true — не задавати pageSize, друкувати на папері за налаштуванням драйвера
   * (для чекового рулону 58/80мм, де висота змінна). */
  useDriverPaper?: boolean
  /** true — для етикеток не дозволяти fallback без точного розміру та нульових полів. */
  strictPageSize?: boolean
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

function requireLocalInventory(): LocalInventoryRepository {
  if (!localInventory) throw new Error('LOCAL_INVENTORY_NOT_READY')
  return localInventory
}

function requireLocalOrders(): LocalOrderRepository {
  if (!localOrders) throw new Error('LOCAL_ORDERS_NOT_READY')
  return localOrders
}

function requireLocalBootstrap(): LocalBootstrapRepository {
  if (!localBootstrap) throw new Error('LOCAL_BOOTSTRAP_NOT_READY')
  return localBootstrap
}

function requireLocalPos(): LocalPosRepository {
  if (!localPos) throw new Error('LOCAL_POS_NOT_READY')
  return localPos
}

function requireLocalSupply(): LocalSupplyRepository {
  if (!localSupply) throw new Error('LOCAL_SUPPLY_NOT_READY')
  return localSupply
}

function requireLocalStaff(): LocalStaffRepository {
  if (!localStaff) throw new Error('LOCAL_STAFF_NOT_READY')
  return localStaff
}
function requireLocalWarehouse(): LocalWarehouseRepository {
  if (!localWarehouse) throw new Error('LOCAL_WAREHOUSE_NOT_READY')
  return localWarehouse
}

function requireLocalSync(): LocalSyncRepository {
  if (!localSync) throw new Error('LOCAL_SYNC_NOT_READY')
  return localSync
}

function requireLocalSupplierCatalog(): LocalSupplierCatalogRepository {
  if (!localSupplierCatalog) throw new Error('LOCAL_SUPPLIER_CATALOG_NOT_READY')
  return localSupplierCatalog
}

function requireCashalot(): CashalotService {
  if (!cashalot) throw new Error('FISCAL_SERVICE_NOT_READY')
  return cashalot
}

function requireDesktopSession(): { id: string; tenant_id: string; role: string } {
  if (!desktopAuthSession) throw new Error('Необхідно увійти в програму')
  return desktopAuthSession
}

interface TrustedAuthConfig {
  supabaseUrl: string
  supabaseAnonKey: string
}

interface DesktopOnlineLoginResult {
  user: {
    id: string
    tenant_id: string
    full_name: string
    role: string
    phone: string
    email: string
    is_active: boolean
    created_at?: string
  }
  access_token: string
  refresh_token: string
  expires_in: number
}

let trustedAuthConfig: TrustedAuthConfig | null = null
const onlinePasswordAttempts = new Map<string, { failures: number; blockedUntil: number }>()

function normalizeAuthPhone(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.startsWith('380')) return digits
  if (digits.startsWith('80')) return `3${digits}`
  if (digits.startsWith('0')) return `38${digits}`
  return digits
}

function authPhoneToEmail(phone: string): string {
  return `${normalizeAuthPhone(phone)}@forsage.internal`
}

function requireTrustedAuthConfig(): TrustedAuthConfig {
  if (trustedAuthConfig) return trustedAuthConfig
  const configPath = path.join(__dirname, 'trusted-auth-config.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new Error('Онлайн-вхід не налаштовано в цій збірці')
  }
  const config = parsed as Partial<TrustedAuthConfig>
  let url: URL
  try {
    url = new URL(String(config.supabaseUrl ?? ''))
  } catch {
    throw new Error('Онлайн-вхід має некоректне налаштування сервера')
  }
  if (url.protocol !== 'https:' || !config.supabaseAnonKey) {
    throw new Error('Онлайн-вхід має некоректне налаштування сервера')
  }
  trustedAuthConfig = {
    supabaseUrl: url.toString().replace(/\/$/, ''),
    supabaseAnonKey: String(config.supabaseAnonKey),
  }
  return trustedAuthConfig
}

function recordOnlinePasswordFailure(attemptKey: string): never {
  const previous = onlinePasswordAttempts.get(attemptKey)
  const failures = (previous?.failures ?? 0) + 1
  onlinePasswordAttempts.set(attemptKey, {
    failures: failures >= 10 ? 0 : failures,
    blockedUntil: failures >= 10 ? Date.now() + 15 * 60_000 : 0,
  })
  throw new Error(failures >= 10
    ? 'Забагато спроб входу. Спробуйте через 15 хвилин'
    : 'Невірний номер телефону або пароль')
}

async function loginOnlineAndProvisionLocal(phone: string, password: string): Promise<DesktopOnlineLoginResult> {
  const normalizedPhone = normalizeAuthPhone(phone)
  if (!normalizedPhone || !password) throw new Error('Вкажіть номер телефону та пароль')
  const attemptKey = `${DEFAULT_TENANT_ID}:${normalizedPhone}`
  const attempt = onlinePasswordAttempts.get(attemptKey)
  if (attempt && attempt.blockedUntil > Date.now()) {
    throw new Error('Забагато спроб входу. Спробуйте через 15 хвилин')
  }

  const config = requireTrustedAuthConfig()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  let response: Response
  try {
    response = await net.fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: authPhoneToEmail(normalizedPhone), password }),
      signal: controller.signal,
    })
  } catch {
    throw new Error('Сервер входу недоступний. Перевірте інтернет і повторіть')
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 400 || response.status === 401 || response.status === 422) {
    return recordOnlinePasswordFailure(attemptKey)
  }
  if (!response.ok) {
    if (response.status === 429) throw new Error('Забагато спроб входу. Спробуйте пізніше')
    throw new Error('Сервер входу тимчасово недоступний')
  }

  const payload = await response.json() as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    user?: { id?: unknown; app_metadata?: Record<string, unknown> }
  }
  const serverUserId = typeof payload.user?.id === 'string' ? payload.user.id : ''
  const tenantId = typeof payload.user?.app_metadata?.tenant_id === 'string'
    ? payload.user.app_metadata.tenant_id
    : ''
  if (
    !serverUserId
    || tenantId !== DEFAULT_TENANT_ID
    || typeof payload.access_token !== 'string'
    || typeof payload.refresh_token !== 'string'
  ) {
    throw new Error('Обліковий запис не належить цьому магазину')
  }

  const user = requireLocalStaff().adoptServerAuthenticatedPassword(
    serverUserId,
    normalizedPhone,
    password,
    DEFAULT_TENANT_ID,
  )
  onlinePasswordAttempts.delete(attemptKey)
  desktopAuthSession = { id: user.id, tenant_id: user.tenant_id, role: user.role }
  return {
    user,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: Number(payload.expires_in) || 3600,
  }
}

function validateTenantArguments(value: unknown, tenantId: string, depth = 0): void {
  if (depth > 6 || value == null) return
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return
  if (Array.isArray(value)) {
    for (const item of value) validateTenantArguments(item, tenantId, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const suppliedTenantId = typeof record.tenant_id === 'string'
    ? record.tenant_id
    : (typeof record.tenantId === 'string' ? record.tenantId : null)
  if (suppliedTenantId && suppliedTenantId !== tenantId) {
    throw new Error('Операція належить іншому магазину')
  }
  for (const nested of Object.values(record)) validateTenantArguments(nested, tenantId, depth + 1)
}

function handleDesktopIpc(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('Неприпустиме джерело локальної команди')
    }
    if (!PUBLIC_DESKTOP_CHANNELS.has(channel)) {
      const session = requireDesktopSession()
      if (!isDesktopChannelAllowed(channel, session.role)) {
        throw new Error('Недостатньо прав для цієї дії')
      }
      for (const argument of args) validateTenantArguments(argument, session.tenant_id)
      for (const position of desktopTenantArgumentPositions(channel)) {
        const suppliedTenantId = args[position]
        if (typeof suppliedTenantId === 'string' && suppliedTenantId !== session.tenant_id) {
          throw new Error('Операція належить іншому магазину')
        }
      }
    }
    return listener(event, ...args)
  })
}

async function processFiscalReturn(request: LocalFiscalReturnRequest) {
  const pos = requireLocalPos()
  let intent = pos.prepareFiscalReturnIntent(request)
  if (intent.state === 'completed') {
    return { intent, data: intent.checkout_result }
  }
  if (intent.state === 'fiscalizing' || intent.state === 'unknown') {
    throw new Error(
      `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Результат попереднього фіскального повернення потрібно перевірити у Cashalot`,
    )
  }

  if (intent.state === 'prepared') {
    const fiscal = requireCashalot()
    if (!fiscal.isEnabled()) {
      throw new Error('ПРРО Cashalot не налаштовано або вимкнено')
    }
    pos.startFiscalSaleIntent(intent.operation_id)
    try {
      const result = await fiscal.fiscalizeReturnCheck(
        request.items,
        request.pay,
        request.original_fiscal_number,
      )
      intent = pos.markFiscalSaleIntentFiscalized(
        intent.operation_id,
        result as unknown as Record<string, unknown>,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        pos.markFiscalSaleIntentUnknown(intent.operation_id, detail)
      } catch {
        // Намір уже залишився у безпечному блокувальному стані fiscalizing/unknown.
      }
      throw new Error(
        `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Не повторюйте повернення. Перевірте чек у Cashalot: ${detail}`,
      )
    }
  }

  const fiscalResult = intent.fiscal_result
  if (!fiscalResult) {
    throw new Error(
      `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Збережений результат фіскального повернення не знайдено`,
    )
  }
  const fiscalNumber = String(
    fiscalResult.ReceiptFiscalNum ?? fiscalResult.ReceiptLocalNum ?? '',
  ).trim() || null
  const data = pos.createReturn({
    ...request.return_input,
    client_operation_id: intent.operation_id,
    is_fiscal: true,
    fiscal_number: fiscalNumber,
  })
  return {
    intent: pos.getFiscalSaleIntent(intent.operation_id),
    data,
  }
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
      devTools: !app.isPackaged,
    },
  })

  const developmentUrl = process.env.FORSAGE_WEB_URL
  const developmentOrigin = !app.isPackaged && developmentUrl
    ? new URL(developmentUrl).origin
    : null
  const packagedRendererPath = path.resolve(rendererIndexPath()).toLocaleLowerCase('en-US')

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) desktopAuthSession = null
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    desktopAuthSession = null
    writeDesktopDiagnostic('renderer-process-gone', details)
    if (details.reason === 'clean-exit' || details.reason === 'killed') return

    const now = Date.now()
    rendererCrashTimes = rendererCrashTimes.filter((time) => now - time < 60_000)
    rendererCrashTimes.push(now)
    if (rendererCrashTimes.length > 2) {
      dialog.showErrorBox(
        'Forsage не вдалося відновити',
        'Інтерфейс аварійно завершився кілька разів. Причину записано у журнал. Перезапустіть програму.',
      )
      app.quit()
      return
    }

    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
    }, 300)
  })
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    let allowed = false
    try {
      const parsed = new URL(targetUrl)
      if (developmentOrigin) {
        allowed = parsed.origin === developmentOrigin
      } else if (parsed.protocol === 'file:') {
        allowed = path.resolve(fileURLToPath(parsed)).toLocaleLowerCase('en-US') === packagedRendererPath
      }
    } catch {
      allowed = false
    }

    if (allowed) return
    event.preventDefault()
    if (/^https?:\/\//i.test(targetUrl)) void shell.openExternal(targetUrl)
  })

  if (!app.isPackaged && developmentUrl) await mainWindow.loadURL(developmentUrl)
  else await mainWindow.loadFile(rendererIndexPath())

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { desktopAuthSession = null; mainWindow = null })
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
    const deviceName = String(options.deviceName ?? '').trim()
    const minimalBase = {
      silent: options.silent === true,
      printBackground: true,
      ...(deviceName ? { deviceName } : {}),
    }
    const base = {
      ...minimalBase,
      margins: { marginType: 'none' as const },
    }
    // Кожна спроба каскаду ОБОВ'ЯЗКОВО несе deviceName: спрощуємо папір і поля,
    // але ніколи не принтер. Інакше остання спроба пішла б на «принтер за
    // замовчуванням» — і чек вилазив би з етикеткового.
    const bareAttempt = { silent: options.silent === true, ...(deviceName ? { deviceName } : {}) }
    const attempts: Electron.WebContentsPrintOptions[] = options.strictPageSize
      ? [{ ...base, pageSize, landscape }]
      : options.useDriverPaper
        ? [
            { ...base },
            // Частина драйверів етикеток/чекових принтерів відхиляє навіть
            // margins: none як "Invalid printer settings". У такому випадку
            // віддаємо папір і поля повністю драйверу, щоб друк не падав.
            { ...minimalBase },
            bareAttempt,
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
            bareAttempt,
          ]

    const printOnce = (opts: Electron.WebContentsPrintOptions) =>
      new Promise<void>((resolve, reject) => {
        let done = false
        const timeout = opts.silent === true
          ? setTimeout(() => {
              if (done) return
              done = true
              reject(new Error('PRINT_TIMEOUT'))
            }, 15000)
          : null
        printWindow.webContents.print(opts, (success, failureReason) => {
          if (done) return
          done = true
          if (timeout) clearTimeout(timeout)
          if (success || failureReason === 'cancelled') resolve()
          else reject(new Error(failureReason || 'PRINT_FAILED'))
        })
      })

    // Залипле завдання цього ж принтера з'їло б друк мовчки — чистимо до відправки.
    if (deviceName) await preflightPrinter(deviceName)

    let lastError: unknown = null
    for (const opts of attempts) {
      try {
        await printOnce(opts)
        // Спулер прийняв байти — це ще не друк. Переконуємось, що завдання пішло.
        if (deviceName && options.silent === true) await postflightPrinter(deviceName)
        return { success: true }
      } catch (error) {
        lastError = error
        if (error instanceof Error && error.message === 'PRINT_TIMEOUT') break
        // Принтер не готовий або завдання не поїхало — інші налаштування паперу
        // цього не виправлять, тому каскад далі не має сенсу.
        if (error instanceof Error && isSpoolerGuardError(error)) break
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
  desktopDataRoot = dataRoot
  localDatabase = new LocalDatabase(dataRoot)
  void localDatabase.backupIfDue().catch((error) => {
    console.error('[desktop] Automatic local backup failed', error)
  })
  localBootstrap = new LocalBootstrapRepository(localDatabase)
  localCatalog = new LocalCatalogRepository(localDatabase)
  localInventory = new LocalInventoryRepository(localDatabase)
  localOrders = new LocalOrderRepository(localDatabase)
  localPos = new LocalPosRepository(localDatabase)
  localSupply = new LocalSupplyRepository(localDatabase)
  localStaff = new LocalStaffRepository(localDatabase)
  localWarehouse = new LocalWarehouseRepository(localDatabase)
  localSync = new LocalSyncRepository(localDatabase)
  localSupplierCatalog = new LocalSupplierCatalogRepository(localDatabase)
  cashalot = new CashalotService(dataRoot)

  handleDesktopIpc('desktop:get-runtime-info', () => requireLocalDatabase().info())
  handleDesktopIpc('desktop:backup-now', () => requireLocalDatabase().backupNow())
  handleDesktopIpc('desktop:bootstrap:import-snapshot', (_event, snapshot: LocalBootstrapSnapshot) =>
    requireLocalBootstrap().importSnapshot(snapshot),
  )
  handleDesktopIpc('desktop:catalog:find-by-barcode', (_event, barcode: string) =>
    requireLocalCatalog().findByBarcode(barcode),
  )
  handleDesktopIpc('desktop:catalog:find-by-id', (_event, id: string) =>
    requireLocalCatalog().findById(id),
  )
  handleDesktopIpc('desktop:catalog:find-by-sku', (_event, sku: string) =>
    requireLocalCatalog().findBySku(sku),
  )
  handleDesktopIpc('desktop:catalog:list-products', (_event, options) =>
    requireLocalCatalog().listProducts(options),
  )
  handleDesktopIpc('desktop:catalog:list-product-barcodes', () =>
    requireLocalCatalog().listProductBarcodes(),
  )
  handleDesktopIpc('desktop:catalog:save-photo', async (_event, folder: string, rawBytes: ArrayBuffer | Uint8Array) => {
    if (!desktopDataRoot) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    const safeFolder = String(folder || 'product').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'product'
    const bytes = Buffer.from(rawBytes instanceof ArrayBuffer ? new Uint8Array(rawBytes) : rawBytes)
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error('Неприпустимий розмір фото')
    const photoDir = path.join(desktopDataRoot, 'photos', safeFolder)
    await mkdir(photoDir, { recursive: true })
    const photoPath = path.join(photoDir, Date.now() + '-' + crypto.randomUUID() + '.jpg')
    await writeFile(photoPath, bytes)
    return pathToFileURL(photoPath).href
  })
  handleDesktopIpc('desktop:catalog:delete-photo', async (_event, photoUrl: string) => {
    if (!desktopDataRoot || !String(photoUrl).startsWith('file:')) return { ok: true }
    const photosRoot = path.resolve(desktopDataRoot, 'photos')
    const photoPath = path.resolve(fileURLToPath(photoUrl))
    if (photoPath !== photosRoot && !photoPath.startsWith(photosRoot + path.sep)) {
      throw new Error('Видалення фото поза локальним сховищем заборонено')
    }
    await unlink(photoPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return { ok: true }
  })
  handleDesktopIpc('desktop:catalog:list-categories', () =>
    requireLocalCatalog().listCategories(),
  )
  handleDesktopIpc('desktop:catalog:list-brands', () =>
    requireLocalCatalog().listBrands(),
  )
  handleDesktopIpc('desktop:catalog:create-category', (_event, name: string, sortOrder?: number) =>
    requireLocalCatalog().createCategory(name, sortOrder),
  )
  handleDesktopIpc('desktop:catalog:update-category', (_event, id: string, name: string) =>
    requireLocalCatalog().updateCategory(id, name),
  )
  handleDesktopIpc('desktop:catalog:delete-category', (_event, id: string) =>
    requireLocalCatalog().deleteCategory(id),
  )
  handleDesktopIpc('desktop:catalog:create-brand', (_event, name: string, country?: string | null) =>
    requireLocalCatalog().createBrand(name, country),
  )
  handleDesktopIpc('desktop:catalog:update-brand', (_event, id: string, input) =>
    requireLocalCatalog().updateBrand(id, input),
  )
  handleDesktopIpc('desktop:catalog:delete-brand', (_event, id: string) =>
    requireLocalCatalog().deleteBrand(id),
  )
  handleDesktopIpc('desktop:catalog:generate-barcode', () =>
    requireLocalCatalog().generateBarcodeOnly(),
  )
  handleDesktopIpc('desktop:catalog:list-staff', () =>
    requireLocalCatalog().listStaff(),
  )
  handleDesktopIpc('desktop:catalog:get-settings', () =>
    requireLocalCatalog().getSettings(),
  )
  handleDesktopIpc('desktop:catalog:update-settings', (_event, input) =>
    requireLocalCatalog().updateSettings(input),
  )
  handleDesktopIpc('desktop:catalog:search-products', (_event, query: string, limit?: number) =>
    requireLocalCatalog().searchProducts(query, undefined, limit),
  )
  handleDesktopIpc('desktop:catalog:upsert-product', (_event, product: LocalProductUpsert) =>
    requireLocalCatalog().upsertProduct(product),
  )
  handleDesktopIpc('desktop:catalog:save-product', (_event, product: LocalProductUpsert, options) =>
    requireLocalCatalog().saveProduct(product, options),
  )
  handleDesktopIpc('desktop:catalog:delete-product', (_event, id: string) =>
    requireLocalCatalog().deleteProduct(id),
  )
  handleDesktopIpc('desktop:catalog:list-cross-numbers', (_event, productId: string) =>
    requireLocalCatalog().listCrossNumbers(productId),
  )
  handleDesktopIpc('desktop:catalog:list-popular', (_event, limit?: number) =>
    requireLocalCatalog().listPopular(undefined, limit),
  )

  handleDesktopIpc('desktop:supplier-catalog:list', (_event, options?: any) =>
    requireLocalSupplierCatalog().list(options),
  )
  handleDesktopIpc('desktop:supplier-catalog:list-imports', (_event, tenantId?: string, limit?: number) =>
    requireLocalSupplierCatalog().listImports(tenantId, limit),
  )
  handleDesktopIpc('desktop:supplier-catalog:get-import', (_event, id: string, tenantId?: string) =>
    requireLocalSupplierCatalog().getImport(id, tenantId),
  )
  handleDesktopIpc('desktop:supplier-catalog:create', (_event, input: any) =>
    requireLocalSupplierCatalog().create(input),
  )
  handleDesktopIpc('desktop:supplier-catalog:update', (_event, id: string, input: any, tenantId?: string) =>
    requireLocalSupplierCatalog().update(id, input, tenantId),
  )
  handleDesktopIpc('desktop:supplier-catalog:delete', (_event, id: string, tenantId?: string) =>
    requireLocalSupplierCatalog().delete(id, tenantId),
  )
  handleDesktopIpc('desktop:supplier-catalog:import-rows', (_event, filename: string, rows: any[], options: any) =>
    requireLocalSupplierCatalog().importRows(filename, rows, options),
  )

  handleDesktopIpc('desktop:auth:login', (_event, phone: string, password: string) => {
    const user = requireLocalStaff().loginWithPassword(phone, password)
    desktopAuthSession = { id: user.id, tenant_id: user.tenant_id, role: user.role }
    return user
  })
  handleDesktopIpc('desktop:auth:login-online', (_event, phone: string, password: string) =>
    loginOnlineAndProvisionLocal(phone, password))
  handleDesktopIpc('desktop:auth:logout', () => {
    desktopAuthSession = null
    return { success: true }
  })
  handleDesktopIpc('desktop:staff:list-users', () => requireLocalStaff().listUsers())
  handleDesktopIpc('desktop:staff:save-server-user', (_event, input: any, password: string) =>
    requireLocalStaff().saveServerUser(input, password))
  handleDesktopIpc('desktop:staff:update-user', (_event, id: string, input: any) => requireLocalStaff().updateUser(id, input))
  handleDesktopIpc('desktop:staff:delete-user', (_event, id: string) => requireLocalStaff().deleteUser(id))
  handleDesktopIpc('desktop:staff:save-server-password', (_event, id: string, password: string) =>
    requireLocalStaff().saveServerPassword(id, password))
  handleDesktopIpc('desktop:staff:set-pin', (_event, userId: string, pin: string) => requireLocalStaff().setPin(userId, pin))
  handleDesktopIpc('desktop:staff:verify-pin', (_event, userId: string, pin: string) => {
    const session = requireDesktopSession()
    if (userId !== session.id) throw new Error('PIN можна перевіряти лише для поточного користувача')
    return requireLocalStaff().verifyPin(session.id, pin, session.tenant_id)
  })
  handleDesktopIpc('desktop:staff:list-commission-rules', () => requireLocalStaff().listCommissionRules())
  handleDesktopIpc('desktop:staff:create-commission-rule', (_event, input: any) => requireLocalStaff().createCommissionRule(input))
  handleDesktopIpc('desktop:staff:delete-commission-rule', (_event, id: string) => requireLocalStaff().deleteCommissionRule(id))
  handleDesktopIpc('desktop:staff:list-salary', (_event, input?: any) => requireLocalStaff().listSalary(input))
  handleDesktopIpc('desktop:staff:salary-summary', (_event, period?: string) => requireLocalStaff().salarySummary(period))
  handleDesktopIpc('desktop:staff:daily-summary', (_event, workDate?: string) => requireLocalStaff().dailySummary(workDate))
  handleDesktopIpc('desktop:staff:create-salary', (_event, input: any) => requireLocalStaff().createSalary(input))
  handleDesktopIpc('desktop:staff:daily-payout', (_event, input: any) => requireLocalStaff().dailyPayout(input))
  handleDesktopIpc('desktop:staff:delete-salary', (_event, id: string) => requireLocalStaff().deleteSalary(id))
  handleDesktopIpc('desktop:warehouse:list-movements', (_event, input?: any) =>
    requireLocalWarehouse().listMovements(input),
  )
  handleDesktopIpc('desktop:warehouse:create-movement', (_event, input: any) =>
    requireLocalWarehouse().createMovement(input),
  )
  handleDesktopIpc('desktop:warehouse:list-reserves', (_event, tenantId?: string) =>
    requireLocalWarehouse().listReserves(tenantId),
  )
  handleDesktopIpc('desktop:warehouse:create-reserve', (_event, input: any) =>
    requireLocalWarehouse().createReserve(input),
  )
  handleDesktopIpc('desktop:warehouse:release-reserve', (_event, id: string, tenantId?: string) =>
    requireLocalWarehouse().releaseReserve(id, tenantId),
  )
  handleDesktopIpc('desktop:warehouse:list-writeoffs', (_event, input?: any) =>
    requireLocalWarehouse().listWriteoffs(input),
  )
  handleDesktopIpc('desktop:warehouse:get-writeoff', (_event, id: string, tenantId?: string) =>
    requireLocalWarehouse().getWriteoff(id, tenantId),
  )
  handleDesktopIpc('desktop:warehouse:create-writeoff', (_event, input: any) =>
    requireLocalWarehouse().createWriteoff(input),
  )
  handleDesktopIpc('desktop:inventory:list-sessions', (_event, input?: { tenant_id?: string }) =>
    requireLocalInventory().listSessions(input?.tenant_id),
  )
  handleDesktopIpc('desktop:inventory:create-session', (_event, input: { tenant_id?: string; name: string; created_by?: string | null; created_at?: string | null }) =>
    requireLocalInventory().createSession(input),
  )
  handleDesktopIpc('desktop:inventory:start-session', (_event, sessionId: string, input?: { tenant_id?: string; user_id?: string | null }) =>
    requireLocalInventory().startSession(sessionId, input),
  )
  handleDesktopIpc('desktop:inventory:delete-session', (_event, sessionId: string, tenantId?: string) =>
    requireLocalInventory().deleteEmptySession(sessionId, tenantId),
  )
  handleDesktopIpc('desktop:inventory:get-session', (_event, sessionId: string, input?: { tenant_id?: string; user_id?: string }) =>
    requireLocalInventory().getSessionData(sessionId, input?.tenant_id, input?.user_id),
  )
  handleDesktopIpc('desktop:inventory:find-product', (_event, sessionId: string, input: { tenant_id?: string; code?: string; product_id?: string }) =>
    requireLocalInventory().findProduct(sessionId, input),
  )
  handleDesktopIpc('desktop:inventory:count', (_event, sessionId: string, input: any) =>
    requireLocalInventory().countProduct(sessionId, input),
  )
  handleDesktopIpc('desktop:inventory:scan', (_event, sessionId: string, input: any) =>
    requireLocalInventory().scan(sessionId, input),
  )
  handleDesktopIpc('desktop:inventory:set-item-qty', (_event, sessionId: string, itemId: string, input: { tenant_id?: string; counted_stock: number }) =>
    requireLocalInventory().setItemQty(sessionId, itemId, input),
  )
  handleDesktopIpc('desktop:inventory:remove-item', (_event, sessionId: string, itemId: string, tenantId?: string) =>
    requireLocalInventory().removeItem(sessionId, itemId, tenantId),
  )
  handleDesktopIpc('desktop:inventory:labels', (_event, sessionId: string, tenantId?: string) =>
    requireLocalInventory().getLabels(sessionId, tenantId),
  )
  handleDesktopIpc('desktop:inventory:apply-price', (_event, sessionId: string, input: { tenant_id?: string; product_id: string; retail_price: number }) =>
    requireLocalInventory().applyPrice(sessionId, input),
  )
  handleDesktopIpc('desktop:inventory:complete', (_event, sessionId: string, input?: { tenant_id?: string; user_id?: string | null }) =>
    requireLocalInventory().complete(sessionId, input),
  )
  handleDesktopIpc('desktop:orders:list-ready', (_event, input?: { tenant_id?: string; search?: string; limit?: number }) =>
    requireLocalOrders().listReadyOrders(input),
  )
  handleDesktopIpc('desktop:orders:list', (_event, input) =>
    requireLocalOrders().listOrders(input),
  )
  handleDesktopIpc('desktop:orders:save', (_event, input, id?: string) =>
    requireLocalOrders().saveOrder(input, id),
  )
  handleDesktopIpc('desktop:orders:delete', (_event, id: string, tenantId?: string) =>
    requireLocalOrders().deleteOrder(id, tenantId),
  )
  handleDesktopIpc('desktop:orders:update-status', (_event, id: string, status: string, tenantId?: string) =>
    requireLocalOrders().updateOrderStatus(id, status, tenantId),
  )
  handleDesktopIpc('desktop:orders:update-item-status', (_event, orderId: string, itemId: string, status: string, tenantId?: string) =>
    requireLocalOrders().updateOrderItemStatus(orderId, itemId, status, tenantId),
  )
  handleDesktopIpc('desktop:orders:cancel', (_event, id: string, input) =>
    requireLocalOrders().cancelOrder(id, input),
  )
  handleDesktopIpc('desktop:orders:pending-items', (_event, supplierId: string, tenantId?: string) =>
    requireLocalOrders().listPendingItems(supplierId, tenantId),
  )
  handleDesktopIpc('desktop:orders:bulk-arrival', (_event, itemIds: string[], tenantId?: string) =>
    requireLocalOrders().bulkArrival(itemIds, tenantId),
  )
  handleDesktopIpc('desktop:orders:get', (_event, id: string, tenantId?: string) =>
    requireLocalOrders().getOrder(id, tenantId),
  )
  handleDesktopIpc('desktop:orders:list-payments', (_event, orderId: string, tenantId?: string) =>
    requireLocalOrders().listPayments(orderId, tenantId),
  )
  handleDesktopIpc('desktop:orders:list-payments-period', (_event, input?: { date_from?: string; date_to?: string; shift_id?: string }) =>
    requireLocalOrders().listPaymentsByPeriod(input),
  )
  handleDesktopIpc('desktop:orders:add-payment', (_event, orderId: string, input: any) =>
    requireLocalOrders().addPayment(orderId, { ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:orders:complete', (_event, orderId: string, input?: any) => {
    const actorId = requireDesktopSession().id
    const securedInput = { ...(input ?? {}), user_id: actorId }
    const result = requireLocalOrders().completeOrder(orderId, securedInput)
    requireLocalStaff().recordOrderCommissions(orderId, securedInput.tenant_id, actorId)
    return result
  })
  handleDesktopIpc('desktop:supply:list-suppliers', (_event, input?: any) =>
    requireLocalSupply().listSuppliers(input),
  )
  handleDesktopIpc('desktop:supply:get-supplier', (_event, id: string, tenantId?: string) =>
    requireLocalSupply().getSupplier(id, tenantId),
  )
  handleDesktopIpc('desktop:supply:save-supplier', (_event, input, id?: string) =>
    requireLocalSupply().saveSupplier(input, id),
  )
  handleDesktopIpc('desktop:supply:delete-supplier', (_event, id: string, tenantId?: string) =>
    requireLocalSupply().deleteSupplier(id, tenantId),
  )
  handleDesktopIpc('desktop:supply:merge-suppliers', (_event, primaryId: string, duplicateId: string, tenantId?: string) =>
    requireLocalSupply().mergeSuppliers(primaryId, duplicateId, tenantId),
  )
  handleDesktopIpc('desktop:supply:get-debts', (_event, tenantId?: string) =>
    requireLocalSupply().getSupplierDebts(tenantId),
  )
  handleDesktopIpc('desktop:supply:list-invoices', (_event, input?: any) =>
    requireLocalSupply().listInvoices(input),
  )
  handleDesktopIpc('desktop:supply:get-invoice', (_event, id: string, tenantId?: string) =>
    requireLocalSupply().getInvoice(id, tenantId),
  )
  handleDesktopIpc('desktop:supply:create-invoice', (_event, input: any) =>
    requireLocalSupply().createInvoice(input),
  )
  handleDesktopIpc('desktop:supply:update-invoice', (_event, id: string, input: any) =>
    requireLocalSupply().updateInvoice(id, input),
  )
  handleDesktopIpc('desktop:supply:pay-invoice', (_event, id: string, input: any) =>
    requireLocalSupply().payInvoice(id, input),
  )
  handleDesktopIpc('desktop:supply:post-invoice', (_event, id: string, input?: any) =>
    requireLocalSupply().postInvoice(id, input),
  )
  handleDesktopIpc('desktop:supply:cancel-invoice', (_event, id: string, tenantId?: string) =>
    requireLocalSupply().cancelInvoice(id, tenantId),
  )
  handleDesktopIpc('desktop:supply:delete-invoice', (_event, id: string, tenantId?: string) =>
    requireLocalSupply().deleteInvoice(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:list-debtors', (_event, limit?: number) =>
    requireLocalPos().listDebtors(undefined, limit),
  )
  handleDesktopIpc('desktop:pos:search-customers', (_event, input?: { tenant_id?: string; search?: string; has_debt?: boolean; limit?: number }) =>
    requireLocalPos().searchCustomers(input),
  )
  handleDesktopIpc('desktop:pos:list-customers', (_event, input) =>
    requireLocalPos().listCustomers(input),
  )
  handleDesktopIpc('desktop:pos:get-customer', (_event, id: string, tenantId?: string) =>
    requireLocalPos().getCustomer(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:get-customer-sales', (_event, id: string, tenantId?: string) =>
    requireLocalPos().getCustomerSales(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:save-customer', (_event, input, id?: string) =>
    requireLocalPos().saveCustomer(input, id),
  )
  handleDesktopIpc('desktop:pos:delete-customer', (_event, id: string, tenantId?: string) =>
    requireLocalPos().deleteCustomer(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:list-customer-vehicles', (_event, customerId: string, tenantId?: string) =>
    requireLocalPos().listCustomerVehicles(customerId, tenantId),
  )
  handleDesktopIpc('desktop:pos:save-customer-vehicle', (_event, customerId: string, input, vehicleId?: string) =>
    requireLocalPos().saveCustomerVehicle(customerId, input, vehicleId),
  )
  handleDesktopIpc('desktop:pos:delete-customer-vehicle', (_event, customerId: string, vehicleId: string, tenantId?: string) =>
    requireLocalPos().deleteCustomerVehicle(customerId, vehicleId, tenantId),
  )
  handleDesktopIpc('desktop:pos:get-customer-deposit', (_event, customerId: string, tenantId?: string) =>
    requireLocalPos().getCustomerDeposit(customerId, tenantId),
  )
  handleDesktopIpc('desktop:pos:pay-debt', (_event, input: any) =>
    requireLocalPos().payDebt({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:pos:add-customer-deposit', (_event, input: any) =>
    requireLocalPos().addCustomerDeposit({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:pos:create-cash-operation', (_event, input) =>
    requireLocalPos().createCashOperation({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:pos:list-cash-operations', (_event, shiftId: string, tenantId?: string) =>
    requireLocalPos().listCashOperations(shiftId, tenantId),
  )
  handleDesktopIpc('desktop:pos:cash-operation-summary', (_event, shiftId: string, tenantId?: string) =>
    requireLocalPos().getCashOperationSummary(shiftId, tenantId),
  )
  handleDesktopIpc('desktop:pos:expected-cash', (_event, cashierId: string) =>
    requireLocalPos().getExpectedCash(requireDesktopSession().id),
  )
  handleDesktopIpc('desktop:pos:shift-report', (_event, cashierId: string) =>
    requireLocalPos().getShiftReport(requireDesktopSession().id),
  )
  handleDesktopIpc('desktop:pos:reconcile', (_event, cashierId: string, actualAmount: number, comment: string | null) =>
    requireLocalPos().reconcileShift(requireDesktopSession().id, actualAmount, comment),
  )
  handleDesktopIpc('desktop:pos:close-shift', (_event, cashierId: string, actualAmount: number, comment: string | null) =>
    requireLocalPos().closeShift(requireDesktopSession().id, actualAmount, comment),
  )
  handleDesktopIpc('desktop:pos:open-shift', (_event, input: {
    cashier_id: string
    opening_cash?: number
    notes?: string | null
  }) => requireLocalPos().openShift({ ...input, cashier_id: requireDesktopSession().id }))
  handleDesktopIpc('desktop:pos:get-open-shift', (_event, cashierId: string) =>
    requireLocalPos().getOpenShift(requireDesktopSession().id),
  )
  handleDesktopIpc('desktop:pos:checkout', (_event, input: LocalSaleCheckoutInput) => {
    return requireLocalPos().checkout({ ...input, cashier_id: requireDesktopSession().id })
  })
  handleDesktopIpc('desktop:pos:list-sales', (_event, input) =>
    requireLocalPos().listSales(input),
  )
  handleDesktopIpc('desktop:pos:list-returns', (_event, input) =>
    requireLocalPos().listReturns(input),
  )
  handleDesktopIpc('desktop:pos:get-return', (_event, id: string, tenantId?: string) =>
    requireLocalPos().getReturn(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:get-sale-for-return', (_event, saleId: string, tenantId?: string) =>
    requireLocalPos().getSaleForReturn(saleId, tenantId),
  )
  handleDesktopIpc('desktop:pos:create-return', (_event, input) =>
    requireLocalPos().createReturn({ ...input, cashier_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:pos:get-sale', (_event, id: string, tenantId?: string) =>
    requireLocalPos().getSale(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:calculate-prices', (_event, items, tenantId?: string) =>
    requireLocalPos().calculatePrices(items, tenantId),
  )
  handleDesktopIpc('desktop:pos:suspend-sale', (_event, input) =>
    requireLocalPos().suspendSale({ ...input, cashier_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:pos:list-suspended', (_event, tenantId?: string) =>
    requireLocalPos().listSuspendedSales(tenantId),
  )
  handleDesktopIpc('desktop:pos:resume-sale', (_event, id: string, tenantId?: string) =>
    requireLocalPos().resumeSale(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:confirm-resume-sale', (_event, id: string, tenantId?: string) =>
    requireLocalPos().confirmResumeSale(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:discard-suspended-sale', (_event, id: string, tenantId?: string) =>
    requireLocalPos().discardSuspendedSale(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:check-sale-after-payment', (_event, shiftId: string, after: string, tenantId?: string) =>
    requireLocalPos().checkSaleAfterPayment(shiftId, after, tenantId),
  )
  handleDesktopIpc('desktop:sync:list-pending', (_event, limit?: number) =>
    requireLocalSync().listPending(limit),
  )
  handleDesktopIpc('desktop:sync:get-pull-state', () =>
    requireLocalSync().getPullState(),
  )
  handleDesktopIpc('desktop:sync:status', () =>
    requireLocalSync().getSyncStatus(),
  )
  handleDesktopIpc('desktop:sync:apply-pull-changes', (_event, changes: LocalSyncPullChanges) =>
    requireLocalSync().applyPullChanges(changes),
  )
  handleDesktopIpc('desktop:sync:mark-pull-failed', (_event, error: string) =>
    requireLocalSync().markPullFailed(error),
  )
  handleDesktopIpc('desktop:sync:apply-push-results', (_event, results: LocalSyncPushResult[]) =>
    requireLocalSync().applyPushResults(results),
  )
  handleDesktopIpc('desktop:sync:mark-batch-failed', (_event, sequences: number[], error: string) =>
    requireLocalSync().markBatchFailed(sequences, error),
  )
  handleDesktopIpc('desktop:print:html', (_event, html: string, options?: DesktopPrintOptions) =>
    printHtmlDocument(html, options),
  )
  handleDesktopIpc('desktop:print:list-printers', async () => {
    if (!mainWindow) return []
    const printers = await mainWindow.webContents.getPrintersAsync()
    return printers.map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      isDefault: (printer as unknown as { isDefault?: boolean }).isDefault === true,
    }))
  })
  handleDesktopIpc('desktop:print:labels-tspl', (_event, html: string, options: TsplPrintOptions) =>
    printLabelsTspl(html, options),
  )
  handleDesktopIpc('desktop:fiscal:pick-folder', async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: 'Виберіть папку',
      defaultPath: defaultPath && defaultPath.trim() ? defaultPath : undefined,
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  handleDesktopIpc('desktop:fiscal:get-config', () => requireCashalot().getPublicConfig())
  handleDesktopIpc('desktop:fiscal:set-config', (_event, update: CashalotConfigUpdate) =>
    requireCashalot().updateConfig(update),
  )
  handleDesktopIpc('desktop:fiscal:register-com', () => requireCashalot().registerCom())
  handleDesktopIpc('desktop:fiscal:status', () => requireCashalot().getStatus())
  handleDesktopIpc('desktop:fiscal:open-shift', () => requireCashalot().openShift())
  handleDesktopIpc('desktop:fiscal:close-shift', () => requireCashalot().closeShift())
  handleDesktopIpc('desktop:fiscal:x-report', () => requireCashalot().xReport())
  handleDesktopIpc('desktop:fiscal:service-cash', (_event, amount: number, direction: 'in' | 'out') =>
    requireCashalot().serviceCash(amount, direction),
  )
  handleDesktopIpc('desktop:fiscal:fiscalize-sale', async (_event, request: LocalFiscalSaleRequest) => {
    const pos = requireLocalPos()
    const intent = pos.prepareFiscalSaleIntent(request)
    if (intent.state === 'completed' || intent.state === 'fiscalized') return intent
    if (intent.state === 'fiscalizing' || intent.state === 'unknown') {
      throw new Error(
        `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Результат попередньої фіскалізації потрібно перевірити у Cashalot`,
      )
    }

    const fiscal = requireCashalot()
    if (!fiscal.isEnabled()) {
      throw new Error('ПРРО Cashalot не налаштовано або вимкнено')
    }

    pos.startFiscalSaleIntent(intent.operation_id)
    try {
      const result = await fiscal.fiscalizeCheck(request.items, request.pay, request.comment)
      return pos.markFiscalSaleIntentFiscalized(
        intent.operation_id,
        result as unknown as Record<string, unknown>,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        pos.markFiscalSaleIntentUnknown(intent.operation_id, detail)
      } catch {
        // Намір уже залишився у безпечному блокувальному стані fiscalizing/unknown.
      }
      throw new Error(
        `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Не повторюйте оплату. Перевірте чек у Cashalot: ${detail}`,
      )
    }
  })
  handleDesktopIpc('desktop:fiscal:get-sale-intent', (_event, operationId: string) =>
    requireLocalPos().getFiscalSaleIntent(operationId),
  )
  handleDesktopIpc('desktop:fiscal:resolve-unknown-sale', (
    _event,
    operationId: string,
    resolution: LocalFiscalIntentResolution,
  ) => requireLocalPos().resolveUnknownFiscalSaleIntent(operationId, resolution))
  handleDesktopIpc('desktop:fiscal:fiscalize-return', (_event, request: LocalFiscalReturnRequest) =>
    processFiscalReturn(request),
  )
  handleDesktopIpc('desktop:fiscal:list-unresolved-returns', (_event, scope: LocalFiscalReturnIntentScope) =>
    requireLocalPos().listUnresolvedFiscalReturnIntents(scope),
  )
  handleDesktopIpc('desktop:fiscal:resume-return', async (
    _event,
    operationId: string,
    scope: LocalFiscalReturnIntentScope,
  ) => processFiscalReturn(requireLocalPos().getFiscalReturnRequest(operationId, scope)))
  handleDesktopIpc('desktop:fiscal:resolve-unknown-return', (
    _event,
    operationId: string,
    resolution: LocalFiscalReturnIntentResolution,
  ) => requireLocalPos().resolveUnknownFiscalReturnIntent(operationId, resolution))
  handleDesktopIpc('desktop:fiscal:cancel-prepared-return', (
    _event,
    operationId: string,
    input: LocalFiscalReturnIntentCancelInput,
  ) => requireLocalPos().cancelPreparedFiscalReturnIntent(operationId, input))

  await createWindow()
}).catch((error: unknown) => {
  writeDesktopDiagnostic('startup-failed', error)
  console.error('Forsage desktop startup failed', error)
  dialog.showErrorBox(
    'Forsage не запустився',
    'Причину записано у локальний журнал помилок. Дані магазину не видалено.',
  )
  app.exit(1)
})

process.on('uncaughtException', (error) => {
  writeDesktopDiagnostic('uncaught-exception', error)
  app.exit(1)
})
process.on('unhandledRejection', (reason) => {
  writeDesktopDiagnostic('unhandled-rejection', reason)
})
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
    writeDesktopDiagnostic('child-process-gone', details)
  }
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
  localSupplierCatalog = null
})

