import type { AiSupplyRow } from './aiSupplyImport'
import { MAX_SUPPLY_ROWS, normalizeSupplyRows } from './aiSupplyImport'

type Metadata = { supplier_id?: string; supplier_name?: string; invoice_number?: string }
export class AiSupplyResponseError extends Error {
  constructor(message: string, readonly kind: 'missing-table' | 'invalid-part' | 'conflict') {
    super(message)
    this.name = 'AiSupplyResponseError'
  }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** All-or-nothing boundary: validate every response/action BEFORE flattening rows.
 * Does not deduplicate valid repeated lines or infer missing fields from another part.
 */
export function collectSupplyResponse(responses: readonly unknown[], expectedParts: number): { products: AiSupplyRow[]; metadata: Metadata } {
  if (!Number.isInteger(expectedParts) || expectedParts < 1 || responses.length !== expectedParts)
    throw new AiSupplyResponseError('Отримано не всі частини накладної. Неповну накладну не створено.', 'invalid-part')
  const products: AiSupplyRow[] = []
  const metadata: Metadata = {}
  for (const [partIndex, response] of responses.entries()) {
    const part = 'Частина ' + (partIndex + 1)
    if (!record(response) || !Array.isArray(response.actions) || !response.actions.length)
      throw new AiSupplyResponseError(part + ': ШІ повернув відповідь без таблиці приходу.', 'missing-table')
    for (const action of response.actions) {
      if (!record(action) || !['create_products_bulk', 'create_supply_invoice_bulk'].includes(String(action.tool)))
        throw new AiSupplyResponseError(part + ': ШІ повернув відповідь без таблиці приходу.', 'missing-table')
      if (!record(action.payload) || !Array.isArray(action.payload.products) || !action.payload.products.length)
        throw new AiSupplyResponseError(part + ': одна з таблиць товарів порожня або пошкоджена. Неповну накладну не створено.', 'invalid-part')
      const rows = action.payload.products
      if (action.count !== undefined && (!Number.isInteger(action.count) || action.count !== rows.length))
        throw new AiSupplyResponseError(part + ': заявлена кількість позицій не збігається з таблицею. Повторіть розбір.', 'invalid-part')
      if (products.length + rows.length > MAX_SUPPLY_ROWS)
        throw new AiSupplyResponseError('За один раз можна розібрати до ' + MAX_SUPPLY_ROWS + ' позицій. Розділіть файл.', 'invalid-part')
      products.push(...normalizeSupplyRows(rows))
      for (const key of ['supplier_id', 'supplier_name', 'invoice_number'] as const) {
        const value = action.payload[key]
        if (value === undefined || value === null || value === '') continue
        if (typeof value !== 'string')
          throw new AiSupplyResponseError(part + ': некоректні реквізити накладної. Повторіть розбір.', 'invalid-part')
        const normalized = value.trim()
        if (!normalized) continue
        if (metadata[key] !== undefined && metadata[key] !== normalized)
          throw new AiSupplyResponseError('У частинах різні постачальники або номери накладної. Розділіть документи та повторіть розбір.', 'conflict')
        metadata[key] = normalized
      }
    }
  }
  return { products, metadata }
}
