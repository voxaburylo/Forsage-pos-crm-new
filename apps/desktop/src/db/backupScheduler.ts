type BackupDatabase = { backupIfDue(): Promise<string | null>; waitForBackup(): Promise<void> }

export function startBackupScheduler(database: BackupDatabase, onError: (error: unknown) => void): () => void {
  let stopped = false
  let running = false
  const run = async () => {
    if (stopped || running) return
    running = true
    try { await database.backupIfDue() }
    catch (error) { onError(error) }
    finally { running = false }
  }
  void run()
  // Перевірка кожні 5 хв, копія щогодини. Після сну/збою повтор без перезапуску.
  const timer = setInterval(() => { void run() }, 5 * 60_000)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
