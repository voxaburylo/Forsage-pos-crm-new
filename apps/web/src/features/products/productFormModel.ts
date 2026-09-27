import { hryvniaToKopecks, kopecksToHryvnia, type ProductCreateData, type ProductFormData } from '@/types/product'

export function productMoneyInput(value: string | undefined, label: string): number {
  try { return hryvniaToKopecks(value?.trim() || '') }
  catch { throw new Error(label + ': введіть коректну суму у гривнях, не більше двох знаків після коми.') }
}

export function productHasNegativeMargin(purchase: string, retail: string): boolean {
  if (!purchase.trim() || !retail.trim()) return false
  try { return productMoneyInput(purchase, 'Закупівельна ціна') > productMoneyInput(retail, 'Роздрібна ціна') }
  catch { return false } // Field validation explains incomplete/invalid input on save.
}

export function suggestedRetailText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error('Розрахована ціна некоректна. Перевірте таблицю націнки.')
  }
  return kopecksToHryvnia(value)
}

export function createdProductReference(response: unknown): { id: string; name: string } {
  const value = response && typeof response === 'object' && 'data' in response ? response.data : response
  if (!value || typeof value !== 'object' || !('id' in value) || !('name' in value)
    || typeof value.id !== 'string' || !value.id.trim() || typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('Не вдалося підтвердити створення категорії або бренду. Оновіть довідник перед повторною спробою.')
  }
  return { id: value.id, name: value.name }
}

/** Validate the whole editor before starting a write; never send its observed stock. */
export function productEditorPayload(form: ProductFormData, canSeeMargin: boolean): ProductCreateData {
  const payload: ProductCreateData = { ...form }
  delete payload.qty_on_hand
  payload.sku = form.sku.trim()
  payload.name = form.name.trim()
  payload.barcode = form.barcode.trim()
  if (!payload.sku) throw new Error('Артикул обов’язковий')
  if (payload.name.length < 2) throw new Error('Назва мінімум 2 символи')
  if (!form.retail_price.trim()) throw new Error('Вкажіть роздрібну ціну')
  payload.retail_price = kopecksToHryvnia(productMoneyInput(form.retail_price, 'Роздрібна ціна'))
  if (canSeeMargin) {
    payload.purchase_price = kopecksToHryvnia(productMoneyInput(form.purchase_price, 'Закупівельна ціна'))
  } else {
    delete payload.purchase_price
  }
  if (form.core_deposit_amount !== undefined) {
    payload.core_deposit_amount = kopecksToHryvnia(productMoneyInput(form.core_deposit_amount, 'Заставна сума'))
  }
  const reorder = (form.reorder_point.trim() || '0').replace(',', '.')
  if (!/^\d+(?:\.\d{1,3})?$/.test(reorder) || Number(reorder) > Number.MAX_SAFE_INTEGER / 1000) {
    throw new Error('Мінімальний залишок: введіть невід’ємне число, не більше трьох знаків після коми.')
  }
  payload.reorder_point = String(Number(reorder))
  return payload
}
