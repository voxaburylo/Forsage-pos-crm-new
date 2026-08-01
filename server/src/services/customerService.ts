import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
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
    .select('*, price_tier:price_tiers(id,name,discount_pct), customer_cars(vin,deleted_at)', { count: 'exact' })
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
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
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
  const enriched = (data ?? []).map((c: any) => {
    const activeCars = Array.isArray(c.customer_cars)
      ? c.customer_cars.filter((vehicle: any) => !vehicle.deleted_at)
      : []
    return {
      ...c,
      primary_vin: activeCars.find((vehicle: any) => vehicle.vin)?.vin ?? null,
      car_count: activeCars.length,
      customer_cars: undefined,
    }
  })

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

// Той самий номер міг зберегтись у різних форматах: старі записи — «0676…»,
// нові нормалізуються у «+380676…». Шукаємо дубль за всіма варіантами, інакше
// клієнт створювався повторно або падав на unique-обмеженні по phone.
function phoneVariants(phone: string): string[] {
  const variants = new Set<string>([phone, normalizePhone(phone)])
  const core = phone.replace(/\D/g, '').slice(-9)
  if (core.length === 9) {
    variants.add(`+380${core}`)
    variants.add(`380${core}`)
    variants.add(`0${core}`)
    variants.add(`80${core}`)
  }
  return [...variants]
}

export async function findByPhone(phone: string, tenantId: string) {
  const { data } = await db
    .from(TABLE)
    .select('*')
    .in('phone', phoneVariants(phone))
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
  return data?.[0] ?? null
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
    // Конфлікт унікальності по телефону (інший формат того самого номера або
    // гонка) — не помилка, а підтягуємо наявного клієнта.
    if (error.code === '23505') {
      const existingByPhone = await findByPhone(input.phone, tenantId)
      if (existingByPhone) return { customer: existingByPhone, reused: true, vehicleAdded: false }
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
  await runTransaction(async (client) => {
    const customer = await client.query(
      `SELECT id, COALESCE(debt_balance, 0) AS debt_balance,
              COALESCE(deposit_balance, 0) AS deposit_balance,
              COALESCE(bonus_balance, 0) AS bonus_balance
       FROM customers
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [id, tenantId],
    )
    if (!customer.rowCount) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)
    const row = customer.rows[0]
    if (Number(row.debt_balance) !== 0 || Number(row.deposit_balance) !== 0 || Number(row.bonus_balance) !== 0) {
      throw new AppError(
        'CUSTOMER_HAS_BALANCE',
        'Клієнта не можна видалити, доки є борг, передплата або бонуси',
        409,
      )
    }
    const activeOrders = await client.query(
      `SELECT 1
       FROM customer_orders
       WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         AND status NOT IN ('completed', 'cancelled', 'canceled', 'archived')
       LIMIT 1`,
      [id, tenantId],
    )
    if (activeOrders.rowCount) {
      throw new AppError('CUSTOMER_HAS_ACTIVE_ORDERS', 'У клієнта є незавершені замовлення або чернетки', 409)
    }
    const deletedStamp = await client.query<{ deleted_at: Date | string }>(
      'SELECT clock_timestamp() AS deleted_at',
    )
    const deletedAt = deletedStamp.rows[0].deleted_at
    for (const vehicleTable of ['customer_cars', 'customer_vehicles']) {
      await client.query(
        `UPDATE ${vehicleTable}
         SET deleted_at = $3, updated_at = $3
         WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId, deletedAt],
      )
    }
    await client.query(
      'UPDATE customers SET deleted_at = $3, updated_at = $3 WHERE id = $1 AND tenant_id = $2',
      [id, tenantId, deletedAt],
    )
  })
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

export async function payDebt(
  customerId: string,
  input: PayDebtInput,
  userId: string,
  tenantId: string,
) {
  return runTransaction(async (client) => {
    const customerResult = await client.query(
      `SELECT *
       FROM customers
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    const debtBalance = Number(customer.debt_balance ?? 0)
    if (debtBalance <= 0) throw new AppError('NO_DEBT', 'У клієнта немає боргу', 400)
    if (input.amount > debtBalance) {
      throw new AppError('AMOUNT_EXCEEDS_DEBT', 'Сума перевищує борг клієнта', 400)
    }
    if (input.method === 'cash') {
      if (!input.shift_id) throw new AppError('SHIFT_REQUIRED', 'Для оплати готівкою потрібна відкрита касова зміна', 422)
      const shift = await client.query(
        `SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2 AND status = 'open' LIMIT 1 FOR UPDATE`,
        [input.shift_id, tenantId],
      )
      if (!shift.rowCount) throw new AppError('SHIFT_CLOSED', 'Касова зміна не відкрита', 409)
    }
    const newBalance = debtBalance - input.amount
    const updated = await client.query(
      `UPDATE customers SET debt_balance = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [newBalance, customerId, tenantId],
    )
    if (input.method === 'cash') {
      await client.query(
        `INSERT INTO cash_operations (tenant_id, shift_id, type, amount, note, created_by, source)
         VALUES ($1, $2, 'in', $3, $4, $5, 'cashbox')`,
        [tenantId, input.shift_id, input.amount,
          `Оплата боргу: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`, userId],
      )
    }
    await client.query(
      `INSERT INTO audit_log (
         tenant_id, user_id, user_name, action, entity_type, entity_id,
         entity_label, old_value, new_value, note
       ) SELECT $1, $2,
           COALESCE((SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = $2), 'Користувач'),
           'DEBT_PAYMENT', 'customers', $3, $4, $5::jsonb, $6::jsonb, $7`,
      [
        tenantId, userId, customerId, customer.full_name ?? customer.phone ?? customerId.slice(0, 8),
        JSON.stringify({ debt_balance: debtBalance }), JSON.stringify({ debt_balance: newBalance }),
        `Оплата боргу: ${(input.amount / 100).toFixed(2)} грн (${input.method})`,
      ],
    )
    return updated.rows[0]
  })
}

