import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MANUAL_REPLACE_MESSAGE, readPortableUpdateOutcome, settleInterruptedPortableUpdate } from '../src/updates/portableUpdate'

// 25.11.2026 (власник: «на втором ПК программа не обновляется»): установку перервали (вимкнули ПК) —
// стан «невідомо» блокував усі наступні оновлення назавжди. Тепер програма сама перевіряє файл за контрольною сумою.
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function interrupted(current: string, options: { minutesAgo?: number; foreignLock?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-settle-')); roots.push(root)
  const updates = path.join(root, 'Forsage', 'updates'); mkdirSync(updates, { recursive: true })
  const appDir = path.join(root, 'Manager'); mkdirSync(appDir)
  const destination = path.join(appDir, 'Forsage.exe'); writeFileSync(destination, current)
  const job = { protocol: 1, jobId: randomUUID(), root: updates, destination, parentPid: 1, releaseId: '20261125T155106-f8ba36942fe9',
    sha256: hash('MZ-new'), size: 6, previousHash: hash('MZ-old'), deadline: new Date(Date.now() - (options.minutesAgo ?? 60) * 60_000).toISOString() }
  writeFileSync(path.join(updates, 'last-job.json'), JSON.stringify(job))
  writeFileSync(path.join(updates, 'install.lock'), JSON.stringify(options.foreignLock ? { ...job, jobId: randomUUID() } : job))
  writeFileSync(destination + '.update-lock', JSON.stringify(job))
  return { root, updates, destination, job }
}

describe('an interrupted LAN update no longer blocks updates forever', () => {
  it('the old program is still in place: recorded as not installed, locks released, next update may run', async () => {
    const f = interrupted('MZ-old')
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('unknown')
    expect(await settleInterruptedPortableUpdate(f.root)).toBe('failed')
    expect(existsSync(path.join(f.updates, 'install.lock'))).toBe(false)
    expect(existsSync(f.destination + '.update-lock')).toBe(false)
    const outcome = readPortableUpdateOutcome(f.root)
    expect(outcome?.state).toBe('failed')
    expect(outcome?.message).toMatch(/спробує ще раз/)
    expect(readFileSync(f.destination, 'utf8')).toBe('MZ-old')
  })
  it('the new program is in place: recorded as installed', async () => {
    const f = interrupted('MZ-new')
    expect(await settleInterruptedPortableUpdate(f.root)).toBe('installed')
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('installed')
  })
  it('leaves everything untouched: too early, someone else\'s lock, or an unknown file', async () => {
    const early = interrupted('MZ-old', { minutesAgo: 5 })
    expect(await settleInterruptedPortableUpdate(early.root)).toBeNull()
    expect(existsSync(path.join(early.updates, 'install.lock'))).toBe(true)
    const foreign = interrupted('MZ-old', { foreignLock: true })
    expect(await settleInterruptedPortableUpdate(foreign.root)).toBeNull()
    // Чужий файл, але година після строку ще не минула — помічник теоретично ще може працювати.
    const strange = interrupted('MZ-something-else', { minutesAgo: 30 })
    expect(await settleInterruptedPortableUpdate(strange.root)).toBeNull()
    expect(readPortableUpdateOutcome(strange.root)?.state).toBe('unknown')
  })
  // 27.11.2026, фото власника: «поставив новий EXE флешкою — оновлень немає», на екрані «установка перервалась».
  it('the program was replaced by hand from a flash drive: the job is closed, locks released, the file is untouched', async () => {
    const f = interrupted('MZ-flash-drive-s-build', { minutesAgo: 120 })
    expect(readPortableUpdateOutcome(f.root)?.state).toBe('unknown')
    expect(await settleInterruptedPortableUpdate(f.root)).toBe('failed')
    expect(existsSync(path.join(f.updates, 'install.lock'))).toBe(false)
    expect(existsSync(f.destination + '.update-lock')).toBe(false)
    expect(readPortableUpdateOutcome(f.root)?.message).toBe(MANUAL_REPLACE_MESSAGE)
    expect(readFileSync(f.destination, 'utf8')).toBe('MZ-flash-drive-s-build')
    // Програму перенесли в іншу теку (старого файлу немає) — так само закрито.
    const moved = interrupted('MZ-old', { minutesAgo: 120 })
    rmSync(moved.destination)
    expect(await settleInterruptedPortableUpdate(moved.root)).toBe('failed')
    expect(readPortableUpdateOutcome(moved.root)?.message).toBe(MANUAL_REPLACE_MESSAGE)
  })
  it('nothing to do without a previous job', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forsage-settle-')); roots.push(root)
    expect(await settleInterruptedPortableUpdate(root)).toBeNull()
  })
})
