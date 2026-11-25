type BackupDatabase = { backupIfDue(): Promise<string | null>; waitForBackup(): Promise<void> }

/** initialDelayMs — 25.11.2026: перша перевірка не в мить запуску (після ввімкнення ПК диск і так зайнятий). */
export function startBackupScheduler(database: BackupDatabase, onError: (error: unknown) => void, initialDelayMs = 0): () => void {
  let stopped = false
  let running = false
  const run = async () => {
    if (stopped || running) return
    running = true
    try { await database.backupIfDue() }
    catch (error) { onError(error) }
    finally { running = false }
  }
  const first = initialDelayMs > 0 ? setTimeout(() => { void run() }, initialDelayMs) : null
  first?.unref?.()
  if (!first) void run()
  // Перевірка кожні 5 хв, копія щогодини. Після сну/збою повтор без перезапуску.
  const timer = setInterval(() => { void run() }, 5 * 60_000)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer); if (first) clearTimeout(first) }
}
