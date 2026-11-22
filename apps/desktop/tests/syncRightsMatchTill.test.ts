import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

/**
 * 22.11.2026. Правило «каса головна»: усе, що каса дозволила працівникові й записала, мусить дійти
 * до копії на сервері під сесією будь-кого, хто зараз на зміні (черга спільна на пристрій).
 * Досі сервер вимагав власника для дій, які каса дозволяє менеджеру чи комірнику: запис лишався
 * «не відправлено», доки на касі не ввійде власник (видалення товарів чекали в середньому 107 годин).
 *
 * Каталог сервера читаємо як текст: імпортувати його через межу пакета не можна (свій rootDir).
 */
function serverScopes(): Map<string, 'shop' | 'admin'> {
  const source = readFileSync(new URL('../../../server/src/services/sync/operationsCatalog.ts', import.meta.url), 'utf8')
  const scopes = new Map<string, 'shop' | 'admin'>()
  for (const match of source.matchAll(/'([a-z_.]+)': \{[^}]*scope: '(shop|admin)'/g)) scopes.set(match[1], match[2] as 'shop' | 'admin')
  if (scopes.size < 40) throw new Error('не вдалося прочитати області операцій із каталогу сервера')
  return scopes
}

/** Дія каси → операція, яку вона кладе в чергу на сервер. */
const TILL_ACTIONS: Array<[channel: string, operation: string]> = [
  ['desktop:catalog:delete-product', 'product.deleted'],
  ['desktop:orders:delete', 'order.deleted'],
  ['desktop:supply:delete-supplier', 'supplier.deleted'],
  ['desktop:supply:merge-suppliers', 'supplier.merged'],
  ['desktop:supply:cancel-invoice', 'supplier_invoice.cancelled'],
  ['desktop:supplier-catalog:import-rows', 'supplier_catalog.imported'],
  ['desktop:supplier-catalog:delete', 'supplier_catalog.item_deleted'],
  ['desktop:supplier-catalog:create', 'supplier_catalog.item_upserted'],
  ['desktop:supplier-catalog:update', 'supplier_catalog.item_upserted'],
  ['desktop:pos:delete-customer', 'customer.deleted'],
  ['desktop:catalog:delete-category', 'category.deleted'],
  ['desktop:catalog:delete-brand', 'brand.deleted'],
  ['desktop:catalog:update-settings', 'settings.updated'],
  ['desktop:catalog:cleanup-apply', 'product.catalog_cleanup'],
  ['desktop:staff:save-user', 'staff_user.updated'],
  ['desktop:staff:create-user', 'staff_user.created'],
  ['desktop:staff:delete-user', 'staff_user.deleted'],
  ['desktop:staff:add-payment', 'salary_payment.created'],
  ['desktop:staff:delete-payment', 'salary_payment.deleted'],
  ['desktop:staff:save-commission-rule', 'commission_rule.created'],
  ['desktop:staff:delete-commission-rule', 'commission_rule.deleted'],
]
/** Ті, під чиєю сесією йде черга, крім власника й адміністратора (їм сервер дозволяє все). */
const SHIFT_ROLES = ['manager', 'cashier', 'storekeeper']

describe('права сервера на обмін збігаються з правами каси', () => {
  const scopes = serverScopes()

  it('усе, що каса дозволяє працівникові, сервер приймає під звичайною зміною', () => {
    const gaps: string[] = []
    for (const [channel, operation] of TILL_ACTIONS) {
      expect(scopes.has(operation), `операції «${operation}» немає в каталозі сервера`).toBe(true)
      const allowedOnTill = SHIFT_ROLES.filter(role => isDesktopChannelAllowed(channel, role))
      if (allowedOnTill.length && scopes.get(operation) !== 'shop')
        gaps.push(`${channel} дозволено на касі (${allowedOnTill.join(', ')}), а «${operation}» сервер приймає лише від власника`)
    }
    expect(gaps, gaps.join('\n')).toEqual([])
  })

  it('адміністративне на сервері лишається лише тим, що й на касі робить тільки власник', () => {
    for (const [channel, operation] of TILL_ACTIONS) {
      if (scopes.get(operation) !== 'admin') continue
      for (const role of SHIFT_ROLES) expect(isDesktopChannelAllowed(channel, role), `${channel} для ${role}`).toBe(false)
    }
  })
})
