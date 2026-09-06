import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { LocalCatalogRepository } from './catalogRepository'
import { readOpenCashBalance } from './cashBalance'

function nowIso(): string {
  return new Date().toISOString()
}

const MAX_DATABASE_MONEY = 2_147_483_647

function money(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}

function checkedMoney(value: number, label: string): number {
  const normalized = money(value)
  if (normalized < 0) throw new Error(`${label} не може бути від’ємною`)
  if (normalized > MAX_DATABASE_MONEY) {
    throw new Error(`${label} надто велика. Перевірте, чи штрихкод випадково не потрапив у поле ціни.`)
  }
  return normalized
}

function qty(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Number(value))
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const trimmed = String(value).trim()
  return trimmed ? trimmed : null
}

interface SupplyInvoiceItemInput {
  id?: string
  product_id: string
  qty: number
  purchase_price: number
  total?: number
}

interface CreateSupplyInvoiceInput {
  id?: string
  tenant_id?: string
  supplier_id?: string | null
  invoice_number?: string | null
  notes?: string | null
  paid_amount?: number
  payment_method?: 'cash' | 'card' | 'transfer' | null
  fund_source?: 'cashbox' | 'owner_funds' | 'bank_account' | 'business_card' | null
  shift_id?: string | null
  user_id?: string | null
  items: SupplyInvoiceItemInput[]
}

interface UpdateSupplyInvoiceInput {
  tenant_id?: string
  supplier_id?: string | null
  invoice_number?: string | null
  notes?: string | null
  user_id?: string | null
  items?: SupplyInvoiceItemInput[]
}

interface PaymentInput {
  tenant_id?: string
  amount: number
  payment_method: 'cash' | 'card' | 'transfer'
  fund_source: 'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'
  shift_id?: string | null
  note?: string | null
  user_id?: string | null
  payment_id?: string
}

export class LocalSupplyRepository {
  constructor(private readonly db: LocalDatabase) {}

