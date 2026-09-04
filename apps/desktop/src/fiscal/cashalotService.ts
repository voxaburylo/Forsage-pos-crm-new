import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { detectCashalotDir, hasCashalotDll, resolveCashalotDir } from './cashalotPaths'

// Інтеграція з ПРРО Cashalot через COM API (AddIn.CashaLotApi).
// COM недоступний із Node напряму, тому тримаємо довгоживучий PowerShell-процес,
// який створює COM-об'єкт один раз і виконує команди; обмін — base64(JSON)
// рядками через stdin/stdout, щоб кирилиця не залежала від кодування консолі.

export interface CashalotConfig {
  enabled: boolean
  cashalotDir: string
  fiscalNumberRRO: string
  certificateDir: string | null
  /** Пароль файлового ключа, зашифрований DPAPI (safeStorage), base64. */
  encryptedKeyPassword: string | null
}

export interface CashalotPublicConfig {
  enabled: boolean
  cashalotDir: string
  fiscalNumberRRO: string
  certificateDir: string | null
  hasPassword: boolean
  comRegistered: boolean
  /** Чи лежить CashalotApi64.dll у вказаній папці — інакше фіскалізація не піде. */
  dllFound: boolean
}

export interface CashalotConfigUpdate {
  enabled?: boolean
  cashalotDir?: string
  fiscalNumberRRO?: string
  certificateDir?: string | null
  /** undefined — не міняти; '' або null — стерти; рядок — новий пароль. */
  keyPassword?: string | null
}

export interface CashalotRetVal {
  Return?: boolean
  Description?: string
  JsonVal?: string
  ReceiptFiscalNum?: string
  ReceiptLocalNum?: string
  ShiftID?: string
  OfflineMode?: boolean
  FSKOReceiptLink?: string
  CashalotReceiptLink?: string
  Type?: number
  Value?: unknown
}

export interface FiscalCheckItemInput {
  name: string
  vendor_code: string
  barcode?: string | null
  unit?: string | null
  qty: number
  /** Ціна за одиницю в копійках. */
  unit_price: number
  /** Кінцева сума позиції в копійках (з урахуванням знижки). */
  amount: number
  /** Знижка на позицію в копійках. */
  discount?: number
  is_service?: boolean
}

export interface FiscalCheckPayInput {
  /** Отримана готівка, копійки. */
  cash: number
  /** Оплата карткою, копійки. */
  card: number
  /** Безготівковий переказ, копійки. */
  bank?: number
  /** Сума чека до сплати, копійки. */
  check_total: number
  auth_code?: string | null
  rrn?: string | null
  customer_email?: string | null
}

interface WorkerRequest {
  id: string
  method: 'init' | 'call'
  comMethod?: string
  args?: unknown[]
  config: {
    cashalotDir: string
    fiscalNumberRRO: string
    certificateDir: string | null
    keyPassword: string | null
  }
}

interface WorkerResponse {
  id: string
  ok: boolean
  error?: string
  result?: CashalotRetVal
}

const WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:app = $null

function Set-Param($app, $name, $value) {
  # Повернення SetParameter (bool) НЕ повинно потрапити у stdout — інакше
  # засмітить base64-протокол. Тому явно поглинаємо результат.
  [void]$app.SetParameter([string]$name, [string]$value)
}

function Ensure-App($cfg) {
  if ($null -ne $script:app) { return }
  $app = New-Object -ComObject 'AddIn.CashaLotApi'
  Set-Param $app 'PathToCashalotDir' $cfg.cashalotDir
  Set-Param $app 'DeviceIDFnRRO' $cfg.fiscalNumberRRO
  if ($cfg.certificateDir) {
    Set-Param $app 'NOINTERFACEMODE' 'True'
    Set-Param $app 'PathToCertificate' $cfg.certificateDir
    Set-Param $app 'PwdToCertificate' $cfg.keyPassword
    Set-Param $app 'USETOKEN' 'False'
  } else {
    # Без ключа в налаштуваннях авторизацію робить діалог самого Кашалота.
    Set-Param $app 'NOINTERFACEMODE' 'False'
  }
  Set-Param $app 'NOAUTOUPDATE' 'True'
  Set-Param $app 'NOAUTOOPENSHIFT' 'False'
  Set-Param $app 'AUTOPRINTMODE' 'False'
  Set-Param $app 'NOPRINTMODE' 'True'
  $script:app = $app
}

