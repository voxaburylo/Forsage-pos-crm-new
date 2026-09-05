import { describe, expect, it } from 'vitest'
import { desktopTenantArgumentPositions, isDesktopChannelAllowed, PUBLIC_DESKTOP_CHANNELS } from '../src/security/desktopAuthorization'
import { hashSecret, legacySecretHash, secretHashNeedsUpgrade, verifySecret } from '../src/security/secretHash'

describe('desktop authorization boundary', () => {
  it('exposes only login and logout before authentication', () => {
    expect([...PUBLIC_DESKTOP_CHANNELS]).toEqual(['desktop:auth:login', 'desktop:auth:login-online', 'desktop:auth:logout'])
  })

  it('keeps cashdesk actions available to cashiers but blocks administration and stock mutation', () => {
    expect(isDesktopChannelAllowed('desktop:pos:checkout', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:print:html', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:staff:list-users', 'cashier')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:staff:tire-service-report', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:staff:tire-cash-handover', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:supply:post-invoice', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:supply:save-supplier', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:supply:delete-supplier', 'cashier')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:catalog:save-product', 'cashier')).toBe(true)
  })

  it('лишає синхронізацію технічним каналом, а не правом щось вирішувати', () => {
    // Стан черги читає той, хто стоїть за касою: збій він бачить першим.
    expect(isDesktopChannelAllowed('desktop:sync:status', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:sync:list-stuck', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:sync:retry-stuck', 'cashier')).toBe(true)
    // Каналу «зняти операцію з черги» більше немає взагалі: те, що сервер не
    // прийме ніколи, каса вирішує сама, а не питає людину. Що його не існує,
    // стежить тест відповідності preload↔main.
    expect(isDesktopChannelAllowed('desktop:staff:list-users', 'cashier')).toBe(false)
  })

  it('identifies standalone tenant arguments that cannot be checked recursively', () => {
    expect(desktopTenantArgumentPositions('desktop:orders:get')).toEqual([1])
    expect(desktopTenantArgumentPositions('desktop:pos:check-sale-after-payment')).toEqual([2])
    expect(desktopTenantArgumentPositions('desktop:catalog:find-by-id')).toEqual([])
  })
  it('allows stock roles where needed and denies unknown channels and roles', () => {
    expect(isDesktopChannelAllowed('desktop:supply:post-invoice', 'storekeeper')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:inventory:complete', 'storekeeper')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:inventory:complete', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:unknown:operation', 'owner')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:pos:checkout', 'unknown')).toBe(false)
  })
})

describe('desktop secret hash compatibility', () => {
  it('writes random hashes and upgrades only legacy hashes', () => {
    const current = hashSecret('password-1')
    expect(current).toMatch(/^pbkdf2-sha512\$210000\$/)
    expect(verifySecret(current, 'password-1', 'user-id')).toBe(true)
    expect(verifySecret(current, 'wrong', 'user-id')).toBe(false)
    expect(secretHashNeedsUpgrade(current)).toBe(false)

    const legacy = legacySecretHash('password-1', 'user-id')
    expect(verifySecret(legacy, 'password-1', 'user-id')).toBe(true)
    expect(secretHashNeedsUpgrade(legacy)).toBe(true)
  })
})
