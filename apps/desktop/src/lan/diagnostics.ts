import { execFile } from 'node:child_process'
import { LAN_DISCOVERY_PORT } from './discovery'

/**
 * Пояснення «чому два ПК не бачать один одного» людською мовою.
 *
 * Скарга власника: підключення другого ПК не вдавалося тижнями, а програма
 * казала лише «не знайдено». Причин було три одночасно — вимкнений режим
 * головного ПК, брандмауер Windows і різні версії — і жодну не було названо.
 * Тут немає жодної зміни даних магазину: лише читання стану та один явний
 * запит до Windows (з підтвердженням UAC) на правило брандмауера.
 */

export type LanCheckState = 'ok' | 'problem' | 'unknown'
export type LanCheckId = 'mode' | 'staff' | 'listening' | 'discovery' | 'address' | 'firewall' | 'connection'
export interface LanCheck { id: LanCheckId; state: LanCheckState; title: string; detail: string }
export interface LanDiagnosis {
  mode: 'standalone' | 'hub' | 'client'
  ready: boolean
  checks: LanCheck[]
  /** Команда для адміністратора Windows, якщо кнопка недоступна. Порожня поза головним ПК. */
  firewallCommand: string
  canAllowFirewall: boolean
}

export interface LanDiagnosisInput {
  mode: 'standalone' | 'hub' | 'client'
  port: number
  allowedUserId: string
  addresses: string[]
  running: boolean
  discovery: boolean
  connected: boolean
  lastError: string | null
}

export interface FirewallState {
  /** null — Windows не відповіла або це не Windows. */
  tcpAllowed: boolean | null
  udpAllowed: boolean | null
  /** Категорії активних мереж: Public / Private / DomainAuthenticated. */
  networks: string[]
  /**
   * 23.11.2026: Windows має правило «Блокувати» саме для цієї програми (натиснули «Скасувати» у вікні
   * «Дозволити доступ до мережі»). Заборона сильніша за будь-який дозвіл — ПК менеджера не підключиться.
   */
  blocked?: boolean
}

export const FIREWALL_RULE_TCP = 'Forsage LAN TCP'
export const FIREWALL_RULE_UDP = 'Forsage LAN UDP'

function safePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Некоректний порт локальної мережі')
  return port
}

/**
 * Правило за портом, а не за шляхом програми: portable-EXE після кожного
 * оновлення розпаковується в іншу теку, і дозвіл «для програми» мовчки
 * перестає діяти. Доступ лише з локальної підмережі — не з інтернету.
 */
export function firewallRuleScript(port: number, programPath = ''): string {
  const tcp = safePort(port)
  // Заборона «для програми» перекриває дозвіл за портом, тому спершу прибираємо її (лише для цієї програми).
  const program = programPath.replace(/'/g, "''")
  const unblock = program
    ? `Get-NetFirewallApplicationFilter -Program '${program}' -ErrorAction SilentlyContinue | Get-NetFirewallRule | `
      + `Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue; `
    : ''
  const rule = (name: string, protocol: 'TCP' | 'UDP', localPort: number) =>
    `Remove-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue; `
    + `New-NetFirewallRule -DisplayName '${name}' -Direction Inbound -Action Allow -Protocol ${protocol} `
    + `-LocalPort ${localPort} -RemoteAddress LocalSubnet -Profile Any | Out-Null`
  return `${unblock}${rule(FIREWALL_RULE_TCP, 'TCP', tcp)}; ${rule(FIREWALL_RULE_UDP, 'UDP', LAN_DISCOVERY_PORT)}`
}

/** Читає лише факт наявності дозволу. Нічого не змінює й не потребує прав адміністратора. */
export function firewallQueryScript(port: number, programPath: string): string {
  const tcp = safePort(port)
  const program = programPath.replace(/'/g, "''")
  return [
    `$ErrorActionPreference='SilentlyContinue'`,
    `function Allowed($protocol,$localPort){`,
    `  $rules = Get-NetFirewallPortFilter -Protocol $protocol | Where-Object { $_.LocalPort -contains "$localPort" -or $_.LocalPort -eq "$localPort" } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' }`,
    `  return [bool]$rules`,
    `}`,
    `$app = [bool](Get-NetFirewallApplicationFilter -Program '${program}' | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' })`,
    `$blocked = [bool](Get-NetFirewallApplicationFilter -Program '${program}' | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' })`,
    `$result = @{ blocked = $blocked; tcp = ((-not $blocked) -and ($app -or (Allowed 'TCP' ${tcp}))); udp = ((-not $blocked) -and ($app -or (Allowed 'UDP' ${LAN_DISCOVERY_PORT}))); networks = @(Get-NetConnectionProfile | ForEach-Object { "$($_.NetworkCategory)" }) }`,
    `$result | ConvertTo-Json -Compress`,
  ].join('\n')
}

export function parseFirewallState(output: string): FirewallState {
  try {
    const parsed = JSON.parse(output.trim()) as { tcp?: unknown; udp?: unknown; networks?: unknown; blocked?: unknown }
    const networks = Array.isArray(parsed.networks) ? parsed.networks.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : typeof parsed.networks === 'string' ? [parsed.networks] : []
    return {
      tcpAllowed: typeof parsed.tcp === 'boolean' ? parsed.tcp : null,
      udpAllowed: typeof parsed.udp === 'boolean' ? parsed.udp : null,
      networks,
      ...(parsed.blocked === true ? { blocked: true } : {}),
    }
  } catch {
    return { tcpAllowed: null, udpAllowed: null, networks: [] }
  }
}

const UNKNOWN_FIREWALL: FirewallState = { tcpAllowed: null, udpAllowed: null, networks: [] }

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: 'utf8' },
      (error, stdout) => { if (error) reject(error); else resolve(String(stdout)) })
  })
}

