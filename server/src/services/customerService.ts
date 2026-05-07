import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizePhone } from '../validators/customerSchema.js'
import type {
  CreateCustomerInput, UpdateCustomerInput,
  CustomerListQuery, PayDebtInput,
} from '../validators/customerSchema.js'

const TABLE = 'customers'

export async function listCustomers(query: CustomerListQuery) {
  const { search, has_debt, tag, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*', { count: 'exact' })
    .is('deleted_at', null)
    .order('full_name', { ascending: true })
    .range(offset, offset + per_page - 1)

  if (search) {
    const normalized = normalizePhone(search)
    q = q.or(`phone.ilike.%${normalized}%,full_name.ilike.%${search}%`)
  }
  if (has_debt === 'true')  q = q.gt('debt_balance', 0)
  if (has_debt === 'false') q = q.eq('debt_balance', 0)
  if (tag) q = q.contains('tags', [tag])

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

export async function getCustomer(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
  return data
}

export async function findByPhone(phone: string) {
  const normalized = normalizePhone(phone)
  const { data } = await db
    .from(TABLE)
    .select('*')
    .eq('phone', normalized)
    .is('deleted_at', null)
    .maybeSingle()
  return data
}

export async function createCustomer(input: CreateCustomerInput) {
  const existing = await findByPhone(input.phone)
  if (existing) throw new AppError('PHONE_DUPLICATE', `Клієнт з телефоном ${input.phone} вже існує`, 409)

  const { data, error } = await db
    .from(TABLE)
    .insert(input)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateCustomer(id: string, input: UpdateCustomerInput) {
  await getCustomer(id)

  if (input.phone) {
    const existing = await findByPhone(input.phone)
    if (existing && existing.id !== id) {
      throw new AppError('PHONE_DUPLICATE', `Телефон ${input.phone} вже використовується`, 409)
    }
  }

  const { data, error } = await db
    .from(TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function deleteCustomer(id: string) {
  await getCustomer(id)
  const { error } = await db
    .from(TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function getCustomerSales(customerId: string) {
  await getCustomer(customerId)

  const { data, error } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at')
    .eq('customer_id', customerId)
    .order('completed_at', { ascending: false })
    .limit(50)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

// Повертає продажі в борг — це і є "история долгов" для MVP
export async function getCustomerDebts(customerId: string) {
  await getCustomer(customerId)

  const { data, error } = await db
    .from('sales')
    .select('id, sale_number, total, status, completed_at')
    .eq('customer_id', customerId)
    .eq('payment_method', 'debt')
    .order('completed_at', { ascending: false })
    .limit(50)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function payDebt(customerId: string, input: PayDebtInput) {
  const customer = await getCustomer(customerId)

  if (customer.debt_balance <= 0) {
    throw new AppError('NO_DEBT', 'У клієнта немає боргу', 400)
  }
  if (input.amount > customer.debt_balance) {
    throw new AppError('AMOUNT_EXCEEDS_DEBT', 'Сума перевищує борг клієнта', 400)
  }

  const newBalance = customer.debt_balance - input.amount

  const { data, error } = await db
    .from(TABLE)
    .update({ debt_balance: newBalance, updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}
