import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeRemoteTenantArguments } from '../src/security/desktopAuthorization'

describe('commands from the manager PC and the web (25.11.2026)', () => {
  it('a missing shop number that arrived over the network as null means "not given", so the till default applies', () => {
    // Як надходить з ПК менеджера: [id клієнта, undefined] → JSON → [id клієнта, null].
    const sent = JSON.parse(JSON.stringify(['customer-1', undefined]))
    expect(sent).toEqual(['customer-1', null])
    const args = normalizeRemoteTenantArguments('desktop:pos:list-customer-vehicles', sent)
    expect(args).toEqual(['customer-1', undefined])
    const list = (customerId: string, tenantId = 'default-shop') => [customerId, tenantId]
    expect(list(...(args as [string, string?]))).toEqual(['customer-1', 'default-shop'])
  })

  it('keeps a real shop number and touches only shop positions', () => {
    expect(normalizeRemoteTenantArguments('desktop:pos:list-customer-vehicles', ['c', 'shop-a'])).toEqual(['c', 'shop-a'])
    expect(normalizeRemoteTenantArguments('desktop:pos:delete-customer-vehicle', ['c', null, null])).toEqual(['c', null, undefined])
    expect(normalizeRemoteTenantArguments('desktop:catalog:list-products', [null])).toEqual([null])
  })

  it('every network command of the main PC goes through this step, not only the web ones', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const lan = main.slice(main.indexOf('async function executeLanCommand('), main.indexOf('async function createWindow('))
    expect(lan).toContain('normalizeRemoteTenantArguments(channel, args)')
  })
})
