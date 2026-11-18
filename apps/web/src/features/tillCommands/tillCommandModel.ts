import type { ProductFormData } from '@/types/product'

/** Поля картки, які можна змінити з вебу через касу. Ціна — у копійках. */
export interface TillProductFields {
  name?: string
  sku?: string
  barcode?: string | null
  retail_price?: number
  storage_bin?: string | null
  notes?: string | null
}
export interface TillProductUpdate { product_id: string; base: TillProductFields; changes: TillProductFields }
export interface TillCardSnapshot {
  name: string; sku: string; barcode: string | null; retail_price: number; purchase_price: number
  storage_bin: string | null; notes?: string | null; is_active?: number | boolean; is_service?: number | boolean
}

export const TILL_FIELD_LABELS: Record<keyof TillProductFields, string> = {
  name: 'Назва', sku: 'Артикул', barcode: 'Штрихкод', retail_price: 'Ціна продажу', storage_bin: 'Комірка', notes: 'Примітка',
}

const norm = (field: keyof TillProductFields, value: unknown) => field === 'retail_price'
  ? Number(value ?? 0) : String(value ?? '').trim() || null

export function cardFields(card: TillCardSnapshot): Required<TillProductFields> {
  return { name: card.name, sku: card.sku, barcode: card.barcode ?? null, retail_price: Number(card.retail_price),
    storage_bin: card.storage_bin ?? null, notes: card.notes ?? null }
}

/** Лише змінені поля + те, що бачив працівник: так каса розпізнає, що картку встигли змінити. */
export function buildTillUpdate(productId: string, seen: TillCardSnapshot, edited: Required<TillProductFields>): TillProductUpdate | null {
  const before = cardFields(seen)
  const base: TillProductFields = {}, changes: TillProductFields = {}
  for (const field of Object.keys(TILL_FIELD_LABELS) as Array<keyof TillProductFields>) {
    if (norm(field, before[field]) === norm(field, edited[field])) continue
    Object.assign(base, { [field]: norm(field, before[field]) })
    Object.assign(changes, { [field]: norm(field, edited[field]) })
  }
  return Object.keys(changes).length ? { product_id: productId, base, changes } : null
}

const kopecksToForm = (value: number) => (value / 100).toFixed(2)

/**
 * Перевірка на касі перед записом. Повертає зміни для звичайного збереження картки
 * або кидає помилку зі зрозумілою причиною (вона піде назад у веб).
 */
export function planTillProductUpdate(current: TillCardSnapshot | null, update: TillProductUpdate): Partial<ProductFormData> {
  if (!current) throw new Error('Товар не знайдено в базі каси (можливо, його видалено або об’єднано).')
  if (current.is_service === 1 || current.is_service === true) throw new Error('Це послуга, а не товар. Змініть її на касі.')
  const now = cardFields(current)
  const form: Partial<ProductFormData> = {}
  for (const [field, desired] of Object.entries(update.changes) as Array<[keyof TillProductFields, unknown]>) {
    if (!(field in TILL_FIELD_LABELS)) throw new Error('Це поле з вебу змінювати не можна.')
    const value = norm(field, desired), seen = norm(field, update.base[field]), actual = norm(field, now[field])
    if (actual !== seen && actual !== value) throw new Error(`Поле «${TILL_FIELD_LABELS[field]}» вже змінили на касі. Оновіть сторінку й перевірте ще раз.`)
    if ((field === 'name' || field === 'sku') && !value) throw new Error(`Поле «${TILL_FIELD_LABELS[field]}» не може бути порожнім.`)
    if (field === 'retail_price') {
      const price = Number(value)
      if (!Number.isInteger(price) || price < 0) throw new Error('Некоректна ціна.')
      // Жорстке правило власника: товар не відпускається нижче закупівельної ціни.
      if (price < Number(current.purchase_price)) throw new Error(`Ціна нижча за закупівельну (${kopecksToForm(Number(current.purchase_price))} грн). Не збережено.`)
      form.retail_price = kopecksToForm(price)
    } else {
      Object.assign(form, { [field]: value ?? '' })
    }
  }
  return form
}
