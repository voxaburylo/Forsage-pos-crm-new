import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { getCurrentShift } from './shiftService.js'
import type { CreateSaleInput, CalculatePriceInput, SaleListQuery } from '../validators/saleSchema.js'

const TABLE = 'sales'

async function generateSaleNumber(): Promise<string> {
  const { count } = await db.from(TABLE).select('*', { count: 'exact', head: true })
  const num = ((count ?? 0) + 1).toString().padStart(6, '0')
  return num
}

export async function listSales(query: SaleListQuery) {
  const { shift_id, customer_id, sale_number, date_from, date_to, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*, customer:customers(id,phone,full_name)', { count: 'exact' })
    .order('completed_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (shift_id)    q = q.eq('shift_id', shift_id)
  if (customer_id) q = q.eq('customer_id', customer_id)
  if (sale_number) q = q.eq('sale_number', sale_number)
  if (date_from)   q = q.gte('completed_at', date_from)
  if (date_to)     q = q.lte('completed_at', date_to)

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  }
}

export async function getSale(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, sale_items(*, product:products(id,sku,name,unit)), customer:customers(id,phone,full_name)')
    .eq('id', id)
    .single()

  if (error || !data) throw new AppError('SALE_NOT_FOUND', 'Продаж не знайдено', 404)
  return data
}

export async function calculatePrice(input: CalculatePriceInput) {
  const productIds = input.items.map((i) => i.product_id)
  const { data: products, error } = await db
    .from('products')
    .select('id, sku, name, retail_price, qty_on_hand, unit')
    .in('id', productIds)
    .is('deleted_at', null)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return input.items.map((item) => {
    const product = products?.find((p) => p.id === item.product_id)
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', `Товар не знайдено: ${item.product_id}`, 404)
    const total = Math.round(product.retail_price * item.qty)
    return {
      product_id: item.product_id,
      sku:        product.sku,
      name:       product.name,
      unit:       product.unit,
      unit_price: product.retail_price,
      qty:        item.qty,
      total,
      in_stock:   product.qty_on_hand >= item.qty,
      qty_on_hand: product.qty_on_hand,
    }
  })
}

export async function createSale(cashierId: string, input: CreateSaleInput) {
  // 1. Перевіряємо що зміна відкрита
  const shift = await getCurrentShift(cashierId)
  if (!shift) throw new AppError('NO_OPEN_SHIFT', 'Спочатку відкрийте зміну', 400)
  if (shift.id !== input.shift_id) throw new AppError('WRONG_SHIFT', 'Невірна зміна', 400)

  // 2. Борг вимагає клієнта
  if (input.payment_method === 'debt' && !input.customer_id) {
    throw new AppError('CUSTOMER_REQUIRED', 'При продажу в борг потрібно вказати клієнта', 400)
  }

  // 3. Рахуємо суми
  const subtotal = input.items.reduce((s, i) => s + i.unit_price * i.qty, 0)
  const itemsDiscount = input.items.reduce((s, i) => s + i.discount, 0)
  const totalDiscount = input.discount + itemsDiscount
  const total = Math.max(0, subtotal - totalDiscount)

  // 4. Генеруємо номер чека
  const saleNumber = await generateSaleNumber()

  // 5. Створюємо продаж
  const { data: sale, error: saleError } = await db
    .from(TABLE)
    .insert({
      sale_number:    saleNumber,
      customer_id:    input.customer_id ?? null,
      cashier_id:     cashierId,
      shift_id:       input.shift_id,
      status:         'completed',
      subtotal:       Math.round(subtotal),
      discount:       Math.round(totalDiscount),
      total:          Math.round(total),
      payment_method: input.payment_method,
      is_debt:        input.payment_method === 'debt',
      notes:          input.notes ?? null,
    })
    .select('id')
    .single()

  if (saleError || !sale) throw new AppError('DB_ERROR', saleError?.message ?? 'Помилка створення продажу', 500)

  // 6. Додаємо позиції чека
  const saleItems = input.items.map((item) => ({
    sale_id:    sale.id,
    product_id: item.product_id,
    qty:        item.qty,
    unit_price: item.unit_price,
    discount:   item.discount,
    total:      Math.round(item.unit_price * item.qty - item.discount),
  }))

  const { error: itemsError } = await db.from('sale_items').insert(saleItems)
  if (itemsError) throw new AppError('DB_ERROR', itemsError.message, 500)

  // 7. Зменшуємо залишки товарів (select + update для кожного)
  for (const item of input.items) {
    const { data: prod } = await db
      .from('products')
      .select('qty_on_hand')
      .eq('id', item.product_id)
      .single()

    if (prod) {
      await db
        .from('products')
        .update({ qty_on_hand: prod.qty_on_hand - item.qty, updated_at: new Date().toISOString() })
        .eq('id', item.product_id)
    }
  }

  // 8. Якщо борг — збільшуємо debt_balance клієнта
  if (input.payment_method === 'debt' && input.customer_id) {
    const { data: customer } = await db
      .from('customers')
      .select('debt_balance')
      .eq('id', input.customer_id)
      .single()

    if (customer) {
      await db
        .from('customers')
        .update({ debt_balance: customer.debt_balance + Math.round(total), updated_at: new Date().toISOString() })
        .eq('id', input.customer_id)
    }
  }

  return getSale(sale.id)
}

