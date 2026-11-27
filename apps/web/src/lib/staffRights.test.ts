import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultStaffRights, mergeStaffRights, SWITCHABLE_RIGHTS } from './staffRights'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 24.11.2026 (рішення власника): права працівника перемикачами в картці; екран довіряє лише головному ПК і ролі.
describe('staff rights on the screen', () => {
  it('until the main PC answers, the screen shows only what the role gives', () => {
    expect(defaultStaffRights('owner')).toEqual({ orders: true, purchase_prices: true, reports: true, writeoffs: true })
    expect(defaultStaffRights('manager')).toEqual({ orders: true, purchase_prices: false, reports: true, writeoffs: false })
    expect(defaultStaffRights('cashier')).toEqual({ orders: false, purchase_prices: false, reports: false, writeoffs: false })
    expect(defaultStaffRights('storekeeper')).toEqual({ orders: false, purchase_prices: true, reports: false, writeoffs: true })
  })

  it('an answer from the main PC only adds rights that the owner may switch on for this role', () => {
    expect(mergeStaffRights('cashier', { orders: true, purchase_prices: false, reports: true })).toEqual({ orders: true, purchase_prices: false, reports: true, writeoffs: false })
    expect(mergeStaffRights('manager', { orders: false, reports: false, purchase_prices: true })).toEqual({ orders: true, purchase_prices: true, reports: true, writeoffs: false })
    // Чужа чи зіпсована відповідь нічого не відкриває.
    expect(mergeStaffRights('sto_viewer', { orders: true, purchase_prices: true, reports: true })).toEqual({ orders: false, purchase_prices: false, reports: false, writeoffs: false })
    for (const answer of [null, 'yes', [], { orders: 'true', reports: 1 }]) expect(mergeStaffRights('cashier', answer)).toEqual(defaultStaffRights('cashier'))
  })

  it('the screen and the main PC agree on who may get which switch', () => {
    const till = read('../../../desktop/src/security/staffRights.ts')
    expect(till).toContain("orders: ['cashier', 'storekeeper'],\n  purchase_prices: ['cashier', 'manager'],\n  reports: ['cashier'],")
    expect(till).toContain("orders: ['owner', 'admin', 'manager'],\n  purchase_prices: ['owner', 'admin', 'storekeeper'],\n  reports: ['owner', 'admin', 'manager'],")
    expect(SWITCHABLE_RIGHTS).toEqual({ orders: ['cashier', 'storekeeper'], purchase_prices: ['cashier', 'manager'], reports: ['cashier'], writeoffs: ['manager', 'cashier'] })
    // 27.11.2026: «Списує товар» можна ввімкнути й касиру — на потреби магазину, з коментарем.
    expect(till).toContain("writeoffs: ['manager', 'cashier'],")
  })

  it('the rights open exactly these places: orders section, statistics, purchase price in the product card', () => {
    const app = read('../App.tsx')
    for (const route of ['/orders"', '/orders/new"', '/orders/:id"', '/orders/:id/add"', '/orders/:id/edit"', '/needs-action"', '/quotes/new"', '/quotes/:id"', '/chats"']) {
      const line = app.split('\n').find(item => item.includes('<Route path="' + route)) ?? ''
      expect(line, route).toContain('<ProtectedRoute roles={OFFICE_ROLES} right="orders">')
    }
    expect(app).toContain('<Route path="/analytics/statistics" element={<ProtectedRoute roles={OFFICE_ROLES} right="reports">')
    expect(app.match(/right="reports"/g)).toHaveLength(1)
    expect(read('../components/ProtectedRoute.tsx')).toContain('if (roles && !roles.includes(role) && !(right && rights[right])) {')
    expect(read('../components/Sidebar.tsx')).toContain("label: 'Замовлення',           roles: ['owner','admin','manager'], right: 'orders' },")
    for (const file of ['../features/products/ProductDetailPage.tsx', '../features/products/ProductFormPage.tsx']) {
      expect(read(file)).toContain('const canSeeMargin = useStaffRights().purchase_prices')
    }
  })
})
