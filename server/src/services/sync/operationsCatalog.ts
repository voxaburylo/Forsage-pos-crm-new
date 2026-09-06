/**
 * УВАГА: цей каталог живе на сервері, а не в `shared`, і це навмисно.
 * Пакет `shared` віддає сирий TypeScript, тому зібраний сервер не може
 * імпортувати його в рантаймі — 06.09.2026 такий імпорт поклав Vercel-функцію
 * (FUNCTION_INVOCATION_FAILED на всіх адресах) і зупинив збірку на Render.
 * Каталог потрібен серверу в рантаймі й касі лише в тестах, тому місце йому
 * тут; тест каси імпортує його відносним шляхом.
 */

/**
 * Каталог операцій синхронізації — одне місце, де записано, що означає кожна
 * операція каси.
 *
 * Навіщо. Досі кожна операція була описана двічі: у касі (локальний запис) і на
 * сервері (окремий обробник плюс окремий список прав). Списки розʼїжджалися
 * мовчки, і це двічі коштувало магазину даних:
 *
 * - 02.09.2026 касиру дозволили «product.upsert», але забули «brand.upsert» —
 *   не долетіли 141 бренд, 341 товар і 21 накладна;
 * - 05.09.2026 дозволили накладну, але забули «supplier.created» — вмерли
 *   2 постачальники, 2 накладні і 22 операції за ними.
 *
 * Це той самий баг двічі. Тепер права живуть тут, а тест не дає забути
 * довідник: якщо роль може створити сутність, вона мусить могти надіслати й те,
 * на що ця сутність посилається в тому самому акті.
 */

/** Сутності, які каса створює сама і надсилає на сервер. */
export type SyncEntity =
  | 'brand' | 'category' | 'supplier' | 'product' | 'customer'
  | 'invoice' | 'sale' | 'order' | 'inventory_session' | 'shift'

export type SyncRole =
  | 'owner' | 'admin' | 'manager' | 'cashier' | 'storekeeper' | 'sto_viewer' | 'tire_worker'

/**
 * Хто має право надіслати операцію.
 *
 * `shop` — звичайна робота магазину: чек, накладна, ревізія, картка клієнта.
 * Приймається від будь-якого працівника, бо **черга спільна на весь пристрій**.
 * Менеджер створив замовлення вранці, чергу відправила сесія касира ввечері —
 * і операція має пройти. Перевірка «за тим, хто натиснув» ламала саме це: до
 * 06.09.2026 такий рядок відхилявся, а за ним ставало все, що на нього
 * спиралося. Право робити дію стережеться там, де дія робиться — у самій касі
 * (`desktopAuthorization.ts`, 177 каналів, fail-closed), а не на виході черги.
 *
 * `admin` — адміністративна зміна: працівники, ПІН-коди, налаштування,
 * правила комісії, зарплати, видалення довідників. Тут перевірка сесії
 * лишається: такі операції не робляться «принагідно» під час зміни.
 */
export type SyncOperationScope = 'shop' | 'admin'

/** Ролі, яким дозволена звичайна робота магазину. */
export const SYNC_SHOP_ROLES: readonly SyncRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper']

export interface SyncOperationSpec {
  /** Яку сутність операція народжує — якщо народжує. */
  creates?: SyncEntity
  /**
   * На що операція посилається В ТОМУ САМОМУ АКТІ: товар несе бренд і
   * категорію, накладна — постачальника й товари. Сюди свідомо НЕ входять
   * посилання на створене раніше кимось іншим (оплата замовлення посилається
   * на замовлення, але створює його менеджер окремою дією).
   */
  references?: SyncEntity[]
  /** Область: звичайна робота магазину чи адміністративна зміна. */
  scope: SyncOperationScope
}

/** Ролі, яким дозволено все: власник і адміністратор магазину. */
export const SYNC_SUPERUSER_ROLES: readonly SyncRole[] = ['owner', 'admin']

