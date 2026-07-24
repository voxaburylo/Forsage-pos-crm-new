import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { AppError } from '../middleware/errorHandler.js'
import { logAction } from './auditService.js'
import { allocateReturnableLineTotals } from './returnAllocation.js'
import type { CreateReturnInput, ReturnListQuery } from '../validators/returnSchema.js'
import { CONDITION_ALLOWED_ACTIONS } from '../validators/returnSchema.js'

const MAX_RETURN_DAYS = 14

type RequestedReturnItem = CreateReturnInput['items'][number]

interface SaleItemForReturnValidation {
  id: string
  product_id: string
  unit_price: number
  qty: number
  product?: {
    id: string
    name: string
    tenant_id: string
  } | Array<{
    id: string
    name: string
    tenant_id: string
  }> | null
}

export interface ResolvedReturnItem {
  sale_item_id: string
  product_id: string
  quantity: number
  condition: string
  unit_price: number
  product_name: string
}

function relatedProduct(row: SaleItemForReturnValidation) {
  return Array.isArray(row.product) ? row.product[0] : row.product
}

/**
 * Builds trusted return lines exclusively from tenant-scoped sale items.
 * Client product identifiers are used only as an integrity assertion.
 */
export function resolveReturnItems(
  requestedItems: RequestedReturnItem[],
  saleItems: SaleItemForReturnValidation[],
  returnedQtyBySaleItem: ReadonlyMap<string, number>,
  stockAction: string,
  tenantId: string,
): ResolvedReturnItem[] {
  const saleItemById = new Map(saleItems.map((item) => [item.id, item]))

  return requestedItems.map((requested) => {
    const source = saleItemById.get(requested.sale_item_id)
    const product = source ? relatedProduct(source) : null
    if (!source || !product || product.tenant_id !== tenantId || product.id !== source.product_id) {
      throw new AppError('ITEM_NOT_FOUND', 'Позицію чека не знайдено', 404)
    }

    if (requested.product_id !== source.product_id) {
      throw new AppError(
        'PRODUCT_MISMATCH',
        'Товар у поверненні не відповідає вибраній позиції чека',
        409,
      )
    }

    const soldQty = Number(source.qty)
    const unitPrice = Number(source.unit_price)
    const returnedQty = Number(returnedQtyBySaleItem.get(source.id) ?? 0)
    const requestedQty = Number(requested.quantity)
    if (
      !Number.isFinite(soldQty)
      || soldQty < 0
      || !Number.isFinite(unitPrice)
      || unitPrice < 0
      || !Number.isFinite(returnedQty)
      || returnedQty < 0
    ) {
      throw new AppError('DB_ERROR', 'Некоректні дані позиції чека', 500)
    }

    const availableQty = Math.max(0, soldQty - returnedQty)
    if (requestedQty > availableQty + 1e-9) {
      throw new AppError(
        'DUPLICATE_RETURN',
        'Кількість повернення перевищує доступну кількість у чеку',
        409,
      )
    }

    const condition = requested.condition ?? 'good'
    validateConditionAction(condition, stockAction, product.name)
    return {
      sale_item_id: source.id,
      product_id: source.product_id,
      quantity: requestedQty,
      condition,
      unit_price: unitPrice,
      product_name: product.name,
    }
  })
}

export async function listReturns(query: ReturnListQuery, tenantId: string) {
  const { page, per_page } = query
  const offset = (page - 1) * per_page

  const { data, error, count } = await db
    .from('returns')
    .select(
      '*, sale:sales(id,sale_number,total), customer:customers(id,phone,full_name)',
      { count: 'exact' }
    )
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (error) {
    logger.error({ error: error.message }, 'Failed to list returns')
    throw new AppError('DB_ERROR', 'Не вдалося завантажити список повернень', 500)
  }

  return {
    data: data ?? [],
    pagination: {
      page, per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page),
    },
  }
}

export async function getReturn(id: string, tenantId: string) {
  const { data, error } = await db
    .from('returns')
    .select(
      '*, sale:sales(id,sale_number,total,payment_method), customer:customers(id,phone,full_name), return_items(*)'
    )
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()

  if (error || !data) {
    throw new AppError('RETURN_NOT_FOUND', 'Повернення не знайдено', 404)
  }
  return data
}

