import { it, expect } from 'vitest'
import { navigationAllowed } from './navigationAccess'
// 22.11.2026, рішення власника «веб повний, але тільки через головний ПК»: розділи запису видно у вебі,
// а відкриваються вони лише коли головний ПК на звʼязку (TillOnly). Каса й друк — лише на касі.
it('offers web destinations; sale and printing stay on the till', () => {
  for (const path of ['/pos', '/orders/new', '/suppliers/invoices/new', '/labels']) expect(navigationAllowed(path, false)).toBe(false)
  for (const path of ['/products', '/customers', '/analytics', '/reports', '/inventory', '/suppliers/invoices', '/ai-assistant', '/staff', '/settings']) expect(navigationAllowed(path, false)).toBe(true)
  expect(navigationAllowed('/pos', true)).toBe(true)
})
