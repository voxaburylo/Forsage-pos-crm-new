import { describe, expect, it } from 'vitest'
import { safeProblemDetail, technicalShape } from '../src/diagnostics/problemDetails'

/**
 * 26.11.2026 (аудит): «Технічна помилка [unknown]» — 101 раз на сканері ревізії (20.11) і 13 разів на її завершенні
 * (25.11); причину за відбитком уже не відновити. Форма помилки без даних магазину тепер лишається в журналі.
 */
describe('a technical error keeps its shape in the problem log, never shop data', () => {
  it('database constraints and typical code errors are named', () => {
    expect(technicalShape('SqliteError: NOT NULL constraint failed: inventory_items.counted_qty')).toBe('NOT NULL constraint failed: inventory_items.counted_qty')
    expect(technicalShape("Error invoking remote method 'desktop:inventory:complete': SqliteError: UNIQUE constraint failed: inventory_movements.id")).toBe('UNIQUE constraint failed: inventory_movements.id')
    expect(technicalShape("TypeError: Cannot read properties of undefined (reading 'qty_on_hand')\n    at complete (C:\\Users\\Someone\\app.js:1:1)")).toBe("Cannot read properties of undefined (reading 'qty_on_hand')")
    expect(technicalShape('Error: no such column: p.is_archived')).toBe('no such column: p.is_archived')
    expect(technicalShape('database is locked')).toBe('database is locked')
  })

  it('anything that may carry names, numbers or paths stays a fingerprint only', () => {
    for (const text of [
      'Клієнт Іван Петренко 0671234567 не знайдений',
      'UNIQUE constraint failed: products.sku 80127 Антифриз',
      'ENOENT: no such file or directory, open C:\\Users\\Someone\\photo.png',
      'Request failed with status 500: {"customer":"Іван"}',
      "Cannot read properties of undefined (reading 'Іван Петренко')",
      'something went wrong with order 12345',
    ]) expect(technicalShape(text), text).toBeNull()
  })

  it('the log line shows the shape, and a stored line with a shape is read back unchanged', () => {
    const detail = safeProblemDetail('SqliteError: NOT NULL constraint failed: inventory_items.counted_qty', 'ipc.desktop:inventory:complete')!
    expect(detail).toMatch(/^Технічна помилка; причину можна зіставити за відбитком: NOT NULL constraint failed: inventory_items\.counted_qty \[unknown\]\. Відбиток: [a-f0-9]{20}\.$/)
    expect(safeProblemDetail(detail, 'ipc.desktop:inventory:complete')).toBe(detail)
    // Невідома помилка з можливими даними — як і раніше, лише відбиток.
    expect(safeProblemDetail('boom for customer 0671234567', 'ipc.desktop:pos:checkout')).toMatch(/^Технічна помилка; причину можна зіставити за відбитком \[unknown\]\. Відбиток: [a-f0-9]{20}\.$/)
    // Підроблений «збережений» рядок із даними замість форми не проходить як є.
    const forged = 'Технічна помилка; причину можна зіставити за відбитком: Іван Петренко 0671234567 [unknown]. Відбиток: 0123456789abcdef0123.'
    expect(safeProblemDetail(forged, 'ipc.desktop:pos:checkout')).not.toContain('0671234567')
  })
})
