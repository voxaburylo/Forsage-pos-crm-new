import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Хто зараз тримає базу головного ПК (22.11.2026, рішення власника «база висить у фоні, веб працює,
 * навіть коли програму не відкрито й у Windows ніхто не входив»).
 *
 * Програма може працювати двома способами:
 *  - «вікно» — звичайна каса на екрані;
 *  - «фон» — без вікна, з планувальника Windows одразу після ввімкнення ПК (ключ --background).
 * Базу одночасно тримає лише одна копія програми. Фон завжди поступається вікну: вікно просить відпустити
 * базу й чекає, доки фонова копія коректно закриється. Коли вікно закривають, воно знову запускає фон.
 *
 * Свій файл, а не лише блокування Electron: фон працює в іншому сеансі Windows (до входу користувача),
 * і вікно з робочого столу не завжди «бачить» його звичайними засобами.
 */
export type TillOwnerMode = 'window' | 'background' | 'window-closing'
export interface TillOwner { pid: number; mode: TillOwnerMode; started_at: string }

export const OWNER_FILE = 'till-owner.json'
export const HANDOFF_FILE = 'till-handoff.request'
export const BACKGROUND_FLAG = '--background'
/** Скільки вікно чекає, поки фон закриється (оплата чи копія бази, що саме йде, мають завершитись). */
export const HANDOFF_WAIT_MS = 120_000
/** Скільки фон чекає, поки закриється вікно, яке саме його й запустило. */
export const WINDOW_CLOSE_WAIT_MS = 90_000
/** Назва завдання в планувальнику Windows (див. scripts/background-task.ps1). */
export const BACKGROUND_TASK = '\\Forsage\\TillBackground'

export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes(BACKGROUND_FLAG)
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    // EPERM — процес є, але належить іншому сеансу чи користувачу: вважаємо живим.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export function readOwner(dataRoot: string): TillOwner | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dataRoot, OWNER_FILE), 'utf8')) as Partial<TillOwner>
    if (!Number.isSafeInteger(raw.pid) || !['window', 'background', 'window-closing'].includes(String(raw.mode))) return null
    return { pid: Number(raw.pid), mode: raw.mode as TillOwnerMode, started_at: String(raw.started_at ?? '') }
  } catch { return null }
}

/** Живий власник бази; запис мертвого процесу (після вимкнення світла) не рахується. */
export function liveOwner(dataRoot: string, alive: (pid: number) => boolean = processAlive, self = process.pid): TillOwner | null {
  const owner = readOwner(dataRoot)
  return owner && owner.pid !== self && alive(owner.pid) ? owner : null
}

export function writeOwner(dataRoot: string, mode: TillOwnerMode, pid = process.pid, now = new Date()): void {
  const target = path.join(dataRoot, OWNER_FILE), partial = target + '.' + pid + '.partial'
  writeFileSync(partial, JSON.stringify({ pid, mode, started_at: now.toISOString() }), 'utf8')
  renameSync(partial, target)
}

/** Прибрати свій запис (чужий не чіпаємо). */
export function releaseOwner(dataRoot: string, pid = process.pid): void {
  if (readOwner(dataRoot)?.pid === pid) rmSync(path.join(dataRoot, OWNER_FILE), { force: true })
}

export function requestHandoff(dataRoot: string, fromPid = process.pid): void {
  writeFileSync(path.join(dataRoot, HANDOFF_FILE), JSON.stringify({ from: fromPid, at: new Date().toISOString() }), 'utf8')
}

export function handoffRequested(dataRoot: string): boolean {
  return existsSync(path.join(dataRoot, HANDOFF_FILE))
}

export function clearHandoff(dataRoot: string): void {
  rmSync(path.join(dataRoot, HANDOFF_FILE), { force: true })
}

/** Чекати без зайнятого процесора, поки процес не завершиться. true — завершився. */
export function waitForExit(pid: number, timeoutMs: number, alive: (pid: number) => boolean = processAlive,
  sleep: (ms: number) => void = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)): boolean {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    sleep(250)
  }
  return true
}

export type StartDecision =
  | { action: 'start' }
  /** Фон: базу тримає вікно — фону тут робити нічого. */
  | { action: 'exit'; reason: string }

/**
 * Що робити цій копії програми під час запуску. Виконується до будь-якої роботи з базою.
 *  - вікно: якщо базу тримає фон — попросити відпустити й дочекатися; далі звичайний запуск;
 *  - фон: якщо базу тримає живе вікно — вийти; якщо вікно саме закривається (воно й запустило фон) — дочекатися.
 */
export function decideStart(dataRoot: string, background: boolean, deps: {
  alive?: (pid: number) => boolean
  sleep?: (ms: number) => void
  log?: (event: string, details: Record<string, unknown>) => void
} = {}): StartDecision {
  const alive = deps.alive ?? processAlive
  const owner = liveOwner(dataRoot, alive)
  if (!owner) return { action: 'start' }
  if (background) {
    if (owner.mode === 'window-closing' && waitForExit(owner.pid, WINDOW_CLOSE_WAIT_MS, alive, deps.sleep)) return { action: 'start' }
    return { action: 'exit', reason: owner.mode === 'background' ? 'background-already-running' : 'window-owns-database' }
  }
  if (owner.mode === 'background') {
    deps.log?.('background-handoff-requested', { pid: owner.pid })
    requestHandoff(dataRoot)
    const released = waitForExit(owner.pid, HANDOFF_WAIT_MS, alive, deps.sleep)
    deps.log?.('background-handoff-finished', { pid: owner.pid, released })
    clearHandoff(dataRoot)
  }
  // Інше вікно того самого сеансу Windows обробляє звичайне блокування Electron (фокус на наявне вікно).
  return { action: 'start' }
}
