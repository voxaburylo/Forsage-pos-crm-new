import type { LocalDatabaseBackup } from './localDatabase'

/** Зберігаємо недавні погодинні копії ТА історію за 14 днів із копіями. */
export function backupsToPrune(backups: LocalDatabaseBackup[], recent = 24, daily = 14): LocalDatabaseBackup[] {
  const sorted = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const keep = new Set(sorted.slice(0, Math.max(1, Math.floor(recent))).map((entry) => entry.filePath))
  const days = new Set<string>()
  for (const entry of sorted) {
    const day = entry.createdAt.slice(0, 10)
    if (!days.has(day) && days.size < daily) {
      keep.add(entry.filePath)
      days.add(day)
    }
  }
  return sorted.filter((entry) => !keep.has(entry.filePath))
}
