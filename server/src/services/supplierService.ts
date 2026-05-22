import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type {
  CreateSupplierInput, UpdateSupplierInput, SupplierListQuery,
  CreateSupplyInvoiceInput, UpdateSupplyInvoiceInput, SupplyInvoiceListQuery,
} from '../validators/supplierSchema.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const SUPPLIER_TABLE = 'suppliers'
const INVOICE_TABLE  = 'supply_invoices'
const ITEM_TABLE     = 'supply_invoice_items'

// ===================== Постачальники =====================

export async function listSuppliers(query: SupplierListQuery) {
  const { search, is_active, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(SUPPLIER_TABLE)
    .select('*', { count: 'exact' })
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

export async function getSupplier(id: string) {
  const { data, error } = await db
    .from(SUPPLIER_TABLE)
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Постачальника не знайдено', 404)
  return data
}

export async function createSupplier(input: CreateSupplierInput) {
  const { data, error } = await db
    .from(SUPPLIER_TABLE)
    .insert({ ...input, tenant_id: TENANT_ID })
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateSupplier(id: string, input: UpdateSupplierInput) {
  await getSupplier(id)

  const { data, error } = await db
    .from(SUPPLIER_TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function deleteSupplier(id: string) {
  await getSupplier(id)
  const { error } = await db
    .from(SUPPLIER_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ===================== Приходні накладні =====================

export async function listSupplyInvoices(query: SupplyInvoiceListQuery) {
  const { status, supplier_id, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(INVOICE_TABLE)
    .select('*, supplier:suppliers(id,name)', { count: 'exact' })
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

export async function getSupplyInvoice(id: string) {
  const { data, error } = await db
    .from(INVOICE_TABLE)
    .select('*, supplier:suppliers(id,name), items:supply_invoice_items(*, product:products(id,sku,name,unit,retail_price,barcode))')
    .eq('id', id)
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
  return data
}

export async function createSupplyInvoice(_userId: string, input: CreateSupplyInvoiceInput) {
  // 1. Рахуємо суми на сервері — не довіряємо client-side total
  const itemsWithTotal = input.items.map((item) => ({
    ...item,
    total: Math.round(item.qty * item.purchase_price),
  }))
  const totalKopecks = itemsWithTotal.reduce((sum, item) => sum + item.total, 0)

  // 2. Створюємо накладну
  const { data: invoice, error: invError } = await db
    .from(INVOICE_TABLE)
    .insert({
      supplier_id:    input.supplier_id ?? null,
      invoice_number: input.invoice_number ?? null,
      notes:          input.notes ?? null,
      status:         'draft',
      total:          totalKopecks,
      tenant_id:      TENANT_ID,
    })
    .select('id')
    .single()

  if (invError || !invoice) throw new AppError('DB_ERROR', invError?.message ?? 'Помилка створення накладної', 500)

  // 3. Створюємо позиції накладної
  const itemsToInsert = itemsWithTotal.map((item) => ({
    invoice_id:     invoice.id,
    product_id:     item.product_id,
    qty:            item.qty,
    purchase_price: item.purchase_price,
    total:          item.total,
    tenant_id:      TENANT_ID,
  }))

  const { error: itemsError } = await db.from(ITEM_TABLE).insert(itemsToInsert)
  if (itemsError) throw new AppError('DB_ERROR', itemsError.message, 500)

  return getSupplyInvoice(invoice.id)
}

export async function updateSupplyInvoice(id: string, input: UpdateSupplyInvoiceInput) {
  const existing = await getSupplyInvoice(id)
  if (existing.status !== 'draft') {
    throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)
  }

  const { data, error } = await db
    .from(INVOICE_TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, supplier:suppliers(id,name), items:supply_invoice_items(*, product:products(id,sku,name,unit,retail_price,barcode))')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function postSupplyInvoice(id: string, userId: string) {
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

  return getSupplyInvoice(id)
}

export async function cancelSupplyInvoice(id: string) {
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

  return getSupplyInvoice(id)
}

export async function deleteSupplyInvoice(id: string) {
  const invoice = await getSupplyInvoice(id)
  if (invoice.status !== 'draft') {
    throw new AppError('INVOICE_POSTED', 'Не можна видалити проведену або скасовану накладну', 400)
  }

  // Видаляємо позиції, потім накладну (через ON DELETE RESTRICT)
  const { error: delItemsError } = await db
    .from(ITEM_TABLE)
    .delete()
    .eq('invoice_id', id)

  if (delItemsError) throw new AppError('DB_ERROR', delItemsError.message, 500)

  const { error: delError } = await db
    .from(INVOICE_TABLE)
    .delete()
    .eq('id', id)

  if (delError) throw new AppError('DB_ERROR', delError.message, 500)
}