export async function readFirewallState(port: number, programPath: string): Promise<FirewallState> {
  if (process.platform !== 'win32') return UNKNOWN_FIREWALL
  try { return parseFirewallState(await runPowerShell(firewallQueryScript(port, programPath), 25_000)) }
  catch { return UNKNOWN_FIREWALL }
}

/**
 * Просить Windows додати правило. Сама програма прав не має: Windows показує
 * власне вікно підтвердження (UAC), і без «Так» нічого не змінюється.
 */
export async function requestFirewallRule(port: number, programPath = ''): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Налаштування брандмауера доступне лише у Windows')
  const inner = Buffer.from(firewallRuleScript(port, programPath), 'utf16le').toString('base64')
  const outer = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
    + `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'; exit $p.ExitCode`
  try { await runPowerShell(outer, 120_000) }
  catch { throw new Error('Windows не підтвердила зміну брандмауера. Правило не додано.') }
}

function firewallCheck(firewall: FirewallState, port: number): LanCheck {
  const publicNetwork = firewall.networks.some(name => name === 'Public')
  if (firewall.tcpAllowed === null) {
    return { id: 'firewall', state: 'unknown', title: 'Брандмауер Windows',
      detail: `Не вдалося прочитати правила Windows. Якщо другий ПК не підключається, дозвольте вхідні TCP ${port} і UDP ${LAN_DISCOVERY_PORT}.` }
  }
  if (firewall.blocked) {
    return { id: 'firewall', state: 'problem', title: 'Windows заборонила Форсажу мережу',
      detail: 'У брандмауері Windows є правило «Блокувати» саме для цієї програми (так буває, якщо у вікні Windows «Дозволити доступ» натиснули «Скасувати»). '
        + 'Через нього другий ПК не підключиться. Натисніть «Дозволити в брандмауері» і підтвердьте запит Windows — заборону буде прибрано.' }
  }
  if (!firewall.tcpAllowed) {
    return { id: 'firewall', state: 'problem', title: 'Брандмауер Windows блокує підключення',
      detail: `Дозволу на вхідні підключення до порту ${port} не знайдено${publicNetwork ? '; мережа позначена як загальнодоступна, тому Windows закриває її суворіше' : ''}. `
        + 'Натисніть «Дозволити в брандмауері» і підтвердьте запит Windows.' }
  }
  if (firewall.udpAllowed === false) {
    return { id: 'firewall', state: 'problem', title: 'Брандмауер блокує автопошук',
      detail: `Підключення за адресою працюватиме, але другий ПК не знайде цей автоматично: UDP ${LAN_DISCOVERY_PORT} не дозволено.` }
  }
  return { id: 'firewall', state: 'ok', title: 'Брандмауер Windows дозволяє підключення', detail: `Вхідні TCP ${port} і UDP ${LAN_DISCOVERY_PORT} дозволено.` }
}

