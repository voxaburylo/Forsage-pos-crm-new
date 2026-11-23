import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { LocalDatabase } from '../db/localDatabase'
import { runNightlyCheck } from './nightlyCheck'

/**
 * 23.11.2026 (план C7): репетиція оновлення — нова програма запускається на КОПІЇ бази в окремій теці,
 * без мережі: відкриває копію (з усіма своїми змінами схеми), перевіряє її й закривається. Робоча база не
 * відкривається взагалі. Режим вмикається лише разом: прапорець --rehearsal, FORSAGE_REHEARSAL_ROOT і
 * LOCALAPPDATA, що вказує на ту саму теку, — тож випадково (або з ярлика) його не ввімкнути.
 */
export const REHEARSAL_RESULT_FILE = 'rehearsal-result.json'

export function rehearsalRootFrom(argv: readonly string[], env: Record<string, string | undefined>): string | null {
  if (!argv.includes('--rehearsal')) return null
  const root = env.FORSAGE_REHEARSAL_ROOT
  if (!root || !path.isAbsolute(root) || !env.LOCALAPPDATA) return null
  return path.resolve(env.LOCALAPPDATA) === path.resolve(root) ? path.resolve(root) : null
}

export interface RehearsalResult {
  ok: boolean
  release_id: string | null
  schema_version: number | null
  products: number | null
  findings: Array<{ code: string; title: string; count: number; severity: string }>
  error: string | null
}

/** Відкрити копію, перевірити й закрити. Помилка файла бази — провал; знахідки нічної перевірки лише показуються. */
export function runStartupRehearsal(root: string, releaseId: string | null): RehearsalResult {
  let db: LocalDatabase | null = null
  let result: RehearsalResult
  try {
    db = LocalDatabase.open(path.join(root, 'Forsage')).database
    const check = runNightlyCheck(db)
    const products = (db.prepare('SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL').get() as { n: number }).n
    const broken = check.findings.filter(item => item.code === 'nightly-db-file' || item.code === 'nightly-db-references')
    result = {
      ok: broken.length === 0, release_id: releaseId, schema_version: db.info().schemaVersion, products,
      findings: check.findings.map(item => ({ code: item.code, title: item.title, count: item.count, severity: item.severity })),
      error: broken.length ? broken.map(item => item.title).join('; ') : null,
    }
  } catch (error) {
    result = { ok: false, release_id: releaseId, schema_version: null, products: null, findings: [], error: error instanceof Error ? error.message.slice(0, 1000) : String(error) }
  } finally {
    try { db?.close() } catch { /* копію все одно буде видалено */ }
  }
  writeFileSync(path.join(root, REHEARSAL_RESULT_FILE), JSON.stringify(result))
  return result
}
