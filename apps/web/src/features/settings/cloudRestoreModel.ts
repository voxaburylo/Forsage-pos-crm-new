/** Аварійне відновлення з хмарної копії: вибір найсвіжішої перевіреної копії зі списку сервера. */
export interface CloudBackupItem {
  device_id: string
  name: string
  created_at: string
  id: string
  sha256: string
  size_bytes: number
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/** Лише копії, з яких справді можна відновитись: відомі id, SHA-256 і розмір, дата читається. */
export function usableCloudBackups(items: readonly CloudBackupItem[]): CloudBackupItem[] {
  return items
    .filter(item => UUID.test(String(item.device_id)) && UUID.test(String(item.id))
      && /^[a-f0-9]{64}$/.test(String(item.sha256)) && Number(item.size_bytes) > 0 && Number.isFinite(Date.parse(item.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
}

export function latestCloudBackup(items: readonly CloudBackupItem[]): CloudBackupItem | null {
  return usableCloudBackups(items)[0] ?? null
}

/** Скільки повних днів копія відстає від сьогодні — щоб власник бачив, що втратить. */
export function backupAgeDays(createdAt: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(createdAt)) / 86_400_000))
}
