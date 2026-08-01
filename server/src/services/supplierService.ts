import { randomUUID } from 'node:crypto'
import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { getShiftCashBreakdown } from './shiftService.js'
import type {
  CreateSupplierInput, UpdateSupplierInput, SupplierListQuery,
  CreateSupplyInvoiceInput, UpdateSupplyInvoiceInput, SaveSupplyInvoiceDraftInput, SupplyInvoiceListQuery,
} from '../validators/supplierSchema.js'

const SUPPLIER_TABLE = 'suppliers'
const INVOICE_TABLE  = 'supply_invoices'
const ITEM_TABLE     = 'supply_invoice_items'

function normalizeSupplyInvoiceItems(items: CreateSupplyInvoiceInput['items'] | NonNullable<UpdateSupplyInvoiceInput['items']>) {
  return items.map((item) => ({
    ...item,
    total: Math.round(item.qty * item.purchase_price),
  }))
}

function supplyInvoiceItemsTotal(items: Array<{ total: number }>): number {
  return items.reduce((sum, item) => sum + item.total, 0)
}

async function assertCashboxHasFunds(amount: number, fundSource: string | null | undefined, shiftId: string | null | undefined, tenantId: string) {
  if (fundSource !== 'cashbox' || amount <= 0) return
  if (!shiftId) throw new AppError('SHIFT_REQUIRED', 'Щоб платити з каси, спочатку відкрийте касову зміну', 400)
  const { data: shift, error } = await db
    .from('shifts')
    .select('id,opening_cash,status')
    .eq('id', shiftId)
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  if (!shift) throw new AppError('SHIFT_REQUIRED', 'Щоб платити з каси, спочатку відкрийте касову зміну', 400)
  const cash = await getShiftCashBreakdown(shiftId, tenantId, Number(shift.opening_cash ?? 0))
  if (cash.expected_amount < amount) {
    throw new AppError(
      'CASHBOX_INSUFFICIENT_FUNDS',
      `У касі недостатньо грошей. Доступно ${(cash.expected_amount / 100).toFixed(2)} грн, потрібно ${(amount / 100).toFixed(2)} грн. Оплатіть частину власними коштами.`,
      422,
    )
  }
}

function draftPayloadTotal(payload: unknown): number {
  const items = Array.isArray((payload as any)?.items) ? (payload as any).items : []
  return items.reduce((sum: number, item: any) => {
    const explicitTotal = Number(item?.total ?? 0)
    if (Number.isFinite(explicitTotal) && explicitTotal > 0) return sum + Math.round(explicitTotal)
    const qty = Number(item?.qty ?? 0)
    const purchase = Number(item?.purchase_price ?? 0)
    return sum + Math.max(0, Math.round(qty * purchase))
  }, 0)
}

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

/**
 * Злиття дублікатів постачальників: усі посилання (накладні, замовлення, PO,
 * прайси тощо) переносяться на основного, дублікат — soft-delete.
 * Посилання знаходимо динамічно по всіх таблицях із колонкою supplier_id —
 * щоб нічого не загубити при появі нових таблиць.
 */
export async function mergeSuppliers(primaryId: string, duplicateId: string, tenantId: string) {
  if (primaryId === duplicateId) {
    throw new AppError('SAME_SUPPLIER', 'Не можна злити постачальника з самим собою', 400)
  }

  const { data: both, error: bothErr } = await db
    .from(SUPPLIER_TABLE)
    .select('id')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .in('id', [primaryId, duplicateId])
  if (bothErr) throw new AppError('DB_ERROR', bothErr.message, 500)
  if (!both || both.length !== 2) throw new AppError('NOT_FOUND', 'Постачальника не знайдено', 404)

  await runTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'supplier_id'`
    )
    for (const row of rows) {
      const table = String(row.table_name)
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue // захист від некоректних імен
      if (table === 'supply_invoices' || table === 'supplier_payments') {
        await client.query(
          `UPDATE public.${table} SET supplier_id = $1, updated_at = NOW()
           WHERE supplier_id = $2 AND tenant_id = $3`,
          [primaryId, duplicateId, tenantId]
        )
        continue
      }
      await client.query(
        `UPDATE public.${table} SET supplier_id = $1 WHERE supplier_id = $2`,
        [primaryId, duplicateId]
      )
    }
    await client.query(
      `UPDATE suppliers SET deleted_at = NOW(), is_active = false, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [duplicateId, tenantId]
    )
  })

  return getSupplier(primaryId, tenantId)
}

export async function deleteSupplier(id: string, tenantId: string) {
  await getSupplier(id, tenantId)
  const deletedAt = new Date().toISOString()
  const { error } = await db
    .from(SUPPLIER_TABLE)
    .update({ deleted_at: deletedAt, updated_at: deletedAt, is_active: false })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

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
    .is('deleted_at', null)
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
    .select('*, supplier:suppliers(id,name), items:supply_invoice_items(*, product:products(id,sku,name,unit,purchase_price,retail_price,barcode,storage_bin,category_id,photo_url)), payments:supplier_payments(*)')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
  return data
}

