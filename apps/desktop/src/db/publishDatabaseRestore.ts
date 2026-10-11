import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs'
import path from 'node:path'

const sidecars = ['-wal', '-shm', '-journal']
const key = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)

function plainDirectory(directory: string): void {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || key(realpathSync(directory)) !== key(directory))
    throw new Error('LOCAL_RESTORE_REDIRECTED_PATH')
}
function plainFile(file: string): BigIntStats {
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || key(realpathSync(file)) !== key(file))
    throw new Error('LOCAL_RESTORE_REDIRECTED_PATH')
  return stat
}
function noSidecars(file: string): void {
  if (sidecars.some(suffix => lstatSync(file + suffix, { throwIfNoEntry: false })))
    throw new Error('База ще має файли незавершених операцій SQLite. Повністю закрийте всі підключення; відновлення не виконано.')
}
function digest(file: string): string {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(512 * 1024), fd = openSync(file, 'r')
  try {
    let count: number
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
  } finally { closeSync(fd) }
  return hash.digest('hex')
}
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
}
function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs
}

/** Only the closed, explicitly selected local restore path may replace this file. */
export function assertClosedRestoreTarget(dataRoot: string): string {
  plainDirectory(dataRoot)
  const dataPath = path.join(dataRoot, 'data')
  plainDirectory(dataPath)
  const live = path.join(dataPath, 'forsage.db')
  plainFile(live)
  noSidecars(live)
  return live
}

/**
 * Keep the authoritative file in place until one same-directory rename.
 * Never resume from arbitrary partial files or choose a backup during startup.
 * Main must have stopped all writers and closed SQLite before calling this.
 */
export function publishPreparedRestore(dataRoot: string, prepared: string): void {
  const live = assertClosedRestoreTarget(dataRoot)
  if (key(path.dirname(prepared)) !== key(path.dirname(live))
    || !/^restore-[0-9a-f-]{36}\.db\.partial$/i.test(path.basename(prepared)))
    throw new Error('LOCAL_RESTORE_INVALID_CANDIDATE_PATH')
  const preparedStat = plainFile(prepared), currentStat = plainFile(live)
  noSidecars(prepared)
  const preparedHash = digest(prepared), currentHash = digest(live)

  const retainedRoot = path.join(dataRoot, 'corrupt')
  if (!existsSync(retainedRoot)) mkdirSync(retainedRoot)
  plainDirectory(retainedRoot)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const retained = path.join(retainedRoot, 'forsage-' + stamp + '-' + randomUUID() + '.db')
  const staged = retained + '.partial'
  let owned: BigIntStats | undefined
  try {
    copyFileSync(live, staged, constants.COPYFILE_EXCL)
    owned = plainFile(staged)
    const fd = openSync(staged, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    if (digest(staged) !== currentHash) throw new Error('LOCAL_RESTORE_PREVIOUS_COPY_MISMATCH')
    // Exclusive publication of the fully verified previous DB. A crash during
    // its copy leaves only .partial; the live file remains available throughout.
    linkSync(staged, retained)

    // Recheck after all slow I/O, before the single operation that changes data.
    // A restarted writer, replaced path, modified candidate or archive must stop.
    if (assertClosedRestoreTarget(dataRoot) !== live
      || !sameVersion(plainFile(live), currentStat) || digest(live) !== currentHash)
      throw new Error('LOCAL_RESTORE_CURRENT_CHANGED')
    plainDirectory(retainedRoot)
    noSidecars(prepared)
    if (!sameVersion(plainFile(prepared), preparedStat) || digest(prepared) !== preparedHash)
      throw new Error('LOCAL_RESTORE_CANDIDATE_CHANGED')
    const retainedStat = lstatSync(retained, { bigint: true })
    if (!retainedStat.isFile() || retainedStat.isSymbolicLink() || !sameIdentity(retainedStat, owned)
      || digest(retained) !== currentHash) throw new Error('LOCAL_RESTORE_PREVIOUS_COPY_MISMATCH')

    // The previous DB is never removed first. If rename fails or the process
    // stops before it, the original remains live. After it, only the ready DB.
    renameSync(prepared, live)
  } finally {
    // Never remove a pre-existing collision or a path replaced by another actor.
    // An interrupted copy may leave a private partial, not a published archive.
    if (owned) {
      try {
        plainDirectory(retainedRoot)
        const stat = lstatSync(staged, { bigint: true, throwIfNoEntry: false })
        if (stat?.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, owned)) unlinkSync(staged)
      } catch { /* cleanup must not report a failed restore after successful publication */ }
    }
  }
}
