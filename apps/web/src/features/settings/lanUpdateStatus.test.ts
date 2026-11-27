import { describe, expect, it } from 'vitest'
import { lanUpdateLines } from './LanUpdateStatus'

const base = { checkedAt: null, error: null, installError: null, staged: null, outcome: null, portable: true, executable: null }
// 25.11.2026: причина, чому ПК менеджера не оновлюється, — на екрані, простими словами.
describe('manager PC update status in plain words', () => {
  it('says when the program was not started from the archive file', () => {
    expect(lanUpdateLines({ ...base, portable: false })[0]).toMatchObject({ tone: 'bad', text: expect.stringContaining('Forsage-Manager') })
  })
  it('says that an interrupted install blocks updates and what to do', () => {
    expect(lanUpdateLines({ ...base, outcome: { state: 'unknown' } }).find(line => line.tone === 'bad')?.text).toContain('флешкою')
  })
  // 27.11.2026: програму поставили флешкою — це звичайний стан, не червона помилка.
  it('a manual replacement from a flash drive is shown as a normal state', () => {
    const lines = lanUpdateLines({ ...base, outcome: { state: 'failed', message: 'Програму замінено вручну (флешкою) — попереднє оновлення закрито, наступні йдуть як звичайно' } })
    expect(lines[0]).toMatchObject({ tone: 'ok', text: expect.stringContaining('замінено вручну') })
    expect(lines.some(line => line.tone === 'bad')).toBe(false)
  })
  it('shows a failed download with its reason and a ready update', () => {
    expect(lanUpdateLines({ ...base, checkedAt: '2026-11-25T16:00:00Z', error: 'Головний ПК недоступний' }).some(line => line.text.includes('Головний ПК недоступний'))).toBe(true)
    expect(lanUpdateLines({ ...base, staged: '20261125T155106-f8ba36942fe9' }).some(line => line.text.includes('повністю закриєте'))).toBe(true)
  })
})