export async function getLatestSupplyInvoiceDraft(tenantId: string) {
  const { data, error } = await db
    .from(INVOICE_TABLE)
    .select('*, supplier:suppliers(id,name)')
    .eq('tenant_id', tenantId)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .not('draft_payload', 'is', null)
    .order('draft_saved_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? null
}
export async function createSupplyInvoice(userId: string, input: CreateSupplyInvoiceInput, tenantId: string) {
  const itemsWithTotal = normalizeSupplyInvoiceItems(input.items)
  const totalKopecks = supplyInvoiceItemsTotal(itemsWithTotal)

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

  if (paidAmount > 0) {
    const method = input.payment_method ?? 'cash'
    const fundSource = input.fund_source ?? (method === 'cash' ? 'cashbox' : 'bank_account')
    await assertCashboxHasFunds(paidAmount, fundSource, input.shift_id ?? null, tenantId)
    const { error: paymentError } = await db.from('supplier_payments').insert({
      tenant_id: tenantId,
      invoice_id: invoice.id,
      supplier_id: input.supplier_id ?? null,
      amount: paidAmount,
      payment_method: method,
      fund_source: fundSource,
      shift_id: input.shift_id ?? null,
      note: 'Оплата під час створення накладної',
      created_by: userId,
    })
    if (paymentError) throw new AppError('DB_ERROR', paymentError.message, 500)

    if (fundSource === 'cashbox') {
      const { error: cashError } = await db.from('cash_operations').insert({
        tenant_id: tenantId,
        shift_id: input.shift_id ?? null,
        type: 'out',
        amount: paidAmount,
        note: 'Оплата постачальнику під час створення накладної',
        source: 'cashbox',
        created_by: userId,
      })
      if (cashError) throw new AppError('DB_ERROR', cashError.message, 500)
    }
  }

  return getSupplyInvoice(invoice.id, tenantId)
}

export async function saveSupplyInvoiceDraft(userId: string, input: SaveSupplyInvoiceDraftInput, tenantId: string) {
  const timestamp = new Date().toISOString()
  const invoiceId = input.invoice_id ?? randomUUID()
  const draftPayload = {
    ...(input.draft_payload as Record<string, unknown>),
    serverInvoiceId: invoiceId,
    savedAt: timestamp,
  }
  const totalKopecks = input.total ?? draftPayloadTotal(draftPayload)

  if (input.invoice_id) {
    const { data: existing, error: existingError } = await db
      .from(INVOICE_TABLE)
      .select('id,status')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .single()
    if (existingError || !existing) throw new AppError('NOT_FOUND', 'Чернетку накладної не знайдено', 404)
    if (existing.status !== 'draft') throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)

    const { error } = await db
      .from(INVOICE_TABLE)
      .update({
        supplier_id: input.supplier_id ?? null,
        invoice_number: input.invoice_number ?? null,
        notes: input.notes ?? null,
        total: totalKopecks,
        draft_payload: draftPayload,
        draft_saved_at: timestamp,
        draft_saved_by: userId,
        updated_at: timestamp,
      })
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    return getSupplyInvoice(invoiceId, tenantId)
  }

  const { error } = await db
    .from(INVOICE_TABLE)
    .insert({
      id: invoiceId,
      supplier_id: input.supplier_id ?? null,
      invoice_number: input.invoice_number ?? null,
      notes: input.notes ?? null,
      status: 'draft',
      total: totalKopecks,
      paid_amount: 0,
      payment_method: null,
      draft_payload: draftPayload,
      draft_saved_at: timestamp,
      draft_saved_by: userId,
      tenant_id: tenantId,
    })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return getSupplyInvoice(invoiceId, tenantId)
}

