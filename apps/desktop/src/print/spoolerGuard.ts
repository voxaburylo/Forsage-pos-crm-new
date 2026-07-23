import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

// Охорона черги друку Windows.
//
// Навіщо: коли термопринтер моргає по USB (просадка живлення, кабель, USB3-порт),
// його завдання лишається у спулері назавжди в стані `Printing, Retained`, а
// Windows нікому про це не повідомляє. Наслідок — усі наступні друки мовчки
// стають у чергу за трупом, і станція «просто не друкує». Гірше того, Electron
// повертає success, щойно спулер прийняв байти, тож каса рапортує успіх.
//
// Тому кожен друк обгортаємо з двох боків: перед відправкою чистимо чергу і
// перевіряємо готовність принтера, після — переконуємось, що завдання реально
// пішло. Кожен принтер перевіряється ОКРЕМО за іменем: чековий і етикетковий
// не мають впливати один на одного.

/** Статуси, за яких завдання нікуди не поїде і лише блокує чергу. */
const STUCK_JOB_PATTERN = 'Error|Blocked|Offline|PaperOut|UserIntervention'
/**
 * Статуси «нібито в роботі». Найпідступніший випадок зависання виглядає саме
 * так — `Printing, Retained` БЕЗ жодної помилки, PagesPrinted=0, і воно висить
 * годинами. Тому для них додатково дивимось на вік і прогрес.
 */
const IN_FLIGHT_JOB_PATTERN = 'Printing|Retained|Deleting|Spooling'
/** Скільки секунд завдання може висіти без жодної надрукованої сторінки. */
const STALE_JOB_SECONDS = 90
/** Статуси принтера, за яких немає сенсу відправляти. */
const NOT_READY_PATTERN = 'Error|Offline|PaperOut|PaperProblem|NotAvailable|Unavailable'

export const SPOOLER_ERRORS = {
  queueStuck: 'PRINT_QUEUE_STUCK',
  notReady: 'PRINT_PRINTER_NOT_READY',
  notConfirmed: 'PRINT_NOT_CONFIRMED',
} as const

/** Чи це відмова саме охорони черги (а не звичайна помилка налаштувань друку). */
export function isSpoolerGuardError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return Object.values(SPOOLER_ERRORS).some((code) => message.includes(code))
}

const PREFLIGHT_SCRIPT = String.raw`
param([string]$PrinterName)
$ErrorActionPreference = 'Stop'
$stuckPattern = '${STUCK_JOB_PATTERN}'
$inFlightPattern = '${IN_FLIGHT_JOB_PATTERN}'
$staleSeconds = ${STALE_JOB_SECONDS}

function Get-StuckJobs {
  $now = Get-Date
  @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue | Where-Object {
    $_.JobStatus -match $stuckPattern -or (
      $_.JobStatus -match $inFlightPattern -and
      $_.PagesPrinted -eq 0 -and
      $_.SubmittedTime -and
      ($now - $_.SubmittedTime).TotalSeconds -gt $staleSeconds
    )
  })
}

try {
  # @() обов'язкове: Windows PowerShell 5.1 розгортає одноелементний масив при
  # поверненні з функції, і тоді .Count дає $null — саме випадок «залип рівно
  # один job», тобто найчастіший. Без обгортки перевірка мовчки пропускала його.
  $stuck = @(Get-StuckJobs)
  if ($stuck.Count -gt 0) {
    $stuck | Remove-PrintJob -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1500
    if (@(Get-StuckJobs).Count -gt 0) { throw '${SPOOLER_ERRORS.queueStuck}' }
  }
  $printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
  if ($printer -and ($printer.PrinterStatus -match '${NOT_READY_PATTERN}')) {
    throw "${SPOOLER_ERRORS.notReady}: $($printer.PrinterStatus)"
  }
} catch [System.Management.Automation.CommandNotFoundException] {
  # Немає модуля PrintManagement — друкуємо без перевірки.
}
[Console]::Out.Write('PREFLIGHT_OK')
`

