import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { roleRights, roleSwitches } from './staffRights'

// 24.11.2026: блок «Права» в картці працівника має казати правду — звіряємо його з меню програми.
describe('rights block in the staff card', () => {
  const sidebar = readFileSync(new URL('../../components/Sidebar.tsx', import.meta.url), 'utf8')
  const menuRoles = (label: string) => sidebar.split('\n').find(line => line.includes(`label: '${label}'`)) ?? ''

  it('every role with a login has a description, and the tire worker is told there is no login', () => {
    for (const role of ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer']) expect(roleRights(role).can.length).toBeGreaterThan(0)
    expect(roleRights('tire_worker')).toEqual({ can: [], cannot: ['Входу в програму немає — лише виконавець робіт шиномонтажу'] })
    expect(roleRights('unknown')).toEqual({ can: [], cannot: [] })
  })

  it('matches the menu: orders are closed for the cashier and open for the manager; staff and settings only for the owner', () => {
    expect(menuRoles('Замовлення')).toContain("'manager'")
    expect(menuRoles('Замовлення')).not.toContain("'cashier'")
    expect(roleRights('cashier').cannot.join(' ')).toContain('Замовлення')
    expect(roleRights('manager').can.join(' ')).toContain('замовлення')
    for (const label of ['Працівники', 'Налаштування']) expect(menuRoles(label)).toContain("['owner','admin']")
    expect(menuRoles('Видати зарплату')).toContain("'cashier'")
    expect(menuRoles('Поступлення товарів')).toContain("'cashier'")
    expect(menuRoles('Аналітика')).not.toContain("'storekeeper'")
  })

  it('shows the owner switches by role', () => {
    expect(roleSwitches('cashier')).toEqual(['orders', 'purchase_prices', 'reports', 'writeoffs', 'web'])
    expect(roleSwitches('manager')).toEqual(['sale', 'deposit', 'purchase_prices', 'writeoffs'])
    expect(roleSwitches('storekeeper')).toEqual(['orders'])
    expect(roleSwitches('owner')).toEqual([])
    expect(roleSwitches('tire_worker')).toEqual([])
  })
})
