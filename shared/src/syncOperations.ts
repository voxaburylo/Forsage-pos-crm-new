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
  /** Хто може надсилати. owner та admin можуть усе — їх тут не перелічуємо. */
  roles: SyncRole[]
}

/** Ролі, яким дозволено все: власник і адміністратор магазину. */
export const SYNC_SUPERUSER_ROLES: readonly SyncRole[] = ['owner', 'admin']

export const SYNC_OPERATIONS: Record<string, SyncOperationSpec> = {
  'brand.deleted': { roles: [] },
  'brand.upsert': { creates: 'brand', roles: ['manager', 'cashier', 'storekeeper'] },
  'cash_operation.created': { references: ['shift'], roles: ['manager', 'cashier'] },
  'category.deleted': { roles: [] },
  'category.upsert': { creates: 'category', roles: ['manager', 'cashier', 'storekeeper'] },
  'commission_rule.created': { references: ['brand', 'category'], roles: [] },
  'commission_rule.deleted': { roles: [] },
  'customer.bonus_adjusted': { roles: ['manager'] },
  'customer.created': { creates: 'customer', roles: ['manager', 'cashier'] },
  'customer.debt_paid': { references: ['customer', 'shift'], roles: ['manager', 'cashier'] },
  'customer.deleted': { roles: [] },
  'customer.deposit_changed': { references: ['customer', 'shift'], roles: ['manager', 'cashier'] },
  'customer.updated': { roles: ['manager', 'cashier'] },
  'customer_vehicle.created': { references: ['customer'], roles: ['manager', 'cashier'] },
  'customer_vehicle.deleted': { roles: ['manager', 'cashier'] },
  'customer_vehicle.updated': { roles: ['manager', 'cashier'] },
  'inventory.completed': { references: ['product', 'inventory_session'], roles: ['cashier'] },
  'inventory.created': { creates: 'inventory_session', roles: ['cashier', 'storekeeper'] },
  'inventory.deleted': { roles: ['cashier', 'storekeeper'] },
  'inventory.started': { references: ['inventory_session'], roles: ['cashier', 'storekeeper'] },
  'order.canceled': { roles: ['manager'] },
  'order.completed': { roles: ['manager', 'cashier'] },
  'order.created': { creates: 'order', references: ['customer', 'product'], roles: ['manager'] },
  'order.deleted': { roles: [] },
  'order.item_status_updated': { roles: ['manager', 'storekeeper'] },
  'order.items_arrived': { roles: ['manager', 'storekeeper'] },
  'order.payment_added': { roles: ['manager', 'cashier'] },
  'order.status_updated': { roles: ['manager'] },
  'order.updated': { references: ['customer', 'product'], roles: ['manager'] },
  'product.deleted': { roles: [] },
  'product.upsert': { creates: 'product', references: ['brand', 'category'], roles: ['manager', 'cashier', 'storekeeper'] },
  'reserve.created': { references: ['product'], roles: ['manager', 'storekeeper'] },
  'reserve.released': { roles: ['manager', 'storekeeper'] },
  'return.created': { references: ['product', 'sale'], roles: ['manager', 'cashier'] },
  'salary_payment.created': { roles: [] },
  'salary_payment.deleted': { roles: [] },
  'sale.completed': { creates: 'sale', references: ['product', 'customer', 'shift'], roles: ['manager', 'cashier'] },
  'sale.suspended': { references: ['product', 'customer', 'shift'], roles: ['manager', 'cashier'] },
  'sale.suspended_deleted': { roles: ['manager', 'cashier'] },
  'sale.suspended_resumed': { roles: ['manager', 'cashier'] },
  'settings.updated': { roles: [] },
  'shift.closed': { roles: ['manager', 'cashier'] },
  'shift.opened': { creates: 'shift', roles: ['manager', 'cashier'] },
  'staff_pin.updated': { roles: [] },
  'staff_user.created': { roles: [] },
  'staff_user.deleted': { roles: [] },
  'staff_user.updated': { roles: [] },
  'supplier.created': { creates: 'supplier', roles: ['manager', 'cashier', 'storekeeper'] },
  'supplier.deleted': { roles: [] },
  'supplier.merged': { roles: [] },
  'supplier.updated': { roles: ['manager'] },
  'supplier_catalog.imported': { roles: [] },
  'supplier_catalog.item_deleted': { roles: [] },
  'supplier_catalog.item_upserted': { roles: [] },
  'supplier_invoice.cancelled': { roles: [] },
  'supplier_invoice.created': { creates: 'invoice', references: ['supplier', 'product'], roles: ['manager', 'cashier', 'storekeeper'] },
  'supplier_invoice.deleted': { roles: ['cashier'] },
  'supplier_invoice.payment_added': { roles: ['manager', 'cashier', 'storekeeper'] },
  'supplier_invoice.posted': { roles: ['manager', 'cashier', 'storekeeper'] },
  'supplier_invoice.updated': { references: ['supplier', 'product'], roles: ['manager', 'cashier', 'storekeeper'] },
  'warehouse_movement.created': { references: ['product'], roles: ['manager', 'storekeeper'] },
  'writeoff.created': { references: ['product'], roles: ['manager', 'storekeeper'] },
}

/** Чи можна цій ролі надсилати таку операцію. Невідомий тип — ні. */
export function isSyncOperationAllowed(role: string, operationType: string): boolean {
  if (SYNC_SUPERUSER_ROLES.includes(role as SyncRole)) return true
  const spec = SYNC_OPERATIONS[operationType]
  return spec ? spec.roles.includes(role as SyncRole) : false
}

/** Операції, які народжують саме цю сутність. */
export function operationsCreating(entity: SyncEntity): string[] {
  return Object.entries(SYNC_OPERATIONS)
    .filter(([, spec]) => spec.creates === entity)
    .map(([type]) => type)
}
