import { localAnalytics } from './repositories/localAnalytics'
import path from 'node:path'
import { pendingUnitSpellings, tidyUnitSpellings } from './repositories/catalogUnitTidy'
import { pendingErasedBarcodes, restoreErasedBarcodes } from './repositories/restoreErasedBarcodes'
import { resolvePortableExecutable } from './updates/installedPortable'
import { PinRoster } from './security/pinRoster'
import { webRpcChannelAllowed } from './lan/webRpcChannels'
import { TillDeviceLink } from './link/tillDeviceLink'
import { serverDataDue, storeServerData } from './backup/serverDataCopy'
import { isExpectedCommandFailure } from './diagnostics/expectedCommandFailure'
import { RendererRecovery } from './rendererRecovery'
import { deferQuitForMainWindow, NativeCloseController, requestUnloadScript } from './nativeClose'
import { BlackBox } from './diagnostics/blackBox'
import { safeDiagnosticDetails } from './diagnostics/blackBoxData'
import { readBuildInfo } from './diagnostics/buildInfo'
import { LOCAL_CRASH_OPTIONS } from './diagnostics/localCrashCapture'
import { existsSync, mkdirSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, shell, safeStorage, powerMonitor, crashReporter, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { RememberedAccess, type RememberedUser } from './security/rememberedAccess'
import { DesktopSessionLifecycleError, serverSessionCacheResultForError } from './security/desktopSessionLifecycle'
import { verifyAndRememberServerSession } from './security/serverSession'
import { CatalogCleanupRepository } from './repositories/catalogCleanupRepository'
import { catalogAutoMergeTick } from './repositories/catalogAutoMerge'
import { CatalogTidyRepository } from './repositories/catalogTidyRepository'
import { scanCatalogCleanup } from './repositories/catalogCleanupWorker'
import { checkCleanupCapability, cleanupCartBlockers } from './security/catalogCleanupSafety'
import { createMirrorSigner } from './security/mirrorIdentity'
import { LocalDatabase, LocalDatabaseOpenError, OutdatedBuildError, type LocalDatabaseOpenResult } from './db/localDatabase'
import { startBackupScheduler } from './db/backupScheduler'
import { ShiftBackupService } from './backup/shiftBackupService'
import { customerHistory } from './repositories/customerHistory'
import { runCatalogAgent } from './repositories/catalogAgentWorker'
import { assertLocalDataAuthority } from './security/localDataAuthority'
import { fetchCloudBackup, type CloudBackupRequest } from './backup/cloudRestore'
import { ExternalBackupService, importExternalCopy, readExternalConfig, setExternalFolder } from './backup/externalBackup'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_TENANT_ID } from './db/localTypes'
import type {
  LocalFiscalIntentResolution,
  LocalFiscalReturnIntentCancelInput,
  LocalFiscalReturnIntentResolution,
  LocalFiscalReturnIntentScope,
  LocalFiscalSaleRequest,
  LocalFiscalReturnRequest,
  LocalProductUpsert,
  LocalSaleCheckoutInput,
  LocalSyncPushResult,
} from './db/localTypes'
import { LocalCatalogRepository } from './repositories/catalogRepository'
import { applyCatalogBatch } from './repositories/catalogBatchWorker'
import { CatalogAgentRepository } from './repositories/catalogAgentRepository'
import { createAiInvoiceInWorker, previewAiInvoiceInWorker, commitReceivingInWorker, prewarmAiInvoiceCheck } from './repositories/supplyInvoiceWorker'
import { LocalInventoryRepository } from './repositories/inventoryRepository'
import { LocalOrderRepository } from './repositories/orderRepository'
import { LocalPosRepository } from './repositories/posRepository'
import { LocalSupplyRepository } from './repositories/supplyRepository'
import { requireDocumentRevision } from './repositories/documentRevision'
import { LocalStaffRepository, businessDate } from './repositories/staffRepository'
import { LocalWarehouseRepository } from './repositories/warehouseRepository'
import { LocalPurchaseRepository } from './repositories/localPurchaseRepository'
import { LocalSyncRepository } from './repositories/syncRepository'
import { createBackgroundSyncExecutor } from './repositories/syncPullWorker'
import { LocalSupplierCatalogRepository } from './repositories/supplierCatalogRepository'
import { LocalProblemRepository } from './repositories/problemRepository'
import {
  CashalotService,
  type CashalotConfigUpdate,
} from './fiscal/cashalotService'
import { fiscalizeSale, processFiscalReturn } from './fiscal/fiscalOrchestration'
import { printLabelsTspl, type TsplPrintOptions } from './print/tsplLabelPrinter'
import { canUseReceiptGdiFallback, printReceiptViaGdi } from './print/receiptGdiPrinter'
import { enqueuePrinterJob, setPrinterJobGuard } from './print/printerJobQueue'
import { PrintAttemptGuard } from './print/printAttemptGuard'
import { setPrintProcessReporter } from './print/printProcess'
import { assertPrinterRole, type PrinterRole } from './print/printerRole'
import { withPrintTimeout } from './print/printTimeout'
import { loadPrintHtml } from './print/loadPrintHtml'
import { getPrintSession, isPrintSession } from './print/printSession'
import { assertPrintRuntimeFiles } from './print/printRuntime'
import { isLanProxyChannel, LocalNetworkCoordinator, type LanSession } from './lan/localNetwork'
import { rememberedManagerClient } from './lan/lanClientMemory'
import { isWebMergeChannel, runWebCatalogMerge } from './repositories/webCatalogMerge'
import { productPhotoThumbnails } from './lib/photoThumbnails'
import { RealtimeWake } from './link/realtimeWake'
import { OutboxPusher } from './link/outboxPush'
import { LanOrderQueue } from './lan/orderQueue'
import { buildLanDiagnosis, readFirewallState, requestFirewallRule } from './lan/diagnostics'
import { assertLanIdentityConnection, canPairEmptyClient, cacheLanIdentity, hasLanIdentity, loginLanClient } from './lan/clientIdentity'
import { createPortableReleaseSource, downloadPortableUpdate, launchPortableUpdateAfterQuit, readPortableUpdateOutcome, settleInterruptedPortableUpdate, type StagedUpdate } from './updates/portableUpdate'
import { LanOrderClient } from './lan/orderClient'
import { isSpoolerGuardError, postflightPrinter, preflightPrinter } from './print/spoolerGuard'
import { disposePrintWarmShell, prewarmPrintShell } from './print/printWarmShell'
import { desktopTenantArgumentPositions, normalizeRemoteTenantArguments, isDesktopChannelAllowed, isManagerDepositChannel, isManagerSaleChannel, PUBLIC_DESKTOP_CHANNELS } from './security/desktopAuthorization'
import { cardBatchCodes, generateCardBatch, isFreeCard, listCardBatches } from './repositories/customerCardBatches'
import { buildStatusReport } from './link/statusReport'
import { nightlyCheckTick, readNightlySummary } from './diagnostics/nightlyCheckRunner'
import { MANAGER_DEPOSIT_ONLY, MANAGER_SALE_DENIED, WEB_ACCESS_PROBE, WEB_WORK_DENIED, canWorkViaWeb, managerCanSell, managerCanTakeDeposit, managerDepositAllowedIds, managerSaleAllowedIds, setManagerDepositAccess, setManagerSaleAccess, setWebWorkAccess, webWorkAllowedIds } from './security/managerSaleAccess'
import { employeePricing, setEmployeePricing } from './security/employeePricing'
import { activeSession } from './security/activeSession'
import { customerWritePayload } from './security/customerWritePolicy'
import { BACKGROUND_TASK, clearHandoff, decideStart, handoffRequested, isBackgroundLaunch, releaseOwner, writeOwner } from './background/tillOwner'
import { spawn } from 'node:child_process'
import { rehearsalRootFrom, runStartupRehearsal } from './diagnostics/startupRehearsal'
import { allStaffRights, effectiveStaffRights, setStaffRight, WRITEOFF_CREATE_CHANNELS } from './security/staffRights'
import { compactOutbox, previewOutboxCompaction } from './repositories/outboxCompaction'
import { quickCheckInWorker } from './db/verifiedBackup'

// Keep the existing encryption profile stable across package/product renames.
// Перевірки (смоки) запускають справжню програму поруч із робочою касою — їм окремий профіль; у зібраній програмі цього немає.
// 23.11.2026 (план C7): репетиція оновлення — копія бази в окремій теці, власний профіль, без мережі (diagnostics/startupRehearsal).
const rehearsalRoot = rehearsalRootFrom(process.argv, process.env)
if (rehearsalRoot) {
  // Жодного звернення назовні: ні сервер, ні Telegram, ні ШІ. Репетиція лише відкриває й перевіряє копію.
  globalThis.fetch = (async () => { throw new Error('REHEARSAL_OFFLINE') }) as typeof fetch
}
app.setPath('userData', rehearsalRoot ? path.join(rehearsalRoot, 'userData')
  : !app.isPackaged && process.env.FORSAGE_TEST_USER_DATA ? process.env.FORSAGE_TEST_USER_DATA : path.join(app.getPath('appData'), 'desktop'))
// This business UI/thermal rasterizer does not require 3D acceleration.
// Avoid the hardware-driver path on Windows, including remote desktop sessions.
if (process.platform === 'win32') app.disableHardwareAcceleration()
/**
 * 22.11.2026, рішення власника: база головного ПК працює у фоні одразу після ввімкнення ПК, ще до входу у Windows,
 * щоб веб працював, навіть коли касу не відкрито. Фонова копія (--background) — без вікна; вікно каси при запуску
 * просить її відпустити базу й чекає, а закриваючись — запускає фон знову. Базу тримає лише одна копія (background/tillOwner).
 */
const backgroundMode = isBackgroundLaunch(process.argv)
const ownerDataRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Forsage') : app.getPath('userData')
let startDecision: ReturnType<typeof decideStart> = { action: 'start' }
try { mkdirSync(ownerDataRoot, { recursive: true }); startDecision = decideStart(ownerDataRoot, backgroundMode) }
catch { /* без файла власника — звичайний запуск, як до 22.11.2026 */ }
const gotSingleInstanceLock = startDecision.action === 'start' && app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
else { try { writeOwner(ownerDataRoot, backgroundMode ? 'background' : 'window') } catch { /* не заважає запуску */ } }
const blackBox = gotSingleInstanceLock ? new BlackBox(path.join(
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Forsage') : app.getPath('userData'), 'logs', 'blackbox',
)) : null
blackBox?.record('runtime', { pid: process.pid, version: app.getVersion(), electron: process.versions.electron,
  node: process.versions.node, platform: process.platform, arch: process.arch })
const desktopBuildInfo = readBuildInfo(__dirname)
try { blackBox?.record('build', { build: desktopBuildInfo?.contentHash ?? createHash('sha256').update(readFileSync(__filename)).digest('hex'),
  release: desktopBuildInfo?.releaseId, builtAt: desktopBuildInfo?.builtAt, version: desktopBuildInfo?.version }) } catch { /* optional identity */ }
// Capture the native stack on the next renderer/GPU/utility crash, locally only.
if (gotSingleInstanceLock) {
  try {
    const crashDir = path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Forsage') : app.getPath('userData'), 'logs', 'crashes')
    mkdirSync(crashDir, { recursive: true })
    app.setPath('crashDumps', crashDir)
    crashReporter.start(LOCAL_CRASH_OPTIONS)
    blackBox?.record('local-crash-capture-started')
  } catch (error) { blackBox?.record('local-crash-capture-failed', error) }
}
let diagnosticCommandSequence = 0
let audioServiceUnavailable = false
blackBox?.record('rendering-policy', { reason: process.platform === 'win32' ? 'software' : 'system-default' })
app.on('web-contents-created', (_event, contents) => {
  if (!isPrintSession(contents.session)) return
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('render-process-gone', (_goneEvent, details) => {
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') blackBox?.record('print-renderer-process-gone', details)
  })
  contents.on('did-fail-load', (_loadEvent, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame) blackBox?.record('print-document-load-failed', { exitCode: errorCode })
  })
})

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
let stopBackupScheduler: (() => void) | null = null
let shiftBackups: ShiftBackupService | null = null
let externalBackups: ExternalBackupService | null = null
let tillDeviceLink: TillDeviceLink | null = null
let databaseMaintenance = false
let quitAfterCleanup = false
let localCatalog: LocalCatalogRepository | null = null
let localInventory: LocalInventoryRepository | null = null
let localOrders: LocalOrderRepository | null = null
let localPos: LocalPosRepository | null = null
let localSupply: LocalSupplyRepository | null = null
let localStaff: LocalStaffRepository | null = null
let localWarehouse: LocalWarehouseRepository | null = null
let localSync: LocalSyncRepository | null = null
let localSupplierCatalog: LocalSupplierCatalogRepository | null = null
let localProblems: LocalProblemRepository | null = null
let localNetwork: LocalNetworkCoordinator | null = null
let lanOrderQueue: LanOrderQueue | null = null
let lanOrderClient: LanOrderClient | null = null
let lanOrderTimer: ReturnType<typeof setInterval> | null = null
let lanPairInProgress = false
let lanUpdateTimer: ReturnType<typeof setInterval> | null = null
let lanUpdateFlight: Promise<void> | null = null
let lanUpdateAbort: AbortController | null = null
let stagedLanUpdate: StagedUpdate | null = null
/**
 * 25.11.2026 (власник: «на втором ПК программа не обновляется — подумай почему»): причина була лише в чорній скриньці
 * ПК менеджера. Тепер стан оновлення видно на екрані («Налаштування» → «ПК і копії»): коли перевіряв, що завантажив,
 * чому не завантажив, чому не встановив і чим закінчилась остання установка.
 */
