import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizePhone } from '../validators/customerSchema.js'
import type {
  CreateCustomerInput, UpdateCustomerInput,
  CustomerListQuery, PayDebtInput,
} from '../validators/customerSchema.js'

const TABLE = 'customers'

export async function listCustomers(query: CustomerListQuery, tenantId: string) {
  const { search, has_debt, tag, group_id, sort, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*, price_tier:price_tiers(id,name,discount_pct), customer_cars(vin)', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .range(offset, offset + per_page - 1)

  // ORD-33/16: нещодавні / найбільший борг зверху, або за іменем (за замовчуванням)
  if (sort === 'recent') q = q.order('updated_at', { ascending: false })
  else if (sort === 'debt') q = q.order('debt_balance', { ascending: false })
  else q = q.order('full_name', { ascending: true })

  if (search) {
    const normalized = normalizePhone(search)
    const orParts = [
      `phone.ilike.%${normalized}%`,
      `full_name.ilike.%${search}%`,
      `card_barcode.ilike.%${search}%`,
    ]
    // Пошук також за VIN авто клієнта
    const { data: vinMatches } = await db
      .from('customer_cars')
      .select('customer_id')
      .ilike('vin', `%${search}%`)
    const vinIds = [...new Set((vinMatches ?? []).map((v: any) => v.customer_id).filter(Boolean))]
    if (vinIds.length > 0) orParts.push(`id.in.(${vinIds.join(',')})`)
    q = q.or(orParts.join(','))
  }
  if (has_debt === 'true')  q = q.gt('debt_balance', 0)
  if (has_debt === 'false') q = q.eq('debt_balance', 0)
  if (tag) q = q.contains('tags', [tag])
  if (group_id) {
    // Verify group belongs to tenant
    const { data: group } = await db
      .from('customer_groups')
      .select('id')
      .eq('id', group_id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!group) return { data: [], pagination: { page, per_page, total: 0, total_pages: 0 } }

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
    primary_vin: c.customer_cars?.find((v: any) => v.vin)?.vin ?? null,
    car_count: Array.isArray(c.customer_cars) ? c.customer_cars.length : 0,
    customer_cars: undefined,
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

export async function getCustomer(id: string, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, price_tier:price_tiers(id,name,discount_pct)')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()

  if (error || !data) throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
  return data
}

export async function findByPhone(phone: string, tenantId: string) {
  const normalized = normalizePhone(phone)
  const { data } = await db
    .from(TABLE)
    .select('*')
    .eq('phone', normalized)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()
  return data
}

export async function createCustomer(input: CreateCustomerInput, tenantId: string) {
  const { vehicle, ...customerInput } = input
  const existing = await findByPhone(input.phone, tenantId)
  if (existing) {
    let vehicleAdded = false
    if (vehicle?.vin || vehicle?.brand || vehicle?.model) {
      try {
        await createCustomerVehicle(existing.id, {
          brand: vehicle.brand || 'Авто',
          model: vehicle.model || '—',
          year: vehicle.year,
          vin: vehicle.vin,
          notes: vehicle.notes,
        }, tenantId)
        vehicleAdded = true
      } catch (error) {
        const sameCustomerDuplicate = error instanceof AppError
          && error.code === 'VIN_DUPLICATE'
          && error.message.includes('цього клієнта')
        if (!sameCustomerDuplicate) throw error
      }
    }
    return { customer: existing, reused: true, vehicleAdded }
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({ ...customerInput, tenant_id: tenantId })
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505' && input.card_barcode) {
      throw new AppError('BARCODE_DUPLICATE', `Штрихкод картки ${input.card_barcode} вже використовується`, 409)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  let vehicleAdded = false
  if (vehicle?.vin || vehicle?.brand || vehicle?.model) {
    await createCustomerVehicle(data.id, {
      brand: vehicle.brand || 'Авто',
      model: vehicle.model || '—',
      year: vehicle.year,
      vin: vehicle.vin,
      notes: vehicle.notes,
    }, tenantId)
    vehicleAdded = true
  }
  return { customer: data, reused: false, vehicleAdded }
}

export async function updateCustomer(id: string, input: UpdateCustomerInput, tenantId: string) {
  await getCustomer(id, tenantId)

  if (input.phone) {
    const existing = await findByPhone(input.phone, tenantId)
    if (existing && existing.id !== id) {
      throw new AppError('PHONE_DUPLICATE', `Телефон ${input.phone} вже використовується`, 409)
    }
  }

  const { data, error } = await db
    .from(TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505' && input.card_barcode) {
      throw new AppError('BARCODE_DUPLICATE', `Штрихкод картки ${input.card_barcode} вже використовується`, 409)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }
  return data
}

export async function deleteCustomer(id: string, tenantId: string) {
  await getCustomer(id, tenantId)
  const { error } = await db
    .from(TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function getCustomerSales(customerId: string, tenantId: string) {
  await getCustomer(customerId, tenantId)

  const { data, error } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at')
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .order('completed_at', { ascending: false })
    .limit(50)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

// Повертає продажі в борг — це і є "история долгов" для MVP
export async function getCustomerDebts(customerId: string, tenantId: string) {
  await getCustomer(customerId, tenantId)

  const { data, error } = await db
    .from('sales')
    .select('id, sale_number, total, status, completed_at')
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .eq('payment_method', 'debt')
    .order('completed_at', { ascending: false })
    .limit(50)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function payDebt(customerId: string, input: PayDebtInput, tenantId: string) {
  const customer = await getCustomer(customerId, tenantId)

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
    .eq('tenant_id', tenantId)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

// ===================== VEHICLES =====================
// Єдине джерело правди — customer_cars («Гараж»): туди пишуть Telegram-бот,
// AI-імпорт і роут /customer-cars. Раніше тут була ПАРАЛЕЛЬНА таблиця
// customer_vehicles — через це форма замовлення та картка клієнта не бачили
// авто, заведені ботом/ШІ. API назовні не змінилось: колонка make у відповіді
// мапиться в поле brand, яке очікує фронт.

const VEHICLE_TABLE = 'customer_cars'
const VEHICLE_COLUMNS = 'id, customer_id, brand:make, model, year, vin, notes, created_at'

export async function listCustomerVehicles(customerId: string, tenantId: string) {
  await getCustomer(customerId, tenantId)

  const { data, error } = await db
    .from(VEHICLE_TABLE)
    .select(VEHICLE_COLUMNS)
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function createCustomerVehicle(
  customerId: string,
  input: { brand: string; model: string; year?: number | null; vin?: string | null; notes?: string | null },
  tenantId: string,
) {
  await getCustomer(customerId, tenantId)

  // VIN у customer_cars унікальний — перевіряємо заздалегідь, щоб дати
  // зрозумілу помилку замість голої помилки БД
  const vin = input.vin?.trim() ? input.vin.trim().toUpperCase() : null
  if (vin) {
    const { data: existing } = await db
      .from(VEHICLE_TABLE)
      .select('id, customer_id')
      .eq('vin', vin)
      .maybeSingle()
    if (existing) {
      throw new AppError('VIN_DUPLICATE',
        existing.customer_id === customerId
          ? 'Авто з таким VIN уже є в гаражі цього клієнта'
          : 'Авто з таким VIN уже привʼязане до іншого клієнта', 409)
    }
  }

  const { data, error } = await db
    .from(VEHICLE_TABLE)
    .insert({
      tenant_id:   tenantId,
      customer_id: customerId,
      make:        input.brand,
      model:       input.model,
      year:        input.year ?? null,
      vin,
      notes:       input.notes ?? null,
    })
    .select(VEHICLE_COLUMNS)
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function deleteCustomerVehicle(vehicleId: string, tenantId: string) {
  const { error } = await db
    .from(VEHICLE_TABLE)
    .delete()
    .eq('id', vehicleId)
    .eq('tenant_id', tenantId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ===================== BONUSES =====================

export async function manualBonus(customerId: string, amount: number, description: string | null, userId: string, tenantId: string) {
  const { data: customer, error: getErr } = await db
    .from('customers')
    .select('id, bonus_balance, tenant_id')
    .eq('id', customerId)
    .eq('tenant_id', tenantId)
    .single()

  if (getErr || !customer) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)

  const newBalance = (customer.bonus_balance ?? 0) + amount

  const { error: updErr } = await db
    .from('customers')
    .update({ bonus_balance: Math.max(0, newBalance) })
    .eq('id', customerId)
    .eq('tenant_id', tenantId)

  if (updErr) throw new AppError('DB_ERROR', updErr.message, 500)

  await db.from('bonus_transactions').insert({
    tenant_id:        tenantId,
    customer_id:      customerId,
    amount:           amount,
    transaction_type: 'manual',
    description:      description ?? (amount > 0 ? 'Ручне нарахування' : 'Ручне списання'),
    created_by:       userId,
  })

  const { data: updated } = await db.from('customers').select('*').eq('id', customerId).eq('tenant_id', tenantId).single()
  return updated
}
