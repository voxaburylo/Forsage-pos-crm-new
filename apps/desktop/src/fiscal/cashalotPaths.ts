import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Пошук папки ПРРО Кашалот на ТІЙ машині, де реально стоїть каса.
// Раніше типовий шлях був прибитий до профілю розробника
// (`C:\Users\neo\AppData\Local\Cashalot`), тому на магазинному компʼютері
// фіскалізація падала з «FISCAL_DLL_NOT_FOUND» на неіснуючу папку.

/** Бібліотека COM-API, за якою впізнаємо справжню папку Кашалота. */
export const CASHALOT_DLL = 'CashalotApi64.dll'

export interface CashalotProbe {
  fileExists(target: string): boolean
  dirExists(target: string): boolean
}

export const realProbe: CashalotProbe = {
  fileExists(target) {
    try {
      return fs.statSync(target).isFile()
    } catch {
      return false
    }
  },
  dirExists(target) {
    try {
      return fs.statSync(target).isDirectory()
    } catch {
      return false
    }
  },
}

/**
 * Місця, куди інсталятор Кашалота кладе програму, у порядку ймовірності.
 * Перше — і типовий шлях, якщо не знайшли нічого.
 */
export function cashalotSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || os.homedir()
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    path.join(local, 'Cashalot'),
    path.join(local, 'Programs', 'Cashalot'),
    path.join(roaming, 'Cashalot'),
    path.join(programFiles, 'Cashalot'),
    path.join(programFilesX86, 'Cashalot'),
  ]
}

/** Чи лежить у папці CashalotApi64.dll — єдина ознака, що це справді Кашалот. */
export function hasCashalotDll(dir: string | null | undefined, probe: CashalotProbe = realProbe): boolean {
  if (!dir || !dir.trim()) return false
  return probe.fileExists(path.join(dir, CASHALOT_DLL))
}

/** Перша папка з DLL; якщо Кашалот не встановлено — типовий шлях цього користувача. */
export function detectCashalotDir(
  env: NodeJS.ProcessEnv = process.env,
  probe: CashalotProbe = realProbe,
): string {
  const candidates = cashalotSearchDirs(env)
  return candidates.find((dir) => hasCashalotDll(dir, probe)) ?? candidates[0]
}

/**
 * Який шлях брати з урахуванням збереженого в fiscal.json.
 *
 * Порядок навмисний: збережене вручну має пріоритет, поки воно робоче, — але
 * шлях із чужого профілю (папки просто нема) мовчки лікується на правильний,
 * без участі касира.
 */
export function resolveCashalotDir(
  stored: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  probe: CashalotProbe = realProbe,
): string {
  const saved = typeof stored === 'string' ? stored.trim() : ''
  if (hasCashalotDll(saved, probe)) return saved
  const detected = detectCashalotDir(env, probe)
  if (hasCashalotDll(detected, probe)) return detected
  // Кашалота не видно ніде: лишаємо папку власника, якщо вона хоча б існує
  // (програму ще не поставили), інакше — типовий шлях поточного профілю.
  if (saved && probe.dirExists(saved)) return saved
  return detected
}
