import { stat, statfs } from 'node:fs/promises'
// Leave room for the live WAL and a compressed copy; never delete existing backups.
export function requiredBackupSpace(databaseBytes: number): number {
  return Math.max(512 * 1024 * 1024, databaseBytes * 3)
}
export async function assertBackupSpace(root: string, databasePath: string): Promise<void> {
  const [disk, database] = await Promise.all([statfs(root), stat(databasePath)])
  if (disk.bavail * disk.bsize < requiredBackupSpace(database.size))
    throw new Error('Недостатньо місця для безпечної резервної копії. Звільніть місце на диску; наявні резерви не видалено.')
}
