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
