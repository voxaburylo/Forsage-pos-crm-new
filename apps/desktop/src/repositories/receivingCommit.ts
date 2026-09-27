import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalProductUpsert } from '../db/localTypes'
import { LocalCatalogRepository } from './catalogRepository'
import { LocalSupplyRepository } from './supplyRepository'
import { assertDocumentRevision, requireDocumentRevision } from './documentRevision'
import { idempotentMutation } from './idempotentMutation'
import { checkedSupplyMoney, normalizeSupplyItem } from './supplyValidation'

export interface ReceivingProductBase {
  name: string; sku: string; barcode: string | null; category_id: string | null
  storage_bin: string | null; retail_price: number; photo_url: string | null
}
export interface ReceivingLine {
  client_key: string; product_id?: string; is_new?: boolean
  product_name: string; sku: string; barcode?: string | null; unit?: string
  qty: number; purchase_price: number; retail_price: number; total?: number
  category_id?: string | null; storage_bin?: string | null; photo_url?: string | null
  product_base?: ReceivingProductBase
}
export interface ReceivingCommitInput {
  operation_id: string; invoice_id: string; expected_revision?: string
  tenant_id?: string; user_id?: string | null; supplier_id: string
  invoice_number?: string | null; notes?: string | null; items: ReceivingLine[]
  payments: Array<{ amount: number; payment_method: 'cash' | 'card' | 'transfer'
    fund_source: 'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'
    shift_id?: string | null; note?: string | null }>
}
const clean = (value: unknown) => String(value ?? '').trim()
const nullable = (value: unknown) => clean(value) || null
const skuKey = (value: unknown) => clean(value).normalize('NFKC').toLocaleUpperCase('uk-UA')
const nameKey = (value: unknown) => clean(value).normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ')
const barcodeKey = (value: unknown) => clean(value).replace(/[\s\-._/]+/g, '')
const fields = ['name', 'sku', 'barcode', 'category_id', 'storage_bin', 'retail_price', 'photo_url'] as const
function productFields(row: any): ReceivingProductBase {
  return { name: clean(row.name), sku: clean(row.sku), barcode: nullable(row.barcode),
    category_id: nullable(row.category_id), storage_bin: nullable(row.storage_bin),
    retail_price: Number(row.retail_price), photo_url: nullable(row.photo_url) }
}
function productInput(row: any): LocalProductUpsert {
  return { id: row.id, tenant_id: row.tenant_id, sku: row.sku, name: row.name, barcode: row.barcode,
    brand_id: row.brand_id, category_id: row.category_id, unit: row.unit,
    purchase_price: row.purchase_price, retail_price: row.retail_price, qty_on_hand: row.qty_on_hand,
    reorder_point: row.reorder_point, notes: row.notes, storage_bin: row.storage_bin,
    photo_url: row.photo_url, core_deposit_amount: row.core_deposit_amount,
    is_active: Boolean(row.is_active), is_service: Boolean(row.is_service),
    is_favorite: Boolean(row.is_favorite), requires_core_return: Boolean(row.requires_core_return),
    specs: JSON.parse(row.specs_json || '{}') }
}
function lineFailure(index: number, message: string): never {
  // Retain the row index across Electron error localization, without raw SQL.
  throw new Error(`RECEIVING_LINE:${index}: Рядок ${index + 1}: ${message}`)
}