  listSuppliers(filters: { tenant_id?: string; search?: string; is_active?: string; page?: number; per_page?: number } = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const tenantId = filters.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(filters.page ?? 1))
    const perPage = Math.max(1, Math.min(200, Number(filters.per_page ?? 50)))
    const offset = (page - 1) * perPage
    const where = ['tenant_id = ?', 'deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (filters.is_active === 'true') where.push('is_active = 1')
    if (filters.is_active === 'false') where.push('is_active = 0')
    const search = text(filters.search)
    if (search) {
      where.push(`(
        name LIKE ? OR name LIKE ? OR name LIKE ?
        OR COALESCE(contact_name, '') LIKE ? OR COALESCE(contact_name, '') LIKE ? OR COALESCE(contact_name, '') LIKE ?
        OR phone LIKE ?
      )`)
      const raw = `%${search}%`
      const title = `%${search.charAt(0).toUpperCase()}${search.slice(1).toLowerCase()}%`
      const upper = `%${search.toUpperCase()}%`
      params.push(raw, title, upper, raw, title, upper, raw)
    }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`SELECT count(*) AS count FROM suppliers WHERE ${whereSql}`).get(...params) as { count: number }
    const rows = this.db.prepare(`
      SELECT id, name, phone, email, contact_name, notes, is_active, created_at, updated_at, deleted_at
      FROM suppliers
      WHERE ${whereSql}
      ORDER BY name ASC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset) as any[]
    return {
      data: rows.map((row) => ({ ...row, is_active: Boolean(row.is_active) })),
      pagination: {
        page,
        per_page: perPage,
        total: Number(totalRow?.count ?? 0),
        total_pages: Math.ceil(Number(totalRow?.count ?? 0) / perPage),
      },
    }
  }

  getSupplier(id: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT id, name, phone, email, contact_name, notes, is_active, created_at, updated_at, deleted_at
      FROM suppliers
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId) as any | undefined
    if (!row) throw new Error('Постачальника не знайдено')
    return { ...row, is_active: Boolean(row.is_active) }
  }

  saveSupplier(input: any, supplierId?: string): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const id = supplierId ?? randomUUID()
    const name = String(input.name ?? '').trim()
    if (!supplierId && !name) throw new Error('Вкажіть назву постачальника')
    const existing = supplierId ? this.getSupplier(supplierId, tenantId) : null
    const next = {
      id,
      name: name || existing?.name,
      phone: input.phone !== undefined ? text(input.phone) : existing?.phone ?? null,
      email: input.email !== undefined ? text(input.email) : existing?.email ?? null,
      contact_name: input.contact_name !== undefined ? text(input.contact_name) : existing?.contact_name ?? null,
      notes: input.notes !== undefined ? text(input.notes) : existing?.notes ?? null,
      is_active: input.is_active !== undefined ? Boolean(input.is_active) : existing?.is_active ?? true,
    }
    this.db.prepare(`
      INSERT INTO suppliers (
        id, tenant_id, name, phone, email, contact_name, notes, is_active,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, phone = excluded.phone, email = excluded.email,
        contact_name = excluded.contact_name, notes = excluded.notes,
        is_active = excluded.is_active, dirty_at = excluded.dirty_at,
        updated_at = excluded.updated_at, deleted_at = NULL
    `).run(
      id, tenantId, next.name, next.phone, next.email, next.contact_name, next.notes,
      next.is_active ? 1 : 0, timestamp, existing?.created_at ?? timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'supplier', id, supplierId ? 'supplier.updated' : 'supplier.created', next, timestamp)
    return this.getSupplier(id, tenantId)
  }

  deleteSupplier(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    this.getSupplier(id, tenantId)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE suppliers SET deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, timestamp, id, tenantId)
    this.addOutbox(tenantId, 'supplier', id, 'supplier.deleted', { id }, timestamp)
    return { ok: true }
  }

  mergeSuppliers(primaryId: string, duplicateId: string, tenantId = DEFAULT_TENANT_ID): any {
    const primary = this.getSupplier(primaryId, tenantId)
    this.getSupplier(duplicateId, tenantId)
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE supply_invoices SET supplier_id = ?, dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND supplier_id = ? AND deleted_at IS NULL
      `).run(primaryId, timestamp, timestamp, tenantId, duplicateId)
      this.db.prepare(`
        UPDATE supplier_payments SET supplier_id = ?, dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND supplier_id = ? AND deleted_at IS NULL
      `).run(primaryId, timestamp, timestamp, tenantId, duplicateId)
      this.db.prepare(`
        UPDATE suppliers SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, duplicateId, tenantId)
      this.addOutbox(tenantId, 'supplier', primaryId, 'supplier.merged', {
        primary_supplier_id: primaryId, duplicate_supplier_id: duplicateId,
      }, timestamp)
    })
    return primary
  }

  getSupplierDebts(tenantId = DEFAULT_TENANT_ID): any {
    const rows = this.db.prepare(`
      SELECT s.id AS supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
             COALESCE(SUM(CASE WHEN i.status = 'posted' THEN i.total ELSE 0 END), 0) AS total,
             COALESCE(SUM(CASE WHEN i.status = 'posted' THEN i.paid_amount ELSE 0 END), 0) AS paid,
             COUNT(CASE WHEN i.status = 'posted' THEN 1 END) AS invoices
      FROM suppliers s
      LEFT JOIN supply_invoices i ON i.supplier_id = s.id AND i.tenant_id = s.tenant_id AND i.deleted_at IS NULL
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL
      GROUP BY s.id, s.name, s.phone
      HAVING total <> paid
      ORDER BY (total - paid) DESC
    `).all(tenantId) as any[]
    const suppliers = rows.map((row) => ({
      ...row,
      total: Number(row.total),
      paid: Number(row.paid),
      balance: Number(row.total) - Number(row.paid),
      invoices: Number(row.invoices),
    }))
    return {
      suppliers,
      total_debt: suppliers.reduce((sum, row) => sum + Math.max(0, row.balance), 0),
      total_credit: suppliers.reduce((sum, row) => sum + Math.max(0, -row.balance), 0),
    }
  }
  listInvoices(filters: {
    tenant_id?: string
    status?: string
    supplier_id?: string
    page?: number
    per_page?: number
  } = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const tenantId = filters.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(filters.page ?? 1))
    const perPage = Math.max(1, Math.min(100, Number(filters.per_page ?? 20)))
    const offset = (page - 1) * perPage
    const where = ['i.tenant_id = ?', 'i.deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (filters.status) {
      where.push('i.status = ?')
      params.push(filters.status)
    }
    if (filters.supplier_id) {
      where.push('i.supplier_id = ?')
      params.push(filters.supplier_id)
    }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`
      SELECT count(*) AS count
      FROM supply_invoices i
      WHERE ${whereSql}
    `).get(...params) as { count: number }
    const rows = this.db.prepare(`
      SELECT i.*, s.name AS supplier_name
      FROM supply_invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE ${whereSql}
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset) as any[]
    return {
      data: rows.map((row) => this.mapInvoiceRow(row)),
      pagination: {
        page,
        per_page: perPage,
        total: Number(totalRow?.count ?? 0),
        total_pages: Math.ceil(Number(totalRow?.count ?? 0) / perPage),
      },
    }
  }

