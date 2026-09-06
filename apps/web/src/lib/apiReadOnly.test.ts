import { describe, expect, it } from 'vitest'
import { isWebReadOnlyRequest } from './api'

describe('web API is read-only', () => {
  it('allows reads and login session operations', () => {
    expect(isWebReadOnlyRequest('/api/v1/products', 'GET')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/reports/daily', 'HEAD')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/auth/login', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/auth/refresh', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/auth/logout', 'POST')).toBe(false)
  })

  it('blocks every ordinary mutation before it reaches the server', () => {
    expect(isWebReadOnlyRequest('/api/v1/sales', 'POST')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/inventory/sessions', 'POST')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/products/1', 'PUT')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/customer-orders/1', 'DELETE')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/sync/push', 'POST')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/auth/set-pin', 'POST')).toBe(true)
  })
})
