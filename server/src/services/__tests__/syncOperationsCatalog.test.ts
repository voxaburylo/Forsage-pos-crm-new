import { syncModuleSource as source } from './helpers/syncSource.js'
import { describe, expect, it } from 'vitest'
import {
  SYNC_OPERATIONS,
  isSyncOperationAllowed,
  operationsCreating,
  type SyncEntity,
} from '@crm-forsage/shared'

/**
 * Двічі за два тижні магазин втратив дані через одну й ту саму помилку: ролі
 * дозволили створювати сутність, але не дозволили надіслати довідник, на який
 * та посилається. Спершу бренд (02.09.2026, не долетіли 341 товар і 21
 * накладна), потім постачальник (05.09.2026, вмерли 2 накладні і 22 операції
 * за ними). Обидва рази це помічали через тижні — по скарзі «кількості немає».
 *
 * Ці тести роблять третій раз неможливим.
 */
describe('каталог операцій синхронізації', () => {
  it('роль, якій дозволено операцію, може надіслати й усе, на що та посилається', () => {
    const gaps: string[] = []

    for (const [operationType, spec] of Object.entries(SYNC_OPERATIONS)) {
      for (const entity of spec.references ?? []) {
        const creators = operationsCreating(entity as SyncEntity)
        expect(creators.length, `нікому не дозволено створювати «${entity}»`).toBeGreaterThan(0)

        for (const role of spec.roles) {
          const canCreate = creators.some((creator) => isSyncOperationAllowed(role, creator))
          if (!canCreate) {
            gaps.push(`${role}: може «${operationType}», але не може створити «${entity}» (${creators.join(' / ')})`)
          }
        }
      }
    }

    expect(gaps, 'ланцюжок обірветься на зовнішньому ключі — саме так зникали товари й накладні').toEqual([])
  })

  it('кожна операція, яку сервер уміє застосувати, описана в каталозі', () => {
        const handled = new Set(
      [...source.matchAll(/operation\.operation_type === '([a-z_.]+)'/g)].map((match) => match[1]),
    )

    const undocumented = [...handled].filter((type) => !(type in SYNC_OPERATIONS)).sort()
    // Незадекларована операція мовчки дістається лише власнику: касир отримає
    // «Недостатньо прав», черга стане, і шукати причину доведеться в логах.
    expect(undocumented, 'додали обробник, але забули описати права в каталозі').toEqual([])
  })

  it('власник і адміністратор можуть усе, решта — лише описане', () => {
    for (const role of ['owner', 'admin']) {
      expect(isSyncOperationAllowed(role, 'sale.completed')).toBe(true)
      expect(isSyncOperationAllowed(role, 'operation.that.does.not.exist')).toBe(true)
    }
    for (const role of ['manager', 'cashier', 'storekeeper', 'tire_worker', 'sto_viewer']) {
      expect(isSyncOperationAllowed(role, 'operation.that.does.not.exist')).toBe(false)
    }
  })

  it('те, що народжує сутність, не залежить від ролі — інакше довідник нікому не створити', () => {
    const entities: SyncEntity[] = [
      'brand', 'category', 'supplier', 'product', 'customer',
      'invoice', 'sale', 'order', 'inventory_session', 'shift',
    ]
    for (const entity of entities) {
      expect(operationsCreating(entity), `сутність «${entity}» ніхто не створює`).not.toEqual([])
    }
  })
})