const POSTFLIGHT_SCRIPT = String.raw`
param([string]$PrinterName, [int]$TimeoutSeconds = 20)
$ErrorActionPreference = 'Stop'
$stuckPattern = '${STUCK_JOB_PATTERN}'

# Чекаємо, поки завдання піде з черги. Порожня черга = надруковано.
# Статус помилки = ні. Якщо воно й далі друкується і сторінки РЕАЛЬНО йдуть
# (довга партія) — виходимо з успіхом, щоб не блокувати касу. А от завдання,
# яке за весь час не надрукувало жодної сторінки, — це і є класичне зависання
# «Printing, Retained», і мовчки видавати його за успіх не можна.
try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $failure = $null
  $drained = $false
  while ((Get-Date) -lt $deadline) {
    $jobs = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue)
    if ($jobs.Count -eq 0) { $drained = $true; break }
    $bad = @($jobs | Where-Object { $_.JobStatus -match $stuckPattern })
    if ($bad.Count -gt 0) { $failure = $bad[0].JobStatus; break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $drained -and -not $failure) {
    $left = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue)
    $printing = @($left | Where-Object { $_.PagesPrinted -gt 0 })
    if ($left.Count -gt 0 -and $printing.Count -eq 0) { $failure = 'No pages printed' }
  }
  if ($failure) {
    Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue |
      Where-Object { $_.JobStatus -match $stuckPattern } |
      Remove-PrintJob -Confirm:$false -ErrorAction SilentlyContinue
    throw "${SPOOLER_ERRORS.notConfirmed}: $failure"
  }
} catch [System.Management.Automation.CommandNotFoundException] {
  # Немає модуля PrintManagement — покладаємось на результат друку.
}
[Console]::Out.Write('POSTFLIGHT_OK')
`

function runGuardScript(
  fileName: string,
  script: string,
  printerName: string,
  extraArgs: string[],
  timeoutMs: number,
  okMarker: string,
): Promise<void> {
  const scriptPath = path.join(app.getPath('userData'), fileName)
  fs.writeFileSync(scriptPath, script, 'utf8')

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NoLogo', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-PrinterName', printerName,
      ...extraArgs,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    ps.stdout.on('data', (chunk) => { stdout += String(chunk) })
    ps.stderr.on('data', (chunk) => { stderr += String(chunk) })
    // Сам PowerShell не запустився — не привід валити друк.
    ps.on('error', () => resolve())

    const timeout = setTimeout(() => { ps.kill(); resolve() }, timeoutMs)

    ps.on('close', (exitCode) => {
      clearTimeout(timeout)
      if (exitCode === 0 && stdout.includes(okMarker)) resolve()
      else reject(new Error(stderr.trim() || stdout.trim() || `PRINT_GUARD_EXIT_${exitCode}`))
    })
  })
}

/**
 * Прибирає залиплі завдання конкретного принтера і перевіряє його готовність.
 * Кидає PRINT_QUEUE_STUCK / PRINT_PRINTER_NOT_READY, якщо друкувати марно.
 */
export function preflightPrinter(printerName: string): Promise<void> {
  const name = printerName.trim()
  if (!name) return Promise.resolve()
  return runGuardScript('print-preflight.ps1', PREFLIGHT_SCRIPT, name, [], 15000, 'PREFLIGHT_OK')
}

/**
 * Чекає, поки завдання зникне з черги принтера. Кидає PRINT_NOT_CONFIRMED,
 * якщо воно натомість впало в помилку — тобто друку НЕ відбулось.
 */
export function postflightPrinter(printerName: string, timeoutSeconds = 20): Promise<void> {
  const name = printerName.trim()
  if (!name) return Promise.resolve()
  return runGuardScript(
    'print-postflight.ps1',
    POSTFLIGHT_SCRIPT,
    name,
    ['-TimeoutSeconds', String(timeoutSeconds)],
    (timeoutSeconds + 10) * 1000,
    'POSTFLIGHT_OK',
  )
}
