import { describe, expect, it } from 'vitest'
import { homePathForRole } from './ProtectedRoute'

describe('homePathForRole', () => {
  it('routes cashiers to POS', () => {
    expect(homePathForRole('cashier')).toBe('/pos')
  })

  it('routes storekeepers to warehouse picking', () => {
    expect(homePathForRole('storekeeper')).toBe('/inventory/picking')
  })

  it('routes office roles to the dashboard', () => {
    expect(homePathForRole('owner')).toBe('/dashboard')
    expect(homePathForRole('admin')).toBe('/dashboard')
    expect(homePathForRole('manager')).toBe('/dashboard')
  })
})
