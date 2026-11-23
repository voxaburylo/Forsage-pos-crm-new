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
    expect(isWebReadOnlyRequest('/api/v1/auth/change-password', 'POST')).toBe(true)
  })

  it('lets the web change a staff PIN or password even without the main PC (only a hash reaches the till)', () => {
    // 22.11.2026, рішення власника: без головного ПК — лише перегляд і зміни, що не стосуються залишків.
    expect(isWebReadOnlyRequest('/api/v1/auth/set-pin', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/admin/users/00000000-0000-4000-8000-000000000001/password', 'PUT')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/admin/users/00000000-0000-4000-8000-000000000001', 'PUT')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/settings/owner-alerts', 'PUT')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/settings', 'PUT')).toBe(true)
  })

  it('lets the web hand a command to the till, and nothing else on that route', () => {
    // 22.11.2026: без цього «Змінити через касу» і закриття зміни з вебу не доходили до сервера взагалі.
    expect(isWebReadOnlyRequest('/api/v1/till-commands', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/till-commands/claim', 'POST')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/till-commands/abc/result', 'POST')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/till-commands', 'DELETE')).toBe(true)
  })
  it('lets the web talk to the assistant and recognise a photo, but AI actions go only through the main PC', () => {
    expect(isWebReadOnlyRequest('/api/v1/ai/supply-invoice-photo', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/ai/apply-action', 'POST')).toBe(true)
    expect(isWebReadOnlyRequest('/api/v1/ai/config', 'POST')).toBe(true)
    // 22.11.2026 (рішення власника «веб повний через головний ПК»): розмова лише читає; правила помічника — налаштування.
    expect(isWebReadOnlyRequest('/api/v1/ai/chat', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/ai/memory', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/till-rpc', 'POST')).toBe(false)
  })
})

// 22.11.2026, огляд кнопок вебу: кілька дій веб відхиляв даремно — їхні дані живуть лише на сервері або запит лише читає.
describe('web may change what lives only on the server, and ask the assistant to look things up', () => {
  const id = '00000000-0000-4000-8000-000000000001'

  it('price link for a customer, customer groups, connecting the owner bot', () => {
    expect(isWebReadOnlyRequest('/api/v1/price-links', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/price-links/' + id, 'DELETE')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/customer-groups', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/customer-groups/' + id, 'PATCH')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/customer-groups/' + id + '/members', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/customer-groups/' + id + '/members/' + id, 'DELETE')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/settings/telegram-connect', 'POST')).toBe(false)
  })

  it('product photo search and reading a VIN from a photo only read', () => {
    expect(isWebReadOnlyRequest('/api/v1/ai/product-photos', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/vin/ocr', 'POST')).toBe(false)
  })

  it('nothing next to them is opened by accident', () => {
    for (const [path, method] of [['/api/v1/customers', 'POST'], ['/api/v1/customers/' + id, 'PUT'], ['/api/v1/customer-groupsx', 'POST'], ['/api/v1/price-linksx', 'POST'],
      ['/api/v1/settings', 'PUT'], ['/api/v1/settings/telegram-connectx', 'POST'], ['/api/v1/products/bulk-update', 'POST'], ['/api/v1/ai/product-photos', 'DELETE'],
      ['/api/v1/vin/decode', 'POST'], ['/api/v1/ai/apply', 'POST']] as const)
      expect(isWebReadOnlyRequest(path, method), method + ' ' + path).toBe(true)
  })
})
