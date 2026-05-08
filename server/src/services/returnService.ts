import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { CreateReturnInput, ReturnListQuery } from '../validators/returnSchema.js'

const MAX_RETURN_DAYS = 14

export async function listReturns(query: ReturnListQuery) {
  const { page, per_page } = query
  const offset = (page - 1) * per_page

  const { data, error, count } = await db
    .from('returns')
    .select('*, sale:sales(id,sale_number,total), customer:customers(id,phone,full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  }
}

export async function getReturn(id: string) {
  const { data, error } = await db
    .from('returns')
    .select('*, sale:sales(id,sale_number,total,payment_method), customer:customers(id,phone,full_name), return_items(*)')
    .eq('id', id)
    .single()

  if (error || !data) throw new AppError('RETURN_NOT_FOUND', 'Повернення не знайдено', 404)
  return data
}

export async function createReturn(userId: string, input: CreateReturnInput) {
  // 1. Отримуємо чек з позиціями
  const { data: sale, error: saleError } = await db
    .from('sales')
    .select('id, sale_number, customer_id, total, status, payment_method, completed_at')
    .eq('id', input.sale_id)
    .single()

  if (saleError || !sale) throw new AppError('SALE_NOT_FOUND', 'Чек не знайдено', 404)

  // 2. Перевіряємо що чек ще не повернутий
  if (sale.status === 'returned') {
    throw new AppError('ALREADY_RETURNED', 'Цей чек вже було повернуто', 409)
  }

  // 3. Перевіряємо термін повернення (14 днів)
  const saleDate = new Date(sale.completed_at)
  const diffDays = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
  if (diffDays > MAX_RETURN_DAYS) {
    throw new AppError(
      'RETURN_PERIOD_EXPIRED',
      `Термін повернення минув (максимум ${MAX_RETURN_DAYS} днів)`,
      400,
    )
  }

  // 4. Перевіряємо що debt_reduction можливий тільки якщо є клієнт
  if (input.refund_method === 'debt_reduction' && !sale.customer_id) {
    throw new AppError('CUSTOMER_REQUIRED', 'Повернення на борг можливе тільки для клієнтів з карткою', 400)
  }

  // 5. Отримуємо позиції чека
  const { data: saleItems, error: itemsError } = await db
    .from('sale_items')
    .select('id, product_id, qty, unit_price, total')
    .eq('sale_id', input.sale_id)

  if (itemsError) throw new AppError('DB_ERROR', itemsError.message, 500)
  const items = saleItems ?? []

  // 6. Створюємо запис повернення
  const { data: returnRecord, error: returnError } = await db
    .from('returns')
    .insert({
      tenant_id:      '00000000-0000-0000-0000-000000000001',
      sale_id:        input.sale_id,
      customer_id:    sale.customer_id ?? null,
      return_type:    'refund',
      reason:         input.reason,
      reason_note:    input.reason_note ?? null,
      refund_method:  input.refund_method,
      refund_kopecks: sale.total,
      stock_action:   'return_to_stock',
      status:         'completed',
      approved_by:    userId,
    })
    .select('id')
    .single()

  if (returnError || !returnRecord) throw new AppError('DB_ERROR', returnError?.message ?? 'Помилка створення повернення', 500)

  // 7. Записуємо позиції повернення та відновлюємо залишки
  for (const item of items) {
    // Записуємо позицію
    await db.from('return_items').insert({
      tenant_id:          '00000000-0000-0000-0000-000000000001',
      return_id:          returnRecord.id,
      product_id:         item.product_id,
      sale_item_id:       item.id,
      quantity:           item.qty,
      unit_price_kopecks: item.unit_price,
      total_kopecks:      item.total,
      condition:          'good',
    })

    // Відновлюємо qty_on_hand
    const { data: product } = await db
      .from('products')
      .select('qty_on_hand')
      .eq('id', item.product_id)
      .single()

    if (product) {
      await db
        .from('products')
        .update({ qty_on_hand: product.qty_on_hand + item.qty, updated_at: new Date().toISOString() })
        .eq('id', item.product_id)
    }
  }

  // 8. Якщо повернення на зменшення боргу — зменшуємо debt_balance
  if (input.refund_method === 'debt_reduction' && sale.customer_id) {
    const { data: customer } = await db
      .from('customers')
      .select('debt_balance')
      .eq('id', sale.customer_id)
      .single()

    if (customer && customer.debt_balance > 0) {
      const reduction = Math.min(customer.debt_balance, sale.total)
      await db
        .from('customers')
        .update({ debt_balance: customer.debt_balance - reduction, updated_at: new Date().toISOString() })
        .eq('id', sale.customer_id)
    }
  }

  // 9. Позначаємо чек як повернутий
  await db.from('sales').update({ status: 'returned', updated_at: new Date().toISOString() }).eq('id', input.sale_id)

  return getReturn(returnRecord.id)
}






