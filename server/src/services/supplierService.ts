import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import type {
  CreateSupplierInput, UpdateSupplierInput, SupplierListQuery,
  CreateSupplyInvoiceInput, UpdateSupplyInvoiceInput, SupplyInvoiceListQuery,
} from '../validators/supplierSchema.js'

const SUPPLIER_TABLE = 'suppliers'
const INVOICE_TABLE  = 'supply_invoices'
const ITEM_TABLE     = 'supply_invoice_items'

// ===================== Постачальники =====================

export async function listSuppliers(query: SupplierListQuery, tenantId: string) {
  const { search, is_active, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(SUPPLIER_TABLE)
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .range(offset, offset + per_page - 1)

  if (search)     q = q.or(`name.ilike.%${search}%,contact_name.ilike.%${search}%,phone.ilike.%${search}%`)
  if (is_active)  q = q.eq('is_active', is_active === 'true')

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: {
      page,
      per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page),
    },
  }
}

export async function getSupplier(id: string, tenantId: string) {
  const { data, error } = await db
    .from(SUPPLIER_TABLE)
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Постачальника не знайдено', 404)
  return data
}

export async function createSupplier(input: CreateSupplierInput, tenantId: string) {
  const { data, error } = await db
    .from(SUPPLIER_TABLE)
    .insert({ ...input, tenant_id: tenantId })
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateSupplier(id: string, input: UpdateSupplierInput, tenantId: string) {
  await getSupplier(id, tenantId)

  const { data, error } = await db
    .from(SUPPLIER_TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function deleteSupplier(id: string, tenantId: string) {
  await getSupplier(id, tenantId)
  const { error } = await db
    .from(SUPPLIER_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ===================== Приходні накладні =====================

export async function listSupplyInvoices(query: SupplyInvoiceListQuery, tenantId: string) {
  const { status, supplier_id, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(INVOICE_TABLE)
    .select('*, supplier:suppliers(id,name)', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (status)      q = q.eq('status', status)
  if (supplier_id) q = q.eq('supplier_id', supplier_id)

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  }
}

export async function getSupplyInvoice(id: string, tenantId: string) {
  const { data, error } = await db
    .from(INVOICE_TABLE)
    .select('*, supplier:suppliers(id,name), items:supply_invoice_items(*, product:products(id,sku,name,unit,retail_price,barcode,storage_bin,category_id))')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
  return data
}

export async function createSupplyInvoice(_userId: string, input: CreateSupplyInvoiceInput, tenantId: string) {
  const itemsWithTotal = input.items.map((item) => ({
    ...item,
    total: Math.round(item.qty * item.purchase_price),
  }))
  const totalKopecks = itemsWithTotal.reduce((sum, item) => sum + item.total, 0)

  // Оплата постачальнику не може перевищувати суму накладної
  const paidAmount = Math.min(input.paid_amount ?? 0, totalKopecks)

  const { data: invoice, error: invError } = await db
    .from(INVOICE_TABLE)
    .insert({
      supplier_id:    input.supplier_id ?? null,
      invoice_number: input.invoice_number ?? null,
      notes:          input.notes ?? null,
      status:         'draft',
      total:          totalKopecks,
      paid_amount:    paidAmount,
      payment_method: paidAmount > 0 ? (input.payment_method ?? 'cash') : null,
      tenant_id:      tenantId,
    })
    .select('id')
    .single()

  if (invError || !invoice) throw new AppError('DB_ERROR', invError?.message ?? 'Помилка створення накладної', 500)

  const itemsToInsert = itemsWithTotal.map((item) => ({
    invoice_id:     invoice.id,
    product_id:     item.product_id,
    qty:            item.qty,
    purchase_price: item.purchase_price,
    total:          item.total,
    tenant_id:      tenantId,
  }))

  const { error: itemsError } = await db.from(ITEM_TABLE).insert(itemsToInsert)
  if (itemsError) throw new AppError('DB_ERROR', itemsError.message, 500)

  return getSupplyInvoice(invoice.id, tenantId)
}

export async function updateSupplyInvoice(id: string, input: UpdateSupplyInvoiceInput, tenantId: string) {
  const existing = await getSupplyInvoice(id, tenantId)
  if (existing.status !== 'draft') {
    throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)
  }

  const { data, error } = await db
    .from(INVOICE_TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*, supplier:suppliers(id,name), items:supply_invoice_items(*, product:products(id,sku,name,unit,retail_price,barcode,storage_bin,category_id))')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function postSupplyInvoice(id: string, userId: string, tenantId: string) {
  // Ensure the invoice belongs to the tenant
  await getSupplyInvoice(id, tenantId)

  const { error } = await db.rpc('post_supply_invoice', {
    p_invoice_id: id,
    p_user_id:    userId
  })

  if (error) {
    if (error.message.includes('NOT_FOUND')) {
      throw new AppError('NOT_FOUND', error.message, 404)
    }
    if (error.message.includes('INVOICE_ALREADY_POSTED')) {
      throw new AppError('INVOICE_ALREADY_POSTED', error.message, 400)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  return getSupplyInvoice(id, tenantId)
}

export async function cancelSupplyInvoice(id: string, tenantId: string) {
  // Ensure the invoice belongs to the tenant
  await getSupplyInvoice(id, tenantId)

  const { error } = await db.rpc('cancel_supply_invoice', {
    p_invoice_id: id
  })

  if (error) {
    if (error.message.includes('NOT_FOUND')) {
      throw new AppError('NOT_FOUND', error.message, 404)
    }
    if (error.message.includes('ALREADY_CANCELLED')) {
      throw new AppError('ALREADY_CANCELLED', error.message, 400)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  return getSupplyInvoice(id, tenantId)
}

/**
 * Доплата постачальнику по накладній (коли оплачуємо вже після приймання).
 * Збільшує paid_amount, але не вище суми накладної.
 */
export async function addInvoicePayment(id: string, amount: number, method: string | null, tenantId: string) {
  const invoice = await getSupplyInvoice(id, tenantId)
  const newPaid = Math.min((invoice.paid_amount ?? 0) + amount, invoice.total)

  const { data, error } = await db
    .from(INVOICE_TABLE)
    .update({
      paid_amount: newPaid,
      payment_method: method ?? invoice.payment_method ?? 'cash',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*, supplier:suppliers(id,name)')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

/**
 * Борги перед постачальниками: по проведених накладних
 * balance = total - paid_amount. >0 — ми винні постачальнику.
 */
export async function getSupplierDebts(tenantId: string) {
  const { data, error } = await db
    .from(INVOICE_TABLE)
    .select('supplier_id, total, paid_amount, supplier:suppliers(id, name, phone)')
    .eq('tenant_id', tenantId)
    .eq('status', 'posted')
    .limit(5000)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  const map = new Map<string, { supplier_id: string; supplier_name: string; supplier_phone: string | null; total: number; paid: number; balance: number; invoices: number }>()
  for (const row of data ?? []) {
    const sid = row.supplier_id ?? 'none'
    const supplier = (row.supplier as any)
    const cur = map.get(sid) ?? {
      supplier_id: sid,
      supplier_name: supplier?.name ?? 'Без постачальника',
      supplier_phone: supplier?.phone ?? null,
      total: 0, paid: 0, balance: 0, invoices: 0,
    }
    cur.total += row.total ?? 0
    cur.paid += row.paid_amount ?? 0
    cur.balance = cur.total - cur.paid
    cur.invoices += 1
    map.set(sid, cur)
  }

  const list = [...map.values()].filter((s) => s.balance !== 0).sort((a, b) => b.balance - a.balance)
  const totalDebt = list.reduce((s, x) => s + Math.max(0, x.balance), 0)
  const totalCredit = list.reduce((s, x) => s + Math.max(0, -x.balance), 0)
  return { suppliers: list, total_debt: totalDebt, total_credit: totalCredit }
}

export async function deleteSupplyInvoice(id: string, tenantId: string) {
  const invoice = await getSupplyInvoice(id, tenantId)
  if (invoice.status === 'posted') {
    throw new AppError('INVOICE_POSTED', 'Не можна видалити проведену накладну. Спочатку скасуйте її.', 400)
  }

  const { error: delItemsError } = await db
    .from(ITEM_TABLE)
    .delete()
    .eq('invoice_id', id)
    .eq('tenant_id', tenantId)

  if (delItemsError) throw new AppError('DB_ERROR', delItemsError.message, 500)

  const { error: delError } = await db
    .from(INVOICE_TABLE)
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (delError) throw new AppError('DB_ERROR', delError.message, 500)
}

// ===================== Замовлення постачальникам (PO) =====================

export async function listSupplierPOs(tenantId: string, status?: string) {
  let q = db
    .from('supplier_purchase_orders')
    .select(`*, supplier:suppliers(id, name, phone),
      items:supplier_purchase_order_items(id, qty, product:products(id, name, sku),
        customer_order_item:customer_order_items(id, order_id, order:customer_orders(order_number)))`)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function updateSupplierPOStatus(id: string, status: 'ordered' | 'received' | 'cancelled', tenantId: string) {
  const { data, error } = await db
    .from('supplier_purchase_orders')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  if (!data) throw new AppError('NOT_FOUND', 'Замовлення постачальнику не знайдено', 404)
  return data
}

export async function createSupplierPOsForOrder(orderId: string, tenantId: string) {
  // 1. Отримуємо позиції замовлення, які вимагають закупівлі у постачальника
  const { data: items, error: itemsErr } = await db
    .from('customer_order_items')
    .select('*, order:customer_orders(tenant_id, order_number)')
    .eq('order_id', orderId)

  if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)
  if (!items || items.length === 0) return

  // Перевірка tenant_id (можна взяти з першого елемента)
  const orderTenantId = (items[0] as any).order?.tenant_id
  if (orderTenantId !== tenantId) {
    throw new AppError('FORBIDDEN', 'Немає доступу до цього замовлення', 403)
  }

  const orderNumber = (items[0] as any).order?.order_number || '0'

  // Фільтруємо позиції: тільки тип 'supplier', є supplier_id і product_id
  // (supplier_purchase_order_items.product_id NOT NULL), і немає draft-нотатки
  const supplierItems = items.filter(
    (i) => i.source_type === 'supplier' && i.supplier_id && i.product_id && !i.is_draft_note
  )

  if (supplierItems.length === 0) return

  // 2. Виключаємо позиції, для яких вже створено замовлення постачальнику
  const itemIds = supplierItems.map((i) => i.id)
  const { data: existingPoItems, error: existingErr } = await db
    .from('supplier_purchase_order_items')
    .select('customer_order_item_id')
    .in('customer_order_item_id', itemIds)

  if (existingErr) throw new AppError('DB_ERROR', existingErr.message, 500)

  const existingIds = new Set((existingPoItems || []).map((x) => x.customer_order_item_id))
  const itemsToOrder = supplierItems.filter((i) => !existingIds.has(i.id))

  if (itemsToOrder.length === 0) return

  // 3. Групуємо позиції за supplier_id
  const groups: Record<string, typeof itemsToOrder> = {}
  for (const item of itemsToOrder) {
    const sId = item.supplier_id!
    if (!groups[sId]) groups[sId] = []
    groups[sId].push(item)
  }

  // 4. Для кожної групи створюємо замовлення постачальнику.
  // Номер — із послідовності БД (unique-індекс tenant_id+po_number),
  // PO разом із позиціями — в одній транзакції
  const supplierIds = Object.keys(groups)
  const { data: supplierRows } = await db
    .from('suppliers')
    .select('id, name')
    .in('id', supplierIds)
  const supplierNames = new Map((supplierRows ?? []).map((s) => [s.id, s.name]))

  await runTransaction(async (client) => {
    for (const [supplierId, groupItems] of Object.entries(groups)) {
      const supplierName = supplierNames.get(supplierId) || 'SUPP'
      // кирилиця в назві постачальника теж має давати читабельний код (не «PO-12--1»)
      const cleanName = (supplierName.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 6).toUpperCase() || 'SUPP')
      const seqRes = await client.query("SELECT nextval('supplier_po_number_seq') AS n")
      const poNumber = `PO-${orderNumber}-${cleanName}-${seqRes.rows[0].n}`

      const poRes = await client.query(
        `INSERT INTO supplier_purchase_orders (tenant_id, supplier_id, status, po_number, notes)
         VALUES ($1, $2, 'ordered', $3, $4)
         RETURNING id`,
        [tenantId, supplierId, poNumber, `Автоматично створено для замовлення клієнта №${orderNumber}`]
      )
      const poId = poRes.rows[0].id

      for (const item of groupItems) {
        await client.query(
          `INSERT INTO supplier_purchase_order_items (tenant_id, po_id, product_id, qty, customer_order_item_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, poId, item.product_id, item.qty, item.id]
        )
      }
    }
  })
}
