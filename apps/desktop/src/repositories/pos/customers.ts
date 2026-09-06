/**
 * Клієнти: картки, авто, борги, депозити.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import { money, nowIso } from './posShared'
import { randomUUID } from 'node:crypto'
import { LocalPosShifts } from './shifts'

export class LocalPosCustomers extends LocalPosShifts {
  listDebtors(tenantId = DEFAULT_TENANT_ID, limit = 200): Array<{
    id: string
    full_name: string | null
    phone: string | null
    debt_balance: number
    deposit_balance: number
  }> {
    return this.db.prepare(`
      SELECT id, full_name, phone, debt_balance, COALESCE(deposit_balance, 0) AS deposit_balance
      FROM customers
      WHERE tenant_id = ? AND deleted_at IS NULL AND debt_balance > 0
      ORDER BY debt_balance DESC
      LIMIT ?
    `).all(tenantId, limit) as unknown as Array<{
      id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance: number
    }>
  }

  searchCustomers(input: { tenant_id?: string; search?: string; has_debt?: boolean; limit?: number } = {}): Array<{
    id: string
    full_name: string | null
    phone: string | null
    debt_balance: number
    deposit_balance: number
  }> {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const limit = Math.max(1, Math.min(200, input.limit ?? 50))
    const rawSearch = String(input.search ?? '').trim()
    const search = rawSearch.toLocaleLowerCase('uk-UA')
    const titleSearch = search.replace(/(^|\s)\S/g, (char) => char.toLocaleUpperCase('uk-UA'))
    const upperSearch = search.toLocaleUpperCase('uk-UA')
    const digits = search.replace(/\D/g, '')
    const params: any[] = [tenantId]
    let where = 'tenant_id = ? AND deleted_at IS NULL'
    if (input.has_debt) where += ' AND debt_balance > 0'
    if (search) {
      where += ` AND (
        lower(COALESCE(full_name, '')) LIKE ?
        OR COALESCE(phone, '') LIKE ?
        OR lower(COALESCE(email, '')) LIKE ?
        OR lower(COALESCE(card_barcode, '')) LIKE ?
      )`
      const q = `%${search}%`
      params.push(q, `%${digits || search}%`, q, q)
    }
    params.push(limit)
    return this.db.prepare(`
      SELECT id, full_name, phone, debt_balance, COALESCE(deposit_balance, 0) AS deposit_balance
      FROM customers
      WHERE ${where}
      ORDER BY ${input.has_debt ? 'debt_balance DESC,' : ''} updated_at DESC
      LIMIT ?
    `).all(...params) as unknown as Array<{
      id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance: number
    }>
  }

  listCustomers(input: {
    tenant_id?: string
    search?: string
    has_debt?: string
    tag?: string
    sort?: string
    page?: number
    per_page?: number
  } = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(200, Number(input.per_page ?? 50) || 50))
    const offset = (page - 1) * perPage
    const rawSearch = String(input.search ?? '').trim()
    const search = rawSearch.toLocaleLowerCase('uk-UA')
    const titleSearch = search.replace(/(^|\s)\S/g, (char) => char.toLocaleUpperCase('uk-UA'))
    const upperSearch = search.toLocaleUpperCase('uk-UA')
    const digits = search.replace(/\D/g, '')
    const where = ['c.tenant_id = ?', 'c.deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (input.has_debt === 'true') where.push('c.debt_balance > 0')
    if (input.tag) {
      where.push('c.tags_json LIKE ?')
      params.push(`%"${input.tag}"%`)
    }
    if (search) {
      where.push(`(
        COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR lower(COALESCE(c.email, '')) LIKE ?
        OR COALESCE(c.phone, '') LIKE ?
        OR lower(COALESCE(c.card_barcode, '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM customer_vehicles v
          WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id
            AND v.deleted_at IS NULL
            AND lower(COALESCE(v.vin, '')) LIKE ?
        )
      )`)
      const q = `%${search}%`
      params.push(`%${rawSearch}%`, `%${titleSearch}%`, `%${upperSearch}%`, q, `%${digits || search}%`, q, q)
    }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM customers c WHERE ${whereSql}`)
      .get(...params) as { total: number }
    const orderBy = input.sort === 'debt'
      ? 'c.debt_balance DESC, c.updated_at DESC'
      : input.sort === 'name'
        ? 'lower(COALESCE(c.full_name, c.phone, c.id)) ASC'
        : 'c.updated_at DESC'
    const rows = this.db.prepare(`
      SELECT c.*,
        (SELECT v.vin FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
         ORDER BY v.created_at ASC LIMIT 1) AS primary_vin,
        (SELECT COUNT(*) FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL) AS car_count
      FROM customers c
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateCustomer(row)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  findCustomerByBarcode(barcode: string, tenantId = DEFAULT_TENANT_ID): any | null {
    const normalized = String(barcode ?? '').trim()
    if (!normalized) return null
    const row = this.db.prepare(`
      SELECT c.*,
        (SELECT v.vin FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
         ORDER BY v.created_at ASC LIMIT 1) AS primary_vin,
        (SELECT COUNT(*) FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL) AS car_count
      FROM customers c
      WHERE c.tenant_id = ?
        AND c.card_barcode = ?
        AND c.deleted_at IS NULL
      LIMIT 1
    `).get(tenantId, normalized) as any
    return row ? this.decorateCustomer(row) : null
  }

  getCustomer(customerId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT c.*,
        (SELECT v.vin FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
         ORDER BY v.created_at ASC LIMIT 1) AS primary_vin,
        (SELECT COUNT(*) FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL) AS car_count
      FROM customers c
      WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
      LIMIT 1
    `).get(customerId, tenantId) as any
    if (!row) throw new Error('Клієнта не знайдено')
    return this.decorateCustomer(row)
  }

  getCustomerSales(customerId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT id, sale_number, total, payment_method, status, completed_at
      FROM sales
      WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY completed_at DESC
      LIMIT 200
    `).all(customerId, tenantId) as any[]
  }

  saveCustomer(input: any, customerId?: string): { data: any; meta?: { reused: boolean; vehicle_added: boolean } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const phone = String(input.phone ?? '').trim()
    if (!customerId && !phone) throw new Error("Телефон обов'язковий")

    if (!customerId) {
      const existing = this.db.prepare(`
        SELECT id FROM customers
        WHERE tenant_id = ? AND deleted_at IS NULL AND phone = ?
        LIMIT 1
      `).get(tenantId, phone) as { id: string } | undefined
      if (existing) {
        const vehicleAdded = this.addCustomerVehicle(existing.id, tenantId, input.vehicle, timestamp)
        return { data: this.getCustomer(existing.id, tenantId), meta: { reused: true, vehicle_added: vehicleAdded } }
      }
    }

    const id = customerId ?? randomUUID()
    if (customerId) {
      const current = this.getCustomer(customerId, tenantId)
      const requestedBonus = input.bonus_balance !== undefined ? money(input.bonus_balance) : null
      if (requestedBonus !== null && requestedBonus < 0) throw new Error('Баланс бонусів не може бути від’ємним')
      const values: Record<string, any> = {
        phone: input.phone,
        full_name: input.full_name,
        email: input.email,
        birth_date: input.birth_date,
        notes: input.notes,
        tags_json: input.tags !== undefined ? JSON.stringify(input.tags ?? []) : undefined,
        price_tier_id: input.price_tier_id,
        vip_level: input.vip_level,
        risk_profile: input.risk_profile,
        discount_pct: input.discount_pct,
        loyalty_mode: input.loyalty_mode === 'cashback' ? 'cashback' : input.loyalty_mode === 'discount' ? 'discount' : undefined,
        client_status: input.client_status,
        card_barcode: input.card_barcode,
      }
      const entries = Object.entries(values).filter(([, value]) => value !== undefined)
      return this.db.transaction(() => {
        if (entries.length) {
          const sets = entries.map(([key]) => `${key} = ?`)
          this.db.prepare(`
            UPDATE customers
            SET ${sets.join(', ')}, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          `).run(...entries.map(([, value]) => value), timestamp, timestamp, id, tenantId)
          const syncPatch = Object.fromEntries(entries.map(([key, value]) => [
            key === 'tags_json' ? 'tags' : key,
            key === 'tags_json' ? JSON.parse(String(value)) : value,
          ]))
          this.addOutbox(tenantId, 'customer', id, 'customer.updated', { id, ...syncPatch, updated_at: timestamp }, timestamp)
        }
        if (requestedBonus !== null && requestedBonus !== Number(current.bonus_balance ?? 0)) {
          const bonusAmount = requestedBonus - Number(current.bonus_balance ?? 0)
          const transactionId = randomUUID()
          const description = bonusAmount > 0 ? 'Ручне нарахування' : 'Ручне списання'
          this.db.prepare(`
            UPDATE customers
            SET bonus_balance = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          `).run(requestedBonus, timestamp, timestamp, id, tenantId)
          this.db.prepare(`
            INSERT INTO bonus_transactions (
              id, tenant_id, customer_id, amount, transaction_type, description,
              created_by, dirty_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)
          `).run(
            transactionId, tenantId, id, bonusAmount, description,
            input.user_id ?? null, timestamp, timestamp, timestamp,
          )
          this.addOutbox(tenantId, 'customer', id, 'customer.bonus_adjusted', {
            customer_id: id,
            transaction_id: transactionId,
            amount: bonusAmount,
            description,
            created_by: input.user_id ?? null,
            created_at: timestamp,
          }, timestamp)
        }
        return { data: this.getCustomer(id, tenantId) }
      })
    }
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO customers (
          id, tenant_id, phone, full_name, email, birth_date, debt_balance, notes, tags_json,
          price_tier_id, bonus_balance, vip_level, risk_profile, discount_pct,
          client_status, card_barcode, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 'standard', 'low', ?, ?, ?, ?, ?, ?)
      `).run(
        id, tenantId, phone, input.full_name ?? null, input.email ?? null, input.birth_date ?? null,
        input.notes ?? null, JSON.stringify(input.tags ?? []), input.price_tier_id ?? null,
        Number(input.discount_pct ?? 0), input.client_status ?? 'client',
        input.card_barcode ?? null, timestamp, timestamp, timestamp,
      )
      this.addOutbox(tenantId, 'customer', id, 'customer.created', {
        id, phone, full_name: input.full_name ?? null, email: input.email ?? null, birth_date: input.birth_date ?? null,
        notes: input.notes ?? null, tags: input.tags ?? [], price_tier_id: input.price_tier_id ?? null,
        discount_pct: Number(input.discount_pct ?? 0), client_status: input.client_status ?? 'client',
        card_barcode: input.card_barcode ?? null, vehicle: input.vehicle ?? null,
      }, timestamp)
      this.addCustomerVehicle(id, tenantId, input.vehicle, timestamp)
    })
    return { data: this.getCustomer(id, tenantId), meta: { reused: false, vehicle_added: Boolean(input.vehicle) } }
  }

  deleteCustomer(customerId: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    const customer = this.getCustomerForMoney(customerId, tenantId)
    if (Number(customer.debt_balance ?? 0) !== 0 || Number(customer.deposit_balance ?? 0) !== 0 || Number((customer as any).bonus_balance ?? 0) !== 0) {
      throw new Error('Клієнта не можна видалити, доки є борг, передплата або бонуси')
    }
    const activeOrder = this.db.prepare(`
      SELECT id FROM customer_orders
      WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
        AND status NOT IN ('completed', 'cancelled', 'canceled', 'archived')
      LIMIT 1
    `).get(customerId, tenantId)
    if (activeOrder) throw new Error('У клієнта є незавершені замовлення або чернетки')
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE customers SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, customerId, tenantId)
      this.db.prepare(`
        UPDATE customer_vehicles SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, customerId, tenantId)
      this.addOutbox(tenantId, 'customer', customerId, 'customer.deleted', { id: customerId }, timestamp)
    })
    return { ok: true }
  }

  listCustomerVehicles(customerId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    this.getCustomer(customerId, tenantId)
    return this.db.prepare(`
      SELECT id, customer_id, brand, model, year, vin, notes, created_at, updated_at
      FROM customer_vehicles
      WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all(customerId, tenantId) as any[]
  }

  saveCustomerVehicle(customerId: string, input: any, vehicleId?: string): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    this.getCustomer(customerId, tenantId)
    const timestamp = nowIso()
    const id = vehicleId ?? randomUUID()
    const existing = vehicleId
      ? this.db.prepare(`
          SELECT * FROM customer_vehicles
          WHERE id = ? AND customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).get(vehicleId, customerId, tenantId) as any
      : null
    if (vehicleId && !existing) throw new Error('Автомобіль не знайдено')
    const brand = String(input.brand ?? input.make ?? existing?.brand ?? '').trim()
    const model = String(input.model ?? existing?.model ?? '').trim()
    if (!brand && !model && !String(input.vin ?? existing?.vin ?? '').trim()) {
      throw new Error('Вкажіть марку, модель або VIN')
    }
    const next = {
      brand,
      model,
      year: input.year !== undefined && input.year !== null && input.year !== '' ? Number(input.year) : existing?.year ?? null,
      vin: String(input.vin ?? existing?.vin ?? '').trim().toUpperCase() || null,
      notes: input.notes !== undefined ? (String(input.notes ?? '').trim() || null) : existing?.notes ?? null,
    }
    this.db.prepare(`
      INSERT INTO customer_vehicles (
        id, tenant_id, customer_id, brand, model, year, vin, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        brand = excluded.brand, model = excluded.model, year = excluded.year,
        vin = excluded.vin, notes = excluded.notes, dirty_at = excluded.dirty_at,
        updated_at = excluded.updated_at, deleted_at = NULL
    `).run(
      id, tenantId, customerId, next.brand, next.model, next.year, next.vin, next.notes,
      timestamp, existing?.created_at ?? timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'customer_vehicle', id, vehicleId ? 'customer_vehicle.updated' : 'customer_vehicle.created', {
      id, customer_id: customerId, ...next,
    }, timestamp)
    return this.db.prepare(`
      SELECT id, customer_id, brand, model, year, vin, notes, created_at, updated_at
      FROM customer_vehicles WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId)
  }

  deleteCustomerVehicle(customerId: string, vehicleId: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE customer_vehicles SET deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(timestamp, timestamp, timestamp, vehicleId, customerId, tenantId)
    if (Number(result.changes) === 0) throw new Error('Автомобіль не знайдено')
    this.addOutbox(tenantId, 'customer_vehicle', vehicleId, 'customer_vehicle.deleted', {
      id: vehicleId, customer_id: customerId,
    }, timestamp)
    return { ok: true }
  }

  getCustomerDeposit(customerId: string, tenantId = DEFAULT_TENANT_ID): {
    balance: number
    transactions: any[]
  } {
    const customer = this.db.prepare(`
      SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
      FROM customers
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(customerId, tenantId) as { id: string; deposit_balance: number } | undefined
    if (!customer) throw new Error('Клієнта не знайдено')
    const transactions = this.db.prepare(`
      SELECT id, amount, balance_after, method, order_id, sale_id, shift_id, notes, created_at
      FROM customer_deposit_transactions
      WHERE tenant_id = ? AND customer_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50
    `).all(tenantId, customerId)
    return { balance: Number(customer.deposit_balance ?? 0), transactions }
  }

  payDebt(input: {
    tenant_id?: string
    customer_id: string
    amount: number
    method: 'cash' | 'card' | 'transfer'
    shift_id?: string | null
    user_id?: string | null
    notes?: string | null
  }): { data: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть коректну суму')
    if (input.method === 'cash' && !input.shift_id) {
      throw new Error('Для оплати готівкою потрібна відкрита касова зміна')
    }
    return this.db.transaction(() => {
      const customer = this.getCustomerForMoney(input.customer_id, tenantId)
      if (customer.debt_balance <= 0) throw new Error('У клієнта немає боргу')
      if (amount > customer.debt_balance) throw new Error('Сума перевищує борг клієнта')
      const timestamp = nowIso()
      const balanceAfter = customer.debt_balance - amount
      this.db.prepare(`
        UPDATE customers
        SET debt_balance = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(balanceAfter, timestamp, timestamp, customer.id, tenantId)

      const cashOperationId = input.method === 'cash' && input.shift_id ? randomUUID() : null
      if (cashOperationId) {
        this.addCashOperation(tenantId, input.shift_id!, input.user_id ?? null, 'cash_in', amount, `Оплата боргу: ${customer.full_name ?? customer.phone ?? customer.id.slice(0, 8)}`, timestamp, cashOperationId)
      }

      this.addOutbox(tenantId, 'customer', customer.id, 'customer.debt_paid', {
        customer_id: customer.id,
        amount,
        method: input.method,
        shift_id: input.shift_id ?? null,
        cash_operation_id: cashOperationId,
        notes: input.notes ?? null,
        created_by: input.user_id ?? null,
        created_at: timestamp,
      }, timestamp)
      this.addAudit(tenantId, input.user_id ?? 'local', 'customer.debt_paid', 'customer', customer.id, { amount, method: input.method, debt_balance: balanceAfter }, timestamp)
      return { data: { ...customer, debt_balance: balanceAfter } }
    })
  }

  addCustomerDeposit(input: {
    tenant_id?: string
    customer_id: string
    amount: number
    method: 'cash' | 'card' | 'transfer'
    shift_id?: string | null
    user_id?: string | null
    notes?: string | null
  }): { data: { balance: number } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть коректну суму')
    if (input.method === 'cash' && !input.shift_id) {
      throw new Error('Для поповнення готівкою потрібна відкрита касова зміна')
    }
    return this.db.transaction(() => {
      const customer = this.getCustomerForMoney(input.customer_id, tenantId)
      const timestamp = nowIso()
      const balanceAfter = Number(customer.deposit_balance ?? 0) + amount
      const transactionId = randomUUID()
      this.db.prepare(`
        UPDATE customers
        SET deposit_balance = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(balanceAfter, timestamp, timestamp, customer.id, tenantId)
      this.db.prepare(`
        INSERT INTO customer_deposit_transactions (
          id, tenant_id, customer_id, amount, balance_after, method, shift_id,
          notes, created_by, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(transactionId, tenantId, customer.id, amount, balanceAfter, input.method, input.shift_id ?? null, input.notes ?? 'Поповнення рахунку на касі', input.user_id ?? null, timestamp, timestamp, timestamp)

      const cashOperationId = input.method === 'cash' && input.shift_id ? randomUUID() : null
      if (cashOperationId) {
        this.addCashOperation(tenantId, input.shift_id!, input.user_id ?? null, 'cash_in', amount, `Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone ?? customer.id.slice(0, 8)}`, timestamp, cashOperationId)
      }

      this.addOutbox(tenantId, 'customer', customer.id, 'customer.deposit_changed', {
        customer_id: customer.id,
        transaction_id: transactionId,
        amount,
        method: input.method,
        shift_id: input.shift_id ?? null,
        cash_operation_id: cashOperationId,
        notes: input.notes ?? 'Поповнення рахунку на касі',
        created_by: input.user_id ?? null,
        created_at: timestamp,
      }, timestamp)
      this.addAudit(tenantId, input.user_id ?? 'local', 'customer.deposit_changed', 'customer', customer.id, { amount, method: input.method, balance_after: balanceAfter }, timestamp)
      return { data: { balance: balanceAfter } }
    })
  }

  payOutCustomerDeposit(input: {
    tenant_id?: string
    customer_id: string
    payout_id?: string
    amount: number
    method: 'cash' | 'card' | 'transfer'
    shift_id?: string | null
    user_id?: string | null
    notes?: string | null
  }): { data: { balance: number; replayed: boolean } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть коректну суму видачі')
    if (input.method === 'cash' && !input.shift_id) {
      throw new Error('Для видачі готівки потрібна відкрита касова зміна')
    }
    const payoutId = input.payout_id ?? randomUUID()
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT tenant_id, customer_id, amount, balance_after
        FROM customer_deposit_transactions
        WHERE id = ?
        LIMIT 1
      `).get(payoutId) as { tenant_id: string; customer_id: string; amount: number; balance_after: number } | undefined
      if (existing) {
        if (existing.tenant_id !== tenantId || existing.customer_id !== input.customer_id || Number(existing.amount) !== -amount) {
          throw new Error('Ідентифікатор виплати вже використано іншою операцією')
        }
        return { data: { balance: Number(existing.balance_after), replayed: true } }
      }

      const customer = this.getCustomerForMoney(input.customer_id, tenantId)
      if (amount > Number(customer.deposit_balance ?? 0)) {
        throw new Error('Сума видачі перевищує кошти на рахунку клієнта')
      }
      if (input.method === 'cash') {
        const shift = this.db.prepare(`
          SELECT id FROM shifts
          WHERE id = ? AND tenant_id = ? AND status = 'open'
          LIMIT 1
        `).get(input.shift_id!, tenantId)
        if (!shift) throw new Error('Касова зміна не відкрита')
      }

      const timestamp = nowIso()
      const balanceAfter = Number(customer.deposit_balance ?? 0) - amount
      const note = input.notes?.trim() || 'Видача коштів з рахунку клієнта'
      this.db.prepare(`
        UPDATE customers
        SET deposit_balance = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(balanceAfter, timestamp, timestamp, customer.id, tenantId)
      this.db.prepare(`
        INSERT INTO customer_deposit_transactions (
          id, tenant_id, customer_id, amount, balance_after, method, shift_id,
          notes, created_by, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payoutId, tenantId, customer.id, -amount, balanceAfter, input.method,
        input.shift_id ?? null, note, input.user_id ?? null, timestamp, timestamp, timestamp,
      )

      const cashOperationId = input.method === 'cash' ? payoutId : null
      if (cashOperationId) {
        this.addCashOperation(
          tenantId, input.shift_id!, input.user_id ?? null, 'cash_out', amount,
          `${note}: ${customer.full_name ?? customer.phone ?? customer.id.slice(0, 8)}`,
          timestamp, cashOperationId,
        )
      }
      this.addOutbox(tenantId, 'customer', customer.id, 'customer.deposit_changed', {
        customer_id: customer.id,
        transaction_id: payoutId,
        amount: -amount,
        method: input.method,
        shift_id: input.shift_id ?? null,
        cash_operation_id: cashOperationId,
        notes: note,
        created_by: input.user_id ?? null,
        created_at: timestamp,
      }, timestamp)
      this.addAudit(
        tenantId, input.user_id ?? 'local', 'customer.deposit_payout', 'customer', customer.id,
        { amount: -amount, method: input.method, balance_after: balanceAfter }, timestamp,
      )
      return { data: { balance: balanceAfter, replayed: false } }
    })
  }

  protected addCustomerVehicle(customerId: string, tenantId: string, vehicle: any, timestamp: string): boolean {
    if (!vehicle || !(vehicle.vin || vehicle.brand || vehicle.model)) return false
    const vin = String(vehicle.vin ?? '').trim().toUpperCase() || null
    if (vin) {
      const exists = this.db.prepare(`
        SELECT id FROM customer_vehicles
        WHERE tenant_id = ? AND customer_id = ? AND deleted_at IS NULL AND upper(vin) = ?
        LIMIT 1
      `).get(tenantId, customerId, vin)
      if (exists) return false
    }
    const id = randomUUID()
    const payload = {
      id,
      customer_id: customerId,
      brand: String(vehicle.brand ?? vehicle.make ?? '').trim(),
      model: String(vehicle.model ?? '').trim(),
      year: vehicle.year ?? null,
      vin,
      notes: vehicle.notes ?? null,
    }
    this.db.prepare(`
      INSERT INTO customer_vehicles (
        id, tenant_id, customer_id, brand, model, year, vin, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, customerId, payload.brand, payload.model,
      payload.year, payload.vin, payload.notes, timestamp, timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'customer_vehicle', id, 'customer_vehicle.created', payload, timestamp)
    return true
  }

  protected getCustomerForMoney(customerId: string, tenantId: string): {
    id: string
    full_name: string | null
    phone: string | null
    debt_balance: number
    deposit_balance: number
    bonus_balance: number
    loyalty_mode: 'discount' | 'cashback'
    discount_pct: number
  } {
    const row = this.db.prepare(`
      SELECT id, full_name, phone, debt_balance, COALESCE(deposit_balance, 0) AS deposit_balance,
             COALESCE(bonus_balance, 0) AS bonus_balance, COALESCE(loyalty_mode, 'discount') AS loyalty_mode,
             COALESCE(discount_pct, 0) AS discount_pct
      FROM customers
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(customerId, tenantId) as { id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance: number; bonus_balance: number; loyalty_mode: 'discount' | 'cashback'; discount_pct: number } | undefined
    if (!row) throw new Error('Клієнта не знайдено')
    return row
  }
}
