import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalProduct } from '../db/localTypes'
import { LocalCatalogRepository } from './catalogRepository'
import { LocalSupplyRepository } from './supplyRepository'
import { idempotentMutation } from './idempotentMutation'

export class CatalogBatchRepository {
  constructor(private db: LocalDatabase, private catalog: LocalCatalogRepository) {}
  apply(input: { operation_id: string; kind: 'import' | 'bulk'; payload: any }): any {
    if (!/^[0-9a-f-]{36}$/i.test(input.operation_id)) throw new Error('Відсутній ідентифікатор операції')
    if (!['import', 'bulk'].includes(input.kind)) throw new Error('Невідомий тип пакета')
    const rows = input.kind === 'import' ? input.payload?.items : input.payload?.productIds
    if (!Array.isArray(rows) || !rows.length || rows.length > 50000) throw new Error('Некоректний пакет товарів')
    return idempotentMutation(this.db, 'catalog-batch:' + DEFAULT_TENANT_ID, input.operation_id, input, () => {
      if (input.kind === 'import') return importProducts(this.db, this.catalog, input.payload)
      const ids = [...new Set<string>(input.payload.productIds)]
      const u = input.payload.updates
      const price = (current: number, fixed: unknown, action: any, purchase: number): number => {
        let value = fixed === undefined ? current : Number(fixed)
        if (fixed === undefined && action) {
          const n = Number(action.value)
          if (!Number.isFinite(n)) throw new Error('Некоректна зміна ціни')
          if (action.type === 'percent') value = current * (1 + n / 100)
          else if (action.type === 'amount') value = current + n
          else if (action.type === 'markup') value = purchase * (1 + n / 100)
          else throw new Error('Невідома зміна ціни')
        }
        if (!Number.isFinite(value) || value < 0) throw new Error('Ціна має бути невід’ємною')
        return Math.round(value)
      }
      for (const id of ids) {
        const product = this.catalog.findById(id)
        if (!product) throw new Error('Товар не знайдено: ' + id)
        const purchase = price(product.purchase_price, u.purchase_price, u.purchase_price_action, product.purchase_price)
        const retail = price(product.retail_price, u.retail_price, u.retail_price_action, purchase)
        this.catalog.saveProduct(existingPayload(product, {
          purchase_price: purchase, retail_price: retail,
          ...(u.category_id !== undefined ? { category_id: u.category_id } : {}),
          ...(u.is_active !== undefined ? { is_active: u.is_active } : {}),
        }))
      }
      return { updated: ids.length }
    })
  }
}

function retailFromSettings(price: number, settings: any): number {
  const rules = Array.isArray(settings?.markup_rules) ? settings.markup_rules : []
  const rule = rules.find((candidate: any) =>
    price >= Number(candidate.minPrice) && price < Number(candidate.maxPrice))
  const result = Math.round(price * (1 + Number(rule?.markupPct ?? 30) / 100))
  if (settings?.price_rounding_enabled !== true) return result
  const step = Math.max(1, Number(settings.price_rounding_step) || 100)
  const scaled = result / step
  const rounded = settings.price_rounding_dir === 'up' ? Math.ceil(scaled)
    : settings.price_rounding_dir === 'down' ? Math.floor(scaled) : Math.round(scaled)
  return rounded * step
}

