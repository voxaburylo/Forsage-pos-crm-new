import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { logAction } from './auditService.js'
import type { CreateReturnInput, ReturnListQuery } from '../validators/returnSchema.js'
import { CONDITION_ALLOWED_ACTIONS } from '../validators/returnSchema.js'

const MAX_RETURN_DAYS = 14

export async function listReturns(query: ReturnListQuery) {
  const { page, per_page } = query
  const offset = (page - 1) * per_page

  const { data, error, count } = await db
    .from('returns')
    .select(
      '*, sale:sales(id,sale_number,total), customer:customers(id,phone,full_name)',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: {
      page, per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page),
    },
  }
}

export async function getReturn(id: string) {
  const { data, error } = await db
    .from('returns')
    .select(
      '*, sale:sales(id,sale_number,total,payment_method), customer:customers(id,phone,full_name), return_items(*)'
    )
    .eq('id', id)
    .single()

  if (error || !data) {
    throw new AppError('RETURN_NOT_FOUND', 'Povernennia ne znaydeno', 404)
  }
  return data
}

/** Отримати позиції чека з інформацією скільки вже повернуто */
export async function getSaleItems(saleId: string) {
  const { data: sale, error: saleErr } = await db
    .from('sales')
    .select('id, sale_number, status, customer_id, total, completed_at')
    .eq('id', saleId)
    .single()

  if (saleErr || !sale) {
    throw new AppError('SALE_NOT_FOUND', 'Chek ne znaydeno', 404)
  }

  // Отримуємо всі sale_item_id для цього чека
  const { data: allSaleItemIds } = await db
    .from('sale_items')
    .select('id')
    .eq('sale_id', saleId)

  const ids = (allSaleItemIds ?? []).map((si: { id: string }) => si.id)

  // Збираємо вже повернуті кількості по кожній позиції
  const returnedQtyMap = new Map<string, number>()
  if (ids.length > 0) {
    const { data: existingReturnItems } = await db
      .from('return_items')
      .select('sale_item_id, quantity')
      .in('sale_item_id', ids)

    for (const ri of existingReturnItems ?? []) {
      returnedQtyMap.set(
        ri.sale_item_id,
        (returnedQtyMap.get(ri.sale_item_id) ?? 0) + ri.quantity
      )
    }
  }

  // Отримуємо позиції чека з товарами
  const { data: saleItems, error: itemsErr } = await db
    .from('sale_items')
    .select('*, product:products(id,sku,name,unit)')
    .eq('sale_id', saleId)

  if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

  const items = (saleItems ?? []).map((item: any) => {
    const returnedQty = returnedQtyMap.get(item.id) ?? 0
    return {
      id: item.id,
      product_id: item.product_id,
      product_name: item.product?.name ?? 'Nevidomyi tovar',
      sku: item.product?.sku ?? '',
      unit: item.product?.unit ?? 'sht',
      qty: item.qty,
      unit_price: item.unit_price,
      total: item.total,
      already_returned_qty: returnedQty,
      available_qty: Math.max(0, item.qty - returnedQty),
    }
  })

  return {
    sale: {
      id: sale.id,
      sale_number: sale.sale_number,
      status: sale.status,
      customer_id: sale.customer_id,
      total: sale.total,
      completed_at: sale.completed_at,
    },
    items,
  }
}

/** Валідує що condition + stock_action сумісні */
function validateConditionAction(
  condition: string,
  stockAction: string,
  productName: string,
): void {
  const allowed = CONDITION_ALLOWED_ACTIONS[condition]
  if (!allowed || !allowed.includes(stockAction)) {
    const allowedStr = allowed ? allowed.join(', ') : 'ne vyznacheno'
    throw new AppError(
      'INVALID_STOCK_ACTION',
      'Tovar "' + productName + '" z stanom "' + condition + '" ne mozhna: '
      + stockAction + '. Dozvoleno: ' + allowedStr,
      422,
    )
  }
}

/**
 * Створити повернення (часткове або повне).
 *
 * Валідація (термін, сумісність condition+action) виконується тут.
 * Усі операції з БД (INSERT return + return_items, UPDATE stock,
 * debt_reduction, sale status) виконуються атомарно через RPC process_return.
 */
