import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

function money(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
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
      where.push('(lower(name) LIKE ? OR lower(COALESCE(contact_name, \'\')) LIKE ? OR phone LIKE ?)')
      const like = `%${search.toLowerCase()}%`
      params.push(like, like, `%${search}%`)
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
      const purchasePrice = money(item.purchase_price)
      return {
        id: item.id ?? randomUUID(),
        product_id: item.product_id,
        qty: itemQty,
        purchase_price: purchasePrice,
        total: money(item.total ?? itemQty * purchasePrice),
      }
    })
    const total = normalizedItems.reduce((sum, item) => sum + item.total, 0)
    const paidAmount = Math.max(0, Math.min(money(input.paid_amount ?? 0), total))
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

  updateInvoice(id: string, input: { tenant_id?: string; invoice_number?: string | null; notes?: string | null; user_id?: string | null }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const invoice = this.getInvoice(id, tenantId)
    if (invoice.status !== 'draft') throw new Error('Не можна редагувати проведену накладну')
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE supply_invoices
        SET invoice_number = ?, notes = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(text(input.invoice_number), input.notes ?? null, timestamp, timestamp, id, tenantId)
      this.addOutbox(tenantId, 'supply_invoice', id, 'supplier_invoice.updated', {
        id,
        invoice_number: text(input.invoice_number),
        notes: input.notes ?? null,
      }, timestamp)
    })
    return this.getInvoice(id, tenantId)
  }

  postInvoice(id: string, input: { tenant_id?: string; user_id?: string | null } = {}): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const invoice = this.getInvoice(id, tenantId)
    if (invoice.status !== 'draft') throw new Error('Накладну вже проведено або скасовано')
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE supply_invoices
        SET status = 'posted', posted_by = ?, posted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(input.user_id ?? null, timestamp, timestamp, timestamp, id, tenantId)
      for (const item of invoice.items ?? []) {
        const product = this.findProduct(item.product_id, tenantId)
        if (!product) continue
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
          randomUUID(),
          tenantId,
          item.product_id,
          id,
          item.qty,
          newQty,
          item.purchase_price ?? 0,
          `Прихідна накладна ${invoice.invoice_number ?? id}`,
          timestamp,
          timestamp,
          timestamp,
        )
      }
      this.addOutbox(tenantId, 'supply_invoice', id, 'supplier_invoice.posted', {
        id,
        user_id: input.user_id ?? null,
        items: (invoice.items ?? []).map((item: any) => ({ product_id: item.product_id, qty: item.qty, purchase_price: item.purchase_price })),
      }, timestamp)
    })
    return this.getInvoice(id, tenantId)
  }

  payInvoice(id: string, input: PaymentInput): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const invoice = this.getInvoice(id, tenantId)
    if (invoice.status === 'cancelled') throw new Error('Не можна оплатити скасовану накладну')
    const remaining = Number(invoice.total ?? 0) - Number(invoice.paid_amount ?? 0)
    const amount = money(input.amount)
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
    const invoice = this.getInvoice(id, tenantId)
    if (invoice.status === 'cancelled') return invoice
    const timestamp = nowIso()
    this.db.transaction(() => {
      if (invoice.status === 'posted') {
        for (const item of invoice.items ?? []) {
          const product = this.findProduct(item.product_id, tenantId)
          if (!product) continue
          const newQty = Math.max(0, Number(product.qty_on_hand ?? 0) - Number(item.qty ?? 0))
          this.db.prepare(`
            UPDATE products SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(newQty, timestamp, timestamp, item.product_id, tenantId)
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
    if (invoice.status === 'posted') throw new Error('Не можна видалити проведену накладну. Спочатку скасуйте її.')
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

  private insertPayment(invoiceId: string, tenantId: string, input: PaymentInput & { payment_id?: string }, supplierId: string | null, timestamp: string): string {
    const paymentId = input.payment_id ?? randomUUID()
    const amount = money(input.amount)
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