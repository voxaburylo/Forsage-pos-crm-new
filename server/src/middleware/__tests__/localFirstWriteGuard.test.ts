import { describe, expect, it } from 'vitest'
import { isWriteAllowed } from '../localFirstWriteGuard.js'

/**
 * Рішення власника 06.09.2026: локальна база на касі — єдина. Через веб можна
 * дивитися продажі, аналітику, шукати й переглядати товари; продавати, правити
 * й робити ревізію — тільки на касі.
 *
 * Причина не в безпеці, а в порядку: дві точки запису в одну базу неминуче
 * дають розбіжність. Ми її вже бачили — залишки, які «не сходяться».
 */
function req(method: string, path: string, client?: string) {
  return {
    method,
    path,
    get: (name: string) => (name.toLowerCase() === 'x-forsage-client' ? client : undefined),
  } as any
}

describe('веб тільки дивиться, пише лише каса', () => {
  it('дивитися можна звідусіль', () => {
    for (const path of ['/api/v1/sales', '/api/v1/products', '/api/v1/analytics/abc']) {
      expect(isWriteAllowed(req('GET', path))).toBe(true)
      expect(isWriteAllowed(req('HEAD', path))).toBe(true)
    }
  })

  it('змінювати з вебу не можна — ні продати, ні виправити, ні провести ревізію', () => {
    const forbidden: Array<[string, string]> = [
      ['POST', '/api/v1/sales'],
      ['POST', '/api/v1/returns'],
      ['PUT', '/api/v1/products/123'],
      ['POST', '/api/v1/products'],
      ['DELETE', '/api/v1/customers/123'],
      ['POST', '/api/v1/inventory/sessions'],
      ['POST', '/api/v1/suppliers/invoices'],
      ['POST', '/api/v1/cash-operations'],
      ['POST', '/api/v1/writeoffs'],
    ]
    for (const [method, path] of forbidden) {
      expect(isWriteAllowed(req(method, path)), `${method} ${path}`).toBe(false)
    }
  })

  it('каса пише все те саме — вона представляється заголовком', () => {
    for (const [method, path] of [['POST', '/api/v1/sales'], ['PUT', '/api/v1/products/1']]) {
      expect(isWriteAllowed(req(method, path, 'desktop'))).toBe(true)
    }
  })

  it('черга синхронізації приймається лише від каси', () => {
    expect(isWriteAllowed(req('POST', '/api/v1/sync/push'))).toBe(false)
    expect(isWriteAllowed(req('POST', '/api/v1/sync/bootstrap'))).toBe(false)
    expect(isWriteAllowed(req('POST', '/api/v1/sync/push', 'desktop'))).toBe(true)
    expect(isWriteAllowed(req('POST', '/api/v1/sync/bootstrap', 'desktop'))).toBe(true)
  })

  it('веб може лише керувати своєю сесією; решта auth-змін — тільки з каси', () => {
    expect(isWriteAllowed(req('POST', '/api/v1/auth/login'))).toBe(true)
    expect(isWriteAllowed(req('POST', '/api/v1/auth/refresh'))).toBe(true)
    expect(isWriteAllowed(req('POST', '/api/v1/auth/logout'))).toBe(true)
    expect(isWriteAllowed(req('POST', '/api/v1/auth/set-pin'))).toBe(false)
    expect(isWriteAllowed(req('POST', '/api/v1/auth/change-password'))).toBe(false)
    expect(isWriteAllowed(req('POST', '/api/v1/auth/set-pin', 'desktop'))).toBe(true)
  })

  it('вебхуки й службові задачі — не дані магазину, їх не чіпаємо', () => {
    expect(isWriteAllowed(req('POST', '/api/v1/telegram/webhook'))).toBe(true)
    expect(isWriteAllowed(req('POST', '/api/v1/internal/ai-cross-enrichment'))).toBe(true)
    expect(isWriteAllowed(req('POST', '/api/v1/jobs/run'))).toBe(true)
  })

  it('схожа адреса не відкриває лазівку', () => {
    // «/api/v1/syncing» не є «/api/v1/sync/» — префікс перевіряється зі слешем.
    expect(isWriteAllowed(req('POST', '/api/v1/syncing'))).toBe(false)
    expect(isWriteAllowed(req('POST', '/api/v1/authentic'))).toBe(false)
  })
})
