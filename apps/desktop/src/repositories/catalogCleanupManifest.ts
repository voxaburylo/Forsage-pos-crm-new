// Keep in step with server/services/sync/catalogCleanupMirror.ts. No database writes.
// Conservative projected size includes the longest permitted reason and local snapshot overhead.
import { productSearchText } from './catalogRepository'
type Row = Record<string, any>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const placeholder = '00000000-0000-4000-8000-000000000000'
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const text = (value: unknown, min: number, max: number, trim = false) => typeof value === 'string'
  && (trim ? value.trim().length : value.length) >= min && (trim ? value.trim().length : value.length) <= max
const validId = (value: unknown) => typeof value === 'string' && UUID.test(value)
const object = (row: Row) => JSON.parse(row.specs_json || '{}') as Row
const cleanRow = ({ brand: _brand, ...row }: Row) => row

export function catalogCleanupManifestBlockers(input: { tenant_id: string; target_id: string; source_ids: string[]; stock_review: string },
  selected: Row[], metadata: { product_barcodes: Row[]; product_aliases: Row[]; product_cross_numbers: Row[] }, codes: string[], total: number): string[] {
  const blockers: string[] = [], target = selected[0], sources = selected.slice(1), timestamp = new Date().toISOString()
  if (!validId(input.tenant_id) || input.tenant_id !== input.tenant_id.toLowerCase()
    || selected.some(row => !validId(row.id) || row.id !== row.id.toLowerCase() || row.tenant_id !== input.tenant_id)) blockers.push('Картка має несумісний ідентифікатор UUID; злиття ще не можна передати серверу.')
  for (const row of selected) {
    if (!text(row.sku, 1, 100)) blockers.push('Артикул має бути заповнений і містити до 100 символів: ' + row.name)
    if (!text(row.name, 1, 1000)) blockers.push('Назва має містити від 1 до 1000 символів: ' + row.id)
    if (row.barcode != null && !text(row.barcode, 0, 100)) blockers.push('Штрихкод картки має понад 100 символів: ' + row.name)
    if (row.brand_id != null && !validId(row.brand_id)) blockers.push('Бренд має несумісний ідентифікатор: ' + row.name)
  }
  for (const row of sources) if (!text(row.name, 1, 300)) blockers.push('Стара назва дубля має понад 300 символів; її неможливо зберегти як пошуковий псевдонім без обрізання: ' + row.id)
  for (const [kind, rows] of Object.entries(metadata)) for (const row of rows) {
    if (!validId(row.id) || !validId(row.product_id) || row.tenant_id !== input.tenant_id
      || !date(row.created_at) || !date(row.updated_at) || (row.deleted_at != null && !date(row.deleted_at))) blockers.push('Несумісний ідентифікатор або дата метаданих: ' + kind + ' / ' + row.id)
    if (kind === 'product_barcodes' && (!text(row.barcode, 1, 100, true) || (row.barcode_type !== undefined && !text(row.barcode_type, 0, 20))
      || ![true, false, 0, 1].includes(row.is_primary))) blockers.push('Некоректний штрихкод або його тип: ' + row.id)
    if (kind === 'product_aliases' && !text(row.alias, 1, 300)) blockers.push('Пошуковий псевдонім має містити від 1 до 300 символів: ' + row.id)
    if (kind === 'product_cross_numbers' && (!text(row.cross_number, 1, 100, true)
      || !String(row.cross_number ?? '').replace(/[\s\-.\/_]/g, '')
      || (row.brand != null && !text(row.brand, 0, 100)) || (row.source !== undefined && !text(row.source, 0, 200))
      || (row.notes != null && typeof row.notes !== 'string'))) blockers.push('Некоректний крос-номер або його примітки: ' + row.id)
  }
  const barcodes: Row[] = metadata.product_barcodes.map(row => ({ ...row }))
  const barcodeByValue = new Map(barcodes.map(row => [row.barcode, row]))
  for (const barcode of codes) {
    const existing = barcodeByValue.get(barcode)
    if (existing) Object.assign(existing, { product_id: target.id, is_primary: barcode === target.barcode ? 1 : 0, deleted_at: null, updated_at: timestamp })
    else barcodes.push({ id: placeholder, tenant_id: input.tenant_id, product_id: target.id, barcode, barcode_type: 'EAN13', is_primary: barcode === target.barcode ? 1 : 0, created_at: timestamp, updated_at: timestamp, deleted_at: null })
  }
  const aliases: Row[] = metadata.product_aliases.map(row => ({ ...row, product_id: target.id, updated_at: timestamp }))
  const aliasValues = new Set(aliases.filter(row => !row.deleted_at).map(row => row.alias))
  for (const source of sources) for (const alias of [source.name, source.sku].filter(Boolean)) {
    if (!aliasValues.has(alias)) {
      aliases.push({ id: placeholder, tenant_id: input.tenant_id, product_id: target.id, alias, created_at: timestamp, updated_at: timestamp, deleted_at: null }); aliasValues.add(alias)
    }
  }
  const crosses: Row[] = metadata.product_cross_numbers.map(row => ({ ...row, updated_at: timestamp }))
  const sourceCopies = sources.map(row => {
    const saved = object(row), prior = saved.cleanup_barcodes
    if (prior !== undefined && (!Array.isArray(prior) || prior.some(code => !text(code, 1, 100)))) blockers.push('Пошкоджена історія штрихкодів товару: ' + row.name)
    const current = metadata.product_barcodes.filter(code => code.product_id === row.id && !code.deleted_at).map(code => code.barcode)
    const cleanup_barcodes = [...new Set([...(Array.isArray(prior) ? prior : []), row.barcode, ...current].filter(Boolean))]
    if (cleanup_barcodes.length > 5000) blockers.push('Історія штрихкодів перевищує 5000 записів: ' + row.name)
    const specs = { ...saved, cleanup_barcodes, merged_into_product_id: target.id, merge_operation_id: placeholder }
    return { ...cleanRow(row), specs, specs_json: JSON.stringify(specs), qty_on_hand: 0, is_active: false, deleted_at: timestamp, updated_at: timestamp, dirty_at: timestamp }
  })
  const targetSpecs = object(target)
  const specs = { ...targetSpecs, cleanup_sources: [...(Array.isArray(targetSpecs.cleanup_sources) ? targetSpecs.cleanup_sources : []), ...sources.map(row => ({
    id: row.id, sku: row.sku, name: row.name, barcode: row.barcode, brand_id: row.brand_id, category_id: row.category_id, unit: row.unit,
    purchase_price: row.purchase_price, retail_price: row.retail_price, photo_url: row.photo_url, notes: row.notes, storage_bin: row.storage_bin,
    specs: object(row), merge_operation_id: placeholder,
  }))], cleanup_stock_review: { status: input.stock_review, user_id: placeholder, at: timestamp, operation_id: placeholder } }
  const searchText = productSearchText({ id: target.id, sku: target.sku, name: target.name, barcode: target.barcode, storage_bin: target.storage_bin,
    additional_barcodes: barcodes.filter(row => !row.deleted_at && row.product_id === target.id).map(row => row.barcode) }, [...aliasValues])
  const products = [{ ...cleanRow(target), search_text: searchText, specs, specs_json: JSON.stringify(specs), qty_on_hand: total, is_active: true, updated_at: timestamp, dirty_at: timestamp }, ...sourceCopies]
  for (const [kind, rows] of [['Штрихкоди', barcodes], ['Псевдоніми', aliases], ['Крос-номери', crosses]] as const) if (rows.length > 5000) blockers.push(kind + ': після злиття буде понад 5000 записів; пакет несумісний із сервером.')
  const projected = { version: 1, operation_id: placeholder, target_id: target.id, source_ids: input.source_ids, products, barcodes, aliases, cross_numbers: crosses,
    stock_review: input.stock_review, reason: '', user_id: placeholder, merged_at: timestamp }
  // Reserve 16 KiB for the maximum JSON-escaped reason, generated row defaults,
  // boolean encoding differences and the <=21 signed current balance entries.
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') + 16_384 > 2_000_000) blockers.push('Пакет злиття перевищує безпечний ліміт 2 МБ. Оберіть меншу групу; історію й назви не буде обрізано.')
  return [...new Set(blockers)]
}

export function assertCleanupActorId(userId: string): void {
  if (!validId(userId)) throw new Error('Працівник має несумісний ідентифікатор UUID; злиття не записано.')
}
