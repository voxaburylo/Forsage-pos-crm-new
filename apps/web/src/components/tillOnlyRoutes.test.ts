import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

/**
 * Рішення власника 06.09.2026: робоча база одна — та, що на касі. Через веб
 * можна дивитися продажі, аналітику, шукати й переглядати товари. Продавати,
 * правити й робити ревізію — тільки на касі.
 *
 * Тут стережемо, щоб екрани, які існують заради зміни даних, не відкривалися у
 * вебі. Справжня межа — на сервері (`localFirstWriteGuard`), але людина не має
 * дізнаватися про неї, натиснувши «Зберегти» після пів години роботи.
 */
describe('екрани змін не відкриваються у вебі', () => {
  const mustBeTillOnly = [
    '/pos',
    '/returns',
    '/products/new',
    '/products/:id/edit',
    '/customers/new',
    '/customers/:id/edit',
    '/suppliers/new',
    '/suppliers/:id/edit',
    '/suppliers/invoices/new',
    '/suppliers/invoices/:id/edit',
    '/receiving',
    '/inventory',
    '/orders/new',
    '/orders',
    '/orders/:id',
    '/orders/:id/edit',
    '/suppliers',
    '/suppliers/invoices',
    '/quotes/new',
    '/inventory/:id',
    '/inventory/picking',
    '/inventory/movements',
    '/inventory/writeoffs/new',
  ]

  for (const path of mustBeTillOnly) {
    it(`${path} — тільки на касі`, () => {
      const route = new RegExp(`<Route\\s+path="${path.replace(/[/:]/g, (c) => '\\' + c)}"[^\\n]*`).exec(app)
      expect(route, `маршрут ${path} зник`).not.toBeNull()
      expect(route![0], `маршрут ${path} відкритий у вебі`).toContain('<TillOnly')
    })
  }

  const mustStayOpen = ['/analytics', '/sales', '/products', '/customers', '/reports']
  for (const path of mustStayOpen) {
    it(`${path} — дивитися можна`, () => {
      const route = new RegExp(`<Route\\s+path="${path}"[^\\n]*`).exec(app)
      expect(route, `маршрут ${path} зник`).not.toBeNull()
      // Перегляд у вебі має лишатися: заради нього веб і потрібен.
      expect(route![0]).not.toContain('<TillOnly')
    })
  }
})
