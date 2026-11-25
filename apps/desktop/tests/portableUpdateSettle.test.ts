import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPortableUpdateOutcome, settleInterruptedPortableUpdate } from '../src/updates/portableUpdate'

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
    const strange = interrupted('MZ-something-else')
    expect(await settleInterruptedPortableUpdate(strange.root)).toBeNull()
    expect(readPortableUpdateOutcome(strange.root)?.state).toBe('unknown')
  })
  it('nothing to do without a previous job', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forsage-settle-')); roots.push(root)
    expect(await settleInterruptedPortableUpdate(root)).toBeNull()
  })
})