function productSpecs(product: LocalProduct & Record<string, any>): Record<string, string> {
  try {
    const value = JSON.parse(product.specs_json ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

function existingPayload(product: LocalProduct & Record<string, any>, changes: Record<string, unknown>) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    barcode: product.barcode,
    brand_id: product.brand_id ?? null,
    category_id: product.category_id ?? null,
    unit: product.unit,
    purchase_price: product.purchase_price,
    retail_price: product.retail_price,
    qty_on_hand: Number(product.qty_on_hand),
    reorder_point: Number(product.reorder_point ?? 0),
    notes: product.notes ?? null,
    storage_bin: product.storage_bin,
    is_active: product.is_active === 1,
    is_service: product.is_service === 1,
    is_favorite: product.is_favorite === 1,
    photo_url: product.photo_url ?? null,
    requires_core_return: Boolean(product.requires_core_return),
    core_deposit_amount: Number(product.core_deposit_amount ?? 0),
    specs: productSpecs(product),
    ...changes,
  }
}

function importProducts(db: LocalDatabase, catalog: LocalCatalogRepository, body: any): any {
  if (body.mode !== undefined && !['add', 'replace'].includes(body.mode)) throw new Error('Невідомий режим імпорту')
  const bridge = { catalog: { saveProduct: catalog.saveProduct.bind(catalog), listCategories: catalog.listCategories.bind(catalog), createCategory: catalog.createCategory.bind(catalog), getSettings: catalog.getSettings.bind(catalog) }, supply: new LocalSupplyRepository(db) }
  const save = bridge?.catalog.saveProduct
  if (!bridge || !save) throw new Error('Локальна база недоступна')
  const current = db.prepare('SELECT * FROM products WHERE tenant_id = ? AND deleted_at IS NULL').all(DEFAULT_TENANT_ID) as unknown as LocalProduct[]
  const products = new Map(current.map((product) => [product.id, product]))
  const categories = bridge.catalog.listCategories?.() ?? []
  const categoryIds = new Map(categories.map((category) =>
    [category.name.trim().toLocaleLowerCase('uk-UA'), category.id]))
  for (const item of body.items) {
    if (!Number.isFinite(item.qty) || item.qty < 0 || !Number.isFinite(item.price) || item.price < 0) throw new Error('Некоректна кількість або ціна в рядку ' + item.row);
    const name = item.category_name?.trim()
    const key = name?.toLocaleLowerCase('uk-UA')
    if (name && key && !categoryIds.has(key) && bridge.catalog.createCategory) {
      const category = bridge.catalog.createCategory(name)
      categoryIds.set(key, category.id)
    }
  }
  const settings = bridge.catalog.getSettings?.() ?? {}
  const invoiceItems: Array<{ product_id: string; qty: number; purchase_price: number; total: number }> = []
  let created = 0
  let updated = 0
  let errors = 0
  for (const item of body.items) {
    let product = item.product_id ? products.get(item.product_id) : undefined
    if (item.product_id && !product) throw new Error('Товар у рядку ' + item.row + ' видалено. Оновіть зіставлення.');
    if (product && item.barcode) {
      const barcodeOwner = catalog.findByBarcode(item.barcode);
      if (barcodeOwner && barcodeOwner.id !== product.id) throw new Error('Артикул і штрихкод належать різним товарам у рядку ' + item.row);
    }
    if (!product && !body.create_missing) { errors += 1; continue }
    const categoryId = item.category_name
      ? categoryIds.get(item.category_name.trim().toLocaleLowerCase('uk-UA')) ?? null
      : product?.category_id ?? null
    const retail = item.retail_price ?? retailFromSettings(item.price, settings)
    if (!product) {
      product = save({
        id: randomUUID(),
        sku: item.sku ? item.sku.trim() : 'IMP-' + Date.now() + '-' + item.row,
        name: item.name,
        barcode: item.barcode || null,
        category_id: categoryId,
        unit: 'шт',
        purchase_price: item.price,
        retail_price: retail,
        qty_on_hand: body.supplier_id ? 0 : item.qty,
        reorder_point: 0,
        storage_bin: item.storage_bin || null,
        is_active: true,
      })
      products.set(product.id, product)
      created += 1
    } else if (!body.supplier_id) {
      const nextQty = body.mode === 'add' ? Number(product.qty_on_hand) + item.qty : item.qty
      product = save(existingPayload(product, {
        sku: item.sku ? item.sku.trim() : product.sku,
        name: item.name || product.name,
        barcode: item.barcode || product.barcode,
        category_id: categoryId,
        purchase_price: item.price,
        retail_price: body.update_retail === false ? product.retail_price : retail,
        qty_on_hand: nextQty,
        stock_correction: true,
        storage_bin: item.storage_bin || product.storage_bin,
      }))
      products.set(product.id, product)
      updated += 1
    } else if (body.supplier_id) {
      const changes: Record<string, unknown> = {}
      if (item.name && item.name !== product.name) changes.name = item.name
      if (item.barcode && item.barcode !== product.barcode) changes.barcode = item.barcode
      if (categoryId && categoryId !== product.category_id) changes.category_id = categoryId
      if (item.storage_bin && item.storage_bin !== product.storage_bin) changes.storage_bin = item.storage_bin
      if (Object.keys(changes).length > 0) {
        product = save(existingPayload(product, changes))
        products.set(product.id, product)
      }
    }
    if (body.supplier_id) {
      invoiceItems.push({
        product_id: product.id,
        qty: item.qty,
        purchase_price: item.price,
        total: Math.round(item.qty * item.price),
      })
    }
  }
  if (body.supplier_id) {
    if (!invoiceItems.length) throw new Error('Немає товарів для створення накладної')
    const invoice = bridge.supply?.createInvoice({
      supplier_id: body.supplier_id,
      invoice_number: body.invoice_number ?? null,
      notes: body.notes ?? null,
      items: invoiceItems,
    })
    if (!invoice) throw new Error('Не вдалося створити локальну накладну')
    return { data: invoice }
  }
  return { data: { created, updated, errors } }
}
