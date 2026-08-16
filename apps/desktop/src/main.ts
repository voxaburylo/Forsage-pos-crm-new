import path from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { LocalDatabase } from './db/localDatabase'
import { AsyncLocalStorage } from 'node:async_hooks'
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
import { enqueuePrinterJob } from './print/printerJobQueue'
import { assertPrinterRole, type PrinterRole } from './print/printerRole'
import { withPrintTimeout } from './print/printTimeout'
import { isLanProxyChannel, LocalNetworkCoordinator, type LanSession } from './lan/localNetwork'
import { isSpoolerGuardError, postflightPrinter, preflightPrinter } from './print/spoolerGuard'
import { desktopTenantArgumentPositions, isDesktopChannelAllowed, PUBLIC_DESKTOP_CHANNELS } from './security/desktopAuthorization'

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

// Electron does not provide the usual browser text menu automatically.
// Install it for every current and future BrowserWindow (main UI, print preview,
// and any auxiliary window), so text fields behave consistently everywhere.
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('context-menu', (_contextEvent, params) => {
    const hasSelection = params.selectionText.trim().length > 0
    if (!params.isEditable && !hasSelection) return

    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { label: 'Скасувати', role: 'undo', enabled: params.editFlags.canUndo },
          { label: 'Повторити', role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          { label: 'Вирізати', role: 'cut', enabled: params.editFlags.canCut },
          { label: 'Копіювати', role: 'copy', enabled: params.editFlags.canCopy || hasSelection },
          { label: 'Вставити', role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { label: 'Виділити все', role: 'selectAll', enabled: params.editFlags.canSelectAll },
        ]
      : [
          { label: 'Копіювати', role: 'copy', enabled: hasSelection },
          { type: 'separator' },
          { label: 'Виділити все', role: 'selectAll' },
        ]

    Menu.buildFromTemplate(template).popup({ window })
  })
})

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
let localNetwork: LocalNetworkCoordinator | null = null
type DesktopIpcListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
const desktopCommandHandlers = new Map<string, DesktopIpcListener>()
const desktopSessionContext = new AsyncLocalStorage<LanSession>()
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
  /** Жорстко не дозволяє чеку потрапити на POS-80, а етикетці — на POS-58. */
  printerRole?: PrinterRole
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

async function loadRendererWithRetry(window: BrowserWindow): Promise<void> {
  const target = rendererIndexPath()
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!existsSync(target)) {
      lastError = new Error(`Файл інтерфейсу не знайдено: ${target}`)
    } else {
      try {
        await window.loadFile(target)
        return
      } catch (error) {
        lastError = error
      }
    }
    writeDesktopDiagnostic('renderer-load-retry', { attempt, target, error: diagnosticValue(lastError) })
    if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
  throw lastError instanceof Error ? lastError : new Error('Не вдалося завантажити інтерфейс Forsage')
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
  const contextualSession = desktopSessionContext.getStore()
  if (contextualSession) return contextualSession
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

function handleDesktopIpc(channel: string, listener: DesktopIpcListener): void {
  desktopCommandHandlers.set(channel, listener)
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now()
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('Неприпустиме джерело локальної команди')
    }
    try {
      const session = PUBLIC_DESKTOP_CHANNELS.has(channel) ? null : requireDesktopSession()
      if (session && localNetwork?.getStatus().mode === 'client' && isLanProxyChannel(channel)) {
        return await localNetwork.invoke(channel, args, session)
      }
      return await executeDesktopCommand(channel, listener, event, args, session)
    } finally {
      const durationMs = Date.now() - startedAt
      if (durationMs >= 2_000) {
        writeDesktopDiagnostic('slow-desktop-command', { channel, duration_ms: durationMs })
      }
    }
  })
}

