import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: {} }))
vi.mock('@/lib/desktopBridge', () => ({ isDesktopRuntime: () => false }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ session: null }) }))

import { WEB_ACCESS_PROBE, WEB_ACCESS_RETRY_MS, WEB_ACCESS_TTL_MS, WEB_ROLES_BY_DEFAULT, askWebWorkAccess, forgetWebWorkAccess } from './webWorkAccess'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

// 23.11.2026 (план B3): касир у вебі працює через головний ПК лише з дозволом власника; дозвіл знає головний ПК.
describe('web work access: the web asks the main PC about a cashier', () => {
  beforeEach(() => forgetWebWorkAccess())

  it('owner, admin and manager need no question; nobody else is in by role', () => {
    expect([...WEB_ROLES_BY_DEFAULT].sort()).toEqual(['admin', 'manager', 'owner'])
    expect(WEB_ROLES_BY_DEFAULT.has('cashier')).toBe(false)
  })

  it('the answer of the main PC is remembered for a few minutes, then asked again', async () => {
    let now = 1_000_000
    const ask = vi.fn(async () => true)
    expect(await askWebWorkAccess('u1', ask, () => now)).toBe(true)
    now += WEB_ACCESS_TTL_MS - 1
    expect(await askWebWorkAccess('u1', ask, () => now)).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
    // Власник вимкнув дозвіл: після строку веб питає знову й закриває роботу.
    now += 2
    ask.mockResolvedValueOnce(false)
    expect(await askWebWorkAccess('u1', ask, () => now)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('only a plain «yes» opens the work; anything else is «no»', async () => {
    let user = 0
    for (const answer of [false, null, undefined, 'true', 1, { allowed: true }]) {
      expect(await askWebWorkAccess('odd-' + user++, async () => answer, () => 5)).toBe(false)
    }
  })

  it('a main PC that did not answer is not a refusal: nothing is remembered and the web asks again later, not at once', async () => {
    let now = 50_000
    const ask = vi.fn(async (): Promise<unknown> => { throw new Error('Головний ПК не на звʼязку') })
    expect(await askWebWorkAccess('u2', ask, () => now)).toBe(false)
    // Одразу вдруге не питаємо — щоб кожен екран не будив головний ПК.
    expect(await askWebWorkAccess('u2', ask, () => now + 1)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    now += WEB_ACCESS_RETRY_MS + 1
    ask.mockResolvedValueOnce(true)
    expect(await askWebWorkAccess('u2', ask, () => now)).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('one employee never gets the answer given for another', async () => {
    expect(await askWebWorkAccess('yes', async () => true, () => 1)).toBe(true)
    expect(await askWebWorkAccess('no', async () => false, () => 1)).toBe(false)
    expect(await askWebWorkAccess('yes', async () => false, () => 2)).toBe(true)
    expect(await askWebWorkAccess('no', async () => true, () => 2)).toBe(false)
  })

  it('the question is the one the main PC answers, and the screens use this single source', () => {
    expect(WEB_ACCESS_PROBE).toBe('desktop:access:web-work')
    const till = read('../../../desktop/src/security/managerSaleAccess.ts')
    expect(till).toContain(`export const WEB_ACCESS_PROBE = '${WEB_ACCESS_PROBE}'`)
    expect(read('../components/TillOnly.tsx')).not.toContain('WEB_RPC_ROLES')
    expect(read('../components/Sidebar.tsx')).toContain('|| viaWeb),')
    // Сервер пропускає касира до головного ПК; чи можна — вирішує головний ПК.
    expect(read('../../../../server/src/services/tillRpcService.ts')).toContain("export const WEB_RPC_ROLES = ['owner', 'admin', 'manager', 'cashier'] as const")
    const staff = read('../features/staff/StaffPage.tsx')
    // 24.11.2026: перемикач переїхав у блок «Права» картки працівника (StaffRightsBlock); для касира — лише він.
    expect(staff).toContain('<StaffRightsBlock userId={selectedUser.id} role={editForm.role} savedRole={selectedUser.role}/>')
    expect(read('../features/staff/ManagerSaleToggle.tsx')).toContain("{switches.includes('web') && <WebWorkToggle userId={userId} />}")
    expect(read('../features/staff/staffRights.ts')).toContain("if (role === 'cashier') return ['orders', 'purchase_prices', 'reports', 'writeoffs', 'web']")
  })
})
