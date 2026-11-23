import type { LocalDatabase } from '../db/localDatabase'
import type { LocalProblemInput } from '../db/localTypes'
import { NIGHTLY_CODES, type NightlyResult, nightlyCheckDue, runNightlyCheck } from './nightlyCheck'

/**
 * 23.11.2026 (план T6): запуск нічної перевірки, пам'ять про останній результат і запис у журнал проблем.
 * Результат зберігається в app_meta; у базі даних магазину нічого не змінюється.
 */
const KEY = 'nightly-check:v1'
export type NightlySummary = { checked_at: string; findings: Array<{ code: string; title: string; count: number }> }

export function readNightlySummary(db: LocalDatabase): NightlySummary | null {
  try {
    const row = db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(KEY) as { value_json: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.value_json) as Partial<NightlySummary>
    if (typeof parsed.checked_at !== 'string' || !Array.isArray(parsed.findings)) return null
    return {
      checked_at: parsed.checked_at,
      findings: parsed.findings.filter(item => item && typeof item.code === 'string' && typeof item.title === 'string')
        .map(item => ({ code: item.code, title: item.title, count: Number(item.count) || 0 })).slice(0, 10),
    }
  } catch { return null }
}

export type NightlyDeps = {
  record(problem: LocalProblemInput): void
  resolveCode(code: string): void
  now?: () => Date
  check?: typeof runNightlyCheck
}

/** Одна перевірка зараз: записати знайдене в журнал проблем, закрити те, що більше не знаходиться. */
export function performNightlyCheck(db: LocalDatabase, deps: NightlyDeps): NightlyResult {
  const result = (deps.check ?? runNightlyCheck)(db, { now: deps.now })
  const found = new Set(result.findings.map(item => item.code))
  for (const finding of result.findings) {
    deps.record({ source: 'database', code: finding.code, severity: finding.severity, title: finding.title, detail: finding.detail, context: { count: finding.count } })
  }
  for (const code of NIGHTLY_CODES) if (!found.has(code)) deps.resolveCode(code)
  const summary: NightlySummary = { checked_at: result.checked_at, findings: result.findings.map(item => ({ code: item.code, title: item.title, count: item.count })) }
  db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(KEY, JSON.stringify(summary), result.checked_at)
  return result
}

/** Викликається за таймером: перевіряє лише тоді, коли настав час (уночі або давно не перевіряли). */
export function nightlyCheckTick(db: LocalDatabase, deps: NightlyDeps): NightlyResult | null {
  const now = deps.now?.() ?? new Date()
  if (!nightlyCheckDue(readNightlySummary(db)?.checked_at ?? null, now)) return null
  return performNightlyCheck(db, deps)
}