/** One outer BEGIN IMMEDIATE covers cards, document, split payments, stock and receipt. */
export function commitReceiving(db: LocalDatabase, input: ReceivingCommitInput): any {
  if (!input || !clean(input.operation_id) || !clean(input.invoice_id)) throw new Error('Відсутній ідентифікатор приймання')
  const tenant = input.tenant_id ?? DEFAULT_TENANT_ID
  const supply = new LocalSupplyRepository(db)
  const result = idempotentMutation(db, 'receiving:' + tenant, input.operation_id, input, () => {
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 5000) throw new Error('Перевірте кількість рядків накладної (1–5000)')
    if (!Array.isArray(input.payments) || input.payments.length > 2) throw new Error('Некоректний поділ оплати')
    if (!db.prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND is_active = 1').get(input.supplier_id, tenant))
      throw new Error('Оберіть актуального постачальника')
    const exists = db.prepare('SELECT id FROM supply_invoices WHERE id = ? AND tenant_id = ?').get(input.invoice_id, tenant)
    if (exists) {
      const invoice = supply.getInvoice(input.invoice_id, tenant)
      assertDocumentRevision(invoice.edit_revision, requireDocumentRevision(input.expected_revision), 'Накладна')
      if (invoice.status !== 'draft') throw new Error('DOCUMENT_CONFLICT: Накладну вже проведено або скасовано. Звірте документ; повторного приходу немає.')
    } else if (input.expected_revision) throw new Error('DOCUMENT_CONFLICT: Накладну вже видалено. Правки не записано.')
    const keys = new Set<string>()
    input.items.forEach((line, i) => {
      if (!clean(line.client_key) || keys.has(line.client_key)) lineFailure(i, 'Некоректний ідентифікатор рядка')
      keys.add(line.client_key)
      try { normalizeSupplyItem({ id: line.client_key, product_id: line.product_id || 'new', qty: line.qty, purchase_price: line.purchase_price, total: line.total }); checkedSupplyMoney(line.retail_price, 'Ціна продажу') }
      catch (error) { lineFailure(i, (error as Error).message) }
      if (!clean(line.product_name)) lineFailure(i, 'Вкажіть назву товару')
      if (nullable(line.category_id) && !db.prepare('SELECT id FROM categories WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(line.category_id!, tenant))
        lineFailure(i, 'Категорію видалено. Виберіть актуальну категорію.')
    })
    for (const payment of input.payments) {
      if (checkedSupplyMoney(payment.amount, 'Сума оплати') <= 0
        || !['cash', 'card', 'transfer'].includes(payment.payment_method)
        || !['cashbox', 'owner_funds', 'bank_account', 'business_card'].includes(payment.fund_source)) throw new Error('Некоректна оплата постачальнику')
    }
    const catalog = new LocalCatalogRepository(db)
    // Exact indexes: no fuzzy search, deleted-card bridges or result limits.
    const products = db.prepare('SELECT * FROM products WHERE tenant_id = ? AND deleted_at IS NULL').all(tenant) as any[]
    const archivedSkus = new Set((db.prepare('SELECT sku FROM products WHERE tenant_id = ? AND deleted_at IS NOT NULL').all(tenant) as Array<{ sku: string }>).map(row => skuKey(row.sku)))
    const byId = new Map(products.map(row => [row.id as string, row]))
    const bySku = new Map<string, Set<string>>(), byBarcode = new Map<string, Set<string>>(), byName = new Map<string, Set<string>>()
    const index = (map: Map<string, Set<string>>, key: string, id: string) => { if (key) { const ids = map.get(key) ?? new Set(); ids.add(id); map.set(key, ids) } }
    const add = (row: any) => { byId.set(row.id, row); index(bySku, skuKey(row.sku), row.id); index(byBarcode, barcodeKey(row.barcode), row.id); index(byName, nameKey(row.name), row.id) }
    products.forEach(add)
    for (const row of db.prepare(`SELECT b.product_id, b.barcode FROM product_barcodes b JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
      WHERE b.tenant_id = ? AND b.deleted_at IS NULL AND p.deleted_at IS NULL`).all(tenant) as any[]) index(byBarcode, barcodeKey(row.barcode), row.product_id)
    const invoiceItems = catalog.withSkuLookupIndex(tenant, () => input.items.map((line, i) => {
      try {
        const identifiers = new Set([...(bySku.get(skuKey(line.sku)) ?? []), ...(byBarcode.get(barcodeKey(line.barcode)) ?? [])])
        if (identifiers.size > 1) lineFailure(i, 'Артикул або штрихкод належать різним карткам. Виберіть правильний товар.')
        let product = line.product_id ? byId.get(line.product_id) : undefined
        if (line.product_id && !product) lineFailure(i, 'Вибраний товар видалено. Виберіть актуальну картку.')
        if (product && identifiers.size && !identifiers.has(product.id)) lineFailure(i, 'Введений артикул/штрихкод належить іншому товару. Виберіть його явно.')
        const linked = Boolean(product)
        if (!product && identifiers.size) product = byId.get([...identifiers][0])
        if (!product) {
          const names = byName.get(nameKey(line.product_name))
          if (names && names.size > 1) lineFailure(i, 'Є кілька товарів із точною назвою. Виберіть картку вручну.')
          if (names?.size === 1) product = byId.get([...names][0])
        }
        let saved: any
        if (product) {
          if (!product.is_active || product.is_service) lineFailure(i, 'Товар неактивний або є послугою. Перевірте картку.')
          const current = productFields(product)
          const desired: ReceivingProductBase = linked ? {
            name: clean(line.product_name), sku: clean(line.sku) || current.sku,
            barcode: nullable(line.barcode) || current.barcode, category_id: nullable(line.category_id),
            storage_bin: nullable(line.storage_bin), retail_price: line.retail_price > 0 ? line.retail_price : current.retail_price,
            photo_url: nullable(line.photo_url) || current.photo_url,
          } : { ...current, retail_price: line.retail_price > 0 ? line.retail_price : current.retail_price }
          const base = linked ? (line.product_base ?? current) : current
          if (linked && !line.product_base && fields.some(field => desired[field] !== current[field]))
            lineFailure(i, 'Стара чернетка не містить версії картки. Повторно виберіть товар, звірте ціну та внесіть правки.')
          const patch: any = {}
          for (const field of fields) if (desired[field] !== base[field]) {
            if (current[field] !== base[field] && current[field] !== desired[field]) lineFailure(i, 'Картка товару змінилася. Повторно виберіть товар і звірте правки.')
            patch[field] = desired[field]
          }
          saved = Object.keys(patch).length ? catalog.saveProduct({ ...productInput(product), ...patch }) : product
        } else {
          const sku = clean(line.sku) || 'AUTO-' + randomUUID().replace(/-/g, '').toUpperCase()
          // An archived SKU is history, not permission to revive an unrelated card.
          if (archivedSkus.has(skuKey(sku))) lineFailure(i, 'Артикул зайнятий архівною карткою. Відновіть її або змініть артикул.')
          saved = catalog.saveProduct({ id: randomUUID(), tenant_id: tenant, sku, name: clean(line.product_name),
            barcode: nullable(line.barcode), unit: clean(line.unit) || 'шт', purchase_price: line.purchase_price,
            retail_price: line.retail_price, category_id: nullable(line.category_id), storage_bin: nullable(line.storage_bin),
            photo_url: nullable(line.photo_url), qty_on_hand: 0, is_active: true, is_service: false })
        }
        // Keep indexes fresh for repeated rows in this transaction, retaining genuine extra barcodes.
        if (product) {
          bySku.get(skuKey(product.sku))?.delete(product.id)
          byName.get(nameKey(product.name))?.delete(product.id)
          if (barcodeKey(product.barcode) !== barcodeKey(saved.barcode)) byBarcode.get(barcodeKey(product.barcode))?.delete(product.id)
        }
        const stored = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(saved.id, tenant)
        add(stored)
        return { product_id: saved.id, qty: line.qty, purchase_price: line.purchase_price, total: line.total }
      } catch (error) {
        const message = (error as Error).message
        if (message.startsWith('RECEIVING_LINE:')) throw error
        lineFailure(i, /foreign key/i.test(message) ? 'Категорію або інший реквізит видалено. Виберіть актуальний.' : /unique constraint/i.test(message) ? 'Артикул або штрихкод уже зайнятий.' : message)
      }
    }))
    const body = { tenant_id: tenant, user_id: input.user_id, supplier_id: input.supplier_id,
      invoice_number: input.invoice_number, notes: input.notes, items: invoiceItems }
    let invoice = exists ? supply.updateInvoice(input.invoice_id, { ...body, expected_revision: input.expected_revision })
      : supply.createInvoice({ ...body, id: input.invoice_id, paid_amount: 0 })
    for (const payment of input.payments) invoice = supply.payInvoice(invoice.id, { ...payment, tenant_id: tenant,
      user_id: input.user_id, payment_id: randomUUID(), expected_revision: invoice.edit_revision })
    supply.postInvoice(invoice.id, { tenant_id: tenant, user_id: input.user_id, expected_revision: invoice.edit_revision })
    return { id: invoice.id as string }
  })
  return supply.getInvoice(result.id, tenant)
}
