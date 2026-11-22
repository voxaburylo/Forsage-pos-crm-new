import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isWriteAllowed } from '../../middleware/localFirstWriteGuard.js'

// 22.11.2026, огляд кнопок вебу: кілька дій сервер відхиляв даремно — їхні дані живуть лише на сервері
// (у базі каси таких таблиць немає) або запит лише читає. Список дозволів однаковий у вебі й на сервері.
const id = '00000000-0000-4000-8000-000000000001'
const web = (method: string, path: string) => isWriteAllowed({ method, path, get: () => undefined } as never)

describe('the web may change what lives only on the server', () => {
  it('price link for a customer, customer groups, connecting the owner bot', () => {
    expect(web('POST', '/api/v1/price-links')).toBe(true)
    expect(web('DELETE', '/api/v1/price-links/' + id)).toBe(true)
    expect(web('POST', '/api/v1/customer-groups')).toBe(true)
    expect(web('PATCH', '/api/v1/customer-groups/' + id)).toBe(true)
    expect(web('POST', '/api/v1/customer-groups/' + id + '/members')).toBe(true)
    expect(web('DELETE', '/api/v1/customer-groups/' + id + '/members/' + id)).toBe(true)
    expect(web('POST', '/api/v1/settings/telegram-connect')).toBe(true)
  })

  it('product photo search and reading a VIN from a photo only read', () => {
    expect(web('POST', '/api/v1/ai/product-photos')).toBe(true)
    expect(web('POST', '/api/v1/vin/ocr')).toBe(true)
  })

  it('nothing next to them is opened by accident', () => {
    for (const [method, path] of [['POST', '/api/v1/customers'], ['PUT', '/api/v1/customers/' + id], ['POST', '/api/v1/customer-groupsx'], ['POST', '/api/v1/price-linksx'],
      ['PUT', '/api/v1/settings'], ['POST', '/api/v1/settings/telegram-connectx'], ['POST', '/api/v1/products/bulk-update'], ['DELETE', '/api/v1/ai/product-photos'],
      ['POST', '/api/v1/vin/decode'], ['POST', '/api/v1/sales']] as const)
      expect(web(method, path), method + ' ' + path).toBe(false)
  })

  it('these routes really touch only cloud-only tables', () => {
    const groups = readFileSync(new URL('../../routes/customerGroups.ts', import.meta.url), 'utf8')
    // Клієнтів маршрут лише читає (перевіряє, що вони цього магазину); пише тільки у свої дві таблиці.
    for (const match of groups.matchAll(/from\('([a-z_]+)'\)\s*\.(insert|update|delete|upsert)/g)) expect(['customer_groups', 'customer_group_members']).toContain(match[1])
    const links = readFileSync(new URL('../priceListLinkService.ts', import.meta.url), 'utf8')
    for (const match of links.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)) expect(match[2]).toBe('price_list_links')
    const desktopSchema = readFileSync(new URL('../../../../apps/desktop/src/db/schema.ts', import.meta.url), 'utf8')
    for (const table of ['customer_groups', 'customer_group_members', 'price_list_links']) expect(desktopSchema.includes(table), table).toBe(false)
  })
})