export const SYNC_OPERATIONS: Record<string, SyncOperationSpec> = {
  'brand.deleted': { scope: 'admin' },
  'brand.upsert': { creates: 'brand', scope: 'shop' },
  'cash_operation.created': { references: ['shift'], scope: 'shop' },
  'category.deleted': { scope: 'admin' },
  'category.upsert': { creates: 'category', scope: 'shop' },
  'commission_rule.created': { references: ['brand', 'category'], scope: 'admin' },
  'commission_rule.deleted': { scope: 'admin' },
  'customer.bonus_adjusted': { scope: 'shop' },
  'customer.created': { creates: 'customer', scope: 'shop' },
  'customer.debt_paid': { references: ['customer', 'shift'], scope: 'shop' },
  'customer.deleted': { scope: 'admin' },
  'customer.deposit_changed': { references: ['customer', 'shift'], scope: 'shop' },
  'customer.updated': { scope: 'shop' },
  'customer_vehicle.created': { references: ['customer'], scope: 'shop' },
  'customer_vehicle.deleted': { scope: 'shop' },
  'customer_vehicle.updated': { scope: 'shop' },
  'inventory.completed': { references: ['product', 'inventory_session'], scope: 'shop' },
  'inventory.created': { creates: 'inventory_session', scope: 'shop' },
  'inventory.deleted': { scope: 'shop' },
  'inventory.started': { references: ['inventory_session'], scope: 'shop' },
  'order.canceled': { scope: 'shop' },
  'order.completed': { scope: 'shop' },
  'order.created': { creates: 'order', references: ['customer', 'product'], scope: 'shop' },
  'order.deleted': { scope: 'admin' },
  'order.item_status_updated': { scope: 'shop' },
  'order.items_arrived': { scope: 'shop' },
  'order.payment_added': { scope: 'shop' },
  'order.status_updated': { scope: 'shop' },
  'order.updated': { references: ['customer', 'product'], scope: 'shop' },
  'product.deleted': { scope: 'admin' },
  'product.upsert': { creates: 'product', references: ['brand', 'category'], scope: 'shop' },
  'reserve.created': { references: ['product'], scope: 'shop' },
  'reserve.released': { scope: 'shop' },
  'return.created': { references: ['product', 'sale'], scope: 'shop' },
  'salary_payment.created': { scope: 'admin' },
  'salary_payment.deleted': { scope: 'admin' },
  'sale.completed': { creates: 'sale', references: ['product', 'customer', 'shift'], scope: 'shop' },
  'sale.suspended': { references: ['product', 'customer', 'shift'], scope: 'shop' },
  'sale.suspended_deleted': { scope: 'shop' },
  'sale.suspended_resumed': { scope: 'shop' },
  'settings.updated': { scope: 'admin' },
  'shift.closed': { scope: 'shop' },
  'shift.opened': { creates: 'shift', scope: 'shop' },
  'staff_pin.updated': { scope: 'admin' },
  'staff_user.created': { scope: 'admin' },
  'staff_user.deleted': { scope: 'admin' },
  'staff_user.updated': { scope: 'admin' },
  'supplier.created': { creates: 'supplier', scope: 'shop' },
  'supplier.deleted': { scope: 'admin' },
  'supplier.merged': { scope: 'admin' },
  'supplier.updated': { scope: 'shop' },
  'supplier_catalog.imported': { scope: 'admin' },
  'supplier_catalog.item_deleted': { scope: 'admin' },
  'supplier_catalog.item_upserted': { scope: 'admin' },
  'supplier_invoice.cancelled': { scope: 'admin' },
  'supplier_invoice.created': { creates: 'invoice', references: ['supplier', 'product'], scope: 'shop' },
  'supplier_invoice.deleted': { scope: 'shop' },
  'supplier_invoice.payment_added': { scope: 'shop' },
  'supplier_invoice.posted': { scope: 'shop' },
  'supplier_invoice.updated': { references: ['supplier', 'product'], scope: 'shop' },
  'warehouse_movement.created': { references: ['product'], scope: 'shop' },
  'writeoff.created': { references: ['product'], scope: 'shop' },
}

/** Чи можна цій ролі надсилати таку операцію. Невідомий тип — ні. */
export function isSyncOperationAllowed(role: string, operationType: string): boolean {
  if (SYNC_SUPERUSER_ROLES.includes(role as SyncRole)) return true
  const spec = SYNC_OPERATIONS[operationType]
  if (!spec) return false
  return spec.scope === 'shop' && SYNC_SHOP_ROLES.includes(role as SyncRole)
}

/** Операції, які народжують саме цю сутність. */
export function operationsCreating(entity: SyncEntity): string[] {
  return Object.entries(SYNC_OPERATIONS)
    .filter(([, spec]) => spec.creates === entity)
    .map(([type]) => type)
}
