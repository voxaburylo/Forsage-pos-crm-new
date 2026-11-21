import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 21.11.2026 (план зручності, «друк»): кожен друк запускав новий powershell.exe і заново вантажив
 * модуль PrintManagement — ~1 с на сучасному ПК і 3–5 с на старому, ще до першого байта на принтер.
 * Тепер один процес PowerShell готується ЗАЗДАЛЕГІДЬ (модуль уже завантажено) і чекає завдання на stdin.
 * Логіка самих скриптів друку не змінюється: «прогрітий» процес лише запускає той самий .ps1 з тими ж
 * параметрами. Якщо запасного процесу немає або він помер — запускаємо новий, як раніше.
 */
const STUB_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { Import-Module PrintManagement -ErrorAction Stop } catch { }
$line = [Console]::In.ReadLine()
if (-not $line) { exit 0 }
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
$params = @{}
foreach ($property in $request.params.PSObject.Properties) { $params[$property.Name] = $property.Value }
& $request.file @params
`

const IDLE_MS = 15 * 60_000

type Spare = { child: ChildProcessWithoutNullStreams; idle: NodeJS.Timeout }
let spare: Spare | null = null
/** Тека скриптів друку (userData); stub лежить поруч із ними. */
let scriptDir: string | null = null
let writtenStub: string | null = null

function ensureStub(dir: string): string {
  const target = path.join(dir, 'print-warm-stub.ps1')
  if (writtenStub !== target) {
    fs.writeFileSync(target, STUB_SCRIPT, 'utf8')
    writtenStub = target
  }
  return target
}

function spawnStub(dir: string): ChildProcessWithoutNullStreams {
  return spawn('powershell.exe', [
    '-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureStub(dir),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

function alive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed && child.stdin?.writable === true
}

/** Готує запасний процес наперед (викликається після кожного друку і при старті). */
export function prewarmPrintShell(dir: string | null = scriptDir): void {
  if (process.platform !== 'win32' || !dir) return
  scriptDir = dir
  if (spare && alive(spare.child)) { spare.idle.refresh(); return }
  try {
    const child = spawnStub(dir)
    child.on('error', () => { if (spare?.child === child) spare = null })
    child.on('exit', () => { if (spare?.child === child) { clearTimeout(spare.idle); spare = null } })
    // Не тримаємо пам'ять, якщо друку давно не було (важливо для старого ПК).
    const idle = setTimeout(() => { if (spare?.child === child) { spare = null; try { child.kill() } catch { /* gone */ } } }, IDLE_MS)
    idle.unref?.()
    spare = { child, idle }
  } catch {
    spare = null
  }
}

/** Скидає запасний процес (вихід із програми). */
export function disposePrintWarmShell(): void {
  const current = spare
  spare = null
  if (current) { clearTimeout(current.idle); try { current.child.kill() } catch { /* gone */ } }
}

/**
 * Запускає .ps1 з параметрами через прогрітий процес. stdin лишається відкритим: скрипт друку,
 * якому потрібні дані (сирі байти етикетки), отримає їх як і раніше — викликач пише в stdin і закриває його.
 */
export function runPrintScript(scriptPath: string, params: Record<string, string | number>): ChildProcessWithoutNullStreams {
  scriptDir = path.dirname(scriptPath)
  let child: ChildProcessWithoutNullStreams
  if (spare && alive(spare.child)) {
    child = spare.child
    clearTimeout(spare.idle)
    spare = null
  } else {
    child = spawnStub(scriptDir)
  }
  const request = Buffer.from(JSON.stringify({ file: scriptPath, params }), 'utf8').toString('base64')
  child.stdin.write(request + '\n')
  // Наступний друк уже не чекатиме на запуск PowerShell.
  setTimeout(() => prewarmPrintShell(), 500).unref?.()
  return child
}
