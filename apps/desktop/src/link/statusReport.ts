/**
 * 23.11.2026 (план T2 «Стан системи»): що головний ПК повідомляє про себе серверу разом із «я на зв'язку».
 * Власник бачить це у вебі з телефона: версія каси, відкрито вікно чи працює у фоні, коли була остання копія бази,
 * скільки місця на диску. Лише технічні відомості про комп'ютер — жодних товарів, клієнтів чи грошей.
 */
export type TillStatusReport = {
  version: string | null
  release_id: string | null
  built_at: string | null
  mode: 'window' | 'background'
  role: 'main' | 'manager'
  disk_free_bytes: number | null
  disk_total_bytes: number | null
  database_bytes: number | null
  local_backup_at: string | null
  cloud_backup_at: string | null
  external_backup_at: string | null
  schema_version: number | null
  started_at: string | null
  /** План T6: остання нічна перевірка бази — коли й що знайшла (назва перевірки й кількість, без даних магазину). */
  check_at: string | null
  check_findings: Array<{ code: string; title: string; count: number }>
  /** 23.11.2026 (план T7): ПК менеджера — яка збірка й коли востаннє звертався до головного ПК. */
  manager_release_id?: string | null
  manager_seen_at?: string | null
}

/** Як часто повідомляти: стан змінюється повільно, а «я на зв'язку» йде щопівхвилини. */
export const STATUS_REPORT_EVERY_MS = 5 * 60_000

const text = (value: unknown, max = 80): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const time = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}
const size = (value: unknown): number | null => {
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

export type StatusSources = {
  build?: { version?: unknown; releaseId?: unknown; builtAt?: unknown } | null
  background: boolean
  managerPc: boolean
  disk?: { free?: unknown; total?: unknown } | null
  databaseBytes?: unknown
  localBackupAt?: unknown
  cloudBackupAt?: unknown
  externalBackupAt?: unknown
  schemaVersion?: unknown
  startedAt?: unknown
  check?: { checked_at?: unknown; findings?: unknown } | null
  managerClient?: { release_id?: unknown; seen_at?: unknown } | null
}

/** Збирає повідомлення з того, що вдалося прочитати; чого прочитати не вдалося — null, а не вигадане число. */
export function buildStatusReport(sources: StatusSources): TillStatusReport {
  const schema = Number(sources.schemaVersion)
  return {
    version: text(sources.build?.version, 40),
    release_id: text(sources.build?.releaseId, 80),
    built_at: time(sources.build?.builtAt),
    mode: sources.background ? 'background' : 'window',
    role: sources.managerPc ? 'manager' : 'main',
    disk_free_bytes: size(sources.disk?.free),
    disk_total_bytes: size(sources.disk?.total),
    database_bytes: size(sources.databaseBytes),
    local_backup_at: time(sources.localBackupAt),
    cloud_backup_at: time(sources.cloudBackupAt),
    external_backup_at: time(sources.externalBackupAt),
    schema_version: Number.isSafeInteger(schema) && schema > 0 ? schema : null,
    started_at: time(sources.startedAt),
    check_at: time(sources.check?.checked_at),
    check_findings: (Array.isArray(sources.check?.findings) ? sources.check.findings as Array<Record<string, unknown>> : [])
      .filter(item => item && typeof item.code === 'string' && typeof item.title === 'string')
      .slice(0, 10).map(item => ({ code: String(item.code).slice(0, 60), title: String(item.title).slice(0, 120), count: Math.max(0, Math.trunc(Number(item.count)) || 0) })),
    manager_release_id: text(sources.managerClient?.release_id, 80),
    manager_seen_at: time(sources.managerClient?.seen_at),
  }
}

/** Повідомляти зараз? Перший раз — одразу, далі — не частіше за інтервал. */
export function statusReportDue(lastSentAt: number | null, now: number, everyMs = STATUS_REPORT_EVERY_MS): boolean {
  return lastSentAt === null || now - lastSentAt >= everyMs
}