/** Отримати позиції чека з інформацією скільки вже повернуто */
export async function getSaleItems(saleId: string, tenantId: string) {
  const { data: sale, error: saleErr } = await db
    .from('sales')
    .select('id, sale_number, status, customer_id, total, completed_at, is_fiscal, fiscal_number')
    .eq('id', saleId)
    .eq('tenant_id', tenantId)
    .single()

  if (saleErr || !sale) {
    throw new AppError('SALE_NOT_FOUND', 'Чек не знайдено', 404)
  }

  // Отримуємо всі sale_item_id для цього чека
  const { data: allSaleItemIds, error: saleItemIdsError } = await db
    .from('sale_items')
    .select('id')
    .eq('sale_id', saleId)
    .eq('tenant_id', tenantId)

  if (saleItemIdsError) {
    logger.error({ error: saleItemIdsError.message, saleId }, 'Failed to load sale item ids for return')
    throw new AppError('DB_ERROR', 'Не вдалося завантажити позиції чека', 500)
  }

  const ids = (allSaleItemIds ?? []).map((si: { id: string }) => si.id)

  // Збираємо вже повернуті кількості по кожній позиції
  const returnedQtyMap = new Map<string, number>()
  const returnedTotalMap = new Map<string, number>()
  if (ids.length > 0) {
    const { data: existingReturnItems, error: existingReturnsError } = await db
      .from('return_items')
      .select('sale_item_id, quantity, total_kopecks')
      .eq('tenant_id', tenantId)
      .in('sale_item_id', ids)

    if (existingReturnsError) {
      logger.error({ error: existingReturnsError.message, saleId }, 'Failed to load prior return quantities')
      throw new AppError('DB_ERROR', 'Не вдалося перевірити попередні повернення', 500)
    }

    for (const ri of existingReturnItems ?? []) {
      returnedQtyMap.set(
        ri.sale_item_id,
        (returnedQtyMap.get(ri.sale_item_id) ?? 0) + Number(ri.quantity)
      )
      returnedTotalMap.set(
        ri.sale_item_id,
        (returnedTotalMap.get(ri.sale_item_id) ?? 0) + Number(ri.total_kopecks ?? 0),
      )
    }
  }

  // Отримуємо позиції чека з товарами
  const { data: saleItems, error: itemsErr } = await db
    .from('sale_items')
    .select('*, product:products!inner(id,sku,name,unit,tenant_id)')
    .eq('sale_id', saleId)
    .eq('product.tenant_id', tenantId)
    .eq('tenant_id', tenantId)

  if (itemsErr) {
    logger.error({ error: itemsErr.message, saleId }, 'Failed to load sale items for return')
    throw new AppError('DB_ERROR', 'Не вдалося завантажити позиції чека', 500)
  }

  const refundableByItem = allocateReturnableLineTotals(
    Number(sale.total),
    (saleItems ?? []).map((item: any) => ({
      id: item.id,
      qty: item.qty,
      unit_price: item.unit_price,
      discount: item.discount,
      core_deposit_amount: item.core_deposit_amount,
    })),
  )

  const items = (saleItems ?? []).map((item: any) => {
    const returnedQty = returnedQtyMap.get(item.id) ?? 0
    const refundableTotal = refundableByItem.get(item.id) ?? 0
    const alreadyRefunded = returnedTotalMap.get(item.id) ?? 0
    return {
      id: item.id,
      product_id: item.product_id,
      product_name: item.product?.name ?? 'Невідомий товар',
      sku: item.product?.sku ?? '',
      unit: item.product?.unit ?? 'шт',
      qty: item.qty,
      unit_price: item.unit_price,
      total: item.total,
      already_returned_qty: returnedQty,
      available_qty: Math.max(0, item.qty - returnedQty),
      refundable_total: refundableTotal,
      already_refunded_kopecks: alreadyRefunded,
      available_refund: Math.max(0, refundableTotal - alreadyRefunded),
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
      is_fiscal: sale.is_fiscal === true,
      fiscal_number: sale.fiscal_number ?? null,
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
    const conditionLabels: Record<string, string> = {
      good: 'справний',
      damaged: 'пошкоджений',
      opened_packaging: 'відкрита упаковка',
      defective: 'брак',
    }
    const actionLabels: Record<string, string> = {
      return_to_stock: 'повернути на склад',
      write_off: 'списати',
      send_to_supplier: 'повернути постачальнику',
    }
    const allowedStr = allowed
      ? allowed.map((action) => actionLabels[action] ?? action).join(', ')
      : 'не визначено'
    throw new AppError(
      'INVALID_STOCK_ACTION',
      'Товар "' + productName + '" зі станом "' + (conditionLabels[condition] ?? condition)
      + '" не можна обробити дією "' + (actionLabels[stockAction] ?? stockAction)
      + '". Дозволено: ' + allowedStr,
      422,
    )
  }
}

/**
 * Створити повернення (часткове або повне).
 *
 * Валідація (термін, сумісність condition+action) виконується тут.
 * Усі операції з БД (INSERT return + return_items, UPDATE stock,
 * debt_reduction, sale status) виконуються атомарно через RPC process_return_v2.
 */
export async function createReturn(
  userId: string,
  tenantId: string,
  input: CreateReturnInput,
  userRole: string,
  operationId: string,
) {
  // ==================================================================
  // 1. Отримуємо інформацію про продаж та перевіряємо термін
  // ==================================================================
  const { data: sale, error: saleErr } = await db
    .from('sales')
    .select('id, sale_number, customer_id, payment_method, completed_at, status')
    .eq('id', input.sale_id)
    .eq('tenant_id', tenantId)
    .single()

  if (saleErr || !sale) {
    throw new AppError('SALE_NOT_FOUND', 'Чек не знайдено', 404)
  }

  if (sale.status !== 'completed') {
    throw new AppError('SALE_NOT_COMPLETED', 'Повернення можливе лише для завершеного чека', 409)
  }

  const saleDate = new Date(sale.completed_at)
  const diffDays = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
  if (!Number.isFinite(saleDate.getTime())) {
    throw new AppError('DB_ERROR', 'У чеку вказано некоректну дату завершення', 500)
  }
  if (diffDays > MAX_RETURN_DAYS) {
    throw new AppError(
      'RETURN_PERIOD_EXPIRED',
      'Строк повернення минув (максимум ' + MAX_RETURN_DAYS + ' днів)',
      400,
    )
  }

  // ==================================================================
  // 2. Валідуємо condition + stock_action для кожної позиції
  // ==================================================================
  const stockAction = input.stock_action ?? 'return_to_stock'
  const saleItemIds = input.items.map((item) => item.sale_item_id)
  const { data: saleItemRows, error: saleItemsError } = await db
    .from('sale_items')
    .select('id,product_id,unit_price,qty,product:products!inner(id,name,tenant_id)')
    .eq('sale_id', input.sale_id)
    .eq('tenant_id', tenantId)
    .eq('product.tenant_id', tenantId)
    .in('id', saleItemIds)

  if (saleItemsError) {
    logger.error({ error: saleItemsError.message, saleId: input.sale_id }, 'Failed to validate return items')
    throw new AppError('DB_ERROR', 'Не вдалося перевірити позиції чека', 500)
  }

  const returnedQtyBySaleItem = new Map<string, number>()
  const { data: priorReturnItems, error: priorReturnsError } = await db
    .from('return_items')
    .select('sale_item_id,quantity')
    .eq('tenant_id', tenantId)
    .in('sale_item_id', saleItemIds)

  if (priorReturnsError) {
    logger.error({ error: priorReturnsError.message, saleId: input.sale_id }, 'Failed to validate prior returns')
    throw new AppError('DB_ERROR', 'Не вдалося перевірити попередні повернення', 500)
  }
  for (const prior of priorReturnItems ?? []) {
    returnedQtyBySaleItem.set(
      prior.sale_item_id,
      (returnedQtyBySaleItem.get(prior.sale_item_id) ?? 0) + Number(prior.quantity),
    )
  }

  const resolvedItems = resolveReturnItems(
    input.items,
    (saleItemRows ?? []) as unknown as SaleItemForReturnValidation[],
    returnedQtyBySaleItem,
    stockAction,
    tenantId,
  )

  // ==================================================================
  // 3. Повернення на рахунок або в рахунок боргу вимагає клієнта
  // ==================================================================
  if ((input.refund_method === 'debt_reduction' || input.refund_method === 'credit') && !sale.customer_id) {
    throw new AppError(
      'CUSTOMER_REQUIRED',
      'Цей спосіб повернення можливий лише для чека з клієнтом',
      400,
    )
  }

  // ==================================================================
  // 4. Викликаємо атомарну RPC
  // ==================================================================
  const itemsPayload = resolvedItems.map((item) => ({
    sale_item_id: item.sale_item_id,
    product_id: item.product_id,
    quantity: item.quantity,
    condition: item.condition,
  }))

  const { data, error: rpcError } = await db.rpc('process_return_v2', {
    p_tenant_id:     tenantId,
    p_user_id:       userId,
    p_sale_id:       input.sale_id,
    p_customer_id:   sale.customer_id ?? null,
    p_reason:        input.reason,
    p_operation_id: operationId,
    p_reason_note:   input.reason_note ?? null,
    p_refund_method: input.refund_method,
    p_stock_action:  stockAction,
    p_fiscal_number: input.fiscal_number ?? null,
    p_items:         JSON.stringify(itemsPayload),
  })

  // ==================================================================
  // 5. Обробка помилок RPC
  // ==================================================================
  if (rpcError) {
    const msg = rpcError.message ?? ''
    if (msg.includes('SALE_NOT_FOUND')) {
      throw new AppError('SALE_NOT_FOUND', 'Чек не знайдено', 404)
    }
    if (msg.includes('ALREADY_RETURNED')) {
      throw new AppError('ALREADY_RETURNED', 'Чек уже повністю повернуто', 409)
    }
    if (msg.includes('SALE_NOT_COMPLETED')) {
      throw new AppError('SALE_NOT_COMPLETED', 'Повернення можливе лише для завершеного чека', 409)
    }
    if (msg.includes('CATEGORY_RESTRICTED')) {
      throw new AppError('CATEGORY_RESTRICTED', 'Електроніка не підлягає поверненню', 400)
    }
    if (msg.includes('ITEM_NOT_FOUND')) {
      throw new AppError('ITEM_NOT_FOUND', 'Позицію чека не знайдено', 404)
    }
    if (msg.includes('PRODUCT_MISMATCH')) {
      throw new AppError('PRODUCT_MISMATCH', 'Товар не відповідає позиції чека', 409)
    }
    if (msg.includes('CUSTOMER_MISMATCH')) {
      throw new AppError('CUSTOMER_MISMATCH', 'Клієнт не відповідає вибраному чеку', 409)
    }
    if (msg.includes('CUSTOMER_REQUIRED')) {
      throw new AppError('CUSTOMER_REQUIRED', 'Цей спосіб повернення потребує клієнта', 400)
    }
    if (msg.includes('INSUFFICIENT_DEBT')) {
      throw new AppError('INSUFFICIENT_DEBT', 'Сума боргу клієнта менша за суму повернення', 409)
    }
    if (msg.includes('IDEMPOTENCY_CONFLICT')) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Цей номер операції вже використано для іншого повернення', 409)
    }
    if (msg.includes('DUPLICATE_ITEM') || msg.includes('INVALID_RETURN_ITEMS')) {
      throw new AppError('INVALID_RETURN_ITEMS', 'Некоректні позиції повернення', 422)
    }
    if (msg.includes('DUPLICATE_RETURN')) {
      throw new AppError('DUPLICATE_RETURN', 'Позицію вже повернуто', 409)
    }
    if (msg.includes('INVALID_SALE_ITEM')) {
      throw new AppError('INVALID_SALE_ITEM', 'У чеку є некоректна позиція', 422)
    }
    if (msg.includes('OPEN_SHIFT_REQUIRED')) {
      throw new AppError('OPEN_SHIFT_REQUIRED', 'Спочатку відкрийте касову зміну', 400)
    }
    logger.error({ error: msg, saleId: input.sale_id }, 'process_return_v2 RPC failed')
    throw new AppError('DB_ERROR', 'Не вдалося оформити повернення', 500)
  }

  if (!data) {
    throw new AppError('DB_ERROR', 'Не вдалося отримати результат оформлення повернення', 500)
  }

  const returnRecord = typeof data === 'string' ? JSON.parse(data) : data
  if (!returnRecord || typeof returnRecord !== 'object' || typeof returnRecord.id !== 'string') {
    throw new AppError('DB_ERROR', 'Не вдалося отримати результат оформлення повернення', 500)
  }
  if (returnRecord._replayed === true) return getReturn(returnRecord.id, tenantId)


  // ==================================================================
  // 5.5. Відображаємо повністю повернені позиції у картці виданого замовлення.
  // Часткове повернення не ховаємо під загальним статусом «повернено».
  // ==================================================================
  try {
    const { data: order } = await db
      .from('customer_orders')
      .select('id')
      .eq('sale_id', input.sale_id)
      .eq('tenant_id', tenantId)
      .maybeSingle()

    if (order) {
      const { data: allSaleItems, error: allSaleItemsError } = await db
        .from('sale_items')
        .select('id, product_id, qty')
        .eq('sale_id', input.sale_id)
        .eq('tenant_id', tenantId)
      if (allSaleItemsError) throw allSaleItemsError

      const saleItemIds = (allSaleItems ?? []).map((item) => item.id)
      const { data: allReturnItems, error: allReturnItemsError } = saleItemIds.length > 0
        ? await db
            .from('return_items')
            .select('sale_item_id, quantity')
            .eq('tenant_id', tenantId)
            .in('sale_item_id', saleItemIds)
        : { data: [], error: null }
      if (allReturnItemsError) throw allReturnItemsError

      const soldByProduct = new Map<string, number>()
      const returnedBySaleItem = new Map<string, number>()
      for (const item of allSaleItems ?? []) {
        soldByProduct.set(item.product_id, (soldByProduct.get(item.product_id) ?? 0) + Number(item.qty))
      }
      for (const item of allReturnItems ?? []) {
        returnedBySaleItem.set(
          item.sale_item_id,
          (returnedBySaleItem.get(item.sale_item_id) ?? 0) + Number(item.quantity),
        )
      }
      const returnedByProduct = new Map<string, number>()
      for (const item of allSaleItems ?? []) {
        returnedByProduct.set(
          item.product_id,
          (returnedByProduct.get(item.product_id) ?? 0) + (returnedBySaleItem.get(item.id) ?? 0),
        )
      }
      const fullyReturnedProductIds = [...soldByProduct.entries()]
        .filter(([productId, soldQty]) => (returnedByProduct.get(productId) ?? 0) >= soldQty)
        .map(([productId]) => productId)

      if (fullyReturnedProductIds.length > 0) {
        const { error: orderItemsError } = await db
          .from('customer_order_items')
          .update({ item_status: 'returned' })
          .eq('order_id', order.id)
          .in('product_id', fullyReturnedProductIds)
        if (orderItemsError) throw orderItemsError

        await db.from('order_activity_log').insert({
          order_id: order.id,
          user_id: userId,
          action: 'items_returned',
          details: { return_id: returnRecord.id, product_ids: fullyReturnedProductIds },
        })
      }
    }
  } catch (err) {
    logger.error({
      error: err instanceof Error ? err.message : err,
      saleId: input.sale_id,
    }, 'Failed to map return to customer order')
  }

  // ==================================================================
  // 5.6. Сторно комісії за повернені позиції (щоб менеджеру не лишалась
  //      зарплата за товар, який клієнт повернув)
  // ==================================================================
  try {
    const { reverseCommissionForReturn } = await import('./commissionService.js')
    await reverseCommissionForReturn(
      input.sale_id,
      resolvedItems,
      tenantId,
      userId,
    )
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err, saleId: input.sale_id }, 'Failed to reverse commission on return')
  }

  // ==================================================================
  // 6. Аудит (await — гарантуємо запис)
  // ==================================================================
  await logAction({
    tenantId: tenantId,
    userId: userId,
    userRole: userRole,
    action: 'sale.returned',
    entityType: 'return',
    entityId: returnRecord.id,
    entityLabel: 'Чек №' + sale.sale_number,
    newValue: {
      refund_method: input.refund_method,
      reason: input.reason,
      refund_kopecks: returnRecord.refund_kopecks,
      items_count: resolvedItems.length,
      stock_action: stockAction,
      fiscal_number: input.fiscal_number ?? null,
    },
  })

  return getReturn(returnRecord.id, tenantId)
}