export async function topUpDeposit(
  customerId: string,
  input: { amount: number; method: 'cash' | 'card' | 'transfer'; shift_id?: string | null; notes?: string | null },
  userId: string,
  tenantId: string,
) {
  return runTransaction(async (client) => {
    const customerResult = await client.query(
      `SELECT id, full_name, phone, COALESCE(deposit_balance, 0) AS deposit_balance
       FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    if (input.method === 'cash') {
      if (!input.shift_id) throw new AppError('SHIFT_REQUIRED', 'Для поповнення готівкою потрібна відкрита касова зміна', 422)
      const shift = await client.query(
        `SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2 AND status = 'open' LIMIT 1 FOR UPDATE`,
        [input.shift_id, tenantId],
      )
      if (!shift.rowCount) throw new AppError('SHIFT_CLOSED', 'Касова зміна не відкрита', 409)
    }
    const balance = Number(customer.deposit_balance ?? 0) + input.amount
    await client.query(
      'UPDATE customers SET deposit_balance = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
      [balance, customerId, tenantId],
    )
    await client.query(
      `INSERT INTO customer_deposit_transactions
        (tenant_id, customer_id, amount, balance_after, method, shift_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, customerId, input.amount, balance, input.method, input.shift_id ?? null,
        input.notes ?? 'Поповнення рахунку на касі', userId],
    )
    if (input.method === 'cash') {
      await client.query(
        `INSERT INTO cash_operations (tenant_id, shift_id, type, amount, note, created_by, source)
         VALUES ($1, $2, 'in', $3, $4, $5, 'cashbox')`,
        [tenantId, input.shift_id, input.amount,
          `Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`, userId],
      )
    }
    await client.query(
      `INSERT INTO audit_log (
         tenant_id, user_id, user_name, action, entity_type, entity_id,
         entity_label, old_value, new_value, note
       ) SELECT $1, $2,
           COALESCE((SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = $2), 'Користувач'),
           'DEPOSIT_TOPUP', 'customers', $3, $4, $5::jsonb, $6::jsonb, $7`,
      [
        tenantId, userId, customerId, customer.full_name ?? customer.phone ?? customerId.slice(0, 8),
        JSON.stringify({ deposit_balance: Number(customer.deposit_balance ?? 0) }),
        JSON.stringify({ deposit_balance: balance }),
        `Поповнення рахунку: ${(input.amount / 100).toFixed(2)} грн (${input.method})`,
      ],
    )
    return { balance }
  })
}

// ===================== VEHICLES =====================
// Єдине джерело правди — customer_cars («Гараж»): туди пишуть Telegram-бот,
// AI-імпорт і роут /customer-cars. Раніше тут була ПАРАЛЕЛЬНА таблиця
// customer_vehicles — через це форма замовлення та картка клієнта не бачили
// авто, заведені ботом/ШІ. API назовні не змінилось: колонка make у відповіді
// мапиться в поле brand, яке очікує фронт.

const VEHICLE_TABLE = 'customer_cars'
const VEHICLE_COLUMNS = 'id, customer_id, brand:make, model, year, vin, notes, created_at, updated_at'

export async function listCustomerVehicles(customerId: string, tenantId: string) {
  await getCustomer(customerId, tenantId)

  const { data, error } = await db
    .from(VEHICLE_TABLE)
    .select(VEHICLE_COLUMNS)
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
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
      .eq('tenant_id', tenantId)
      .eq('vin', vin)
      .is('deleted_at', null)
      .maybeSingle()
    if (existing) {
      throw new AppError('VIN_DUPLICATE',
        existing.customer_id === customerId
          ? 'Авто з таким VIN уже є в гаражі цього клієнта'
          : 'Авто з таким VIN уже привʼязане до іншого клієнта', 409)
    }
  }

  const updatedAt = new Date().toISOString()
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
      updated_at:  updatedAt,
      deleted_at:  null,
    })
    .select(VEHICLE_COLUMNS)
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function deleteCustomerVehicle(vehicleId: string, tenantId: string) {
  const deletedAt = new Date().toISOString()
  const { error } = await db
    .from(VEHICLE_TABLE)
    .update({ deleted_at: deletedAt, updated_at: deletedAt })
    .eq('id', vehicleId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

// ===================== BONUSES =====================

export async function manualBonus(customerId: string, amount: number, description: string | null, userId: string, tenantId: string) {
  return runTransaction(async (client) => {
    const customerResult = await client.query(
      `SELECT id, COALESCE(bonus_balance, 0) AS bonus_balance
       FROM customers
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)

    const newBalance = Number(customerResult.rows[0].bonus_balance ?? 0) + amount
    if (newBalance < 0) throw new AppError('INSUFFICIENT_BONUS', 'Недостатньо бонусів у клієнта', 409)

    const updated = await client.query(
      `UPDATE customers
       SET bonus_balance = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [newBalance, customerId, tenantId],
    )
    if (amount !== 0) {
      await client.query(
        `INSERT INTO bonus_transactions (
          tenant_id, customer_id, amount, transaction_type, description, created_by
        ) VALUES ($1, $2, $3, 'manual', $4, $5)`,
        [tenantId, customerId, amount, description ?? (amount > 0 ? 'Ручне нарахування' : 'Ручне списання'), userId],
      )
    }
    return updated.rows[0]
  })
}
