import { describe, expect, it } from 'vitest'
import { analyzeCatalogCleanup, type CleanupProduct } from '../src/repositories/catalogCleanupMatcher'
import { savedStateBlocker } from '../src/repositories/catalogCleanupRepository'

// 26.11.2026, власник: «третій день не можу нормально розбирати товар». У журналі чату — 20 відмов каси «Немає достатніх ознак
// тотожності» на парах із назвами, однаковими буква в букву. Причина: власний артикул картки вирізався з її назви.
function card(id: string, name: string, sku: string | null, barcode: string | null = null, extra: Partial<CleanupProduct> = {}): CleanupProduct {
  return { id, name, sku, barcode, brand: null, unit: 'шт', qty_on_hand: 0, purchase_price: 100, retail_price: 200, ...extra }
}
const group = (a: CleanupProduct, b: CleanupProduct) => analyzeCatalogCleanup([a, b]).groups[0]

describe('cards with the very same name can be merged whatever stands in the article field', () => {
  it.each([
    ['Щетка стеклоочистителя гибкая Elegant Hybrid 600 мм 24 EL 300360', '300360', '89565'],
    ['Ремінь поліклиновий BOSCH 1987946251', '1987946251', 'AUTO-E81937D34A434B6293D1383F97EE953C'],
    ['Ключ балонный Alca 420 100 17х19х21х23мм крестовой', '88815', '420100'],
    ['Ремкомплект супорта ERT 400142 Audi/Mersedes/BMW 60mm', '400142', '78655'],
    ['Насадка на глушитель 106 030 Elegant (0087) 51-63-145мм', '106030', '88797'],
  ])('«%s» (articles %s and %s) — the real refused pair', (name, skuA, skuB) => {
    const found = group(card('a', name, skuA, '2000998836894'), card('b', name, skuB))
    expect(found).toBeDefined()
    expect(found.level).not.toBe('conflict')
    expect(found.product_ids).toEqual(['a', 'b'])
  })

  it('spaces and letter case do not matter; a different size in the name still means different goods', () => {
    expect(group(card('a', 'Свічки  NGK  BKR6E s', '11111'), card('b', 'свічки ngk bkr6e S', '22222'))).toBeDefined()
    expect(group(card('a', 'Щетка Elegant 600 мм EL 300360', '300360'), card('b', 'Щетка Elegant 650 мм EL 300365', '300365'))).toBeUndefined()
  })

  it('the same name with two different lettered maker articles stays refused (different goods)', () => {
    expect(group(card('a', 'Комплект проводів запалювання', 'CSW-2302M'), card('b', 'Комплект проводів запалювання', 'CSW-2601MT'))).toBeUndefined()
  })

  it('names the reason in plain words instead of a service key', () => {
    expect(savedStateBlocker('lan-order-workspace:u1')).toMatch(/бланку замовлення/)
    expect(savedStateBlocker('pos-open-cart:other-user')).toMatch(/відкритому чеку/)
    expect(savedStateBlocker('operator-session:other')).not.toMatch(/operator-session:other/)
  })
})
