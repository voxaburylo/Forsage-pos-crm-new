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
    expect(isDesktopChannelAllowed('desktop:supply:post-invoice', 'cashier')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:catalog:save-product', 'cashier')).toBe(false)
  })

  it('identifies standalone tenant arguments that cannot be checked recursively', () => {
    expect(desktopTenantArgumentPositions('desktop:orders:get')).toEqual([1])
    expect(desktopTenantArgumentPositions('desktop:pos:check-sale-after-payment')).toEqual([2])
    expect(desktopTenantArgumentPositions('desktop:catalog:find-by-id')).toEqual([])
  })
  it('allows stock roles where needed and denies unknown channels and roles', () => {
    expect(isDesktopChannelAllowed('desktop:supply:post-invoice', 'storekeeper')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:inventory:complete', 'storekeeper')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:inventory:complete', 'cashier')).toBe(false)
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