export async function createReturn(userId: string, tenantId: string, input: CreateReturnInput) {
  // ==================================================================
  // 1. Отримуємо інформацію про продаж та перевіряємо термін
  // ==================================================================
  const { data: sale, error: saleErr } = await db
    .from('sales')
    .select('id, sale_number, customer_id, payment_method, completed_at')
    .eq('id', input.sale_id)
    .single()

  if (saleErr || !sale) {
    throw new AppError('SALE_NOT_FOUND', 'Chek ne znaydeno', 404)
  }

  const saleDate = new Date(sale.completed_at)
  const diffDays = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
  if (diffDays > MAX_RETURN_DAYS) {
    throw new AppError(
      'RETURN_PERIOD_EXPIRED',
      'Termin povernennia mynuv (maksymum ' + MAX_RETURN_DAYS + ' dniv)',
      400,
    )
  }

  // ==================================================================
  // 2. Валідуємо condition + stock_action для кожної позиції
  // ==================================================================
  const stockAction = input.stock_action ?? 'return_to_stock'
  for (const item of input.items) {
    const cond = item.condition ?? 'good'
    // Отримуємо назву товару для повідомлення про помилку
    const { data: si } = await db
      .from('sale_items')
      .select('product:products!inner(name)')
      .eq('id', item.sale_item_id)
      .single()
    const prodName = (si?.product as unknown as { name: string } | undefined)?.name ?? 'Nevidomyi'
    validateConditionAction(cond, stockAction, prodName)
  }

  // ==================================================================
  // 3. Перевірка debt_reduction вимагає клієнта
  // ==================================================================
  if (input.refund_method === 'debt_reduction' && !sale.customer_id) {
    throw new AppError(
      'CUSTOMER_REQUIRED',
      'Povernennia na borh mozhlyve tilky dlia kliientiv z kartkoiu',
      400,
    )
  }

  // ==================================================================
  // 4. Викликаємо атомарну RPC
  // ==================================================================
  const itemsPayload = input.items.map((i: any) => ({
    sale_item_id: i.sale_item_id,
    product_id: i.product_id,
    quantity: i.quantity,
    condition: i.condition ?? 'good',
  }))

  const { data, error: rpcError } = await db.rpc('process_return', {
    p_tenant_id:     tenantId,
    p_user_id:       userId,
    p_sale_id:       input.sale_id,
    p_customer_id:   sale.customer_id ?? null,
    p_reason:        input.reason,
    p_reason_note:   input.reason_note ?? null,
    p_refund_method: input.refund_method,
    p_stock_action:  stockAction,
    p_items:         JSON.stringify(itemsPayload),
  })

  // ==================================================================
  // 5. Обробка помилок RPC
  // ==================================================================
  if (rpcError) {
    const msg = rpcError.message ?? ''
    if (msg.includes('SALE_NOT_FOUND')) {
      throw new AppError('SALE_NOT_FOUND', 'Chek ne znaydeno', 404)
    }
    if (msg.includes('ALREADY_RETURNED')) {
      throw new AppError('ALREADY_RETURNED', 'Chek vzhe povnistiu povernutyi', 409)
    }
    if (msg.includes('CATEGORY_RESTRICTED')) {
      throw new AppError('CATEGORY_RESTRICTED', 'Elektronika povernenniu ne pidliahae', 400)
    }
    if (msg.includes('ITEM_NOT_FOUND')) {
      throw new AppError('ITEM_NOT_FOUND', 'Pozystsiyu cheka ne znaydeno', 404)
    }
    if (msg.includes('DUPLICATE_RETURN')) {
      throw new AppError('DUPLICATE_RETURN', 'Pozystsiya vzhe povernuta', 409)
    }
    throw new AppError('DB_ERROR', msg, 500)
  }

  if (!data) {
    throw new AppError('DB_ERROR', 'RPC process_return ne povernuv dani', 500)
  }

  const returnRecord = typeof data === 'string' ? JSON.parse(data) : data

  // ==================================================================
  // 6. Аудит (await — гарантуємо запис)
  // ==================================================================
  await logAction({
    tenantId: tenantId,
    userId: userId,
    userRole: 'manager',
    action: 'sale.returned',
    entityType: 'return',
    entityId: returnRecord.id,
    entityLabel: 'Chek #' + sale.sale_number,
    newValue: {
      refund_method: input.refund_method,
      reason: input.reason,
      refund_kopecks: returnRecord.refund_kopecks,
      items_count: input.items.length,
      stock_action: stockAction,
    },
  })

  return getReturn(returnRecord.id)
}
