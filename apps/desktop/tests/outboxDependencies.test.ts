import { describe, expect, it } from 'vitest'
import { SYNC_OPERATIONS, type SyncEntity } from '@crm-forsage/shared'
import { outboxDependencyKeys } from '../src/repositories/outboxDependencies'

/**
 * Каталог операцій каже, що операція тягне за собою по зовнішньому ключу.
 * Черга каси має ставити рівно ці бар'єри — інакше товар полетить попереду
 * свого бренда, впаде на `products_brand_id_fkey`, а за ним посиплеться прихід
 * і ревізія. Саме так у серпні 2026-го не долетіли 341 товар і 21 накладна.
 *
 * Ці два описи легко розʼїхати: вони в різних застосунках. Тест не дає.
 */
describe('залежності черги і каталог операцій', () => {
  const TENANT = 'tenant-1'

  /** Сутності, за якими черга справді тримає порядок. */
  const ORDERED: SyncEntity[] = ['brand', 'category', 'supplier', 'product', 'invoice']

  /**
   * Свідомо НЕ бар'єри. Клієнт і зміна на сервері вже є або створюються поруч,
   * продаж і сесія ревізії лікуються повтором. Зайвий бар'єр заморозив би чужі
   * чеки через одну невдалу дрібницю — цього ми навмисно уникаємо.
   */
  const NOT_ORDERED: SyncEntity[] = ['customer', 'sale', 'order', 'inventory_session', 'shift']

  /** Як сутність виглядає в payload операції. */
  function payloadFor(entity: SyncEntity, id: string): Record<string, unknown> {
    switch (entity) {
      case 'brand': return { brand_id: id }
      case 'category': return { category_id: id }
      case 'supplier': return { supplier_id: id }
      case 'product': return { items: [{ product_id: id }] }
      case 'invoice': return { invoice_id: id }
      default: return {}
    }
  }

  it('кожна залежність із каталогу стає бар\'єром у черзі', () => {
    const missing: string[] = []

    for (const [operationType, spec] of Object.entries(SYNC_OPERATIONS)) {
      for (const entity of spec.references ?? []) {
        if (!ORDERED.includes(entity as SyncEntity)) continue
        const id = `${entity}-id`
        const keys = outboxDependencyKeys(
          { tenant_id: TENANT, aggregate_type: 'unrelated', aggregate_id: 'self' },
          payloadFor(entity as SyncEntity, id),
        )
        if (!keys.includes(`${TENANT}:reference:${entity}:${id}`)) {
          missing.push(`${operationType} → ${entity}`)
        }
      }
    }

    expect(missing, 'черга не тримає порядок для залежності з каталогу').toEqual([])
  })

  it('операція завжди є бар\'єром сама для себе', () => {
    const keys = outboxDependencyKeys(
      { tenant_id: TENANT, aggregate_type: 'product', aggregate_id: 'p-1' },
      {},
    )
    expect(keys).toContain(`${TENANT}:aggregate:product:p-1`)
    // Товар — ще й довідник для всіх, хто на нього посилається.
    expect(keys).toContain(`${TENANT}:reference:product:p-1`)
  })

  it('те, що навмисно не бар\'єр, бар\'єром не стає', () => {
    const keys = outboxDependencyKeys(
      { tenant_id: TENANT, aggregate_type: 'sale', aggregate_id: 's-1' },
      { customer_id: 'c-1', shift_id: 'sh-1', sale_id: 'other-sale' },
    )
    for (const entity of NOT_ORDERED) {
      expect(keys.some((key) => key.includes(`:reference:${entity}:`)))
        .toBe(false)
    }
  })

  it('бренд і категорія товару потрапляють у бар\'єри — та сама помилка серпня', () => {
    const keys = outboxDependencyKeys(
      { tenant_id: TENANT, aggregate_type: 'product', aggregate_id: 'p-1' },
      { brand_id: 'b-1', category_id: 'c-1' },
    )
    expect(keys).toContain(`${TENANT}:reference:brand:b-1`)
    expect(keys).toContain(`${TENANT}:reference:category:c-1`)
  })

  it('накладна тримає порядок за постачальником і кожним своїм товаром', () => {
    const keys = outboxDependencyKeys(
      { tenant_id: TENANT, aggregate_type: 'supply_invoice', aggregate_id: 'i-1' },
      { supplier_id: 'sup-1', items: [{ product_id: 'p-1' }, { product_id: 'p-2' }] },
    )
    expect(keys).toContain(`${TENANT}:reference:supplier:sup-1`)
    expect(keys).toContain(`${TENANT}:reference:product:p-1`)
    expect(keys).toContain(`${TENANT}:reference:product:p-2`)
    expect(keys).toContain(`${TENANT}:reference:invoice:i-1`)
  })
})