const lanUpdateStatus: { checkedAt: string | null; error: string | null; installError: string | null } = { checkedAt: null, error: null, installError: null }
function lanUpdateReport() {
  let outcome: unknown = null
  try { outcome = process.env.LOCALAPPDATA ? readPortableUpdateOutcome(process.env.LOCALAPPDATA) : null }
  catch (error) { outcome = { state: 'unknown', message: error instanceof Error ? error.message : String(error) } }
  return { ...lanUpdateStatus, staged: stagedLanUpdate?.releaseId ?? null, outcome,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE), executable: process.env.PORTABLE_EXECUTABLE_FILE ?? null }
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)
type DesktopIpcListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
const desktopCommandHandlers = new Map<string, DesktopIpcListener>()
const activeDesktopCommands = new Set<Promise<unknown>>()
const desktopSessionContext = new AsyncLocalStorage<LanSession>()
let cashalot: CashalotService | null = null
let desktopDataRoot: string | null = null
let desktopAuthSession: { id: string; tenant_id: string; role: string } | null = null
let rememberedAccess: RememberedAccess | null = null
let rememberedSessionRequired = false
let desktopLoginGeneration = 0
let serverSessionSaveGeneration = 0
function rememberedUser(id: string, tenant: string): RememberedUser | null {
  return (localDatabase?.prepare('SELECT id,tenant_id,role,phone,full_name,password_hash,pin_hash,is_active,deleted_at FROM staff_users WHERE id=? AND tenant_id=?').get(id,tenant) as RememberedUser | undefined) ?? null
}
function getRememberedAccess(): RememberedAccess {
  if (!localDatabase) throw Error('Локальна база ще не готова')
  if (!rememberedAccess) {

    rememberedAccess = new RememberedAccess({
    read: () => {
      const row = localDatabase!.prepare("SELECT value_json FROM app_meta WHERE key='windows_day_access'").get() as { value_json:string } | undefined
      return row ? JSON.parse(row.value_json) : null
    },
    write: value => {
      if (value === null) localDatabase!.prepare("DELETE FROM app_meta WHERE key='windows_day_access'").run()
      else localDatabase!.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('windows_day_access',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(value),new Date().toISOString())
    },
    encrypt: text => {
      if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) throw Error('Захищене сховище Windows недоступне. Використайте пароль')
      return safeStorage.encryptString(text).toString('base64')
    },
    decrypt: text => safeStorage.decryptString(Buffer.from(text,'base64')),
    user: rememberedUser,

    })
  }
  return rememberedAccess
}
function rememberedStatus() {
  const status = getRememberedAccess().status()
  const locked = rememberedSessionRequired && !status
  if (locked) desktopAuthSession = null
  return { ...status, locked, available: Boolean(status) }
}
let pinRoster: PinRoster | null = null
function getPinRoster(): PinRoster {
  if (!localDatabase) throw Error('Локальна база ще не готова')
  const db = localDatabase
  pinRoster ??= new PinRoster({
    read: () => {
      const row = db.prepare("SELECT value_json FROM app_meta WHERE key='windows_day_pin_roster'").get() as { value_json: string } | undefined
      return row ? JSON.parse(row.value_json) : null
    },
    write: value => {
      if (value === null) db.prepare("DELETE FROM app_meta WHERE key='windows_day_pin_roster'").run()
      else db.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('windows_day_pin_roster',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(value), new Date().toISOString())
    },
    encrypt: text => {
      if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) throw Error('Захищене сховище Windows недоступне. Використайте пароль')
      return safeStorage.encryptString(text).toString('base64')
    },
    decrypt: text => safeStorage.decryptString(Buffer.from(text, 'base64')),
    user: rememberedUser,
  })
  return pinRoster
}
/** Швидкий вхід за PIN — лише на головному чи окремому ПК, де лежить база працівників. */
function pinLoginAvailable(): boolean {
  return localNetwork?.getStatus().mode !== 'client' && !hasLanIdentity(requireLocalDatabase())
}
function completeDesktopLogin(user: { id: string; tenant_id: string; role: string }) {
  const storedUser = rememberedUser(user.id, user.tenant_id)
  if (!storedUser) throw Error('Працівника не знайдено')
  getRememberedAccess().remember(storedUser)
  // Пароль (чи PIN цього ж дня) щойно перевірено: до кінця дня цей працівник може повертатися за PIN.
  try { if (pinLoginAvailable()) getPinRoster().rememberPasswordLogin(storedUser) }
  catch (error) { writeDesktopDiagnostic('pin-roster-unavailable', error) }
  rememberedSessionRequired = true
  desktopAuthSession = { id: user.id, tenant_id: user.tenant_id, role: user.role }
  void checkLanUpdate()
}

/** Background binary transfer only. Normal quit owns installation; no remote file paths or DB copying. */
function checkLanUpdate(): Promise<void> {
  if (lanUpdateFlight) return lanUpdateFlight
  if (databaseMaintenance || !app.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE
    || !process.env.LOCALAPPDATA || !desktopBuildInfo?.releaseId || localNetwork?.getStatus().mode !== 'client') return Promise.resolve()
  let session: LanSession
  try { session = requireDesktopSession() } catch { return Promise.resolve() }
  const network = localNetwork
  lanUpdateAbort = new AbortController()
  const signal = lanUpdateAbort.signal
  const localAppData = process.env.LOCALAPPDATA
  // 25.11.2026: перервана установка (вимкнули ПК) більше не блокує оновлення назавжди — див. settleInterruptedPortableUpdate.
  lanUpdateFlight = settleInterruptedPortableUpdate(localAppData)
    .then(state => { if (state) blackBox?.record('lan-update-settled', { state }) })
    .catch(error => { blackBox?.record('lan-update-settle-failed', { error }) })
    .then(() => downloadPortableUpdate({
    localAppData,
    currentReleaseId: desktopBuildInfo.releaseId,
    signal,
    transport: {
      describe: () => network.requestUpdateMetadata(session, signal),
      chunk: input => network.requestUpdateChunk(input, session, signal),
    },
  })).then(result => {
    lanUpdateStatus.checkedAt = new Date().toISOString(); lanUpdateStatus.error = null
    if (result.state === 'ready') {
      stagedLanUpdate = result.update
      blackBox?.record('lan-update-ready', { release: result.update.releaseId })
    }
  }).catch(error => {
    // Offline is expected. No repeated global banner, no attempt to use the cloud.
    lanUpdateStatus.checkedAt = new Date().toISOString(); lanUpdateStatus.error = errorText(error)
    blackBox?.record('lan-update-deferred', { error })
  }).finally(() => { lanUpdateFlight = null; lanUpdateAbort = null })
  return lanUpdateFlight
}

function diagnosticValue(value: unknown, depth = 0): string {
  if (value instanceof Error) {
    const cause = depth < 3 && value.cause !== undefined ? `\nПричина: ${diagnosticValue(value.cause, depth + 1)}` : ''
    return `${value.name}: ${value.message}\n${value.stack ?? ''}${cause}`
  }
  try { return JSON.stringify(value) } catch { return String(value) }
}

function writeDesktopDiagnostic(event: string, details: unknown): void {
  blackBox?.record(event, details)
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
    ? path.join(__dirname, 'renderer', 'index.html')
    : path.resolve(__dirname, '../../web/dist/index.html')
}

function requireLocalDatabase(): LocalDatabase {
  if (!localDatabase) throw new Error('LOCAL_DATABASE_NOT_READY')
  return localDatabase
}

function requireLocalProblems(): LocalProblemRepository {
  if (!localProblems) throw new Error('LOCAL_DATABASE_NOT_READY')
  return localProblems
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

function requireLocalPos(): LocalPosRepository {
  if (!localPos) throw new Error('LOCAL_POS_NOT_READY')
  return localPos
}

function requireLocalSupply(): LocalSupplyRepository {
  if (!localSupply) throw new Error('LOCAL_SUPPLY_NOT_READY')
  return localSupply
}

/** Хто з менеджерів уже має нараховану ставку за сьогодні — щоб не питати базу на кожну дію. */
const managerWorkDays = new Set<string>()
function noteManagerWorkDay(userId: string, tenantId: string): void {
  const key = `${businessDate()}:${userId}`
  if (managerWorkDays.has(key) || !localStaff) return
  try {
    localStaff.accrueManagerWorkDay(userId, tenantId)
    managerWorkDays.add(key)
  } catch (error) {
    // Нарахування ставки не повинно ламати роботу менеджера: спробуємо на наступній дії.
    console.warn('[salary] денну ставку менеджера не нараховано', error instanceof Error ? error.message : error)
  }
}

function requireLocalStaff(): LocalStaffRepository {
  if (!localStaff) throw new Error('LOCAL_STAFF_NOT_READY')
  return localStaff
}
function requireLocalWarehouse(): LocalWarehouseRepository {
  if (!localWarehouse) throw new Error('LOCAL_WAREHOUSE_NOT_READY')
  return localWarehouse
}
function requireLocalPurchases(): LocalPurchaseRepository {
  if (!localDatabase) throw new Error('LOCAL_DATABASE_NOT_READY')
  return new LocalPurchaseRepository(localDatabase)
}

let cleanupMutationInProgress = false
function cleanupSession() {
  const session = requireDesktopSession()
  // AsyncLocalStorage may still hold the caller after reload/crash/lease expiry.
  // Destructive catalog work must also prove the actual current UI session.
  if ((rememberedSessionRequired && rememberedStatus().locked) || !desktopAuthSession
    || desktopAuthSession.id !== session.id || desktopAuthSession.tenant_id !== session.tenant_id)
    throw new Error('Сесію завершено або змінено. Увійдіть і повторіть перевірку.')
  if (localNetwork?.getStatus().mode === 'client') throw new Error('Очищення номенклатури виконується лише на головному ПК')
  if (!['owner', 'admin'].includes(session.role)) throw new Error('Очищення номенклатури доступне власнику та адміністратору')
  return { ...session, generation: desktopLoginGeneration }
}
function assertCleanupSession(before: ReturnType<typeof cleanupSession>) {
  const current = cleanupSession()
  if (current.id !== before.id || current.tenant_id !== before.tenant_id || current.generation !== before.generation)
    throw new Error('Сесію змінено. Повторіть перевірку під поточним працівником.')
}
async function cleanupCapability(session: ReturnType<typeof cleanupSession>) {
  try {
    const config = requireTrustedAuthConfig()
    return await checkCleanupCapability(config.apiUrl ?? '', getRememberedAccess().serverSession(session)?.access_token, net.fetch)
  } catch { return { available: false, reason: 'Потрібна сумісна серверна версія та серверний вхід. Сканування доступне локально.' } }
}
async function cleanupRepository(session: ReturnType<typeof cleanupSession>) {
  const capability = await cleanupCapability(session)
  const entries: unknown = await mainWindow?.webContents.executeJavaScript(`(() => {
    const values = [];
    for (let i=0; i<localStorage.length; i++) {
      const key=localStorage.key(i);
      if (key && (key.startsWith('forsage_pos_open_receipts_v2:') || key==='forsage_pos_cart')) values.push([key,localStorage.getItem(key)]);
    }
    return values;
  })()`)
  assertCleanupSession(session)
  return new CatalogCleanupRepository(requireLocalDatabase(), { canMirrorMerge: () => capability.available,
    externalBlockers: ids => cleanupCartBlockers(entries, ids) })
}

/**
 * Збережені відкриті чеки вікна програми — для фонового обʼєднання точних дублів (catalogAutoMerge.ts).
 * null — вікна немає або воно не відповіло: звірити чеки нічим, обʼєднання цього разу не виконується.
 */
async function readOpenReceiptsForAutoMerge(): Promise<unknown | null> {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isLoading()) return null
  try {
    const entries: unknown = await window.webContents.executeJavaScript(`(() => {
      const values = [];
      for (let i=0; i<localStorage.length; i++) {
        const key=localStorage.key(i);
        if (key && (key.startsWith('forsage_pos_open_receipts_v2:') || key==='forsage_pos_cart')) values.push([key,localStorage.getItem(key)]);
      }
      return values;
    })()`)
    return Array.isArray(entries) ? entries : null
  } catch { return null }
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
  if (localNetwork) assertLanIdentityConnection(requireLocalDatabase(), localNetwork.getStatus())
  const contextualSession = desktopSessionContext.getStore()
  if (contextualSession) {
    const current = activeSession(requireLocalDatabase(), contextualSession)
    if (!current) throw new DesktopSessionLifecycleError('local-session-ended', 'Доступ працівника вимкнено. Увійдіть заново.')
    return current
  }
  if (rememberedSessionRequired && rememberedStatus().locked) throw new DesktopSessionLifecycleError('local-session-ended', 'Збережений вхід завершено. Увійдіть із паролем')
  if (!desktopAuthSession) throw new DesktopSessionLifecycleError('local-session-ended', 'Необхідно увійти в програму')
  desktopAuthSession = activeSession(requireLocalDatabase(), desktopAuthSession)
  if (!desktopAuthSession) throw new DesktopSessionLifecycleError('local-session-ended', 'Доступ працівника вимкнено. Увійдіть заново.')
  return desktopAuthSession
}

interface TrustedAuthConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  apiUrl?: string
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
    apiUrl: typeof config.apiUrl === 'string' ? config.apiUrl : undefined,
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

