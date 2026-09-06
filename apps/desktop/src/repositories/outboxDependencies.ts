/**
 * Порядок у черзі: що за чим має їхати на сервер.
 *
 * Товар не можна відправити раніше за його бренд, накладну — раніше за
 * постачальника й товари. Інакше сервер відхилить операцію на зовнішньому
 * ключі, а за нею посиплеться все, що на неї спиралося: саме так у серпні
 * 2026-го не долетіли 341 товар і 21 накладна.
 *
 * Перелік того, що операція тягне за собою, живе в спільному каталозі
 * (`shared/src/syncOperations.ts`) — там же, де права ролей. Тут лише витяг
 * конкретних ідентифікаторів із payload; тест `outboxDependencies.test.ts`
 * стежить, щоб ці два описи не розʼїхалися.
 *
 * Свідомо НЕ бар'єри: клієнт, зміна, продаж, сесія ревізії. Вони або вже є на
 * сервері, або операція по них полагодиться повтором — а зайвий бар'єр
 * заморозив би чужі чеки через одну невдалу дрібницю.
 */
export interface OutboxDependencyRow {
  tenant_id: string
  aggregate_type: string
  aggregate_id: string
}


export function outboxDependencyKeys(row: OutboxDependencyRow, payload: any): string[] {
  const prefix = row.tenant_id
  const keys = new Set<string>([
    `${prefix}:aggregate:${row.aggregate_type}:${row.aggregate_id}`,
  ])
  const addReference = (type: 'supplier' | 'product' | 'invoice' | 'brand' | 'category', value: unknown) => {
    if (typeof value === 'string' && value) keys.add(`${prefix}:reference:${type}:${value}`)
  }

  if (row.aggregate_type === 'supplier') addReference('supplier', row.aggregate_id)
  if (row.aggregate_type === 'product') addReference('product', row.aggregate_id)
  if (row.aggregate_type === 'supply_invoice') addReference('invoice', row.aggregate_id)
  // Бренд і категорія — такі самі залежності товару, як постачальник для
  // накладної. Без цього товар летить попереду свого бренда і падає на
  // зовнішньому ключі, а за ним валиться прихід і ревізія.
  if (row.aggregate_type === 'brand') addReference('brand', row.aggregate_id)
  if (row.aggregate_type === 'category') addReference('category', row.aggregate_id)
  addReference('brand', payload?.brand_id)
  addReference('category', payload?.category_id)

  addReference('supplier', payload?.supplier_id)
  addReference('supplier', payload?.primary_supplier_id)
  addReference('supplier', payload?.duplicate_supplier_id)
  addReference('supplier', payload?.import?.supplier_id)
  addReference('product', payload?.product_id)
  addReference('invoice', payload?.invoice_id)
  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    addReference('product', item?.product_id)
  }
  return [...keys]
}
