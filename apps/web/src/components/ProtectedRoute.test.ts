import { describe, expect, it } from 'vitest'
import { homePathForRole } from './ProtectedRoute'

describe('homePathForRole', () => {
  it('uses a readable web home for every role', () => { for (const role of ['owner','cashier','storekeeper','sto_viewer','unknown']) expect(homePathForRole(role, false)).toBe('/products') })
  it('does not redirect stock viewers to a forbidden dashboard', () => { expect(homePathForRole('sto_viewer', true)).toBe('/inventory') })
  it('uses readable products for an unknown local role', () => expect(homePathForRole('unknown', true)).toBe('/products'))
  it('routes cashiers to POS', () => {
    expect(homePathForRole('cashier', true)).toBe('/pos')
  })

  it('routes storekeepers to warehouse picking', () => {
    expect(homePathForRole('storekeeper', true)).toBe('/inventory/picking')
  })

  it('routes office roles to the dashboard', () => {
    expect(homePathForRole('owner', true)).toBe('/dashboard')
    expect(homePathForRole('admin', true)).toBe('/dashboard')
    expect(homePathForRole('manager', true)).toBe('/dashboard')
  })
})
