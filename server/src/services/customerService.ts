import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizePhone } from '../validators/customerSchema.js'
import type {
  CreateCustomerInput, UpdateCustomerInput,
  CustomerListQuery, PayDebtInput,
} from '../validators/customerSchema.js'

const TABLE = 'customers'

export async function listCustomers(query: CustomerListQuery) {
  const { search, has_debt, tag, group_id, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*, price_tier:price_tiers(id,name,discount_pct), customer_vehicles(vin)', { count: 'exact' })
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
  if (group_id) {
    const { data: memberIds } = await db
      .from('customer_group_members')
      .select('customer_id')
      .eq('group_id', group_id)
    const ids = (memberIds ?? []).map((m: any) => m.customer_id)
    if (ids.length === 0) return { data: [], pagination: { page, per_page, total: 0, total_pages: 0 } }
    q = q.in('id', ids)
  }

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  // Додаємо VIN першого авто до кожного клієнта
  const enriched = (data ?? []).map((c: any) => ({
    ...c,
    primary_vin: c.customer_vehicles?.find((v: any) => v.vin)?.vin ?? null,
    customer_vehicles: undefined,
  }))

  return {
    data: enriched,
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
    .select('*, price_tier:price_tiers(id,name,discount_pct)')
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

export async function createCustomer(input: CreateCustomerInput, tenantId: string) {
  const existing = await findByPhone(input.phone)
  if (existing) throw new AppError('PHONE_DUPLICATE', `Клієнт з телефоном ${input.phone} вже існує`, 409)

  const { data, error } = await db
    .from(TABLE)
    .insert({ ...input, tenant_id: tenantId })
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

// ===================== VEHICLES =====================

const VEHICLE_TABLE = 'customer_vehicles'

export async function listCustomerVehicles(customerId: string) {
  const { data, error } = await db
    .from(VEHICLE_TABLE)
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function createCustomerVehicle(
  customerId: string,
  input: { brand: string; model: string; year?: number | null; vin?: string | null; notes?: string | null },
  tenantId: string,
) {
  const { data, error } = await db
    .from(VEHICLE_TABLE)
    .insert({
      tenant_id:   tenantId,
      customer_id: customerId,
      brand:       input.brand,
      model:       input.model,
      year:        input.year ?? null,
      vin:         input.vin ?? null,
      notes:       input.notes ?? null,
    })
    .select()
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function deleteCustomerVehicle(vehicleId: string) {
  const { error } = await db
    .from(VEHICLE_TABLE)
    .delete()
    .eq('id', vehicleId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ===================== BONUSES =====================

export async function manualBonus(customerId: string, amount: number, description: string | null, userId: string) {
  const { data: customer, error: getErr } = await db
    .from('customers')
    .select('id, bonus_balance')
    .eq('id', customerId)
    .single()

  if (getErr || !customer) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)

  const newBalance = (customer.bonus_balance ?? 0) + amount

  const { error: updErr } = await db
    .from('customers')
    .update({ bonus_balance: Math.max(0, newBalance) })
    .eq('id', customerId)

  if (updErr) throw new AppError('DB_ERROR', updErr.message, 500)

  await db.from('loyalty_transactions').insert({
    tenant_id:      '00000000-0000-0000-0000-000000000001',
    customer_id:    customerId,
    type:           'correction',
    amount_kopecks: amount,
    note:           description ?? (amount > 0 ? 'Ручне нарахування' : 'Ручне списання'),
    created_by:     userId,
  })

  const { data: updated } = await db.from('customers').select('*').eq('id', customerId).single()
  return updated
}