export function buildLanDiagnosis(status: LanDiagnosisInput, firewall: FirewallState = UNKNOWN_FIREWALL, programPath = ''): LanDiagnosis {
  const checks: LanCheck[] = []
  if (status.mode === 'standalone') {
    checks.push({ id: 'mode', state: 'problem', title: 'Цей ПК не ввімкнено як головний',
      detail: 'Зараз режим «Окремий компʼютер»: інші ПК його не бачать. Виберіть «Головний ПК каси», працівника і натисніть «Зберегти мережу».' })
    return { mode: status.mode, ready: false, checks, firewallCommand: '', canAllowFirewall: false }
  }
  if (status.mode === 'client') {
    checks.push(status.connected
      ? { id: 'connection', state: 'ok', title: 'Є звʼязок із головним ПК', detail: 'Цей ПК працює з базою головного ПК.' }
      : { id: 'connection', state: 'problem', title: 'Немає звʼязку з головним ПК', detail: status.lastError || 'Головний ПК не відповідає.' })
    return { mode: status.mode, ready: status.connected, checks, firewallCommand: '', canAllowFirewall: false }
  }
  checks.push({ id: 'mode', state: 'ok', title: 'Режим «Головний ПК каси» ввімкнено', detail: 'Цей ПК зберігає базу магазину.' })
  checks.push(status.allowedUserId
    ? { id: 'staff', state: 'ok', title: 'Працівника для другого ПК вибрано', detail: 'Увійти з другого ПК зможе лише він.' }
    : { id: 'staff', state: 'problem', title: 'Не вибрано працівника для другого ПК', detail: 'Виберіть менеджера і збережіть налаштування.' })
  checks.push(status.running
    ? { id: 'listening', state: 'ok', title: `Програма приймає підключення на порту ${status.port}`, detail: 'Головний ПК запущено для мережі.' }
    : { id: 'listening', state: 'problem', title: `Порт ${status.port} не відкрито`,
      detail: status.lastError ? `Причина: ${status.lastError}` : 'Порт може бути зайнятий іншою програмою. Змініть порт або перезапустіть Форсаж.' })
  checks.push(status.addresses.length
    ? { id: 'address', state: 'ok', title: 'Цей ПК підключено до мережі', detail: `Адреса для другого ПК: ${status.addresses.map(address => `${address}:${status.port}`).join(', ')}` }
    : { id: 'address', state: 'problem', title: 'Цей ПК не підключено до локальної мережі', detail: 'Перевірте кабель або Wi-Fi: мережевої адреси немає.' })
  checks.push(status.discovery
    ? { id: 'discovery', state: 'ok', title: 'Автопошук увімкнено', detail: 'Другий ПК знайде цей без введення адреси.' }
    : { id: 'discovery', state: status.running ? 'unknown' : 'problem', title: 'Автопошук недоступний',
      detail: 'Другий ПК можна підключити вручну за адресою вище.' })
  checks.push(firewallCheck(firewall, status.port))
  const ready = checks.every(check => check.state !== 'problem')
  return { mode: status.mode, ready, checks, firewallCommand: firewallRuleScript(status.port, programPath), canAllowFirewall: process.platform === 'win32' }
}

/** Причина обриву на ПК менеджера: що саме зробити, а не просто «немає звʼязку». */
export function describeLanConnectFailure(error: unknown, timedOut: boolean): string {
  const codes = new Set<string>()
  for (let cause: unknown = error, depth = 0; cause && depth < 4; depth++) {
    const record = cause as { code?: unknown; cause?: unknown }
    if (typeof record.code === 'string') codes.add(record.code)
    cause = record.cause
  }
  if (codes.has('ECONNREFUSED')) {
    return 'Немає зв’язку з головним ПК: компʼютер знайдено, але Форсаж на ньому закрито або режим «Головний ПК каси» не ввімкнено.'
  }
  if (codes.has('EHOSTUNREACH') || codes.has('ENETUNREACH') || codes.has('EADDRNOTAVAIL')) {
    return 'Немає зв’язку з головним ПК: адреса недосяжна. Перевірте, що обидва ПК в одній мережі, а адреса збігається з показаною на головному ПК.'
  }
  if (timedOut || codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT')) {
    return 'Немає зв’язку з головним ПК: він не відповідає. Найчастіше це брандмауер Windows на головному ПК — відкрийте там '
      + '«Налаштування» → локальна мережа → «Перевірити готовність». Інші причини: ПК вимкнено або хибна адреса.'
  }
  return 'Немає зв’язку з головним ПК'
}