async function loginOnlineAndProvisionLocal(phone: string, password: string, generation: number | null): Promise<DesktopOnlineLoginResult> {
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

  if (payload.user?.app_metadata?.is_active === false || payload.user?.app_metadata?.can_login === false || payload.user?.app_metadata?.role === 'tire_worker' || payload.user?.app_metadata?.deleted_at) {
    throw new Error('[LOCAL_AUTH_DISABLED] Доступ працівника на сервері вимкнено. Зверніться до власника.')
  }
  // generation = null — перевірка для ПК менеджера: вхід на самому головному ПК не змінюється.
  if (generation !== null && generation !== desktopLoginGeneration) throw Error('Спробу входу скасовано')
  const user = requireLocalStaff().adoptServerAuthenticatedPassword(
    serverUserId,
    normalizedPhone,
    password,
    DEFAULT_TENANT_ID,
  )
  onlinePasswordAttempts.delete(attemptKey)
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

/**
 * Друк і ПРРО ламаються найчастіше і по-своєму, тому в журналі вони мають бути
 * окремими темами, а не однією купою «щось у програмі».
 */
function problemSourceForChannel(channel: string): 'sync' | 'print' | 'fiscal' | 'app' {
  if (channel.startsWith('desktop:print:')) return 'print'
  if (channel.startsWith('desktop:fiscal:')) return 'fiscal'
  if (channel.startsWith('desktop:sync:') || channel.startsWith('desktop:bootstrap:')) return 'sync'
  return 'app'
}

function commandFailureTitle(channel: string): string {
  if (channel.startsWith('desktop:print:')) return 'Друк'
  if (channel.startsWith('desktop:fiscal:')) return 'Операція ПРРО'
  if (channel.startsWith('desktop:sync:')) return 'Синхронізація'
  return `Команда каси «${channel}»`
}

/** Журнал не має права зламати команду, під час якої його викликали. */
function recordDesktopProblem(input: Parameters<LocalProblemRepository['record']>[0]): void {
  try {
    localProblems?.record(input)
  } catch (error) {
    console.error('[desktop] Problem log write failed', safeDiagnosticDetails(error))
  }
}

function handleDesktopIpc(channel: string, listener: DesktopIpcListener): void {
  desktopCommandHandlers.set(channel, listener)
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now()
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('Неприпустиме джерело локальної команди')
    }
    const sequence = ++diagnosticCommandSequence
    blackBox?.record('command-start', { channel, sequence, role: desktopAuthSession?.role ?? 'signed-out' })
    let failed = false
    try {
      const session = PUBLIC_DESKTOP_CHANNELS.has(channel) ? null : requireDesktopSession()
      if (session && localNetwork?.getStatus().mode === 'client' && isLanProxyChannel(channel)) {
        if (databaseMaintenance) throw new Error('Дочекайтеся завершення обслуговування бази')
        if (!isDesktopChannelAllowed(channel, session.role)) throw new Error('Недостатньо прав для цієї дії')
        for (const argument of args) validateTenantArguments(argument, session.tenant_id)
        const command = lanOrderClient!.invoke(channel, args, session)
        activeDesktopCommands.add(command)
        try { return await command }
        finally { activeDesktopCommands.delete(command) }
      }
      return await executeDesktopCommand(channel, listener, event, args, session)
    } catch (error) {
      // Midnight/logout may race an optional background cache request. Do not execute
      // its listener or turn an expected denial into a recurring application fault.
      const cacheResult = serverSessionCacheResultForError(channel, error)
      if (cacheResult !== undefined) return cacheResult
      failed = true
      blackBox?.record('command-error', { channel, sequence, error })
      // Кожна кнопка каси проходить тут. Без цього запису збій бачив лише той,
      // хто відкрив консоль розробника, — тобто ніхто.
      const message = error instanceof Error ? error.message : String(error)
      if (!isExpectedCommandFailure(message)) {
        recordDesktopProblem({
          source: problemSourceForChannel(channel),
          code: `ipc.${channel}`,
          title: `${commandFailureTitle(channel)} завершилась помилкою`,
          detail: message,
          entity_type: 'channel',
          entity_id: channel,
        })
      }
      throw error
    } finally {
      // 19.11.2026: «Друк завершився помилкою ×202» висіли відкритими, хоча наступні чеки друкувались.
      // Успішний друк тим самим каналом закриває старі записи цього каналу.
      if (!failed && channel.startsWith('desktop:print:')) { try { localProblems?.resolveCode(`ipc.${channel}`) } catch { /* optional */ } }
      const durationMs = Date.now() - startedAt
      blackBox?.record('command-end', { channel, sequence, duration_ms: durationMs,
        status: failed ? 'failed' : 'ok', role: desktopAuthSession?.role ?? 'signed-out' })
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
  assertLocalDataAuthority(channel)
  if (databaseMaintenance) throw new Error('База готується до перезапуску. Дочекайтеся завершення.')
  if (!PUBLIC_DESKTOP_CHANNELS.has(channel)) {
    assertLanIdentityConnection(requireLocalDatabase(), localNetwork!.getStatus())
    if (!session) throw new Error('Необхідно увійти в програму')
    session = activeSession(requireLocalDatabase(), session)
    if (!session) throw new Error('Доступ працівника вимкнено. Увійдіть заново.')
    if (!isDesktopChannelAllowed(channel, session.role)) {
      throw new Error('Недостатньо прав для цієї дії')
    }
    // Дозвіл «Може продавати» живе в базі головного ПК. На ПК менеджера продаж однаково
    // перевіряє головний ПК; локально там лишається тільки ПРРО цього комп'ютера.
    if (session.role === 'manager' && isManagerSaleChannel(channel) && localNetwork?.getStatus().mode !== 'client'
      && !managerCanSell(requireLocalDatabase(), session.id)) {
      // «Може приймати задаток» відкриває лише свою зміну й оплату замовлення; решта каси лишається закритою.
      const depositOnly = managerCanTakeDeposit(requireLocalDatabase(), session.id)
      if (!(depositOnly && isManagerDepositChannel(channel))) throw new Error(depositOnly ? MANAGER_DEPOSIT_ONLY : MANAGER_SALE_DENIED)
    }
    // 26.11.2026 (рішення власника): денна ставка менеджера — за день, коли він увійшов. Рахує лише головний ПК (не ПК менеджера).
    if (session.role === 'manager' && localNetwork?.getStatus().mode !== 'client') noteManagerWorkDay(session.id, session.tenant_id)
    // 26.11.2026: списання менеджер робить лише з перемикачем «Списує товар» у своїй картці (вмикає власник).
    if (session.role === 'manager' && WRITEOFF_CREATE_CHANNELS.has(channel) && localNetwork?.getStatus().mode !== 'client'
      && !effectiveStaffRights(requireLocalDatabase(), session.id, session.role).writeoffs) {
      throw new Error('Списання менеджеру вмикає власник: «Працівники» → картка → «Права» → «Списує товар»')
    }
    for (const argument of args) validateTenantArguments(argument, session.tenant_id)
    for (const position of desktopTenantArgumentPositions(channel)) {
      const suppliedTenantId = args[position]
      if (typeof suppliedTenantId === 'string' && suppliedTenantId !== session.tenant_id) {
        throw new Error('Операція належить іншому магазину')
      }
    }
  }
  const run = () => Promise.resolve().then(() => listener(event, ...args))
  const command = session ? desktopSessionContext.run(session, run) : run()
  activeDesktopCommands.add(command)
  try { return await command }
  finally { activeDesktopCommands.delete(command) }
}

function resolveLanSession(userId: string): LanSession | null {
  return activeSession(requireLocalDatabase(), { id: userId, tenant_id: DEFAULT_TENANT_ID })
}

/** Головний ПК із власною базою (не ПК менеджера). */
function isMainTill(): boolean {
  return Boolean(localDatabase) && localNetwork?.getStatus().mode !== 'client' && !hasLanIdentity(requireLocalDatabase())
}

/**
 * 22.11.2026, рішення власника «веб повний, але тільки через головний ПК»: запит вебу виконується тут, у базі
 * головного ПК, тим самим шляхом і з правами того самого працівника, що й команда з ПК менеджера.
 * Викликається і з вікна програми (сесія працівника), і з головного процесу (ключ ПК, екран входу).
 */
async function executeWebRequest(userId: unknown, channel: unknown, args: unknown): Promise<unknown> {
  if (!isMainTill()) throw new Error('Запити вебу виконує лише головний ПК')
  if (databaseMaintenance) throw new Error('База готується до перезапуску. Дочекайтеся завершення.')
  const session = typeof userId === 'string' ? resolveLanSession(userId) : null
  if (!session) throw new Error('Працівника не знайдено або доступ до програми вимкнено')
  // 23.11.2026 (план B3): касир працює через веб лише з дозволом власника в картці працівника; права — його ж, як на касі.
  const viaWeb = canWorkViaWeb(requireLocalDatabase(), session.id, session.role)
  if (channel === WEB_ACCESS_PROBE) return viaWeb
  // 26.11.2026: обʼєднання дублів із помічника у вебі — окремим шляхом (лише власник/адмін, звірка чеків у вікні, копія бази).
  if (isWebMergeChannel(channel)) {
    try {
      return await runWebCatalogMerge({
        db: requireLocalDatabase(), readOpenReceipts: () => readOpenReceiptsForAutoMerge(), backup: () => requireLocalDatabase().backupNow(),
        busy: () => databaseMaintenance || cleanupMutationInProgress, lock: on => { cleanupMutationInProgress = on },
      }, session, channel, Array.isArray(args) ? args[0] : undefined)
    } finally { getOutboxPusher().soon() }
  }
  if (typeof channel !== 'string' || !webRpcChannelAllowed(channel)) throw new Error('Ця дія доступна лише на самій касі')
  if (!viaWeb) throw new Error(session.role === 'cashier' ? WEB_WORK_DENIED : 'Через веб із головним ПК працюють власник, адміністратор, менеджер і касир із дозволом')
  // Дія вебу могла змінити базу — передаємо зміни на сервер одразу, не чекаючи таймера.
  // 23.11.2026: у вебі «магазин не вказано» (undefined) проходить через сервер у JSON як null, а значення за
  // замовчуванням у дії каси спрацьовує лише для undefined — каса шукала клієнта магазину null і відповідала
  // «Клієнта не знайдено» (картка боржника з телефона). Магазин null ніколи не має змісту: повертаємо «не вказано».
  const list = Array.isArray(args) ? [...args] : []
  try { return await executeLanCommand(channel, list, session) } finally { getOutboxPusher().soon() }
}

/**
 * 23.11.2026: зміни каси йдуть на сервер ключем самого головного ПК з головного процесу — і коли в програмі касир,
 * і коли вона працює у фоні. Права на кожну дію вже перевірила каса, коли її виконувала.
 */
let outboxPusher: OutboxPusher | null = null
function getOutboxPusher(): OutboxPusher {
  outboxPusher ??= new OutboxPusher({
    available: () => Boolean(localSync) && getTillDeviceLink().available(),
    store: () => localSync,
    send: body => getTillDeviceLink().syncPush(body as unknown as Record<string, unknown>),
    onError: error => writeDesktopDiagnostic('outbox-push', { error: error instanceof Error ? error.message : String(error) }),
  })
  return outboxPusher
}

let tillDeviceLinkError = ''
function getTillDeviceLink(): TillDeviceLink {
  tillDeviceLink ??= new TillDeviceLink({
    fetch: (url, init) => net.fetch(url, init as RequestInit),
    request: (url, init) => net.fetch(url, init as RequestInit),
    apiUrl: () => { try { return requireTrustedAuthConfig().apiUrl ?? null } catch { return null } },
    deviceId: () => localDatabase?.deviceId ?? null,
    readKey: () => {
      const row = localDatabase?.prepare("SELECT value_json FROM app_meta WHERE key='till_device_link'").get() as { value_json: string } | undefined
      if (!row || process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) return null
      const stored = JSON.parse(row.value_json) as { key?: string; tenant_id?: string }
      if (typeof stored.key !== 'string' || typeof stored.tenant_id !== 'string') return null
      return { token: safeStorage.decryptString(Buffer.from(stored.key, 'base64')), tenant_id: stored.tenant_id }
    },
    writeKey: key => {
      const db = requireLocalDatabase()
      if (!key) { db.prepare("DELETE FROM app_meta WHERE key='till_device_link'").run(); return }
      if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) throw new Error('Захищене сховище Windows недоступне: ключ зв’язку не збережено')
      db.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('till_device_link',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
        .run(JSON.stringify({ key: safeStorage.encryptString(key.token).toString('base64'), tenant_id: key.tenant_id }), new Date().toISOString())
    },
    execute: executeWebRequest,
    outboxSummary: () => {
      if (!localSync) return null
      const status = localSync.getSyncStatus()
      return { waiting: status.pending + status.retrying + status.stuck, oldest_at: status.oldest_created_at, error: status.last_error }
    },
    // 23.11.2026 (план T2): версія, вікно чи фон, копії бази й місце на диску — для «Стан системи» у вебі власника.
    // Лише читання й лише відомості про комп'ютер; чого прочитати не вдалося, те лишається «невідомо».
    statusReport: () => {
      const db = localDatabase
      if (!db) return null
      const attempt = <T>(read: () => T): T | null => { try { return read() } catch { return null } }
      return buildStatusReport({
        build: desktopBuildInfo, background: backgroundMode, managerPc: false,
        disk: attempt(() => { const disk = statfsSync(db.dataRoot); return { free: Number(disk.bavail) * Number(disk.bsize), total: Number(disk.blocks) * Number(disk.bsize) } }),
        databaseBytes: attempt(() => statSync(db.databasePath).size),
        localBackupAt: attempt(() => db.listBackups()[0]?.createdAt ?? null),
        cloudBackupAt: attempt(() => (db.prepare('SELECT MAX(cloud_completed_at) AS at FROM shift_backups WHERE cloud_completed_at IS NOT NULL').get() as { at: string | null } | undefined)?.at ?? null),
        externalBackupAt: attempt(() => readExternalConfig(db.dataRoot).last_copy_at),
        schemaVersion: attempt(() => db.info().schemaVersion),
        startedAt: Date.now() - Math.round(process.uptime() * 1000),
        check: attempt(() => readNightlySummary(db)),
        // 26.11.2026 (T7): остання побачена версія ПК менеджера переживає перезапуск каси.
        managerClient: attempt(() => rememberedManagerClient(db, localNetwork?.lastClientSeen() ?? null)) ?? localNetwork?.lastClientSeen() ?? null,
      })
    },
    canRun: () => isMainTill() && !databaseMaintenance,
    // Без інтернету помилка повторюється щопівхвилини — у діагностику пишемо лише зміну стану.
    onError: error => {
      const text = error instanceof Error ? error.message : String(error)
      if (text === tillDeviceLinkError) return
      tillDeviceLinkError = text
      writeDesktopDiagnostic('till-device-link', { error: text })
    },
  })
  return tillDeviceLink
}

async function executeLanCommand(channel: string, args: unknown[], session: LanSession): Promise<unknown> {
  const listener = desktopCommandHandlers.get(channel)
  if (!listener) throw new Error('Локальну команду не знайдено')
  return executeDesktopCommand(channel, listener, {} as IpcMainInvokeEvent, normalizeRemoteTenantArguments(channel, args), session)
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
  const window = mainWindow
  const closeController = new NativeCloseController({
    isDestroyed: () => window.isDestroyed(),
    requestApproval: deadline => window.webContents.executeJavaScript(requestUnloadScript(deadline)),
    close: () => window.close(),
    failed: error => writeDesktopDiagnostic('window-close-approval-failed', error),
  })
  window.on('close', event => {
    blackBox?.record('window-close-request')
    closeController.onClose(event)
  })
  window.webContents.on('did-finish-load', () => {
    blackBox?.record('renderer-loaded')
    if (audioServiceUnavailable) window.webContents.send('desktop:audio-unavailable')
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) blackBox?.record('renderer-console-error', new Error(message.slice(0, 2048)))
  })
  const makeRecovery = () => new RendererRecovery({
    isDestroyed: () => window.isDestroyed(),
    load: async () => {
      if (!app.isPackaged && developmentUrl) return window.loadURL(developmentUrl)
      const target = rendererIndexPath()
      if (!existsSync(target)) throw new Error(`Файл інтерфейсу не знайдено: ${target}`)
      return window.loadFile(target)
    },
    retry: (attempt, error) => writeDesktopDiagnostic('renderer-load-retry', { attempt, target: rendererIndexPath(), error: diagnosticValue(error) }),
  })
  let recovery = makeRecovery()
  let recoveryFailed = false
  const failRecovery = (error: unknown) => {
    if (recoveryFailed || window.isDestroyed()) return
    recoveryFailed = true
    recovery.stop()
    writeDesktopDiagnostic('renderer-recovery-failed', diagnosticValue(error))
    // Do not quit the database/server because one UI process failed. No sync
    // modal that blocks the main loop; only the user chooses to close the app.
    window.show()
    void dialog.showMessageBox(window, {
      type: 'error', title: 'Не вдалося відновити інтерфейс',
      message: 'Інтерфейс тимчасово не працює. Локальні дані збережено.',
      detail: 'Можна повторити завантаження інтерфейсу без закриття всієї програми. Якщо перед збоєм проводили оплату — перевірте список чеків перед повторною оплатою.',
      buttons: ['Відновити інтерфейс', 'Закрити програму'], defaultId: 0, cancelId: 1,
    }).then(result => {
      if (window.isDestroyed()) return
      if (result.response === 1) { closeController.closeAfterConfirmedRecovery(); return }
      recovery = makeRecovery()
      recoveryFailed = false
      void recovery.start().catch(failRecovery)
    }).catch(dialogError => writeDesktopDiagnostic('recovery-dialog-failed', dialogError))
  }
  window.on('closed', () => {
    blackBox?.record('window-closed')
    closeController.stop()
    recovery.stop()
    if (mainWindow === window) {
      desktopAuthSession = null
      mainWindow = null
      // Auxiliary print windows may remain alive; begin the existing orderly
      // cleanup only now, after the main renderer really accepted departure.
      app.quit()
    }
  })

  // Стандартне меню Electron (File/Edit/View) прибрано: Alt із перемикання мови Alt+Shift
  // переводив фокус у меню, і курсор зникав з поля пароля чи пошуку. Корисні клавіші меню
  // лишаються: масштаб Ctrl +/−/0 і F11 — на весь екран. Копіювання/вставка працюють і без меню.
  window.removeMenu()
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11' && !input.control && !input.alt) {
      event.preventDefault()
      window.setFullScreen(!window.isFullScreen())
      return
    }
    if (!input.control || input.alt || input.meta) return
    const zoom = window.webContents.getZoomLevel()
    if (input.key === '=' || input.key === '+') { event.preventDefault(); window.webContents.setZoomLevel(Math.min(zoom + 0.5, 3)) }
    else if (input.key === '-' || input.key === '_') { event.preventDefault(); window.webContents.setZoomLevel(Math.max(zoom - 0.5, -3)) }
    else if (input.key === '0' && !input.shift) { event.preventDefault(); window.webContents.setZoomLevel(0) }
  })

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

    void recovery.crashed().catch(failRecovery)
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

  await recovery.start().catch(failRecovery)
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
  assertPrintRuntimeFiles()
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
      session: getPrintSession(),
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
      loadPrintHtml(printWindow, html),
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

    // Перевіряємо чергу перед відправкою, не видаляючи наявних завдань.
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
        // Only a rejected configuration is known not to have printed. Never
        // resubmit an ambiguous driver failure with different paper settings.
        if (!(error instanceof Error) || error.message !== 'Invalid printer settings') break
        // «Invalid printer settings» / подібне — пробуємо наступний, простіший варіант
      }
    }
    if (canUseReceiptGdiFallback(options.printerRole, lastError) && options.silent === true) {
      blackBox?.record('receipt-print-driver-fallback', { reason: 'invalid-printer-settings' })
      await printReceiptViaGdi(printWindow, deviceName, documentName)
      await postflightPrinter(deviceName, documentName, submittedAfter)
      return { success: true }
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

/**
 * Стару збірку каси не пускаємо до новішої бази. Мовчазний старт коштував
 * магазину 137 незакритих операцій: з вигляду каса працювала, а черга стояла.
 * Тому тут не «помилка запуску», а зрозуміла вказівка, чим запускати касу.
 */
function openLocalDatabaseOrExplain(dataRoot: string): LocalDatabaseOpenResult | null {
  try {
    return LocalDatabase.open(dataRoot)
  } catch (error) {
    if (!(error instanceof OutdatedBuildError)) throw error
    writeDesktopDiagnostic('outdated-build', {
      message: error.message,
      databaseVersion: error.databaseVersion,
      buildVersion: error.buildVersion,
      executable: process.execPath,
    })
    if (!backgroundMode) dialog.showErrorBox('Запущено стару версію Форсажу', [
      error.message,
      '',
      `Запущено: ${process.execPath}`,
      '',
      'Дані магазину цілі. Закрийте це вікно і запустіть касу ярликом',
      '«ФОРСАЖ → 1. ЛОКАЛЬНА каса — ЗАПУСК».',
    ].join('\n'))
    app.exit(1)
    return null
  }
}

app.whenReady().then(async () => {
  if (rehearsalRoot) {
    // Нічого іншого не запускаємо: ні вікна, ні фону, ні мережі, ні копій. Відкрити копію, перевірити, вийти.
    const outcome = runStartupRehearsal(rehearsalRoot, desktopBuildInfo?.releaseId ?? null)
    app.exit(outcome.ok ? 0 : 5)
    return
  }
  blackBox?.record('app-ready')
  // Перший друк дня не чекає запуску PowerShell (на старому ПК це 3–5 с). Після старту, щоб не гальмувати запуск.
  setTimeout(() => prewarmPrintShell(app.getPath('userData')), 20_000).unref?.()
  powerMonitor.on('suspend', () => blackBox?.record('system-suspend'))
  powerMonitor.on('resume', () => blackBox?.record('system-resume'))
  let rendererBudgetAt = 0, rendererBudget = 0
  // 22.11.2026: після системного вікна «Ви впевнені?» (confirm/alert) вікно каси на Windows лишається активним,
  // але клавіатура в поля більше не потрапляє, доки людина не перемкнеться на іншу програму й назад.
  // Робимо це перемикання самі: зняти фокус з вікна й повернути його разом із вмістом сторінки.
  let focusRepairAt = 0
  ipcMain.on('desktop:window:restore-input-focus', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return
    if (Date.now() - focusRepairAt < 150) return
    focusRepairAt = Date.now()
    try {
      if (!mainWindow.isMinimized() && mainWindow.isVisible()) {
        mainWindow.blur()
        mainWindow.focus()
        mainWindow.webContents.focus()
        blackBox?.record('input-focus-restored')
      }
    } catch { /* повернення фокуса не має ламати роботу каси */ }
  })
  ipcMain.on('desktop:diagnostic-event', (event, payload: unknown) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id || !payload || typeof payload !== 'object') return
    if (Date.now() - rendererBudgetAt > 1000) { rendererBudgetAt = Date.now(); rendererBudget = 0 }
    if (++rendererBudget > 20) return
    const data = payload as Record<string, unknown>
    if (data.kind === 'section' && typeof data.section === 'string') {
      const section = data.section.split(/[/?#]/).filter(Boolean)[0] ?? 'home'
      if (['home', 'pos', 'products', 'orders', 'customers', 'inventory', 'suppliers', 'analytics', 'reports',
        'settings', 'staff', 'sales', 'returns', 'cashflow', 'labels', 'login', 'ai', 'receiving', 'admin',
        'internal', 'auto-purchase', 'audit', 'notifications', 'ai-assistant', 'quotes', 'chats',
        'abc', 'waitlist', 'needs-action', 'staff-analytics'].includes(section)) {
        blackBox?.record('section-opened', { section })
      }
    } else if (data.kind === 'renderer-error' || data.kind === 'renderer-rejection') {
      const error = new Error(typeof data.message === 'string' ? data.message.slice(0, 2048) : 'Unknown renderer error')
      if (typeof data.stack === 'string') error.stack = data.stack.slice(0, 4096)
      blackBox?.record(data.kind, error)
    }
  })
  app.setName('Forsage')
  const dataRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Forsage')
    : app.getPath('userData')
  desktopDataRoot = dataRoot
  const printGuard = new PrintAttemptGuard(path.join(dataRoot, 'print-state', 'attempt'), async printer => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'Перевірте попередній друк',
      message: 'Попередня спроба друку не має підтвердженого результату.',
      detail: `Принтер: ${printer}\nПеревірте папір і чергу Windows. Якщо документ уже надруковано або ще друкується — скасуйте повтор. Новий друк почнеться лише після вашого підтвердження.`,
      buttons: ['Скасувати', 'Перевірив — друкувати'], defaultId: 0, cancelId: 0,
    })
    return result.response === 1
  }, writeDesktopDiagnostic)
  setPrinterJobGuard((printer, job) => printGuard.run(printer, job))
  setPrintProcessReporter(writeDesktopDiagnostic)
  const opened = openLocalDatabaseOrExplain(dataRoot)
  if (!opened) return
  localDatabase = opened.database
  blackBox?.record('database-opened', { schemaVersion: localDatabase.info().schemaVersion, integrityChecked: localDatabase.integrityChecked })
  // 25.11.2026 (власник: «холодний пуск довгий»): відмітки кроків запуску — щоб у журналі було видно, що саме гальмує.
  const startupPhase = (phase: string) => blackBox?.record('startup-phase', { phase, ms: Math.round(performance.now()) })
  // Базу закрито штатно — повна перевірка сторінок не на запуску, а за 5 хв в окремому потоці (каса не чекає).
  if (!localDatabase.integrityChecked) {
    const checkedDb = localDatabase
    setTimeout(() => {
      if (localDatabase !== checkedDb || databaseMaintenance) return
      void quickCheckInWorker(checkedDb.databasePath).then(result => {
        blackBox?.record('integrity-check', { ok: result === 'ok' })
        if (result !== 'ok') recordDesktopProblem({ source: 'database', code: 'database.integrity_failed',
          title: 'База каси пошкоджена: потрібне відновлення з резервної копії',
          detail: 'Перевірка сторінок бази знайшла пошкодження. Не закривайте зміну й зверніться до власника. ' + result.slice(0, 300) })
      }).catch(error => writeDesktopDiagnostic('integrity-check-failed', error))
    }, 5 * 60_000).unref()
  }
  localCatalog = new LocalCatalogRepository(localDatabase)
  localInventory = new LocalInventoryRepository(localDatabase)
  localOrders = new LocalOrderRepository(localDatabase)
  localPos = new LocalPosRepository(localDatabase)
  localSupply = new LocalSupplyRepository(localDatabase)
  localStaff = new LocalStaffRepository(localDatabase, reason => blackBox?.record('local-auth-result', { reason }))
  localWarehouse = new LocalWarehouseRepository(localDatabase)
  localSync = new LocalSyncRepository(localDatabase, createMirrorSigner(path.dirname(path.dirname(localDatabase.databasePath)), {
    encrypt: text => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Захищене сховище Windows недоступне для передачі копії')
      return safeStorage.encryptString(text).toString('base64')
    },
    decrypt: text => safeStorage.decryptString(Buffer.from(text,'base64')),
  }), createBackgroundSyncExecutor(localDatabase))
  localSupplierCatalog = new LocalSupplierCatalogRepository(localDatabase)
  localProblems = new LocalProblemRepository(localDatabase)
  startupPhase('repositories')
  shiftBackups = new ShiftBackupService(localDatabase,
    // Вивантаження змін — поруч із portable-EXE, як і раніше; не в теці програми, яку оновлення замінює.
    process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(resolvePortableExecutable(process.env, process.execPath) ?? process.execPath), error => {
      writeDesktopDiagnostic('shift-backup-failed', error)
      recordDesktopProblem({ source: 'database', code: 'database.shift_backup_failed',
        title: 'Не вдалося зберегти резервну копію бази',
        detail: 'Копія бази (після зміни або щоденна) повториться сама. ' + (error instanceof Error ? error.message : String(error)) })
    }, undefined, { dailyCopy: true })
  // 25.11.2026: копії бази — не в мить запуску (після ввімкнення ПК вони змагались за диск із відкриттям каси).
  shiftBackups.start(2 * 60_000)
  // Зв'язок головного ПК із сервером власним ключем: веб працює через ПК і тоді, коли в програмі ніхто не увійшов.
  getTillDeviceLink().start()
  getOutboxPusher().start()
  // 23.11.2026: у фоні (без вікна) сигнал «у вебі є робота» слухає сам головний процес — інакше запити вебу чекали 1–11 с.
  if (backgroundMode) {
    new RealtimeWake({
      url: () => { try { return requireTrustedAuthConfig().supabaseUrl } catch { return null } },
      apiKey: () => { try { return requireTrustedAuthConfig().supabaseAnonKey } catch { return null } },
      topic: () => { const tenant = getTillDeviceLink().status().tenant_id; return tenant ? `till-rpc-${tenant}` : null },
      onWake: () => { void getTillDeviceLink().wake().catch(() => undefined) },
    }).start()
  }
  // Раз на добу — копія даних, що живуть лише в хмарі, у власну базу: так вони є в кожній копії бази.
  const copyServerData = async () => {
    const db = localDatabase
    if (!db || databaseMaintenance || !isMainTill() || !serverDataDue(db, new Date())) return
    const data = await getTillDeviceLink().serverData()
    if (!data || !localDatabase || databaseMaintenance) return
    blackBox?.record('server-data-copy', storeServerData(localDatabase, data, new Date()))
  }
  setTimeout(() => { void copyServerData().catch(error => writeDesktopDiagnostic('server-data-copy-failed', error)) }, 3 * 60_000).unref()
  setInterval(() => { void copyServerData().catch(error => writeDesktopDiagnostic('server-data-copy-failed', error)) }, 60 * 60_000).unref()
  // 23.11.2026 (план T6): нічна перевірка бази — лише на головному ПК, лише читання. Знайдене йде в журнал проблем
  // і на екран «Стан системи»; програма нічого не виправляє сама.
  setInterval(() => {
    if (!localDatabase || !isMainTill() || databaseMaintenance) return
    try {
      const result = nightlyCheckTick(localDatabase, { record: recordDesktopProblem, resolveCode: code => { localProblems?.resolveCode(code) } })
      if (result) blackBox?.record('nightly-check', { duration_ms: result.duration_ms, findings: result.findings.map(item => item.code + ':' + item.count) })
    } catch (error) { writeDesktopDiagnostic('nightly-check-failed', error) }
  }, 30 * 60_000).unref()
  // 26.11.2026 (слово власника: «дублі зі стовідсотковою схожістю — в автоматі, у фоні, без кнопок»): головний ПК раз
  // на добу сам обʼєднує точні дублі карток. Правило, умови й запис — у repositories/catalogAutoMerge.ts.
  const autoMergeDuplicates = () => {
    const db = localDatabase
    if (!db || !isMainTill() || databaseMaintenance || cleanupMutationInProgress) return
    void catalogAutoMergeTick({
      db, tenantId: DEFAULT_TENANT_ID,
      readOpenReceipts: () => readOpenReceiptsForAutoMerge(),
      backup: () => db.backupNow(),
      busy: () => databaseMaintenance || cleanupMutationInProgress || localDatabase !== db,
      lock: on => { cleanupMutationInProgress = on },
    }).then(outcome => { if (outcome.status === 'ran' || outcome.status === 'server-unproven' || outcome.status === 'no-owner') blackBox?.record('catalog-auto-merge', outcome) },
      error => { cleanupMutationInProgress = false; writeDesktopDiagnostic('catalog-auto-merge-failed', error) })
  }
  setTimeout(autoMergeDuplicates, 10 * 60_000).unref()
  setInterval(autoMergeDuplicates, 30 * 60_000).unref()
  // 20.11.2026: однакове написання одиниць у картках (шт/компл/…), один раз після оновлення; спершу копія бази.
  const unitTidyDb = localDatabase
  setTimeout(() => {
    void (async () => {
      if (localNetwork?.getStatus().mode === 'client' || !pendingUnitSpellings(unitTidyDb)) return
      await unitTidyDb.backupNow()
      const changed = tidyUnitSpellings(unitTidyDb)
      blackBox?.record('catalog-unit-tidy', { changed })
    })().catch(error => writeDesktopDiagnostic('catalog-unit-tidy-failed', error))
      // 22.11.2026, рішення власника «Вернуть»: стерті до виправлення штрихкоди повертаються карткам як додаткові.
      .then(async () => {
        if (localNetwork?.getStatus().mode === 'client' || !pendingErasedBarcodes(unitTidyDb)) return
        await unitTidyDb.backupNow()
        blackBox?.record('catalog-barcode-restore', restoreErasedBarcodes(unitTidyDb))
      }).catch(error => writeDesktopDiagnostic('catalog-barcode-restore-failed', error))
  }, 15_000)
  externalBackups = new ExternalBackupService(dataRoot, localDatabase, error => {
    writeDesktopDiagnostic('external-backup-failed', error)
    recordDesktopProblem({ source: 'database', code: 'database.external_backup_failed',
      title: 'Не вдалося записати копію на флешку',
      detail: 'Робочі дані не змінено. ' + (error instanceof Error ? error.message : String(error)) })
  })
  externalBackups.start(4 * 60_000)
  stopBackupScheduler =startBackupScheduler(localDatabase, (error) => {
    writeDesktopDiagnostic('local-backup-failed', error)
    recordDesktopProblem({ source: 'database', code: 'database.backup_failed',
      title: 'Не вдалося створити резервну копію',
      detail: 'Робочі дані не змінено. ' + (error instanceof Error ? error.message : String(error)) })
  }, 3 * 60_000)
  startupPhase('services')
  cashalot = new CashalotService(dataRoot)
  let releaseSource: ReturnType<typeof createPortableReleaseSource> = null
  try {
    releaseSource = createPortableReleaseSource({ packaged: app.isPackaged,
      portableExecutable: resolvePortableExecutable(process.env, process.execPath), releaseId: desktopBuildInfo?.releaseId })
    if (process.env.LOCALAPPDATA) {
      const outcome = readPortableUpdateOutcome(process.env.LOCALAPPDATA)
      if (outcome) writeDesktopDiagnostic('lan-update-outcome', outcome)
    }
  } catch (error) {
    // Optional update delivery must never prevent the shop from opening.
    writeDesktopDiagnostic('lan-update-source-unavailable', error)
  }
  localNetwork = new LocalNetworkCoordinator(dataRoot, executeLanCommand, resolveLanSession, {
    authenticate: async (phone, password) => {
      // Без номера телефону — вхід лише паролем (23.11.2026): працівника визначає сам пароль.
      if (!phone) return requireLocalStaff().loginWithPasswordOnly(password)
      try {
        return requireLocalStaff().loginWithPassword(phone, password)
      } catch (error) {
        // 21.11.2026: працівника створено на сервері, а на головному ПК він ще не входив —
        // пароля тут немає. Один раз перевіряємо його через сервер входу і зберігаємо лише хеш;
        // токени сервера не використовуються, вхід на головному ПК не змінюється.
        if (!(error instanceof Error) || !error.message.includes('[LOCAL_AUTH_MISSING]')) throw error
        return (await loginOnlineAndProvisionLocal(phone, password, null)).user
      }
    },
    clientBuild: desktopBuildInfo?.releaseId ?? null,
    ...(releaseSource ? { updateMetadata: () => releaseSource.describe(), updateChunk: input => releaseSource.chunk(input) } : {}),
  })
  lanOrderQueue = new LanOrderQueue(localDatabase, (channel, args, session) => localNetwork!.invoke(channel, args, session))
  lanOrderClient = new LanOrderClient(localNetwork, lanOrderQueue)
  lanOrderTimer = setInterval(() => {
    if (databaseMaintenance || localNetwork?.getStatus().mode !== 'client') return
    let session: LanSession
    try { session = requireDesktopSession() } catch { return }
    const work = lanOrderClient!.flush(session)
    activeDesktopCommands.add(work)
    void work.catch(error => recordDesktopProblem({ source: 'app', code: 'lan.order_queue', title: 'Черга замовлень ПК менеджера', detail: error instanceof Error ? error.message : String(error) }))
      .finally(() => activeDesktopCommands.delete(work))
  }, 15_000)
  lanOrderTimer.unref()
  lanUpdateTimer = setInterval(() => { void checkLanUpdate() }, 5 * 60_000)
  lanUpdateTimer.unref()

  // 21.11.2026: ПК менеджера бачить, що нову версію з головного ПК уже завантажено (встановиться при закритті).
  handleDesktopIpc('desktop:get-runtime-info', () => ({ ...requireLocalDatabase().info(), build: desktopBuildInfo,
    stagedUpdateReleaseId: stagedLanUpdate?.releaseId ?? null,
    lanUpdate: localNetwork?.getStatus().mode === 'client' ? lanUpdateReport() : null }))

  // 23.11.2026: номер збірки видно й на екрані входу (власник звіряє версії двох ПК, не входячи). Лише збірка й режим ПК.
  handleDesktopIpc('desktop:get-runtime-info-build', () => ({ build: desktopBuildInfo, stagedUpdateReleaseId: stagedLanUpdate?.releaseId ?? null,
    lan: { mode: localNetwork?.getStatus().mode ?? 'standalone' },
    // 25.11.2026: стан автооновлення ПК менеджера — без шляху до файлу (екран входу бачать усі).
    lanUpdate: localNetwork?.getStatus().mode === 'client' ? { ...lanUpdateReport(), executable: null } : null }))

  handleDesktopIpc('desktop:lan:first-run-status', () => {
    const status = localNetwork!.getStatus()
    try { assertLanIdentityConnection(requireLocalDatabase(), status) }
    catch { return { mode: 'client', configured: false, canPair: false } }
    return { mode: status.mode, configured: status.mode === 'client' && Boolean(status.hubAddress && status.accessKey),
      canPair: !desktopAuthSession && canPairEmptyClient(requireLocalDatabase(), status.mode, lanOrderQueue!.hasPending()) }
  })
  handleDesktopIpc('desktop:lan:discover', async () => {
    const status = localNetwork!.getStatus()
    if (desktopAuthSession || !canPairEmptyClient(requireLocalDatabase(), status.mode, lanOrderQueue!.hasPending())) {
      throw new Error('Пошук підключення доступний лише під час першого запуску чистого ПК менеджера')
    }
    const hubs = await localNetwork!.discoverHubs()
    return hubs.map(hub => ({ address: hub.hubAddress, name: hub.name }))
  })
  handleDesktopIpc('desktop:lan:pair', async (_event, input: unknown) => {
    if (lanPairInProgress) throw new Error('Підключення вже перевіряється')
    if (desktopAuthSession || !canPairEmptyClient(requireLocalDatabase(), localNetwork!.getStatus().mode, lanOrderQueue!.hasPending())) {
      throw new Error('На цьому ПК вже є профіль або дані. Початкове підключення не змінено.')
    }
    if (!input || typeof input !== 'object') throw new Error('Вкажіть головний ПК та код підключення')
    const candidate = input as Record<string, unknown>
    if (typeof candidate.hubAddress !== 'string' || candidate.hubAddress.length > 256
      || typeof candidate.accessKey !== 'string' || candidate.accessKey.length > 256
      || (candidate.port !== undefined && (!Number.isInteger(candidate.port) || Number(candidate.port) < 1024 || Number(candidate.port) > 65535))) {
      throw new Error('Некоректні налаштування підключення')
    }
    lanPairInProgress = true
    desktopLoginGeneration++
    try {
      await localNetwork!.pairRemote({ hubAddress: candidate.hubAddress, accessKey: candidate.accessKey, port: candidate.port as number | undefined })
      return { mode: 'client', configured: true }
    } finally { lanPairInProgress = false }
  })
  handleDesktopIpc('desktop:lan:get-status', () => localNetwork?.getStatus())
  handleDesktopIpc('desktop:lan:update', (_event, input) => {
    if (lanOrderQueue?.hasPending()) throw new Error('Спочатку передайте або перевірте всі офлайн-замовлення. Зміна головного ПК зараз може розділити бази.')
    if (hasLanIdentity(requireLocalDatabase())) {
      const current = localNetwork!.getStatus()
      if (input?.mode !== 'client' || (input.accessKey !== undefined && input.accessKey !== current.accessKey)) {
        throw new Error('ПК менеджера не може стати окремою касою або підключитися до іншого магазину. Дані збережено.')
      }
    }
    return localNetwork?.update(input)
  })
  handleDesktopIpc('desktop:lan:test', () => localNetwork?.testConnection())
  // Лише читання стану мережі та правил Windows. Дані магазину не зачіпаються.
  handleDesktopIpc('desktop:lan:diagnose', async () => {
    const status = localNetwork!.getStatus()
    const firewall = status.mode === 'hub' ? await readFirewallState(status.port, process.execPath) : undefined
    return buildLanDiagnosis(status, firewall, process.execPath)
  })
  // Правило додає сама Windows після свого підтвердження (UAC); без «Так» нічого не змінюється.
  handleDesktopIpc('desktop:lan:allow-firewall', async () => {
    const status = localNetwork!.getStatus()
    if (status.mode !== 'hub') throw new Error('Дозвіл брандмауера потрібен лише на головному ПК каси')
    await requestFirewallRule(status.port, process.execPath)
    return buildLanDiagnosis(localNetwork!.getStatus(), await readFirewallState(status.port, process.execPath), process.execPath)
  })
  handleDesktopIpc('desktop:problems:list', (_event, options?: { includeResolved?: boolean; limit?: number }) =>
    requireLocalProblems().list({ includeResolved: options?.includeResolved, limit: options?.limit }))
  handleDesktopIpc('desktop:problems:summary', () => requireLocalProblems().summary())
  handleDesktopIpc('desktop:problems:resolve', (_event, id: string) => requireLocalProblems().resolve(String(id)))
  handleDesktopIpc('desktop:problems:resolve-all', () => requireLocalProblems().resolveAll())
  handleDesktopIpc('desktop:problems:export', () => {
    // Файл кладемо поруч із базою: власник знає цю папку з резервних копій.
    const root = desktopDataRoot
    if (!root) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    const fileName = `Forsage-проблеми-${new Date().toISOString().slice(0, 10)}.txt`
    const filePath = path.join(root, fileName)
    writeFileSync(filePath, requireLocalProblems().exportText(), 'utf8')
    return { path: filePath }
  })
  handleDesktopIpc('desktop:backup-now', () => requireLocalDatabase().backupNow())
  handleDesktopIpc('desktop:pos:customer-history', (_event, id: string, kind: string, options) =>
    customerHistory(requireLocalDatabase(), requireDesktopSession().tenant_id, id, kind, options))
  handleDesktopIpc('desktop:backup:pending', () => shiftBackups?.pending(requireDesktopSession().tenant_id) ?? [])
  handleDesktopIpc('desktop:backup:status', () => shiftBackups?.status(requireDesktopSession().tenant_id) ?? [])
  handleDesktopIpc('desktop:backup:upload', (_event, id: string, url: string, part?: number) =>
    shiftBackups!.upload(requireDesktopSession().tenant_id, id, url, requireTrustedAuthConfig().supabaseUrl, part === undefined || part === null ? undefined : Number(part)))
  handleDesktopIpc('desktop:backup:confirmed', (_event, id: string, sha: string) =>
    shiftBackups!.confirmed(requireDesktopSession().tenant_id, id, sha))
  handleDesktopIpc('desktop:backup:failed', (_event, id: string, message: string) =>
    shiftBackups!.cloudFailed(requireDesktopSession().tenant_id, id, String(message)))
  handleDesktopIpc('desktop:backup:list', () => requireLocalDatabase().listBackups())
  // Друга копія на флешці / зовнішньому диску (рішення власника 17.11.2026).
  handleDesktopIpc('desktop:backup:external-status', () => {
    if (!externalBackups) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    return externalBackups.status()
  })
  handleDesktopIpc('desktop:backup:external-choose', async () => {
    if (!desktopDataRoot || !externalBackups || !mainWindow) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    const picked = await dialog.showOpenDialog(mainWindow, { title: 'Оберіть флешку або зовнішній диск для копій',
      properties: ['openDirectory', 'createDirectory'], defaultPath: readExternalConfig(desktopDataRoot).folder ?? undefined })
    if (picked.canceled || !picked.filePaths[0]) return externalBackups.status()
    setExternalFolder(desktopDataRoot, picked.filePaths[0])
    // Перша копія — одразу, щоб власник побачив результат.
    await externalBackups.runNow().catch(error => writeDesktopDiagnostic('external-backup-failed', error))
    return externalBackups.status()
  })
  handleDesktopIpc('desktop:backup:external-clear', () => {
    if (!desktopDataRoot || !externalBackups) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    setExternalFolder(desktopDataRoot, null)
    return externalBackups.status()
  })
  handleDesktopIpc('desktop:backup:external-run', async () => {
    if (!externalBackups) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    await externalBackups.runNow()
    return externalBackups.status()
  })
  handleDesktopIpc('desktop:backup:external-import', async (_event, fileName: string) => {
    const dataRoot = desktopDataRoot
    const folder = dataRoot ? readExternalConfig(dataRoot).folder : null
    if (!dataRoot || !folder) throw new Error('Папку з копіями не вибрано')
    const result = await importExternalCopy(folder, String(fileName), path.join(dataRoot, 'backups'),
      file => LocalDatabase.assertBackupIsUsable(file))
    writeDesktopDiagnostic('external-backup-imported', { fileName: result.fileName, sizeBytes: result.sizeBytes })
    return result
  })
  handleDesktopIpc('desktop:backup:fetch-cloud', async (_event, request: CloudBackupRequest) => {
    const session = requireDesktopSession()
    const dataRoot = desktopDataRoot
    if (!dataRoot) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    // Копія має належати магазину, в який увійшов власник.
    if (!request || request.tenant_id !== session.tenant_id) throw new Error('Копія належить іншому магазину')
    const result = await fetchCloudBackup(request, {
      backupsDir: path.join(dataRoot, 'backups'),
      trustedOrigin: requireTrustedAuthConfig().supabaseUrl,
      fetchImpl: net.fetch.bind(net) as unknown as typeof fetch,
      assertUsable: file => LocalDatabase.assertBackupIsUsable(file),
    })
    writeDesktopDiagnostic('cloud-backup-fetched', { fileName: result.fileName, sizeBytes: result.sizeBytes })
    return { fileName: result.fileName, sizeBytes: result.sizeBytes }
  })
  handleDesktopIpc('desktop:backup:restore', async (_event, fileName: string) => {
    if (lanOrderQueue?.hasPending()) throw new Error('Не можна відновити стару базу, поки є непередані офлайн-замовлення. Спочатку збережіть і звірте їх із головним ПК.')
    if (activeDesktopCommands.size > 1) {
      throw new Error('Дочекайтеся завершення поточних операцій перед відновленням бази.')
    }
    // Підміняти файл під відкритими репозиторіями не можна, тому працюємо
    // так: закрили базу → поставили копію на місце → перезапустили програму.
    // Відкат — рідка й важка дія, чесний перезапуск тут безпечніший за
    // спробу перепідключити півтора десятка репозиторіїв на льоту.
    const dataRoot = desktopDataRoot
    if (!dataRoot) throw new Error('LOCAL_DATA_ROOT_NOT_READY')
    const database = requireLocalDatabase()
    const candidate = database.listBackups().find((entry) => entry.fileName === String(fileName))
    if (!candidate) throw new Error('LOCAL_BACKUP_NOT_FOUND')
    // Невдала перевірка не закриває робоче з'єднання й усі його репозиторії.
    LocalDatabase.assertBackupIsUsable(candidate.filePath)
    databaseMaintenance = true
    stopBackupScheduler?.()
    stopBackupScheduler = null
    let closed = false
    try {
      tillDeviceLink?.stop(); outboxPusher?.stop()
      await shiftBackups?.stop()
      await externalBackups?.stop()
      await database.waitForBackup()
      await localNetwork?.stop()
      cashalot?.stopWorker()
      database.close()
      closed = true
      localDatabase = null
      const restored = LocalDatabase.stageBackupForRestart(dataRoot, String(fileName))
      writeDesktopDiagnostic('local-database-restored-manually', restored)
      app.relaunch()
      app.exit(0)
      return restored
    } catch (error) {
      writeDesktopDiagnostic('local-database-restore-failed', error)
      // Не підключаємо лише localDatabase, залишивши репозиторії на закритому
      // дескрипторі. Повний перезапуск з тим самим збереженим файлом.
      dialog.showErrorBox('Копію не відновлено',
        'Відновлення зупинено. Програма перезапуститься; автоматичного відкату не буде.')
      if (!closed) database.close()
      app.relaunch()
      app.exit(1)
      throw error
    }
  })
  // Сумісна зрозуміла відмова для старого renderer, жодного імпорту.
  handleDesktopIpc('desktop:bootstrap:import-snapshot', () => assertLocalDataAuthority('desktop:bootstrap:import-snapshot'))
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
    // Розширення за вмістом: картинки без фону зберігаються як PNG/WebP з прозорістю.
    const isPng = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47
    const isWebp = bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    const photoPath = path.join(photoDir, Date.now() + '-' + crypto.randomUUID() + (isPng ? '.png' : isWebp ? '.webp' : '.jpg'))
    await writeFile(photoPath, bytes)
    return pathToFileURL(photoPath).href
  })
  handleDesktopIpc('desktop:catalog:delete-photo', async (_event, photoUrl: string) => {
    if (!desktopDataRoot || !String(photoUrl).startsWith('file:')) return { ok: true }
    const referenced = requireLocalDatabase().prepare('SELECT 1 FROM products WHERE photo_url = ? LIMIT 1').get(photoUrl)
    if (referenced) return { ok: true }
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
  // 23.11.2026 (план 4.3): мініатюри товарів для друкованого бланка замовлення — і в програмі, і у вебі через
  // головний ПК (фото лежать файлами тут, а file:-адреси не відкриваються ні у вебі, ні у вікні друку).
  // Лише фото, на які посилаються самі товари; лише з теки photos; зменшені до 96 px.
  handleDesktopIpc('desktop:catalog:photo-thumbnails', (_event, productIds: unknown) =>
    productPhotoThumbnails(requireLocalDatabase(), desktopDataRoot, productIds,
      filePath => { const image = nativeImage.createFromPath(filePath); return image.isEmpty() ? null : image.resize({ width: 96 }).toDataURL() }),
  )
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
  // 22.11.2026: каса отримує разом зі списком працівників їхню особисту ціну (відсоток або «за закупкою»).
  handleDesktopIpc('desktop:catalog:list-staff', () => {
    const prices = employeePricing(requireLocalDatabase())
    return requireLocalCatalog().listStaff().map((user: any) => ({ ...user, employee_price: prices[user.id] ?? null }))
  })
  handleDesktopIpc('desktop:catalog:get-settings', () =>
    requireLocalCatalog().getSettings(),
  )
  handleDesktopIpc('desktop:catalog:update-settings', (_event, input) =>
    requireLocalCatalog().updateSettings(input),
  )
  handleDesktopIpc('desktop:catalog:search-products', (_event, query: string, limit?: number) =>
    requireLocalCatalog().searchProducts(query, undefined, limit),
  )
  handleDesktopIpc('desktop:catalog:upsert-product', () => assertLocalDataAuthority('desktop:catalog:upsert-product'))
  handleDesktopIpc('desktop:catalog:analytics', (_event, input) => localAnalytics(requireLocalDatabase(), input))
  handleDesktopIpc('desktop:catalog:agent-scan', (_event, input) => runCatalogAgent(requireLocalDatabase().dataRoot, 'scan', input ?? {}, requireDesktopSession().id))
  handleDesktopIpc('desktop:catalog:cleanup-scan', async () => {
    const session = cleanupSession()
    const [result, capability] = await Promise.all([
      scanCatalogCleanup(requireLocalDatabase().dataRoot, session.tenant_id), cleanupCapability(session),
    ])
    assertCleanupSession(session)
    return { ...result, capability }
  })
  handleDesktopIpc('desktop:catalog:cleanup-preview', async (_event, input) => {
    const session = cleanupSession(), repository = await cleanupRepository(session)
    return repository.preview({ ...input, tenant_id: session.tenant_id })
  })
  handleDesktopIpc('desktop:catalog:cleanup-apply', async (_event, input) => {
    if (cleanupMutationInProgress) throw new Error('Попереднє очищення ще виконується. Дочекайтеся результату.')
    const session = cleanupSession(); cleanupMutationInProgress = true
    try {
      const backupPath = await requireLocalDatabase().backupNow()
      const repository = await cleanupRepository(session)
      assertCleanupSession(session)
      // Synchronous SQLite transaction: no async gap after the final cart/session checks.
      return { ...repository.apply({ ...input, tenant_id: session.tenant_id }, session.id), backupPath }
    } finally { cleanupMutationInProgress = false }
  })
  handleDesktopIpc('desktop:catalog:cleanup-apply-sku', async (_event, input) => {
    if (cleanupMutationInProgress) throw new Error('Попереднє очищення ще виконується. Дочекайтеся результату.')
    const session = cleanupSession(); cleanupMutationInProgress = true
    try {
      const backupPath = await requireLocalDatabase().backupNow()
      assertCleanupSession(session)
      return { ...new CatalogCleanupRepository(requireLocalDatabase()).applySku({ ...input, tenant_id: session.tenant_id }, session.id), backupPath }
    } finally { cleanupMutationInProgress = false }
  })
  // Наведення порядку: перелік змін лише читає каталог; кожен крок виконується після резервної копії
  // та з тими самими перевірками сесії, сервера й відкритих чеків, що й ручне об'єднання.
  handleDesktopIpc('desktop:catalog:cleanup-tidy-plan', async () => {
    const session = cleanupSession(), repository = await cleanupRepository(session)
    return new CatalogTidyRepository(requireLocalDatabase(), repository).plan(session.tenant_id)
  })
  handleDesktopIpc('desktop:catalog:cleanup-tidy-apply', async (_event, input) => {
    if (cleanupMutationInProgress) throw new Error('Попереднє очищення ще виконується. Дочекайтеся результату.')
    const session = cleanupSession(); cleanupMutationInProgress = true
    try {
      const backupPath = await requireLocalDatabase().backupNow()
      const repository = await cleanupRepository(session)
      assertCleanupSession(session)
      const run = new CatalogTidyRepository(requireLocalDatabase(), repository).begin({ ...input, tenant_id: session.tenant_id }, session.id)
      // По одній картці з паузою: сотні збережень поспіль не мають «заморожувати» вікно каси.
      // Після кожної паузи знову перевіряємо, що за касою той самий власник.
      let paused = Date.now()
      for (let index = 0; index < run.total; index++) {
        run.step(index)
        if (Date.now() - paused >= 40) {
          await new Promise<void>(resolve => setImmediate(resolve))
          try { assertCleanupSession(session) } catch (error) { run.finish(); throw error }
          paused = Date.now()
        }
      }
      return { ...run.finish(), backupPath }
    } finally { cleanupMutationInProgress = false }
  })
  handleDesktopIpc('desktop:catalog:agent-fingerprints', (_event, ids) => new CatalogAgentRepository(requireLocalDatabase()).fingerprints(ids))
  handleDesktopIpc('desktop:catalog:agent-apply', async (_event, input) => {
    const userId = requireDesktopSession().id
    const backupPath = await requireLocalDatabase().backupNow()
    const result = await runCatalogAgent(requireLocalDatabase().dataRoot, 'apply', input, userId)
    return { ...result, backupPath }
  })
  handleDesktopIpc('desktop:catalog:apply-batch', (_event, input) => applyCatalogBatch(requireLocalDatabase().dataRoot, input))
  handleDesktopIpc('desktop:catalog:save-product', (_event, product: LocalProductUpsert, options) =>
    requireLocalCatalog().saveProduct(product, options),
  )
  handleDesktopIpc('desktop:catalog:delete-product', (_event, id: string) =>
    requireLocalCatalog().deleteProduct(id),
  )
  handleDesktopIpc('desktop:catalog:list-cross-numbers', (_event, productId: string) =>
    requireLocalCatalog().listCrossNumbers(productId),
  )
  handleDesktopIpc('desktop:catalog:change-cross-numbers', (_event, productId: string, change) =>
    requireLocalCatalog().changeCrossNumbers(productId, change),
  )
  handleDesktopIpc('desktop:catalog:list-analogs', (_event, productId: string, limit?: number) =>
    requireLocalCatalog().listAnalogs(productId, undefined, limit),
  )
  handleDesktopIpc('desktop:catalog:negative-stock', () => requireLocalCatalog().listNegativeStock())
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
  handleDesktopIpc('desktop:supplier-catalog:import-rows', (_event, filename: string, rows: any[], options: any) => {
    if (!options?.operation_id) throw new Error('Оновіть локальну програму для безпечного імпорту прайсу.')
    const session = requireDesktopSession()
    return requireLocalSupplierCatalog().importRows(filename, rows, { ...options, user_id: session.id, tenant_id: session.tenant_id })
  })
  handleDesktopIpc('desktop:supplier-catalog:resolve-import', (_event, operationId: string) => {
    const session = requireDesktopSession()
    return requireLocalSupplierCatalog().resolveImport(operationId, session.id, session.tenant_id)
  })

  handleDesktopIpc('desktop:auth:login', async (_event, phone: string, password: string) => {
    if (lanPairInProgress) throw new Error('Дочекайтеся завершення підключення до головного ПК')
    const generation = ++desktopLoginGeneration
    const network = localNetwork!
    assertLanIdentityConnection(requireLocalDatabase(), network.getStatus())
    const localLogin = () => requireLocalStaff().loginWithPassword(phone, password)
    const user = network.getStatus().mode === 'client'
      ? await loginLanClient({
        remote: () => network.loginRemote(phone, password),
        cache: profile => {
          if (generation !== desktopLoginGeneration) throw new Error('Спробу входу скасовано')
          cacheLanIdentity(requireLocalDatabase(), profile, phone, password, network.getStatus().accessKey)
        }, local: localLogin,
      }) : localLogin()
    if (generation !== desktopLoginGeneration) throw new Error('Спробу входу скасовано')
    completeDesktopLogin(user)
    return user
  })
  // Вхід касира лише паролем — тільки на головному чи окремому ПК, де лежить база працівників.
  // ПК менеджера перевіряє вхід через головний ПК і далі входить з номером телефону.
  handleDesktopIpc('desktop:auth:login-password', async (_event, password: string) => {
    if (lanPairInProgress) throw new Error('Дочекайтеся завершення підключення до головного ПК')
    const generation = ++desktopLoginGeneration
    const network = localNetwork!
    assertLanIdentityConnection(requireLocalDatabase(), network.getStatus())
    const localLogin = () => requireLocalStaff().loginWithPasswordOnly(password)
    // 23.11.2026, рішення власника «логін прибираємо, досить пароля»: ПК менеджера теж входить лише паролем —
    // пароль перевіряє головний ПК і повертає, хто це; без зв'язку — за збереженим на цьому ПК входом.
    const user = network.getStatus().mode === 'client'
      ? await loginLanClient({
        remote: () => network.loginRemote('', password),
        cache: profile => {
          if (generation !== desktopLoginGeneration) throw new Error('Спробу входу скасовано')
          cacheLanIdentity(requireLocalDatabase(), profile, profile.phone, password, network.getStatus().accessKey)
        }, local: localLogin,
      }) : localLogin()
    if (generation !== desktopLoginGeneration) throw new Error('Спробу входу скасовано')
    completeDesktopLogin(user)
    return user
  })
  // 22.11.2026, рішення власника «веб повний, але тільки через головний ПК»: запит вебу виконується тут, у базі
  // головного ПК, тим самим шляхом і з правами того самого працівника, що й команда з ПК менеджера.
  handleDesktopIpc('desktop:web-rpc:execute', (_event, userId: string, channel: string, args: unknown[]) => executeWebRequest(userId, channel, args))
  // 22.11.2026, «головний ПК — тимчасовий сервер магазину»: зв'язок із сервером власним ключем ПК (tillDeviceLink).
  // Стан і сигнал доступні й на екрані входу: вони нічого не змінюють і не відкривають даних.
  // main_till = це головний ПК і в збірці відома адреса сервера: лише тоді вікно програми просить для ПК ключ.
  const linkPossible = () => { try { return isMainTill() && Boolean(requireTrustedAuthConfig().apiUrl) } catch { return false } }
  handleDesktopIpc('desktop:link:status', () => ({ ...getTillDeviceLink().status(), main_till: linkPossible() }))
  handleDesktopIpc('desktop:link:wake', async () => ({ ...(await getTillDeviceLink().wake()), main_till: linkPossible() }))
  handleDesktopIpc('desktop:link:commands-taken', () => { getTillDeviceLink().commandsTaken() })
  // 24.11.2026: помічник без другого пароля — запит іде ключем головного ПК (див. TillDeviceLink.assistant).
  // null — ключа ПК немає або це ПК менеджера: тоді екран працює по-старому, сесією працівника.
  handleDesktopIpc('desktop:link:assistant', async (_event, input: { method?: unknown; path?: unknown; body?: unknown }) => {
    const session = requireDesktopSession()
    if (!isMainTill() || !getTillDeviceLink().available()) return null
    return getTillDeviceLink().assistant({ method: String(input?.method ?? 'GET').toUpperCase(), path: String(input?.path ?? ''),
      body: typeof input?.body === 'string' ? input.body : undefined, role: session.role, staffId: session.id })
  })
  // Вікно програми просить передати зміни зараз. null — ключа ПК ще немає: тоді вікно надсилає по-старому, своєю сесією.
  handleDesktopIpc('desktop:link:push-outbox', () => getOutboxPusher().pushNow())
  // Ключ видає сервер власнику чи адміністратору; сюди його приносить вікно програми одразу після видачі.
  handleDesktopIpc('desktop:link:register', (_event, token: string) => {
    const session = requireDesktopSession()
    if (!isMainTill()) throw new Error('Ключ зв’язку потрібен лише головному ПК')
    getTillDeviceLink().register(token, session.tenant_id)
    return { ...getTillDeviceLink().status(), main_till: true }
  })
  // Етап 9: швидка зміна касира за PIN. Лише ті, хто сьогодні вже входив паролем на цьому ПК.
  handleDesktopIpc('desktop:auth:pin-roster', () => {
    if (lanPairInProgress || !pinLoginAvailable()) return []
    try { return getPinRoster().list() } catch { return [] }
  })
  // 23.11.2026, рішення власника: PIN вводять, нікого не вибираючи, — працівника визначає сам PIN.
  handleDesktopIpc('desktop:auth:login-pin', async (_event, pin: string) => {
    if (lanPairInProgress) throw new Error('Дочекайтеся завершення підключення до головного ПК')
    if (!pinLoginAvailable()) throw new Error('На ПК менеджера вхід — паролем')
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw new Error('PIN-код — 4 цифри')
    const generation = ++desktopLoginGeneration
    const stored = getPinRoster().loginByPin(candidateIds => requireLocalStaff().pinOwners(pin, DEFAULT_TENANT_ID, candidateIds))
    if (generation !== desktopLoginGeneration) throw new Error('Спробу входу скасовано')
    const server = getPinRoster().serverSession(stored.id, stored.tenant_id)
    completeDesktopLogin(stored)
    // Сьогоднішня серверна сесія цього працівника повертається разом із ним — обмін із сервером без пароля.
    if (server) try {
      getRememberedAccess().saveServerSession(stored, server)
      getPinRoster().saveServerSession(stored.id, stored.tenant_id, server)
    } catch (error) { writeDesktopDiagnostic('pin-server-session-skipped', error) }
    return { id: stored.id, tenant_id: stored.tenant_id, full_name: stored.full_name, role: stored.role, phone: stored.phone ?? '',
      email: `${String(stored.phone ?? '').replace(/\D/g, '')}@forsage.internal`, is_active: true }
  })
  handleDesktopIpc('desktop:auth:login-online', async (_event, phone: string, password: string) => {
    if (lanPairInProgress || localNetwork?.getStatus().mode === 'client' || hasLanIdentity(requireLocalDatabase())) throw new Error('Вхід ПК менеджера перевіряє головний ПК без інтернету')
    const generation = ++desktopLoginGeneration
    const result = await loginOnlineAndProvisionLocal(phone, password, generation)
    if (generation !== desktopLoginGeneration) throw Error('Спробу входу скасовано')
    completeDesktopLogin(result.user)
    return result
  })
  handleDesktopIpc('desktop:auth:save-server-session', async (_event, tokens: unknown) => {
    const saveGeneration = ++serverSessionSaveGeneration
    return verifyAndRememberServerSession(tokens, {
      current: () => {
        if (saveGeneration !== serverSessionSaveGeneration) throw new DesktopSessionLifecycleError('superseded', 'Сесію вже оновлено')
        const session = requireDesktopSession()
        // IPC's async context can outlive logout. Bind this cache to the live Windows day session.
        if (!desktopAuthSession || desktopAuthSession.id !== session.id || desktopAuthSession.tenant_id !== session.tenant_id
          || rememberedStatus().locked) throw new DesktopSessionLifecycleError('local-session-ended', 'Поточний вхід завершено')
        return { ...session, generation: desktopLoginGeneration }
      },
      config: requireTrustedAuthConfig(),
      fetch: net.fetch.bind(net),
      save: (identity, checked) => {
        getRememberedAccess().saveServerSession(identity, checked)
        try { if (pinLoginAvailable()) getPinRoster().saveServerSession(identity.id, identity.tenant_id, checked) }
        catch (error) { writeDesktopDiagnostic('pin-roster-server-session-skipped', error) }
      },
    })
  })
  handleDesktopIpc('desktop:auth:restore-server-session', () =>
    getRememberedAccess().serverSession(requireDesktopSession()))
  handleDesktopIpc('desktop:auth:remembered-status', () => rememberedStatus())
  handleDesktopIpc('desktop:auth:restore', () => {
    assertLanIdentityConnection(requireLocalDatabase(), localNetwork!.getStatus())
    desktopLoginGeneration++
    const user = getRememberedAccess().restore()
    if (!user) return null
    desktopAuthSession = { id:user.id, tenant_id:user.tenant_id, role:user.role }
    rememberedSessionRequired = true
    void checkLanUpdate()
    return user
  })
  handleDesktopIpc('desktop:auth:logout', () => {
    desktopLoginGeneration++
    getRememberedAccess().forget()
    rememberedSessionRequired = false
    desktopAuthSession = null
    return { success: true }
  })
  handleDesktopIpc('desktop:staff:list-users', (_event, includeArchived?: boolean) => requireLocalStaff().listUsers(requireDesktopSession().tenant_id, includeArchived === true))
  handleDesktopIpc('desktop:staff:restore-user', (_event, id: string) => {
    const session = requireDesktopSession()
    if (!['owner', 'admin'].includes(session.role)) throw new Error('Недостатньо прав для відновлення працівника')
    return requireLocalStaff().restoreUser(id, session.tenant_id)
  })
  handleDesktopIpc('desktop:staff:save-settings', (_event, id: string, input: any, rules: any[]) => {
    const session = requireDesktopSession()
    if (!['owner', 'admin'].includes(session.role)) throw new Error('Недостатньо прав для зміни працівника')
    if (id === session.id && (input.is_active === false || input.role === 'tire_worker')) throw new Error('Не можна вимкнути власний доступ')
    return requireLocalStaff().saveUserSettings(id, input, rules, session.tenant_id)
  })
  handleDesktopIpc('desktop:purchases:list-rules', () => requireLocalPurchases().listRules(requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:purchases:create-rule', (_event, input: any) => requireLocalPurchases().createRule(input))
  handleDesktopIpc('desktop:purchases:delete-rule', (_event, id: string) => requireLocalPurchases().deleteRule(id, requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:purchases:suggestions', () => requireLocalPurchases().suggestions(requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:purchases:generate-invoices', (_event, input: any) => requireLocalPurchases().generateInvoices({ ...input, user_id: requireDesktopSession().id }))
  handleDesktopIpc('desktop:purchases:supplier-needs', () => requireLocalPurchases().supplierNeeds(requireDesktopSession().tenant_id))
  // 24.11.2026: «Що закінчується» — товари з низьким залишком за постачальниками (лише читання).
  handleDesktopIpc('desktop:purchases:restock-needs', () => requireLocalPurchases().restockNeeds(requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:staff:save-server-user', (_event, input: any, password?: string) =>
    requireLocalStaff().saveServerUser(input, password))
  handleDesktopIpc('desktop:staff:update-user', (_event, id: string, input: any) => {
    if (id === requireDesktopSession().id && (input.is_active === false || input.role === 'tire_worker')) throw new Error('Не можна вимкнути власний доступ')
    return requireLocalStaff().updateUser(id, input)
  })
  handleDesktopIpc('desktop:staff:delete-user', (_event, id: string) => {
    const session = requireDesktopSession()
    if (!['owner', 'admin'].includes(session.role)) throw new Error('Недостатньо прав для видалення працівника')
    if (id === session.id) throw new Error('Не можна видалити власний обліковий запис')
    return requireLocalStaff().deleteUser(id, session.tenant_id)
  })
  handleDesktopIpc('desktop:staff:sale-access', () => managerSaleAllowedIds(requireLocalDatabase()))
  handleDesktopIpc('desktop:staff:set-sale-access', (_event, id: string, enabled: boolean) =>
    setManagerSaleAccess(requireLocalDatabase(), id, enabled))
  handleDesktopIpc('desktop:staff:deposit-access', () => managerDepositAllowedIds(requireLocalDatabase()))
  handleDesktopIpc('desktop:staff:set-deposit-access', (_event, id: string, enabled: boolean) =>
    setManagerDepositAccess(requireLocalDatabase(), id, enabled))
  handleDesktopIpc('desktop:staff:web-access', () => webWorkAllowedIds(requireLocalDatabase()))
  handleDesktopIpc('desktop:staff:set-web-access', (_event, id: string, enabled: boolean) =>
    setWebWorkAccess(requireLocalDatabase(), id, enabled))
  // 24.11.2026: права працівника перемикачами в картці (security/staffRights) — замовлення, закупівельні ціни, звіти.
  handleDesktopIpc('desktop:staff:rights', () => allStaffRights(requireLocalDatabase()))
  // 24.11.2026 (план C9): стиснення старого журналу відправлених операцій — лише кнопкою власника на головному ПК.
  handleDesktopIpc('desktop:maintenance:outbox-preview', () => {
    if (!isMainTill()) throw new Error('Журнал обслуговується лише на головному ПК')
    return previewOutboxCompaction(requireLocalDatabase())
  })
  handleDesktopIpc('desktop:maintenance:outbox-compact', () => {
    if (!isMainTill()) throw new Error('Журнал обслуговується лише на головному ПК')
    return compactOutbox(requireLocalDatabase())
  })
  handleDesktopIpc('desktop:staff:set-right', (_event, id: string, right: string, enabled: boolean) =>
    setStaffRight(requireLocalDatabase(), id, right, enabled))
  handleDesktopIpc('desktop:staff:my-rights', () => {
    const session = requireDesktopSession()
    return effectiveStaffRights(requireLocalDatabase(), session.id, session.role)
  })
  handleDesktopIpc('desktop:staff:employee-pricing', () => employeePricing(requireLocalDatabase()))
  handleDesktopIpc('desktop:staff:set-employee-pricing', (_event, id: string, value: unknown) =>
    setEmployeePricing(requireLocalDatabase(), id, value))
  handleDesktopIpc('desktop:staff:save-server-password', (_event, id: string, password: string) =>
    requireLocalStaff().saveServerPassword(id, password))
  // 22.11.2026: PIN чи пароль, змінений у вебі, поки головний ПК був вимкнений (команда staff.secret, лише хеш).
  // Хто змінив — власник/адмін або сам працівник; перевіряємо за базою головного ПК.
  handleDesktopIpc('desktop:staff:apply-remote-secret', (_event, requestedBy: string, payload: { user_id?: unknown; kind?: unknown; hash?: unknown }) => {
    if (localNetwork?.getStatus().mode === 'client' || hasLanIdentity(requireLocalDatabase())) throw new Error('Зміни з вебу застосовує лише головний ПК')
    const requester = typeof requestedBy === 'string' ? resolveLanSession(requestedBy) : null
    const userId = String(payload?.user_id ?? ''), kind = payload?.kind, hash = String(payload?.hash ?? '')
    if (!requester) throw new Error('Працівника, що вніс зміну, не знайдено або доступ вимкнено')
    if (requester.id !== userId && !['owner', 'admin'].includes(requester.role)) throw new Error('Змінити PIN чи пароль іншому може лише власник або адміністратор')
    if (kind !== 'pin' && kind !== 'password') throw new Error('Некоректні дані зміни')
    return requireLocalStaff().applyRemoteSecret(userId, kind, hash, requester.tenant_id)
  })
  handleDesktopIpc('desktop:staff:set-pin', (_event, userId: string, pin: string) => {
    // PIN дає швидкий вхід, тож ставить його собі сам працівник або власник/адміністратор — будь-кому.
    const session = requireDesktopSession()
    if (userId !== session.id && !['owner', 'admin'].includes(session.role)) throw new Error('PIN-код можна змінити лише собі')
    return requireLocalStaff().setPin(userId, pin, session.tenant_id)
  })
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
  handleDesktopIpc('desktop:staff:payout-list', (_event, workDate?: string) => requireLocalStaff().payoutList(workDate))
  handleDesktopIpc('desktop:staff:daily-summary', (_event, workDate?: string) => requireLocalStaff().dailySummary(workDate))
  handleDesktopIpc('desktop:staff:tire-service-report', (_event, workDate?: string) => requireLocalStaff().tireServiceReport(workDate))
  handleDesktopIpc('desktop:staff:tire-cash-handover', (_event, input: any) => requireLocalStaff().tireCashHandover({ ...input, user_id: requireDesktopSession().id }))
  handleDesktopIpc('desktop:staff:create-salary', (_event, input: any) => requireLocalStaff().createSalary({ ...input, user_id: requireDesktopSession().id }))
  handleDesktopIpc('desktop:staff:daily-payout', (_event, input: any) => requireLocalStaff().dailyPayout({ ...input, user_id: requireDesktopSession().id }))
  handleDesktopIpc('desktop:staff:resolve-operation', (_event, kind: 'salary' | 'daily-salary', operationId: string) => {
    const session = requireDesktopSession()
    return requireLocalStaff().resolveOperation(kind, operationId, session.id, session.tenant_id)
  })
  handleDesktopIpc('desktop:staff:delete-salary', (_event, id: string) => requireLocalStaff().deleteSalary(id))
  for (const kind of ['movement', 'reserve', 'consumption'] as const) {
    handleDesktopIpc('desktop:warehouse:resolve-' + kind, (_event, operationId: string) =>
      requireLocalWarehouse().resolveOperation(kind, operationId, requireDesktopSession().id, requireDesktopSession().tenant_id),
    )
  }
  handleDesktopIpc('desktop:warehouse:list-movements', (_event, input?: any) =>
    requireLocalWarehouse().listMovements(input),
  )
  handleDesktopIpc('desktop:warehouse:create-movement', (_event, input: any) =>
    requireLocalWarehouse().createMovement({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:warehouse:list-reserves', (_event, tenantId?: string) =>
    requireLocalWarehouse().listReserves(tenantId),
  )
  handleDesktopIpc('desktop:warehouse:create-reserve', (_event, input: any) =>
    requireLocalWarehouse().createManualReserve({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:warehouse:release-reserve', (_event, id: string, tenantId?: string) =>
    requireLocalWarehouse().releaseManualReserve(id, tenantId),
  )
  handleDesktopIpc('desktop:warehouse:writeoffs-summary', (_event, input) =>
    requireLocalWarehouse().writeoffsSummary({ month: input?.month, tenant_id: requireDesktopSession().tenant_id }),
  )
  handleDesktopIpc('desktop:warehouse:list-writeoffs', (_event, input?: any) =>
    requireLocalWarehouse().listWriteoffs(input),
  )
  handleDesktopIpc('desktop:warehouse:get-writeoff', (_event, id: string, tenantId?: string) =>
    requireLocalWarehouse().getWriteoff(id, tenantId),
  )
  handleDesktopIpc('desktop:warehouse:get-writeoff-by-operation', (_event, id: string) =>
    requireLocalWarehouse().getWriteoffByOperation(id, requireDesktopSession().id, requireDesktopSession().tenant_id),
  )
  handleDesktopIpc('desktop:warehouse:create-writeoff', (_event, input: any) =>
    requireLocalWarehouse().createWriteoff({ ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:inventory:list-sessions', (_event, input?: { tenant_id?: string; page?: number; per_page?: number }) => {
    const page = Math.max(1, Math.trunc(Number(input?.page) || 1))
    const perPage = Math.min(100, Math.max(1, Math.trunc(Number(input?.per_page) || 20)))
    const inventory = requireLocalInventory()
    const total = inventory.countSessions(input?.tenant_id)
    return {
      data: inventory.listSessions(input?.tenant_id, { limit: perPage, offset: (page - 1) * perPage }),
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: Math.max(1, Math.ceil(total / perPage)),
      },
    }
  })
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
  handleDesktopIpc('desktop:warehouse:list-consumptions', (_event, input: any) => requireLocalWarehouse().listConsumptions(input))
  handleDesktopIpc('desktop:warehouse:create-consumption', (_event, input: any) => requireLocalWarehouse().createConsumption({ ...input, user_id: requireDesktopSession().id }))
  handleDesktopIpc('desktop:inventory:create-product', (_event, sessionId: string, input: any) =>
    requireLocalInventory().createAndCountProduct(sessionId, { ...input, product: { ...input.product, tenant_id: requireDesktopSession().tenant_id }, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:inventory:scan', (_event, sessionId: string, input: any) =>
    requireLocalInventory().scan(sessionId, { ...input, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:inventory:set-item-qty', (_event, sessionId: string, itemId: string, input: { tenant_id?: string; counted_stock: number; expected_revision?: string }) =>
    requireLocalInventory().setItemQty(sessionId, itemId, { ...input, expected_revision: requireDocumentRevision(input?.expected_revision) }),
  )
  handleDesktopIpc('desktop:inventory:remove-item', (_event, sessionId: string, itemId: string, tenantId?: string, expectedRevision?: string) =>
    requireLocalInventory().removeItem(sessionId, itemId, tenantId, requireDocumentRevision(expectedRevision)),
  )
  handleDesktopIpc('desktop:inventory:labels', (_event, sessionId: string, tenantId?: string) =>
    requireLocalInventory().getLabels(sessionId, tenantId),
  )
  handleDesktopIpc('desktop:inventory:update-products', (_event, sessionId: string, input: Parameters<LocalInventoryRepository['updateProducts']>[1]) =>
    requireLocalInventory().updateProducts(sessionId, input),
  )
  handleDesktopIpc('desktop:inventory:apply-price', (_event, sessionId: string, input: { tenant_id?: string; product_id: string; retail_price: number; expected_price?: number }) => {
    if (!Number.isSafeInteger(input?.expected_price) || Number(input?.expected_price) < 0) throw new Error('DOCUMENT_CONFLICT: Звірте актуальну ціну товару перед зміною.')
    return requireLocalInventory().applyPrice(sessionId, input)
  })
  handleDesktopIpc('desktop:inventory:complete', (_event, sessionId: string, input?: { tenant_id?: string; user_id?: string | null; expected_revision?: string }) =>
    requireLocalInventory().complete(sessionId, { ...(input ?? {}), expected_revision: requireDocumentRevision(input?.expected_revision), user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:orders:list-ready', (_event, input?: { tenant_id?: string; search?: string; limit?: number }) =>
    requireLocalOrders().listReadyOrders(input),
  )
  handleDesktopIpc('desktop:orders:list', (_event, input) =>
    requireLocalOrders().listOrders(input),
  )
  handleDesktopIpc('desktop:orders:count', (_event, input) => requireLocalOrders().countOrders(input))
  handleDesktopIpc('desktop:orders:save', (_event, input, id?: string) => {
    if (id && !String(input?.expected_updated_at ?? '').trim()) throw new Error('Немає версії замовлення. Відкрийте актуальну картку перед редагуванням.')
    return requireLocalOrders().saveOrder({ ...input, manager_id: requireDesktopSession().id }, id)
  })
  handleDesktopIpc('desktop:orders:get-save-result', (_event, operationId: string, id?: string) =>
    requireLocalOrders().getSaveResult(operationId, requireDesktopSession().id, requireDesktopSession().tenant_id, id),
  )
  handleDesktopIpc('desktop:orders:accept-offline', (_event, input) =>
    requireLocalOrders().acceptOfflineOrder(input, requireDesktopSession()),
  )
  handleDesktopIpc('desktop:orders:offline-status', () => lanOrderClient?.status(requireDesktopSession()))
  handleDesktopIpc('desktop:orders:retry-offline', (_event, id: string) => {
    if (localNetwork?.getStatus().mode !== 'client') throw new Error('Ця дія доступна тільки на ПК менеджера')
    return lanOrderClient!.retry(requireDesktopSession(), id)
  })
  handleDesktopIpc('desktop:orders:discard-offline', (_event, id: string) => {
    if (localNetwork?.getStatus().mode !== 'client') throw new Error('Ця дія доступна тільки на ПК менеджера')
    return lanOrderClient!.discard(requireDesktopSession(), id)
  })
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
  handleDesktopIpc('desktop:orders:suggest-parts', (_event, query: string) =>
    requireLocalOrders().suggestOrderParts(query, requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:orders:arrival-from-invoice', (_event, invoiceId: string) =>
    requireLocalOrders().applyInvoiceArrival(invoiceId, requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:orders:pending-items', (_event, supplierId: string, tenantId?: string) =>
    requireLocalOrders().listPendingItems(supplierId, tenantId),
  )
  handleDesktopIpc('desktop:orders:bulk-arrival', (_event, itemIds: string[], tenantId?: string) =>
    requireLocalOrders().bulkArrival(itemIds, tenantId),
  )
  // 23.11.2026 (план C3): «Замовити в постачальника».
  // 24.11.2026 (план C2): скасувати всю пачку одного завантаження блокнота.
  // 24.11.2026 (план C2): мініатюри позицій замовлення (зі скриншота кошика чи з довідника).
  handleDesktopIpc('desktop:orders:item-photos', (_event, orderId: string) =>
    requireLocalOrders().listItemPhotos(orderId, requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:orders:cancel-notebook-batch', (_event, input: { order_ids?: unknown; customer_ids?: unknown }) =>
    requireLocalOrders().cancelNotebookBatch(input, requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:orders:supplier-lines', () =>
    requireLocalOrders().listSupplierOrderLines(requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:orders:bulk-ordered', (_event, itemIds: string[]) =>
    requireLocalOrders().bulkOrdered(itemIds, requireDesktopSession().tenant_id))
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
    return requireLocalOrders().completeOrder(orderId, securedInput)
  })
  // 25.11.2026: видача без прийому грошей — внесене зараховується, решта стає боргом клієнта.
  // Лише ідентифікатор замовлення й (для часткової видачі) вибрані позиції: ні суми, ні способу оплати, ні зміни ззовні не беремо.
  handleDesktopIpc('desktop:orders:hand-over', (_event, orderId: string, itemIds?: unknown) => {
    const userId = requireDesktopSession().id
    if (itemIds === undefined || itemIds === null) return requireLocalOrders().completeOrder(orderId, { user_id: userId, on_debt: true })
    if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 500 || !itemIds.every(id => typeof id === 'string' && id.length <= 64)) {
      throw new Error('Некоректний список позицій для видачі')
    }
    return requireLocalOrders().handOverItems(orderId, { user_id: userId, item_ids: itemIds })
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
    createAiInvoiceInWorker(requireLocalDatabase().dataRoot, { ...input, tenant_id: requireDesktopSession().tenant_id, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:supply:update-invoice', (_event, id: string, input: any) =>
    requireLocalSupply().updateInvoice(id, { ...input, expected_revision: requireDocumentRevision(input?.expected_revision) }),
  )
  handleDesktopIpc('desktop:supply:pay-invoice', (_event, id: string, input: any) =>
    requireLocalSupply().payInvoice(id, { ...input, user_id: requireDesktopSession().id, expected_revision: requireDocumentRevision(input?.expected_revision) }),
  )
  handleDesktopIpc('desktop:supply:post-invoice', (_event, id: string, input?: any) =>
    requireLocalSupply().postInvoice(id, { ...(input ?? {}), user_id: requireDesktopSession().id, expected_revision: requireDocumentRevision(input?.expected_revision) }),
  )
  handleDesktopIpc('desktop:supply:cancel-invoice', (_event, id: string, tenantId?: string, expectedRevision?: string) =>
    requireLocalSupply().cancelInvoice(id, tenantId, requireDocumentRevision(expectedRevision)),
  )
  handleDesktopIpc('desktop:supply:delete-invoice', (_event, id: string, tenantId?: string, expectedRevision?: string) =>
    requireLocalSupply().deleteInvoice(id, tenantId, requireDocumentRevision(expectedRevision)),
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
  // 23.11.2026 (план B2): пачки штрихкодів для карток клієнтів (друкарня) і «вільна картка» при першому скануванні.
  handleDesktopIpc('desktop:pos:card-batches', () => listCardBatches(requireLocalDatabase()))
  handleDesktopIpc('desktop:pos:card-batch-codes', (_event, id: string) => cardBatchCodes(requireLocalDatabase(), id))
  handleDesktopIpc('desktop:pos:card-batch-create', (_event, input: { count?: unknown; format?: unknown }) =>
    generateCardBatch(requireLocalDatabase(), { count: input?.count, format: input?.format, createdBy: requireDesktopSession().id }))
  handleDesktopIpc('desktop:pos:free-card', (_event, code: string) => isFreeCard(requireLocalDatabase(), code))
  handleDesktopIpc('desktop:pos:get-customer', (_event, id: string, tenantId?: string) =>
    requireLocalPos().getCustomer(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:get-customer-sales', (_event, id: string, tenantId?: string) =>
    requireLocalPos().getCustomerSales(id, tenantId),
  )
  handleDesktopIpc('desktop:supply:prewarm-invoice-check', async () => {
    await prewarmAiInvoiceCheck(requireLocalDatabase().dataRoot, requireDesktopSession().tenant_id)
    return { ok: true }
  })
  handleDesktopIpc('desktop:supply:preview-invoice-from-ai', (_event, input: any) =>
    previewAiInvoiceInWorker(requireLocalDatabase().dataRoot, { ...input, tenant_id: requireDesktopSession().tenant_id }),
  )
  handleDesktopIpc('desktop:supply:commit-receiving', (_event, input: any) =>
    commitReceivingInWorker(requireLocalDatabase().dataRoot, { ...input, tenant_id: requireDesktopSession().tenant_id, user_id: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:pos:save-customer', (_event, input, id?: string) => {
    const pos = requireLocalPos()
    return pos.saveCustomer(customerWritePayload(input, requireDesktopSession(), id ? pos.getCustomer(id) : undefined), id)
  })
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
  handleDesktopIpc('desktop:pos:expected-cash', (_event, cashierId: string) => {
    const session = requireDesktopSession()
    return requireLocalPos().getExpectedCash(session.id, session.tenant_id)
  })
  handleDesktopIpc('desktop:pos:shift-report', (_event, cashierId: string) => {
    const session = requireDesktopSession()
    return requireLocalPos().getShiftReport(session.id, session.tenant_id)
  })
  handleDesktopIpc('desktop:pos:reconcile', (_event, cashierId: string, actualAmount: number, comment: string | null) => {
    const session = requireDesktopSession()
    return requireLocalPos().reconcileShift(session.id, actualAmount, comment, session.tenant_id)
  })
  handleDesktopIpc('desktop:pos:close-shift', (_event, cashierId: string, actualAmount: number, comment: string | null, shiftId: string, keepInDrawer?: number | null) => {
    const session = requireDesktopSession()
    // Власник/адміністратор може закрити забуту зміну іншого касира; касир — лише свою, як і раніше.
    const foreign = typeof cashierId === 'string' && cashierId !== session.id && (session.role === 'owner' || session.role === 'admin')
    // 24.11.2026: keepInDrawer — скільки лишили на розмін; решта записується як «здано власнику».
    const result = requireLocalPos().closeShift(foreign ? cashierId : session.id, actualAmount, comment, shiftId, session.tenant_id, session.role, session.id,
      keepInDrawer === undefined || keepInDrawer === null ? null : Number(keepInDrawer))
    setImmediate(() => { void shiftBackups?.tick() })
    return result
  })
  handleDesktopIpc('desktop:pos:open-shift', (_event, input: {
    cashier_id: string
    opening_cash?: number
    notes?: string | null
  }) => {
    const session = requireDesktopSession()
    return requireLocalPos().openShift({ ...input, cashier_id: session.id, tenant_id: session.tenant_id })
  })
  // 21.11.2026: зміну закривають з вебу. Сервер прийняв команду лише від власника/адміна; каса ще раз
  // перевіряє, що цей працівник — активний власник або адміністратор у СВОЇЙ базі, і закриває від його імені.
  const remoteShiftActor = (requestedBy: string) => {
    const session = requireDesktopSession()
    if (localNetwork?.getStatus().mode === 'client') throw new Error('Зміни закриває головна каса')
    const actor = typeof requestedBy === 'string' ? activeSession(requireLocalDatabase(), { id: requestedBy, tenant_id: session.tenant_id }) : null
    if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) throw new Error('Недостатньо прав: зміну з вебу закриває лише власник або адміністратор')
    return actor
  }
  handleDesktopIpc('desktop:pos:remote-shifts', (_event, requestedBy: string) => {
    const actor = remoteShiftActor(requestedBy)
    return requireLocalPos().listOpenShifts(actor.tenant_id)
  })
  handleDesktopIpc('desktop:pos:remote-close-shift', (_event, requestedBy: string, input: { shift_id: string; cashier_id: string; actual_amount: number; comment: string }) => {
    const actor = remoteShiftActor(requestedBy)
    const result = requireLocalPos().closeShift(String(input?.cashier_id ?? ''), Number(input?.actual_amount), String(input?.comment ?? ''), String(input?.shift_id ?? ''), actor.tenant_id, actor.role, actor.id)
    setImmediate(() => { void shiftBackups?.tick() })
    return result
  })
  handleDesktopIpc('desktop:pos:list-open-shifts', () => requireLocalPos().listOpenShifts(requireDesktopSession().tenant_id))
  handleDesktopIpc('desktop:pos:get-open-shift', (_event, cashierId: string) => {
    const session = requireDesktopSession()
    return requireLocalPos().getOpenShift(session.id, session.tenant_id)
  })
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
  handleDesktopIpc('desktop:pos:sales-period-report', (_event, input) =>
    requireLocalPos().salesPeriodReport({ ...input, tenant_id: requireDesktopSession().tenant_id }),
  )
  handleDesktopIpc('desktop:pos:list-returns', (_event, input) =>
    requireLocalPos().listReturns(input),
  )
  handleDesktopIpc('desktop:pos:get-return', (_event, id: string, tenantId?: string) =>
    requireLocalPos().getReturn(id, tenantId),
  )
  handleDesktopIpc('desktop:pos:get-return-by-operation', (_event, id: string) =>
    requireLocalPos().getReturnByOperation(id, requireDesktopSession().id, requireDesktopSession().tenant_id),
  )
  handleDesktopIpc('desktop:pos:get-sale-for-return', (_event, saleId: string, tenantId?: string) =>
    requireLocalPos().getSaleForReturn(saleId, tenantId),
  )
  handleDesktopIpc('desktop:pos:create-return', (_event, input) =>
    requireLocalPos().createReturn({ ...input, cashier_id: requireDesktopSession().id, approved_by: requireDesktopSession().id }),
  )
  handleDesktopIpc('desktop:pos:refund-core-deposit', (_event, input: any) =>
    requireLocalPos().refundCoreDeposit({
      sale_item_id: String(input?.sale_item_id ?? ''), refund_id: String(input?.refund_id ?? ''),
      user_id: requireDesktopSession().id, tenant_id: requireDesktopSession().tenant_id,
    }),
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
  handleDesktopIpc('desktop:sync:list-stuck', (_event, limit?: number) =>
    requireLocalSync().listStuck(limit),
  )
  handleDesktopIpc('desktop:sync:apply-pull-changes', () => assertLocalDataAuthority('desktop:sync:apply-pull-changes'))
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
  handleDesktopIpc('desktop:print:labels-tspl', async (_event, html: string, options: TsplPrintOptions) => {
    const startedAt = Date.now()
    const result = await printLabelsTspl(html, options)
    writeDesktopDiagnostic('label-batch-completed', { ...result, total_with_queue_ms: Date.now() - startedAt })
    return result
  })
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
  handleDesktopIpc('desktop:fiscal:fiscalize-sale', (_event, request: LocalFiscalSaleRequest) =>
    fiscalizeSale(requireLocalPos(), requireCashalot, request),
  )
  handleDesktopIpc('desktop:fiscal:get-sale-intent', (_event, operationId: string) =>
    requireLocalPos().getFiscalSaleIntent(operationId),
  )
  handleDesktopIpc('desktop:fiscal:resolve-unknown-sale', (
    _event,
    operationId: string,
    resolution: LocalFiscalIntentResolution,
  ) => requireLocalPos().resolveUnknownFiscalSaleIntent(operationId, resolution))
  handleDesktopIpc('desktop:fiscal:fiscalize-return', (_event, request: LocalFiscalReturnRequest) =>
    processFiscalReturn(requireLocalPos(), requireCashalot, request),
  )
  handleDesktopIpc('desktop:fiscal:list-unresolved-returns', (_event, scope: LocalFiscalReturnIntentScope) =>
    requireLocalPos().listUnresolvedFiscalReturnIntents(scope),
  )
  handleDesktopIpc('desktop:fiscal:resume-return', async (
    _event,
    operationId: string,
    scope: LocalFiscalReturnIntentScope,
  ) => processFiscalReturn(requireLocalPos(), requireCashalot, requireLocalPos().getFiscalReturnRequest(operationId, scope)))
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

  // A restored old config must not downgrade a paired manager to plaintext LAN
  // even for the initial health check before a user has logged in.
  let safeNetworkConfig = false
  try { assertLanIdentityConnection(localDatabase, localNetwork.getStatus()); safeNetworkConfig = true }
  catch (error) { writeDesktopDiagnostic('lan-client-config-blocked', error) }
  if (safeNetworkConfig) await localNetwork.startConfigured()
  startupPhase('ready')
  if (backgroundMode) {
    // Фон: вікна немає. Щойно хтось відкрив касу на екрані — коректно закриваємось і віддаємо базу вікну.
    blackBox?.record('background-started')
    clearHandoff(dataRoot)
    setInterval(() => { if (handoffRequested(dataRoot)) { blackBox?.record('background-handoff'); app.quit() } }, 1_000).unref()
    return
  }
  await createWindow()
}).catch((error: unknown) => {
  writeDesktopDiagnostic('startup-failed', error)
  console.error('Forsage desktop startup failed', safeDiagnosticDetails(error))
  if (!backgroundMode) dialog.showErrorBox(
    'Forsage не запустився',
    error instanceof LocalDatabaseOpenError
      ? `${error.message}\n\n${error.databasePath}\n\nПричину записано у локальний журнал помилок.`
      : 'Причину записано у локальний журнал помилок. Дані магазину не видалено.',
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
    if (details.type === 'Utility' && details.serviceName === 'audio.mojom.AudioService') {
      // Sound is optional: stop reopening a failed native service for every scan.
      audioServiceUnavailable = true
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:audio-unavailable')
      blackBox?.record('audio-disabled-for-session')
    }
  }
})

// Фон вікон не має; допоміжні вікна друку, закриваючись, не мають зупиняти базу.
app.on('window-all-closed', () => { if (!backgroundMode) app.quit() })
app.on('before-quit', (event) => {
  if (deferQuitForMainWindow(event, mainWindow)) return
  if (quitAfterCleanup) return
  event.preventDefault()
  if (databaseMaintenance) return
  blackBox?.record('shutdown-start')
  databaseMaintenance = true
  disposePrintWarmShell()
  if (lanOrderTimer) clearInterval(lanOrderTimer)
  lanOrderTimer = null
  if (lanUpdateTimer) clearInterval(lanUpdateTimer)
  lanUpdateTimer = null
  lanUpdateAbort?.abort()
  stopBackupScheduler?.()
  stopBackupScheduler = null
  void (async () => {
    try {
      await localNetwork?.stop()
      // Не закриваємо SQLite під оплатою/фіскальною відповіддю, що ще триває.
      await Promise.allSettled([...activeDesktopCommands])
      await lanUpdateFlight
      await lanOrderQueue?.settle()
      cashalot?.stopWorker()
      tillDeviceLink?.stop(); outboxPusher?.stop()
      await shiftBackups?.stop()
      await externalBackups?.stop()
      await localDatabase?.waitForBackup().catch((error) => writeDesktopDiagnostic('backup-on-quit-failed', error))
      await localDatabase?.waitForBackgroundWrite().catch((error) => writeDesktopDiagnostic('copy-on-quit-failed', error))
      localDatabase?.close()
      if (stagedLanUpdate && localNetwork?.getStatus().mode === 'client'
        && process.env.LOCALAPPDATA && process.env.PORTABLE_EXECUTABLE_FILE) {
        try {
          await launchPortableUpdateAfterQuit({ packaged: app.isPackaged, portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
            localAppData: process.env.LOCALAPPDATA, update: stagedLanUpdate, parentPid: process.pid, quitConfirmed: true })
        } catch (error) { lanUpdateStatus.installError = errorText(error); writeDesktopDiagnostic('lan-update-install-deferred', error) }
      }
    } catch (error) { writeDesktopDiagnostic('database-close-failed', error) }
    finally {
      // Базу відпущено. Закрилось вікно головного ПК — знову запускаємо фон (якщо власник його налаштував),
      // щоб веб і далі працював через цей ПК. Фон дочекається, поки цей процес повністю завершиться.
      if (gotSingleInstanceLock) {
        try {
          if (!backgroundMode && process.platform === 'win32' && localNetwork?.getStatus().mode !== 'client') {
            writeOwner(ownerDataRoot, 'window-closing')
            spawn('schtasks.exe', ['/Run', '/TN', BACKGROUND_TASK], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref()
          } else releaseOwner(ownerDataRoot)
        } catch (error) { writeDesktopDiagnostic('background-restart-failed', error) }
      }
      quitAfterCleanup = true
      await blackBox?.close()
      app.quit()
    }
  })()
})