  getInvoice(id: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT i.*, s.name AS supplier_name
      FROM supply_invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId) as any | undefined
    if (!row) throw new Error('Накладну не знайдено')
    const invoice = this.mapInvoiceRow(row)
    invoice.items = this.listItems(id, tenantId)
    invoice.payments = this.listPayments(id, tenantId)
    return invoice
  }

  /**
   * Створює локальну чернетку приходу з розпізнаних AI-рядків.
   * Існуючі картки шукаються за штрихкодом, артикулом або точною назвою;
   * нові картки створюються без штрихкоду й категорії для ручного заповнення.
   */
  createInvoiceFromAiRows(input: {
    tenant_id?: string
    supplier_id?: string | null
    supplier_name?: string | null
    invoice_number?: string | null
    notes?: string | null
    user_id?: string | null
    rows: Array<Record<string, unknown>>
  }): {
    invoice: any
    matched: number
    created: number
    unresolved: Array<{ name: string; sku: string; needs_barcode: true; needs_category: boolean }>
    draft_items: Array<Record<string, unknown>>
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!Array.isArray(input.rows) || input.rows.length === 0) throw new Error('AI не знайшов позицій у накладній')
    const catalog = new LocalCatalogRepository(this.db)
    const settings = catalog.getSettings()
    const normalize = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const moneyUah = (value: unknown) => {
      const normalized = typeof value === 'string' ? value.replace(/\s/g, '').replace(',', '.') : value
      const number = Number(normalized ?? 0)
      return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : 0
    }
    const categories = this.db.prepare(`
      SELECT id, name FROM categories
      WHERE tenant_id = ? AND deleted_at IS NULL
    `).all(tenantId) as Array<{ id: string; name: string }>
    const normalizedCategories = categories.map((category) => ({ ...category, normalized: normalize(category.name) }))
    const resolveCategoryId = (suggested: unknown, productName: string): string | null => {
      const wanted = normalize(suggested)
      if (wanted) {
        const exact = normalizedCategories.find((category) => category.normalized === wanted)
        if (exact) return exact.id
        const related = normalizedCategories
          .filter((category) => category.normalized.length >= 3 && (
            wanted.includes(category.normalized) || category.normalized.includes(wanted)
          ))
          .sort((a, b) => b.normalized.length - a.normalized.length)[0]
        if (related) return related.id
      }
      const normalizedName = normalize(productName)
      return normalizedCategories
        .filter((category) => category.normalized.length >= 3 && normalizedName.includes(category.normalized))
        .sort((a, b) => b.normalized.length - a.normalized.length)[0]?.id ?? null
    }
    const retailFromGrid = (purchasePrice: number, categoryId: string | null): number => {
      if (purchasePrice <= 0) return 0
      const categoryMarkup = (Array.isArray(settings?.category_markups) ? settings.category_markups : [])
        .find((row: any) => row.category_id === categoryId)
      const rule = (Array.isArray(settings?.markup_rules) ? settings.markup_rules : [])
        .find((row: any) => purchasePrice >= Number(row.minPrice) && purchasePrice < Number(row.maxPrice))
      const markupPct = Number(categoryMarkup?.markup_pct ?? rule?.markupPct ?? 30)
      const retail = Math.round(purchasePrice * (1 + (Number.isFinite(markupPct) ? markupPct : 30) / 100))
      const rawStep = settings?.price_rounding_enabled === true ? Number(settings.price_rounding_step) : 100
      const step = Math.max(50, Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 100)
      const scaled = retail / step
      if (settings?.price_rounding_dir === 'up') return Math.ceil(scaled) * step
      if (settings?.price_rounding_dir === 'down') return Math.floor(scaled) * step
      return Math.round(scaled) * step
    }

    let supplierId = input.supplier_id ?? null
    if (!supplierId && input.supplier_name?.trim()) {
      const supplier = this.db.prepare(`
        SELECT id FROM suppliers
        WHERE tenant_id = ? AND deleted_at IS NULL AND lower(trim(name)) = lower(trim(?))
        LIMIT 1
      `).get(tenantId, input.supplier_name.trim()) as { id: string } | undefined
      supplierId = supplier?.id ?? null
    }
    let matched = 0
    let created = 0
    const unresolved: Array<{ name: string; sku: string; needs_barcode: true; needs_category: boolean }> = []
    const items: SupplyInvoiceItemInput[] = []
    const draftItems: Array<Record<string, unknown>> = []

    const invoice = this.db.transaction(() => {
      for (const raw of input.rows) {
        const recognizedName = String(raw.name ?? raw.title ?? raw.description ?? '').trim()
        if (!recognizedName) continue
        const recognizedSku = String(raw.sku ?? raw.article ?? raw.part_number ?? raw.oem_number ?? '').trim()
        const recognizedBarcode = String(raw.barcode ?? raw.ean ?? '').trim()
        const qtyValue = Number(raw.qty ?? raw.quantity ?? raw.qty_on_hand ?? 1)
        const rowQty = Number.isFinite(qtyValue) && qtyValue > 0 ? qtyValue : 1
        const purchasePrice = moneyUah(raw.purchase_price_uah ?? raw.purchase_price ?? raw.cost_price)

        let product = recognizedBarcode ? catalog.findByBarcode(recognizedBarcode, tenantId) : null
        if (!product && recognizedSku) product = catalog.findBySku(recognizedSku, tenantId)
        if (!product) {
          const wantedName = normalize(recognizedName)
          const candidates = this.db.prepare(`
            SELECT id, name FROM products WHERE tenant_id = ? AND deleted_at IS NULL
          `).all(tenantId) as Array<{ id: string; name: string }>
          const exact = candidates.find((candidate) => normalize(candidate.name) === wantedName)
          if (exact) product = catalog.findById(exact.id, tenantId)
        }

        const wasCreated = !product
        let categoryId = product?.category_id ?? resolveCategoryId(
          raw.category_name ?? raw.category ?? raw.folder_name ?? raw.folder,
          recognizedName,
        )
        const retailPrice = retailFromGrid(purchasePrice, categoryId)

        if (!product) {
          const productId = randomUUID()
          const productSku = recognizedSku || `AI-${productId.slice(0, 8).toUpperCase()}`
          const brandName = String(raw.brand_name ?? raw.brand ?? '').trim()
          let brandId: string | null = null
          if (brandName) {
            const storedBrand = this.db.prepare(`
              SELECT id FROM brands
              WHERE tenant_id = ? AND deleted_at IS NULL AND lower(trim(name)) = lower(trim(?))
              LIMIT 1
            `).get(tenantId, brandName) as { id: string } | undefined
            brandId = storedBrand?.id ?? catalog.createBrand(brandName, null, tenantId).id
          }
          product = catalog.saveProduct({
            id: productId,
            tenant_id: tenantId,
            sku: productSku,
            name: recognizedName,
            barcode: null,
            purchase_price: purchasePrice,
            retail_price: retailPrice,
            qty_on_hand: 0,
            unit: String(raw.unit ?? 'шт'),
            is_active: true,
            is_service: false,
            category_id: categoryId,
            brand_id: brandId,
          })
          created++
          unresolved.push({ name: recognizedName, sku: productSku, needs_barcode: true, needs_category: !categoryId })
        } else {
          matched++
          categoryId = product.category_id ?? categoryId
        }

        items.push({ product_id: product.id, qty: rowQty, purchase_price: purchasePrice })
        draftItems.push({
          product_id: product.id,
          product_name: product.name,
          sku: product.sku,
          barcode: product.barcode ?? '',
          unit: product.unit ?? String(raw.unit ?? 'шт'),
          qty: rowQty,
          purchase_price: purchasePrice,
          retail_price: retailFromGrid(purchasePrice, categoryId),
          category_id: categoryId,
          total: Math.round(rowQty * purchasePrice),
          storage_bin: product.storage_bin ?? null,
          photo_url: (product as any).photo_url ?? null,
          is_new: wasCreated,
        })
      }
      if (items.length === 0) throw new Error('AI не знайшов позицій у накладній')
      return this.createInvoice({
        tenant_id: tenantId,
        supplier_id: supplierId,
        invoice_number: input.invoice_number ?? null,
        notes: input.notes ?? 'Створено з фото накладної через AI. Перевірте нові товари та проскануйте їх штрихкоди.',
        user_id: input.user_id ?? null,
        items,
      })
    })
    return { invoice, matched, created, unresolved, draft_items: draftItems }
  }
  createInvoice(input: CreateSupplyInvoiceInput): any {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('Додайте хоча б один товар у накладну')
    }
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const invoiceId = input.id ?? randomUUID()
    const normalizedItems = input.items.map((item) => {
      const product = this.findProduct(item.product_id, tenantId)
      if (!product) throw new Error('Товар у накладній не знайдено в локальній базі')
      const itemQty = qty(item.qty)
      if (itemQty <= 0) throw new Error('Кількість у накладній має бути більше нуля')
      const purchasePrice = checkedMoney(item.purchase_price, 'Ціна закупівлі')
      return {
        id: item.id ?? randomUUID(),
        product_id: item.product_id,
        qty: itemQty,
        purchase_price: purchasePrice,
        total: checkedMoney(item.total ?? itemQty * purchasePrice, 'Сума позиції'),
      }
    })
    const total = checkedMoney(
      normalizedItems.reduce((sum, item) => sum + item.total, 0),
      'Сума накладної',
    )
    const paidAmount = Math.min(checkedMoney(input.paid_amount ?? 0, 'Сума оплати'), total)
    const paymentMethod = paidAmount > 0 ? (input.payment_method ?? 'cash') : null
    const fundSource = input.fund_source ?? (paymentMethod === 'cash' ? 'cashbox' : 'bank_account')
    const userId = input.user_id ?? null
    let initialPaymentId: string | null = null

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO supply_invoices (
          id, tenant_id, supplier_id, invoice_number, status, total, paid_amount,
          payment_method, notes, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        invoiceId,
        tenantId,
        input.supplier_id ?? null,
        text(input.invoice_number),
        total,
        paidAmount,
        paymentMethod,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
      )
      for (const item of normalizedItems) {
        this.insertItem(invoiceId, tenantId, item, timestamp)
      }
      if (paidAmount > 0 && paymentMethod) {
        initialPaymentId = randomUUID()
        this.insertPayment(invoiceId, tenantId, {
          amount: paidAmount,
          payment_method: paymentMethod,
          fund_source: fundSource,
          shift_id: input.shift_id ?? null,
          note: 'Оплата під час створення накладної',
          user_id: userId,
          payment_id: initialPaymentId,
        }, input.supplier_id ?? null, timestamp)
      }
      this.addOutbox(tenantId, 'supply_invoice', invoiceId, 'supplier_invoice.created', {
        id: invoiceId,
        supplier_id: input.supplier_id ?? null,
        invoice_number: text(input.invoice_number),
        notes: input.notes ?? null,
        paid_amount: paidAmount,
        payment_id: initialPaymentId,
        payment_method: paymentMethod,
        fund_source: fundSource,
        shift_id: input.shift_id ?? null,
        items: normalizedItems,
      }, timestamp)
    })
    return this.getInvoice(invoiceId, tenantId)
  }

  updateInvoice(id: string, input: UpdateSupplyInvoiceInput): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const invoice = this.getInvoice(id, tenantId)
    if (invoice.status !== 'draft') {
      throw new Error('Проведену накладну не можна редагувати напряму. Натисніть «Редагувати» в проведеній накладній — програма скасує її і відкриє копію для правок.')
    }
    const timestamp = nowIso()
    const normalizedItems = input.items === undefined ? null : input.items.map((item) => {
      const product = this.findProduct(item.product_id, tenantId)
      if (!product) throw new Error('Товар у накладній не знайдено в локальній базі')
      const itemQty = qty(item.qty)
      if (itemQty <= 0) throw new Error('Кількість у накладній має бути більше нуля')
      const purchasePrice = checkedMoney(item.purchase_price, 'Ціна закупівлі')
      return {
        id: item.id ?? randomUUID(),
        product_id: item.product_id,
        qty: itemQty,
        purchase_price: purchasePrice,
        total: checkedMoney(item.total ?? itemQty * purchasePrice, 'Сума позиції'),
      }
    })
    if (normalizedItems && normalizedItems.length === 0) throw new Error('Додайте хоча б один товар у накладну')
    const total = checkedMoney(
      normalizedItems
        ? normalizedItems.reduce((sum, item) => sum + item.total, 0)
        : Number(invoice.total ?? 0),
      'Сума накладної',
    )
    const supplierId = input.supplier_id !== undefined ? input.supplier_id : invoice.supplier_id ?? null
    const invoiceNumber = input.invoice_number !== undefined ? text(input.invoice_number) : invoice.invoice_number ?? null
    const notes = input.notes !== undefined ? input.notes ?? null : invoice.notes ?? null

    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE supply_invoices
        SET supplier_id = ?, invoice_number = ?, notes = ?, total = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(supplierId, invoiceNumber, notes, total, timestamp, timestamp, id, tenantId)

      if (normalizedItems) {
        this.db.prepare('DELETE FROM supply_invoice_items WHERE invoice_id = ? AND tenant_id = ?').run(id, tenantId)
        for (const item of normalizedItems) {
          this.insertItem(id, tenantId, item, timestamp)
        }
      }

      this.addOutbox(tenantId, 'supply_invoice', id, 'supplier_invoice.updated', {
        id,
        supplier_id: supplierId,
        invoice_number: invoiceNumber,
        notes,
        total,
        items: normalizedItems ?? undefined,
      }, timestamp)
    })
    return this.getInvoice(id, tenantId)
  }

  postInvoice(id: string, input: { tenant_id?: string; user_id?: string | null } = {}): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    this.db.transaction(() => {
      const invoice = this.getInvoice(id, tenantId)
      if (invoice.status !== 'draft') throw new Error('Накладну вже проведено або скасовано')
      const items = this.db.prepare(`
        SELECT ii.id, ii.product_id, ii.qty, ii.purchase_price, ii.total,
               p.id AS product_exists, p.name AS product_name, p.deleted_at AS product_deleted_at
        FROM supply_invoice_items ii
        LEFT JOIN products p ON p.id = ii.product_id AND p.tenant_id = ii.tenant_id
        WHERE ii.invoice_id = ? AND ii.tenant_id = ? AND ii.deleted_at IS NULL
        ORDER BY ii.created_at ASC
      `).all(id, tenantId) as any[]
      if (items.length === 0) throw new Error('Додайте хоча б один товар у накладну')
      const missing = items.find((item) => !item.product_exists || item.product_deleted_at)
      if (missing) {
        throw new Error(`Неможливо провести накладну: товар ${missing.product_name || missing.product_id} відсутній або видалений`)
      }

      for (const item of items) {
        const product = this.findProduct(item.product_id, tenantId)
        if (!product) throw new Error(`Товар ${item.product_id} не знайдено в локальній базі`)
        const newQty = Number(product.qty_on_hand ?? 0) + Number(item.qty ?? 0)
        this.db.prepare(`
          UPDATE products
          SET qty_on_hand = ?, purchase_price = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(newQty, item.purchase_price ?? 0, timestamp, timestamp, item.product_id, tenantId)
        this.db.prepare(`
          INSERT INTO inventory_movements (
            id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
            unit_cost, notes, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'supply_invoice', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), tenantId, item.product_id, id, item.qty, newQty,
          item.purchase_price ?? 0, `Прихідна накладна ${invoice.invoice_number ?? id}`,
          timestamp, timestamp, timestamp,
        )
      }

      const total = items.reduce((sum, item) => sum + Number(item.total ?? 0), 0)
      this.db.prepare(`
        UPDATE supply_invoices
        SET status = 'posted', total = ?, posted_by = ?, posted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(total, input.user_id ?? null, timestamp, timestamp, timestamp, id, tenantId)
      this.addOutbox(tenantId, 'supply_invoice', id, 'supplier_invoice.posted', {
        id,
        user_id: input.user_id ?? null,
        items: items.map((item: any) => ({ product_id: item.product_id, qty: item.qty, purchase_price: item.purchase_price })),
      }, timestamp)
    })
    return this.getInvoice(id, tenantId)
  }
  payInvoice(id: string, input: PaymentInput): any {
    return this.db.transaction(() => this.payInvoiceInTransaction(id, input))
  }

  private payInvoiceInTransaction(id: string, input: PaymentInput): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (input.payment_id) {
      const existing = this.db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(input.payment_id) as any
      if (existing) {
        if (existing.tenant_id !== tenantId || existing.invoice_id !== id || existing.deleted_at
          || existing.amount !== checkedMoney(input.amount, 'Сума оплати')
          || existing.payment_method !== input.payment_method || existing.fund_source !== input.fund_source
          || (existing.shift_id ?? null) !== (input.shift_id ?? null)) {
          throw new Error('Ідентифікатор оплати вже використано іншою операцією')
        }
        return this.getInvoice(id, tenantId)
      }
    }
    const invoice = this.getInvoice(id, tenantId)
    if (invoice.status === 'cancelled') throw new Error('Не можна оплатити скасовану накладну')
    const remaining = Number(invoice.total ?? 0) - Number(invoice.paid_amount ?? 0)
    const amount = checkedMoney(input.amount, 'Сума оплати')
    if (amount <= 0) throw new Error('Сума оплати має бути більше нуля')
    if (amount > remaining) throw new Error('Сума перевищує борг за накладною')
    const timestamp = nowIso()
    const paymentId = input.payment_id ?? randomUUID()
    this.db.transaction(() => {
      this.insertPayment(id, tenantId, { ...input, payment_id: paymentId }, invoice.supplier_id ?? null, timestamp)
      this.db.prepare(`
        UPDATE supply_invoices
        SET paid_amount = paid_amount + ?, payment_method = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(amount, input.payment_method, timestamp, timestamp, id, tenantId)
      this.addOutbox(tenantId, 'supply_invoice', id, 'supplier_invoice.payment_added', {
        id,
        payment_id: paymentId,
        amount,
        payment_method: input.payment_method,
        fund_source: input.fund_source,
        shift_id: input.shift_id ?? null,
        note: input.note ?? null,
        user_id: input.user_id ?? null,
      }, timestamp)
    })
    return this.getInvoice(id, tenantId)
  }

  cancelInvoice(id: string, tenantId = DEFAULT_TENANT_ID): any {
    const timestamp = nowIso()
    this.db.transaction(() => {
      const invoice = this.getInvoice(id, tenantId)
      if (invoice.status === 'cancelled') return
      if (Number(invoice.paid_amount ?? 0) > 0) {
        throw new Error('Не можна скасувати оплачену накладну. Спочатку оформіть повернення або перенесення оплати.')
      }
      const items = this.db.prepare(`
        SELECT ii.product_id, ii.qty, ii.purchase_price,
               p.id AS product_exists, p.name AS product_name, p.qty_on_hand, p.deleted_at AS product_deleted_at
        FROM supply_invoice_items ii
        LEFT JOIN products p ON p.id = ii.product_id AND p.tenant_id = ii.tenant_id
        WHERE ii.invoice_id = ? AND ii.tenant_id = ? AND ii.deleted_at IS NULL
        ORDER BY ii.created_at ASC
      `).all(id, tenantId) as any[]
      if (invoice.status === 'posted') {
        const requiredByProduct = new Map<string, number>()
        for (const item of items) {
          if (!item.product_exists || item.product_deleted_at) {
            throw new Error(`Неможливо скасувати накладну: товар ${item.product_name || item.product_id} відсутній або видалений`)
          }
          requiredByProduct.set(item.product_id, (requiredByProduct.get(item.product_id) ?? 0) + Number(item.qty ?? 0))
        }
        for (const [productId, requiredQty] of requiredByProduct) {
          const product = this.findProduct(productId, tenantId)
          if (!product || Number(product.qty_on_hand ?? 0) < requiredQty) {
            throw new Error('Неможливо скасувати накладну: частину товару вже продано або списано')
          }
        }
        for (const item of items) {
          const product = this.findProduct(item.product_id, tenantId)!
          const newQty = Number(product.qty_on_hand ?? 0) - Number(item.qty ?? 0)
          this.db.prepare(`
            UPDATE products SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(newQty, timestamp, timestamp, item.product_id, tenantId)
          this.db.prepare(`
            INSERT INTO inventory_movements (
              id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
              unit_cost, notes, dirty_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'supply_invoice_cancel', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(), tenantId, item.product_id, id, -Number(item.qty ?? 0), newQty,
            item.purchase_price ?? 0, `Скасування приходної накладної ${invoice.invoice_number ?? id}`,
            timestamp, timestamp, timestamp,
          )
        }
      }
      this.db.prepare(`
        UPDATE supply_invoices
        SET status = 'cancelled', dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, id, tenantId)
      this.addOutbox(tenantId, 'supply_invoice', id, 'supplier_invoice.cancelled', { id }, timestamp)
    })
    return this.getInvoice(id, tenantId)
  }
  deleteInvoice(id: string, tenantId = DEFAULT_TENANT_ID): void {
    const invoice = this.getInvoice(id, tenantId)
    if (invoice.status !== 'draft' || Number(invoice.paid_amount ?? 0) > 0) {
      throw new Error('Видалити можна лише неоплачену чернетку накладної. Проведені, скасовані та оплачені документи залишаються в історії.')
    }
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM supplier_payments WHERE invoice_id = ? AND tenant_id = ?').run(id, tenantId)
      this.db.prepare('DELETE FROM supply_invoice_items WHERE invoice_id = ? AND tenant_id = ?').run(id, tenantId)
      this.db.prepare('DELETE FROM supply_invoices WHERE id = ? AND tenant_id = ?').run(id, tenantId)
      this.addOutbox(tenantId, 'supply_invoice', id, 'supplier_invoice.deleted', { id }, timestamp)
    })
  }

  private mapInvoiceRow(row: any): any {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      supplier_id: row.supplier_id ?? null,
      invoice_number: row.invoice_number ?? null,
      status: row.status,
      total: Number(row.total ?? 0),
      paid_amount: Number(row.paid_amount ?? 0),
      payment_method: row.payment_method ?? null,
      notes: row.notes ?? null,
      posted_by: row.posted_by ?? null,
      posted_at: row.posted_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? 'Постачальник' } : null,
    }
  }

  private listItems(invoiceId: string, tenantId: string): any[] {
    const rows = this.db.prepare(`
      SELECT ii.*, p.sku, p.name, p.unit, p.retail_price, p.barcode, p.storage_bin, p.category_id, p.photo_url
      FROM supply_invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = ? AND ii.tenant_id = ? AND ii.deleted_at IS NULL
      ORDER BY ii.created_at ASC
    `).all(invoiceId, tenantId) as any[]
    return rows.map((row) => ({
      id: row.id,
      invoice_id: row.invoice_id,
      product_id: row.product_id,
      qty: Number(row.qty ?? 0),
      purchase_price: Number(row.purchase_price ?? 0),
      total: Number(row.total ?? 0),
      created_at: row.created_at,
      product: {
        id: row.product_id,
        sku: row.sku,
        name: row.name,
        unit: row.unit,
        purchase_price: row.purchase_price,
        retail_price: row.retail_price,
        barcode: row.barcode,
        storage_bin: row.storage_bin,
        category_id: row.category_id,
        photo_url: row.photo_url,
      },
    }))
  }

  private listPayments(invoiceId: string, tenantId: string): any[] {
    return this.db.prepare(`
      SELECT *
      FROM supplier_payments
      WHERE invoice_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all(invoiceId, tenantId) as any[]
  }

  private insertItem(invoiceId: string, tenantId: string, item: Required<SupplyInvoiceItemInput>, timestamp: string): void {
    this.db.prepare(`
      INSERT INTO supply_invoice_items (
        id, tenant_id, invoice_id, product_id, qty, purchase_price, total,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.id, tenantId, invoiceId, item.product_id, item.qty, item.purchase_price, item.total, timestamp, timestamp, timestamp)
  }

  private getCashboxAvailable(tenantId: string, shiftId: string | null | undefined): number {
    return readOpenCashBalance(this.db, tenantId, shiftId)
  }

  private ensureCashboxPaymentAllowed(tenantId: string, input: PaymentInput, amount: number): void {
    if (input.fund_source !== 'cashbox' || amount <= 0) return
    const available = this.getCashboxAvailable(tenantId, input.shift_id)
    if (available < amount) {
      throw new Error(`У касі недостатньо грошей. Доступно ${(available / 100).toFixed(2)} грн, потрібно ${(amount / 100).toFixed(2)} грн. Оплатіть частину власними коштами.`)
    }
  }

  private insertPayment(invoiceId: string, tenantId: string, input: PaymentInput & { payment_id?: string }, supplierId: string | null, timestamp: string): string {
    const paymentId = input.payment_id ?? randomUUID()
    const amount = checkedMoney(input.amount, 'Сума оплати')
    this.ensureCashboxPaymentAllowed(tenantId, input, amount)
    this.db.prepare(`
      INSERT INTO supplier_payments (
        id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source,
        shift_id, note, created_by, dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      paymentId,
      tenantId,
      invoiceId,
      supplierId,
      amount,
      input.payment_method,
      input.fund_source,
      input.shift_id ?? null,
      input.note ?? null,
      input.user_id ?? null,
      timestamp,
      timestamp,
      timestamp,
    )
    if (input.fund_source === 'cashbox') {
      this.db.prepare(`
        INSERT INTO cash_operations (
          id, tenant_id, shift_id, user_id, type, source, amount, supplier_id,
          notes, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'supplier_payment', 'cashbox', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        tenantId,
        input.shift_id ?? null,
        input.user_id ?? null,
        amount,
        supplierId,
        input.note ?? 'Оплата постачальнику',
        timestamp,
        timestamp,
        timestamp,
      )
    }
    return paymentId
  }

  private findProduct(productId: string, tenantId: string): { id: string; qty_on_hand: number } | null {
    const row = this.db.prepare(`
      SELECT id, qty_on_hand
      FROM products
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(productId, tenantId) as { id: string; qty_on_hand: number } | undefined
    return row ?? null
  }

  private addOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    operationType: string,
    payload: unknown,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      aggregateType,
      aggregateId,
      operationType,
      JSON.stringify(payload),
      createdAt,
    )
  }
}