async function executeDesktopCommand(
  channel: string,
  listener: DesktopIpcListener,
  event: IpcMainInvokeEvent,
  args: any[],
  session: LanSession | null,
): Promise<unknown> {
  if (!PUBLIC_DESKTOP_CHANNELS.has(channel)) {
    if (!session) throw new Error('Необхідно увійти в програму')
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
  const run = () => Promise.resolve(listener(event, ...args))
  return session ? desktopSessionContext.run(session, run) : run()
}

function resolveLanSession(userId: string): LanSession | null {
  const row = requireLocalDatabase().prepare(`
    SELECT id, tenant_id, role, is_active FROM staff_users
    WHERE id = ? AND tenant_id = ? LIMIT 1
  `).get(userId, DEFAULT_TENANT_ID) as (LanSession & { is_active: number }) | undefined
  if (!row || row.is_active !== 1 || row.role === 'tire_worker') return null
  return { id: row.id, tenant_id: row.tenant_id, role: row.role }
}

async function executeLanCommand(channel: string, args: unknown[], session: LanSession): Promise<unknown> {
  const listener = desktopCommandHandlers.get(channel)
  if (!listener) throw new Error('Локальну команду не знайдено')
  return executeDesktopCommand(channel, listener, {} as IpcMainInvokeEvent, args, session)
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
  let unresponsiveAt: number | null = null
  mainWindow.on('unresponsive', () => {
    unresponsiveAt = Date.now()
    writeDesktopDiagnostic('window-unresponsive', { route: mainWindow?.webContents.getURL() ?? null })
  })
  mainWindow.on('responsive', () => {
    if (unresponsiveAt === null) return
    writeDesktopDiagnostic('window-responsive', { duration_ms: Date.now() - unresponsiveAt })
    unresponsiveAt = null
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

  const showMainWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }
  // Підписуємося ДО loadFile: на швидкому диску ready-to-show може настати
  // раніше за пізно зареєстрований обробник і лишити порожнє вікно.
  mainWindow.once('ready-to-show', showMainWindow)
  mainWindow.webContents.once('did-finish-load', () => setTimeout(showMainWindow, 0))

  if (!app.isPackaged && developmentUrl) await mainWindow.loadURL(developmentUrl)
  else await loadRendererWithRetry(mainWindow)
  mainWindow.on('closed', () => { desktopAuthSession = null; mainWindow = null })
}

function sanitizePageMm(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

function createPrintDocumentName(role?: PrinterRole): string {
  const kind = role === 'receipt' ? 'receipt' : role === 'label' ? 'label' : 'document'
  return `Forsage-${kind}-${randomUUID().slice(0, 8)}`
}

async function executePrintHtmlDocument(html: string, options: DesktopPrintOptions = {}): Promise<{ success: true }> {
  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new Error('PRINT_HTML_EMPTY')
  }

  const deviceName = String(options.deviceName ?? '').trim()
  if (options.printerRole) assertPrinterRole(deviceName, options.printerRole)
  const documentName = createPrintDocumentName(options.printerRole)
  const widthMm = sanitizePageMm(options.widthMm, 40, 10, 300)
  const heightMm = sanitizePageMm(options.heightMm, 30, 10, 300)
  const printWindow = new BrowserWindow({
    title: documentName,
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

  const destroyPrintWindow = () => {
    if (!printWindow.isDestroyed()) printWindow.destroy()
  }

  try {
    await withPrintTimeout(
      printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
      15_000,
      'PRINT_RENDER_TIMEOUT',
      destroyPrintWindow,
    )
    await withPrintTimeout(
      printWindow.webContents.executeJavaScript(
        `document.title = ${JSON.stringify(documentName)}; Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => null))).then(() => true)`,
        true,
      ),
      10_000,
      'PRINT_RESOURCES_TIMEOUT',
      destroyPrintWindow,
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
        const timeout = setTimeout(() => {
          if (done) return
          done = true
          try { printWindow.webContents.stop() } catch { /* window may already be gone */ }
          reject(new Error('PRINT_OUTCOME_UNKNOWN'))
        }, opts.silent === true ? 20_000 : 60_000)
        printWindow.webContents.print(opts, (success, failureReason) => {
          if (done) return
          done = true
          clearTimeout(timeout)
          if (success) resolve()
          else if (failureReason === 'cancelled') reject(new Error('PRINT_CANCELLED'))
          else reject(new Error(failureReason || 'PRINT_FAILED'))
        })
      })

    // Залипле завдання цього ж принтера з'їло б друк мовчки — чистимо до відправки.
    if (deviceName) await preflightPrinter(deviceName)
    const submittedAfter = new Date(Date.now() - 2_000).toISOString()

    let lastError: unknown = null
    for (const opts of attempts) {
      try {
        await printOnce(opts)
        // Спулер прийняв байти — це ще не друк. Переконуємось, що завдання пішло.
        if (deviceName && options.silent === true) await postflightPrinter(deviceName, documentName, submittedAfter)
        return { success: true }
      } catch (error) {
        lastError = error
        if (error instanceof Error && (
          error.message === 'PRINT_OUTCOME_UNKNOWN' || error.message === 'PRINT_CANCELLED'
        )) break
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

function printHtmlDocument(html: string, options: DesktopPrintOptions = {}): Promise<{ success: true }> {
  const deviceName = String(options.deviceName ?? '').trim()
  return enqueuePrinterJob(deviceName, () => executePrintHtmlDocument(html, options))
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
  localNetwork = new LocalNetworkCoordinator(dataRoot, executeLanCommand, resolveLanSession)

  handleDesktopIpc('desktop:get-runtime-info', () => requireLocalDatabase().info())

  handleDesktopIpc('desktop:lan:get-status', () => localNetwork?.getStatus())
  handleDesktopIpc('desktop:lan:update', (_event, input) => localNetwork?.update(input))
  handleDesktopIpc('desktop:lan:test', () => localNetwork?.testConnection())
  handleDesktopIpc('desktop:backup-now', () => requireLocalDatabase().backupNow())
  handleDesktopIpc('desktop:bootstrap:import-snapshot', (_event, snapshot: LocalBootstrapSnapshot) =>
    requireLocalSync().importSnapshotChunked(snapshot),
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
  handleDesktopIpc('desktop:staff:save-server-user', (_event, input: any, password?: string) =>
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
  handleDesktopIpc('desktop:staff:tire-service-report', (_event, workDate?: string) => requireLocalStaff().tireServiceReport(workDate))
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
    requireLocalInventory().createSession({ ...input, created_by: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:inventory:start-session', (_event, sessionId: string, input?: { tenant_id?: string; user_id?: string | null }) =>
    requireLocalInventory().startSession(sessionId, { ...(input ?? {}), user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:inventory:delete-session', (_event, sessionId: string, tenantId?: string) =>
    requireLocalInventory().deleteEmptySession(sessionId, tenantId),
  )
  handleDesktopIpc('desktop:inventory:get-session', (_event, sessionId: string, input?: { tenant_id?: string; user_id?: string }) =>
    requireLocalInventory().getSessionData(sessionId, input?.tenant_id, requireDesktopSession().id),
  )
  handleDesktopIpc('desktop:inventory:find-product', (_event, sessionId: string, input: { tenant_id?: string; code?: string; product_id?: string }) =>
    requireLocalInventory().findProduct(sessionId, input),
  )
  handleDesktopIpc('desktop:inventory:count', (_event, sessionId: string, input: any) =>
    requireLocalInventory().countProduct(sessionId, { ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:inventory:scan', (_event, sessionId: string, input: any) =>
    requireLocalInventory().scan(sessionId, { ...input, user_id: requireDesktopSession().id }),
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
    requireLocalInventory().complete(sessionId, { ...(input ?? {}), user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:orders:list-ready', (_event, input?: { tenant_id?: string; search?: string; limit?: number }) =>
    requireLocalOrders().listReadyOrders(input),
  )
  handleDesktopIpc('desktop:orders:list', (_event, input) =>
    requireLocalOrders().listOrders(input),
  )
  handleDesktopIpc('desktop:orders:save', (_event, input, id?: string) =>
    requireLocalOrders().saveOrder({ ...input, manager_id: requireDesktopSession().id }, id),
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
    requireLocalOrders().cancelOrder(id, { ...(input ?? {}), user_id: requireDesktopSession().id }),
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
    requireLocalSupply().createInvoice({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:supply:create-invoice-from-ai', (_event, input: any) =>
    requireLocalSupply().createInvoiceFromAiRows({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:supply:update-invoice', (_event, id: string, input: any) =>
    requireLocalSupply().updateInvoice(id, input),
  )
  handleDesktopIpc('desktop:supply:pay-invoice', (_event, id: string, input: any) =>
    requireLocalSupply().payInvoice(id, { ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:supply:post-invoice', (_event, id: string, input?: any) =>
    requireLocalSupply().postInvoice(id, { ...(input ?? {}), user_id: requireDesktopSession().id }),
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
  handleDesktopIpc('desktop:pos:find-customer-by-barcode', (_event, barcode: string) =>
    requireLocalPos().findCustomerByBarcode(barcode),
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
  handleDesktopIpc('desktop:pos:payout-customer-deposit', (_event, input: any) =>
    requireLocalPos().payOutCustomerDeposit({ ...input, user_id: requireDesktopSession().id }),
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
  handleDesktopIpc('desktop:pos:dashboard-summary', (_event, input) =>
    requireLocalPos().dashboardSummary(input),
  )
  handleDesktopIpc('desktop:pos:sold-items-report', (_event, input) =>
    requireLocalPos().soldItemsReport(input),
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
    requireLocalSync().applyPullChangesChunked(changes),
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

  await localNetwork.startConfigured()
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
  void localNetwork?.stop()
  localNetwork = null
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