export async function updateSupplyInvoice(id: string, input: UpdateSupplyInvoiceInput, tenantId: string, userId?: string) {
  const existing = await getSupplyInvoice(id, tenantId)
  if (existing.status !== 'draft') {
    throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)
  }

  const timestamp = new Date().toISOString()
  const hasItems = input.items !== undefined
  const normalizedItems = hasItems ? normalizeSupplyInvoiceItems(input.items ?? []) : null
  const totalKopecks = normalizedItems ? supplyInvoiceItemsTotal(normalizedItems) : Number(existing.total ?? 0)
  const hasDraftPayload = Object.prototype.hasOwnProperty.call(input, 'draft_payload')
  const shouldClearDraft = hasItems || input.draft_payload === null
  const shouldSetDraft = hasDraftPayload && input.draft_payload !== null && !hasItems
  const draftPayload = shouldClearDraft
    ? null
    : shouldSetDraft
      ? { ...(input.draft_payload as Record<string, unknown>), serverInvoiceId: id, savedAt: timestamp }
      : ((existing as any).draft_payload ?? null)
  const draftSavedAt = shouldClearDraft
    ? null
    : shouldSetDraft
      ? timestamp
      : ((existing as any).draft_saved_at ?? null)
  const draftSavedBy = shouldClearDraft
    ? null
    : shouldSetDraft
      ? (userId ?? null)
      : ((existing as any).draft_saved_by ?? null)

  await runTransaction(async (client) => {
    const invoiceResult = await client.query(
      `SELECT status FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, tenantId],
    )
    const invoice = invoiceResult.rows[0]
    if (!invoice) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    if (invoice.status !== 'draft') throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)

    await client.query(
      `UPDATE supply_invoices
       SET supplier_id = $1, invoice_number = $2, notes = $3, total = $4,
           draft_payload = $5::jsonb, draft_saved_at = $6, draft_saved_by = $7,
           updated_at = $8
       WHERE id = $9 AND tenant_id = $10`,
      [
        input.supplier_id !== undefined ? input.supplier_id : existing.supplier_id,
        input.invoice_number !== undefined ? input.invoice_number : existing.invoice_number,
        input.notes !== undefined ? input.notes : existing.notes,
        totalKopecks,
        draftPayload ? JSON.stringify(draftPayload) : null,
        draftSavedAt,
        draftSavedBy,
        timestamp,
        id,
        tenantId,
      ],
    )

    if (normalizedItems) {
      await client.query('DELETE FROM supply_invoice_items WHERE invoice_id = $1 AND tenant_id = $2', [id, tenantId])
      for (const item of normalizedItems) {
        await client.query(
          `INSERT INTO supply_invoice_items (id, tenant_id, invoice_id, product_id, qty, purchase_price, total, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), tenantId, id, item.product_id, Number(item.qty ?? 0), Number(item.purchase_price ?? 0), item.total, timestamp],
        )
      }
    }
  })

  return getSupplyInvoice(id, tenantId)
}

export async function postSupplyInvoice(id: string, userId: string, tenantId: string) {
  // Ensure the invoice belongs to the tenant
  const invoice = await getSupplyInvoice(id, tenantId)
  if ((invoice as any).draft_payload) {
    throw new AppError('INVOICE_DRAFT_NOT_FINALIZED', 'Спочатку відкрийте чернетку накладної та збережіть її позиції', 400)
  }
  if ((invoice.items?.length ?? 0) === 0) {
    throw new AppError('INVOICE_EMPTY', 'У накладній немає товарів', 422)
  }

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
  // Ensure the invoice belongs to the tenant and has no irreversible payment.
  const invoice = await getSupplyInvoice(id, tenantId)
  if (Number(invoice.paid_amount ?? 0) > 0) {
    throw new AppError(
      'PAID_INVOICE_CANNOT_BE_CANCELLED',
      'Не можна скасувати оплачену накладну. Спочатку оформіть повернення або перенесення оплати.',
      409,
    )
  }

  const { error } = await db.rpc('cancel_supply_invoice', {
    p_invoice_id: id
  })

  if (error) {
    if (error.message.includes('NOT_FOUND')) {
      throw new AppError('NOT_FOUND', error.message, 404)
    }
    if (error.message.includes('PAID_INVOICE_CANNOT_BE_CANCELLED')) {
      throw new AppError('PAID_INVOICE_CANNOT_BE_CANCELLED', 'Не можна скасувати оплачену накладну', 409)
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
export async function addInvoicePayment(
  id: string, amount: number, method: string, fundSource: string,
  shiftId: string | null, note: string | null, userId: string, tenantId: string,
) {
  await runTransaction(async (client) => {
    const invoiceResult = await client.query(
      `SELECT id, supplier_id, total, COALESCE(paid_amount, 0) AS paid_amount
       FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, tenantId],
    )
    const invoice = invoiceResult.rows[0]
    if (!invoice) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    const remaining = Number(invoice.total) - Number(invoice.paid_amount)
    if (amount > remaining) throw new AppError('PAYMENT_TOO_LARGE', 'Сума перевищує борг за накладною', 422)
    await assertCashboxHasFunds(amount, fundSource, shiftId, tenantId)

    await client.query(
      `INSERT INTO supplier_payments
       (tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source, shift_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, id, invoice.supplier_id, amount, method, fundSource, shiftId, note, userId],
    )
    await client.query(
      `UPDATE supply_invoices
       SET paid_amount = COALESCE(paid_amount, 0) + $1, payment_method = $2, updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4`,
      [amount, method, id, tenantId],
    )
    if (fundSource === 'cashbox') {
      await client.query(
        `INSERT INTO cash_operations
         (tenant_id, shift_id, type, amount, note, created_by, source)
         VALUES ($1,$2,'out',$3,$4,$5,'cashbox')`,
        [tenantId, shiftId, amount, note || 'Оплата постачальнику', userId],
      )
    }
  })
  return getSupplyInvoice(id, tenantId)
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
    .is('deleted_at', null)
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
  if (invoice.status !== 'draft' || Number(invoice.paid_amount ?? 0) > 0) {
    throw new AppError('INVOICE_DELETE_FORBIDDEN', 'Видалити можна лише неоплачену чернетку накладної. Проведені, скасовані та оплачені документи залишаються в історії.', 409)
  }

  const deletedAt = new Date().toISOString()
  const { error: delError } = await db
    .from(INVOICE_TABLE)
    .update({ deleted_at: deletedAt, updated_at: deletedAt })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

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
    .eq('tenant_id', tenantId)
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