function Convert-RetVal($r) {
  if ($null -eq $r) { return $null }
  if ($r -is [string] -or $r -is [bool] -or $r -is [int] -or $r -is [double]) {
    return @{ Value = $r }
  }
  $out = @{}
  foreach ($name in @('Return','Description','JsonVal','ReceiptFiscalNum','ReceiptLocalNum','ShiftID','OfflineMode','FSKOReceiptLink','CashalotReceiptLink','Type')) {
    try { $out[$name] = $r.$name } catch {}
  }
  return $out
}

function Invoke-Com($app, $name, $a) {
  # Нативний PowerShell-диспатч COM (IDispatch). Reflection InvokeMember на
  # цьому RCW зависає, тому викликаємо метод напряму за динамічним іменем.
  switch (@($a).Count) {
    0 { return $app.$name() }
    1 { return $app.$name($a[0]) }
    2 { return $app.$name($a[0], $a[1]) }
    3 { return $app.$name($a[0], $a[1], $a[2]) }
    4 { return $app.$name($a[0], $a[1], $a[2], $a[3]) }
    default { throw "TOO_MANY_ARGS" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $resp = @{ id = ''; ok = $false }
  try {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $req = $json | ConvertFrom-Json
    $resp.id = $req.id
    Ensure-App $req.config
    if ($req.method -eq 'init') {
      $resp.ok = $true
      $resp.result = @{ Value = $script:app.GetVersion() }
    } else {
      $invokeArgs = @()
      if ($null -ne $req.args) { $invokeArgs = @($req.args | ForEach-Object { [string]$_ }) }
      $r = Invoke-Com $script:app ([string]$req.comMethod) $invokeArgs
      $resp.ok = $true
      $resp.result = Convert-RetVal $r
    }
  } catch {
    $resp.ok = $false
    $resp.error = $_.Exception.Message
  }
  $respJson = ConvertTo-Json $resp -Compress -Depth 8
  $respB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($respJson))
  [Console]::Out.WriteLine($respB64)
}
`

const CALL_TIMEOUT_MS = 180_000

function kopecksToDecimal(kopecks: number): string {
  return (Math.round(kopecks) / 100).toFixed(2)
}

export class CashalotService {
  private readonly configPath: string
  private readonly workerScriptPath: string
  private config: CashalotConfig
  private worker: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private pending = new Map<string, { resolve: (r: WorkerResponse) => void; timer: NodeJS.Timeout }>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dataRoot: string) {
    this.configPath = path.join(dataRoot, 'fiscal.json')
    this.workerScriptPath = path.join(dataRoot, 'cashalot-worker.ps1')
    this.config = this.loadConfig()
    this.healCashalotDir()
  }

  /**
   * Стара версія зберігала в fiscal.json шлях із профілю розробника. На касі
   * такої папки нема, тож фіскалізація падала на «файл не знайдено». Підміняємо
   * її на знайдену автоматично — мовчки, без дій касира.
   */
  private healCashalotDir(): void {
    const healed = resolveCashalotDir(this.config.cashalotDir)
    if (healed === this.config.cashalotDir) return
    this.config.cashalotDir = healed
    try {
      this.saveConfig()
    } catch {
      // Не змогли записати — працюємо з виправленим шляхом у памʼяті.
    }
  }

  private loadConfig(): CashalotConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      return {
        enabled: raw.enabled === true,
        cashalotDir: resolveCashalotDir(typeof raw.cashalotDir === 'string' ? raw.cashalotDir : null),
        fiscalNumberRRO: typeof raw.fiscalNumberRRO === 'string' ? raw.fiscalNumberRRO : '',
        certificateDir: typeof raw.certificateDir === 'string' && raw.certificateDir ? raw.certificateDir : null,
        encryptedKeyPassword: typeof raw.encryptedKeyPassword === 'string' ? raw.encryptedKeyPassword : null,
      }
    } catch {
      return {
        enabled: false,
        cashalotDir: detectCashalotDir(),
        fiscalNumberRRO: '',
        certificateDir: null,
        encryptedKeyPassword: null,
      }
    }
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8')
  }

  private isComRegistered(): boolean {
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    // COM резолвить ProgId спершу з HKCU\Software\Classes, потім із HKLM,
    // тому per-user реєстрація (без адмінправ) теж робоча — перевіряємо обидва.
    for (const root of ['HKCU\\Software\\Classes', 'HKLM\\SOFTWARE\\Classes']) {
      try {
        execSync(`reg query "${root}\\AddIn.CashaLotApi" /ve`, { stdio: 'ignore', windowsHide: true })
        return true
      } catch {
        // не знайдено в цьому корені — пробуємо наступний
      }
    }
    return false
  }

  getPublicConfig(): CashalotPublicConfig {
    return {
      enabled: this.config.enabled,
      cashalotDir: this.config.cashalotDir,
      fiscalNumberRRO: this.config.fiscalNumberRRO,
      certificateDir: this.config.certificateDir,
      hasPassword: this.config.encryptedKeyPassword !== null,
      comRegistered: this.isComRegistered(),
      dllFound: hasCashalotDll(this.config.cashalotDir),
    }
  }

  updateConfig(update: CashalotConfigUpdate): CashalotPublicConfig {
    if (update.enabled !== undefined) this.config.enabled = update.enabled === true
    if (update.cashalotDir !== undefined) this.config.cashalotDir = String(update.cashalotDir || detectCashalotDir())
    if (update.fiscalNumberRRO !== undefined) this.config.fiscalNumberRRO = String(update.fiscalNumberRRO || '').trim()
    if (update.certificateDir !== undefined) {
      this.config.certificateDir = update.certificateDir ? String(update.certificateDir) : null
    }
    if (update.keyPassword !== undefined) {
      if (!update.keyPassword) {
        this.config.encryptedKeyPassword = null
      } else if (safeStorage.isEncryptionAvailable()) {
        this.config.encryptedKeyPassword = safeStorage.encryptString(String(update.keyPassword)).toString('base64')
      } else {
        throw new Error('FISCAL_ENCRYPTION_UNAVAILABLE')
      }
    }
    this.saveConfig()
    // Перезапускаємо воркер, щоб нові параметри застосувались до COM-об'єкта.
    this.stopWorker()
    return this.getPublicConfig()
  }

  isEnabled(): boolean {
    return this.config.enabled && this.config.fiscalNumberRRO.length > 0
  }

  private decryptPassword(): string | null {
    if (!this.config.encryptedKeyPassword) return null
    if (!safeStorage.isEncryptionAvailable()) throw new Error('FISCAL_ENCRYPTION_UNAVAILABLE')
    return safeStorage.decryptString(Buffer.from(this.config.encryptedKeyPassword, 'base64'))
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker && this.worker.exitCode === null) return this.worker

    fs.writeFileSync(this.workerScriptPath, WORKER_SCRIPT, 'utf8')
    const worker = spawn('powershell.exe', [
      '-NoProfile', '-NoLogo', '-NonInteractive', '-Sta',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.workerScriptPath,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    worker.stdout.setEncoding('utf8')
    worker.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk
      let newlineIndex = this.stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
        if (line) this.handleWorkerLine(line)
        newlineIndex = this.stdoutBuffer.indexOf('\n')
      }
    })
    worker.on('exit', () => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.resolve({ id: '', ok: false, error: 'FISCAL_WORKER_EXITED' })
      }
      this.pending.clear()
      if (this.worker === worker) this.worker = null
    })

    this.worker = worker
    this.stdoutBuffer = ''
    return worker
  }

  private handleWorkerLine(line: string): void {
    let response: WorkerResponse
    try {
      response = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
    } catch {
      return
    }
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    clearTimeout(entry.timer)
    entry.resolve(response)
  }

  private sendRequest(request: WorkerRequest): Promise<WorkerResponse> {
    const worker = this.ensureWorker()
    return new Promise<WorkerResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        resolve({ id: request.id, ok: false, error: 'FISCAL_CALL_TIMEOUT' })
      }, CALL_TIMEOUT_MS)
      this.pending.set(request.id, { resolve, timer })
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
      worker.stdin.write(encoded + '\n')
    })
  }

  /**
   * Викликає COM-метод; черга гарантує послідовність (ПРРО не любить паралельність).
   * throwOnReject=false — повернути результат навіть при Return=false (для read-only
   * методів на кшталт GetCurrentStatus, де Return=false = «зміна не відкрита», не помилка).
   */
  private call(comMethod: string, args: string[], throwOnReject = true): Promise<CashalotRetVal> {
    const run = async (): Promise<CashalotRetVal> => {
      if (!this.config.fiscalNumberRRO) throw new Error('FISCAL_RRO_NOT_CONFIGURED')
      const response = await this.sendRequest({
        id: randomUUID(),
        method: 'call',
        comMethod,
        args,
        config: {
          cashalotDir: this.config.cashalotDir,
          fiscalNumberRRO: this.config.fiscalNumberRRO,
          certificateDir: this.config.certificateDir,
          keyPassword: this.decryptPassword(),
        },
      })
      if (!response.ok) throw new Error(response.error || 'FISCAL_CALL_FAILED')
      const result = response.result ?? {}
      if (throwOnReject && result.Return === false) {
        throw new Error(result.Description || 'FISCAL_OPERATION_REJECTED')
      }
      return result
    }
    const chained = this.queue.then(run, run)
    this.queue = chained.catch(() => {})
    return chained
  }

  getStatus(): Promise<CashalotRetVal> {
    return this.call('GetCurrentStatus', [this.config.fiscalNumberRRO], false)
  }

  openShift(): Promise<CashalotRetVal> {
    return this.call('OpenShift', [this.config.fiscalNumberRRO])
  }

  /** Закриває зміну ПРРО з реєстрацією Z-звіту. */
  closeShift(): Promise<CashalotRetVal> {
    return this.call('CloseShift', [this.config.fiscalNumberRRO])
  }

  xReport(): Promise<CashalotRetVal> {
    return this.call('GetXReport', [this.config.fiscalNumberRRO, 'False'])
  }

  serviceCash(amountKopecks: number, direction: 'in' | 'out'): Promise<CashalotRetVal> {
    const method = direction === 'in' ? 'ServiceInputEx' : 'ServiceOutputEx'
    return this.call(method, [this.config.fiscalNumberRRO, kopecksToDecimal(amountKopecks)])
  }

  private buildGoodsJson(items: FiscalCheckItemInput[], comment?: string | null): string {
    if (!items.length) throw new Error('FISCAL_CHECK_EMPTY')
    return JSON.stringify({
      ReceiptLst: items.map((item) => ({
        VendorCode: String(item.vendor_code || item.name).slice(0, 64),
        Name: String(item.name).slice(0, 256),
        GoodsType: item.is_service ? '2' : '1',
        Barcode: item.barcode ? String(item.barcode) : '',
        UnitType: item.unit || 'шт',
        Quantity: String(item.qty),
        Price: kopecksToDecimal(item.unit_price),
        Amount: kopecksToDecimal(item.amount),
        ...(item.discount && item.discount > 0
          ? { DiscountSum: kopecksToDecimal(item.discount) }
          : {}),
        IsExcise: false,
        OtherParametrs: null,
      })),
      ...(comment ? { Comment: String(comment).slice(0, 512) } : {}),
    })
  }

  private buildPayJson(pay: FiscalCheckPayInput): string {
    const payload: Record<string, unknown> = {
      SumCash: pay.cash > 0 ? kopecksToDecimal(pay.cash) : null,
      SumPayByCard: pay.card > 0 ? kopecksToDecimal(pay.card) : null,
      SumPayByBank: pay.bank && pay.bank > 0 ? kopecksToDecimal(pay.bank) : null,
      SumPayCheck: kopecksToDecimal(pay.check_total),
    }
    if (pay.bank && pay.bank > 0) payload.BankPayToolsNM = 'Переказ з картки'
    if (pay.auth_code) payload.ApprovalCode = pay.auth_code
    if (pay.rrn) payload.RRN = pay.rrn
    if (pay.customer_email) payload.CustomerEmail = pay.customer_email
    return JSON.stringify(payload)
  }

  fiscalizeCheck(items: FiscalCheckItemInput[], pay: FiscalCheckPayInput, comment?: string | null): Promise<CashalotRetVal> {
    return this.call('FiscalizeCheck', [
      this.config.fiscalNumberRRO,
      this.buildGoodsJson(items, comment),
      this.buildPayJson(pay),
    ])
  }

  fiscalizeReturnCheck(
    items: FiscalCheckItemInput[],
    pay: FiscalCheckPayInput,
    originalFiscalNumber: string,
  ): Promise<CashalotRetVal> {
    return this.call('FiscalizeReturnCheck', [
      this.config.fiscalNumberRRO,
      this.buildGoodsJson(items),
      this.buildPayJson(pay),
      String(originalFiscalNumber),
    ])
  }

  /**
   * Реєструє CashalotApi64.dll для поточного користувача (HKCU\Software\Classes)
   * без адмінправ/UAC: тимчасово підміняє HKEY_CLASSES_ROOT на HKCU і викликає
   * нативний DllRegisterServer збірки.
   */
  registerCom(): Promise<{ registered: boolean }> {
    const dllPath = path.join(this.config.cashalotDir, 'CashalotApi64.dll')
    if (!fs.existsSync(dllPath)) return Promise.reject(new Error('FISCAL_DLL_NOT_FOUND: ' + dllPath))

    const script = `
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class PerUserComReg {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegCreateKeyEx(IntPtr hKey, string lpSubKey, int Reserved, string lpClass, int dwOptions, int samDesired, IntPtr lpSecurityAttributes, out IntPtr phkResult, out int lpdwDisposition);
  [DllImport("advapi32.dll")] static extern int RegOverridePredefKey(IntPtr hKey, IntPtr hNewKey);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr hKey);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibrary(string p);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr GetProcAddress(IntPtr h, string n);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int RegFn();
  static readonly IntPtr HKCR = new IntPtr(unchecked((int)0x80000000));
  static readonly IntPtr HKCU = new IntPtr(unchecked((int)0x80000001));
  public static int Register(string dll) {
    IntPtr lib = LoadLibrary(dll); if (lib == IntPtr.Zero) throw new Exception("LoadLibrary " + Marshal.GetLastWin32Error());
    IntPtr proc = GetProcAddress(lib, "DllRegisterServer"); if (proc == IntPtr.Zero) throw new Exception("no DllRegisterServer");
    IntPtr hKey; int disp;
    int r = RegCreateKeyEx(HKCU, "Software\\\\Classes", 0, null, 0, 0xF003F, IntPtr.Zero, out hKey, out disp);
    if (r != 0) throw new Exception("RegCreateKeyEx " + r);
    r = RegOverridePredefKey(HKCR, hKey); if (r != 0) { RegCloseKey(hKey); throw new Exception("RegOverridePredefKey " + r); }
    try { RegFn fn = (RegFn)Marshal.GetDelegateForFunctionPointer(proc, typeof(RegFn)); return fn(); }
    finally { RegOverridePredefKey(HKCR, IntPtr.Zero); RegCloseKey(hKey); }
  }
}
"@
Add-Type -TypeDefinition $src
[void][PerUserComReg]::Register('${dllPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}')
`
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { windowsHide: true })
      let stderr = ''
      ps.stderr.on('data', (chunk) => { stderr += chunk })
      ps.on('exit', (code) => {
        const registered = this.isComRegistered()
        if (registered) resolve({ registered: true })
        else reject(new Error('FISCAL_COM_REGISTER_FAILED' + (stderr ? ': ' + stderr.trim().slice(0, 300) : ` (exit ${code})`)))
      })
      ps.on('error', reject)
    })
  }

  stopWorker(): void {
    if (!this.worker) return
    try {
      this.worker.stdin.end()
      this.worker.kill()
    } catch {
      // процес уже міг завершитись
    }
    this.worker = null
  }
}
