import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import {
  DEFAULT_TENANT_ID,
  type LocalProduct,
  type LocalSaleCheckoutInput,
  type LocalSaleCheckoutResult,
  type LocalSalePaymentInput,
} from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

function dayStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function money(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}

function lineTotal(qty: number, unitPrice: number, discount = 0): number {
  return Math.max(0, money(qty * unitPrice) - money(discount))
}

function paymentMethod(payments: LocalSalePaymentInput[]): LocalSaleCheckoutResult['payment_method'] {
  const methods = Array.from(new Set(payments.map((payment) => payment.method)))
  return methods.length === 1 ? methods[0] : 'mixed'
}

export class LocalPosRepository {
  constructor(private readonly db: LocalDatabase) {}

  openShift(input: {
    tenant_id?: string
    cashier_id: string
    opening_cash?: number
    notes?: string | null
  }): string {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const existing = this.findOpenShift(input.cashier_id, tenantId)
    if (existing) return existing

    const timestamp = nowIso()
    const shiftId = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at,
          notes, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
      `).run(
        shiftId,
        tenantId,
        input.cashier_id,
        input.opening_cash ?? 0,
        timestamp,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
      )

      this.addOutbox(
        tenantId,
        'shift',
        shiftId,
        'shift.opened',
        { id: shiftId, cashier_id: input.cashier_id, opening_cash: input.opening_cash ?? 0 },
        timestamp,
      )
    })

    return shiftId
  }

  findOpenShift(cashierId: string, tenantId = DEFAULT_TENANT_ID): string | null {
    return this.getOpenShift(cashierId, tenantId)?.id ?? null
  }

  getOpenShift(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    id: string
    cashier_id: string
    status: 'open'
    opening_cash: number
    closing_cash: number | null
    expected_cash: number | null
    cash_variance: number | null
    opened_at: string
    closed_at: string | null
    notes: string | null
  } | null {
    const row = this.db.prepare(`
      SELECT id, cashier_id, status, opening_cash, closing_cash, expected_cash,
             cash_variance, opened_at, closed_at, notes
      FROM shifts
      WHERE tenant_id = ?
        AND cashier_id = ?
        AND status = 'open'
        AND deleted_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1
    `).get(tenantId, cashierId) as {
      id: string
      cashier_id: string
      status: 'open'
      opening_cash: number
      closing_cash: number | null
      expected_cash: number | null
      cash_variance: number | null
      opened_at: string
      closed_at: string | null
      notes: string | null
    } | undefined
    return row ?? null
  }

  // Список боржників з локальної бази (клієнти з боргом > 0), для каси офлайн.
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
      this.getCustomer(customerId, tenantId)
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
        bonus_balance: input.bonus_balance !== undefined ? money(input.bonus_balance) : undefined,
        loyalty_mode: input.loyalty_mode === 'cashback' ? 'cashback' : input.loyalty_mode === 'discount' ? 'discount' : undefined,
        client_status: input.client_status,
        card_barcode: input.card_barcode,
      }
      const entries = Object.entries(values).filter(([, value]) => value !== undefined)
      if (entries.length) {
        const sets = entries.map(([key]) => `${key} = ?`)
        this.db.prepare(`
          UPDATE customers
          SET ${sets.join(', ')}, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).run(...entries.map(([, value]) => value), timestamp, timestamp, id, tenantId)
      }
      const updated = this.getCustomer(id, tenantId)
      this.addOutbox(tenantId, 'customer', id, 'customer.updated', updated, timestamp)
      return { data: updated }
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
      this.addCustomerVehicle(id, tenantId, input.vehicle, timestamp)
      this.addOutbox(tenantId, 'customer', id, 'customer.created', {
        id, phone, full_name: input.full_name ?? null, email: input.email ?? null, birth_date: input.birth_date ?? null,
        notes: input.notes ?? null, tags: input.tags ?? [], price_tier_id: input.price_tier_id ?? null,
        discount_pct: Number(input.discount_pct ?? 0), client_status: input.client_status ?? 'client',
        card_barcode: input.card_barcode ?? null, vehicle: input.vehicle ?? null,
      }, timestamp)
    })
    return { data: this.getCustomer(id, tenantId), meta: { reused: false, vehicle_added: Boolean(input.vehicle) } }
  }

  deleteCustomer(customerId: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    this.getCustomer(customerId, tenantId)
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

      if (input.method === 'cash' && input.shift_id) {
        this.addCashOperation(tenantId, input.shift_id, input.user_id ?? null, 'cash_in', amount, `Оплата боргу: ${customer.full_name ?? customer.phone ?? customer.id.slice(0, 8)}`, timestamp)
      }

      this.addOutbox(tenantId, 'customer', customer.id, 'customer.debt_paid', {
        customer_id: customer.id,
        amount,
        method: input.method,
        shift_id: input.shift_id ?? null,
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

      if (input.method === 'cash' && input.shift_id) {
        this.addCashOperation(tenantId, input.shift_id, input.user_id ?? null, 'cash_in', amount, `Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone ?? customer.id.slice(0, 8)}`, timestamp)
      }

      this.addOutbox(tenantId, 'customer', customer.id, 'customer.deposit_changed', {
        customer_id: customer.id,
        transaction_id: transactionId,
        amount,
        method: input.method,
        shift_id: input.shift_id ?? null,
        notes: input.notes ?? 'Поповнення рахунку на касі',
        created_by: input.user_id ?? null,
        created_at: timestamp,
      }, timestamp)
      this.addAudit(tenantId, input.user_id ?? 'local', 'customer.deposit_changed', 'customer', customer.id, { amount, method: input.method, balance_after: balanceAfter }, timestamp)
      return { data: { balance: balanceAfter } }
    })
  }
  getSale(saleId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT s.*, c.phone AS customer_phone, c.full_name AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `).get(saleId, tenantId) as any
    if (!row) throw new Error('Чек не знайдено')
    return this.decorateSale(row, tenantId)
  }

  listSales(input: { tenant_id?: string; search?: string; status?: string; product_barcode?: string; date_from?: string; date_to?: string; page?: number; per_page?: number } = {}): {
    data: any[]
    pagination: { page: number; per_page: number; total: number; total_pages: number }
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(200, Number(input.per_page ?? 20) || 20))
    const where = ['s.tenant_id = ?', 's.deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (input.status) {
      where.push('s.status = ?')
      params.push(input.status)
    }
    const productBarcode = String(input.product_barcode ?? '').trim()
    if (productBarcode) {
      where.push(`EXISTS (
        SELECT 1
        FROM sale_items si
        LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
        LEFT JOIN product_barcodes pb ON pb.product_id = si.product_id AND pb.tenant_id = si.tenant_id AND pb.deleted_at IS NULL
        WHERE si.sale_id = s.id
          AND si.tenant_id = s.tenant_id
          AND si.deleted_at IS NULL
          AND (COALESCE(p.barcode, '') = ? OR COALESCE(p.sku, '') = ? OR COALESCE(pb.barcode, '') = ?)
      )`)
      params.push(productBarcode, productBarcode, productBarcode)
    }
    if (input.date_from) {
      where.push('COALESCE(s.completed_at, s.created_at) >= ?')
      params.push(input.date_from)
    }
    if (input.date_to) {
      where.push('COALESCE(s.completed_at, s.created_at) <= ?')
      params.push(input.date_to)
    }
    const raw = String(input.search ?? '').trim()
    if (raw) {
      const lower = raw.toLocaleLowerCase('uk-UA')
      const title = lower.replace(/(^|\s)\S/g, (char) => char.toLocaleUpperCase('uk-UA'))
      const q = `%${raw}%`
      where.push(`(
        s.sale_number LIKE ?
        OR COALESCE(c.phone, '') LIKE ?
        OR COALESCE(c.card_barcode, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR EXISTS (
          SELECT 1 FROM customer_vehicles v
          WHERE v.customer_id = c.id AND v.tenant_id = s.tenant_id
            AND v.deleted_at IS NULL AND upper(COALESCE(v.vin, '')) LIKE upper(?)
        )
      )`)
      params.push(q, q, q, q, `%${title}%`, q)
    }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE ${whereSql}
    `).get(...params) as { total: number }
    const rows = this.db.prepare(`
      SELECT s.*, c.phone AS customer_phone, c.full_name AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE ${whereSql}
      ORDER BY COALESCE(s.completed_at, s.created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, (page - 1) * perPage) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateSale(row, tenantId)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  calculatePrices(items: Array<{ product_id: string; qty: number }>, tenantId = DEFAULT_TENANT_ID): any[] {
    return items.map((item) => {
      const product = this.getProductForUpdate(item.product_id, tenantId)
      if (!product) throw new Error('Товар не знайдено')
      const qty = Number(item.qty ?? 0)
      return {
        product_id: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        unit_price: Number(product.retail_price ?? 0),
        qty,
        total: Number(product.retail_price ?? 0) * qty,
        in_stock: Number(product.qty_on_hand ?? 0) >= qty,
        qty_on_hand: Number(product.qty_on_hand ?? 0),
      }
    })
  }

  suspendSale(input: any): { data: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!input.shift_id) throw new Error('Касову зміну не відкрито')
    const timestamp = nowIso()
    const saleId = randomUUID()
    const saleNumber = this.nextSaleNumber(tenantId, timestamp)
    const prepared = (input.items ?? []).map((item: any) => {
      const product = this.getProductForUpdate(item.product_id, tenantId)
      if (!product) throw new Error('Товар не знайдено')
      const qty = Number(item.qty ?? 0)
      if (qty <= 0) throw new Error('Некоректна кількість')
      const unitPrice = money(item.unit_price ?? product.retail_price)
      const discount = money(item.discount ?? 0)
      return {
        id: randomUUID(), product_id: product.id, description: product.name, sku: product.sku,
        qty, unit_price: unitPrice, purchase_price: product.purchase_price,
        discount, total: lineTotal(qty, unitPrice, discount),
      }
    })
    if (!prepared.length) throw new Error('Чек порожній')
    const subtotal = prepared.reduce((sum: number, item: any) => sum + item.total, 0)
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          cash_amount, card_amount, transfer_amount, debt_amount, pickup_cell, notes,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'suspended', ?, 0, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?)
      `).run(
        saleId, tenantId, saleNumber, input.customer_id ?? null,
        input.cashier_id ?? input.manager_id ?? 'local', input.manager_id ?? null, input.shift_id,
        subtotal, subtotal, input.payment_method ?? 'cash', input.pickup_cell ?? null,
        input.notes ?? null, timestamp, timestamp, timestamp,
      )
      for (const item of prepared) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, tenantId, saleId, item.product_id, item.description, item.sku,
          item.qty, item.unit_price, item.purchase_price, item.discount, item.total,
          timestamp, timestamp,
        )
      }
      this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended', {
        id: saleId, sale_number: saleNumber, ...input, subtotal, total: subtotal, created_at: timestamp,
      }, timestamp)
    })
    return { data: this.getSale(saleId, tenantId) }
  }

  listSuspendedSales(tenantId = DEFAULT_TENANT_ID): any[] {
    return this.listSales({ tenant_id: tenantId, status: 'suspended', page: 1, per_page: 200 }).data
  }

  resumeSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    return { data: sale }
  }

  confirmResumeSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE sales SET status = 'cancelled', dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, saleId, tenantId)
    this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended_resumed', { id: saleId }, timestamp)
    return { data: { ...sale, status: 'cancelled' } }
  }

  discardSuspendedSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE sales SET status = 'cancelled', deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, timestamp, saleId, tenantId)
    this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended_deleted', { id: saleId }, timestamp)
    return { data: { ...sale, status: 'cancelled' } }
  }

  checkSaleAfterPayment(shiftId: string, after: string, tenantId = DEFAULT_TENANT_ID): any | null {
    const row = this.db.prepare(`
      SELECT id FROM sales
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
        AND status = 'completed' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(tenantId, shiftId, after) as { id: string } | undefined
    return row ? this.getSale(row.id, tenantId) : null
  }
  createCashOperation(input: {
    tenant_id?: string
    shift_id: string
    user_id?: string | null
    type: 'in' | 'out'
    amount: number
    note?: string | null
    source?: string
  }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть суму більше нуля')
    const shift = this.db.prepare(`
      SELECT id FROM shifts
      WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
    `).get(input.shift_id, tenantId) as { id: string } | undefined
    if (!shift) throw new Error('Касову зміну не знайдено або вже закрито')
    const timestamp = nowIso()
    const id = randomUUID()
    const dbType = input.type === 'in' ? 'cash_in' : 'cash_out'
    this.db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, input.shift_id, input.user_id ?? null, dbType,
      input.source ?? 'cashbox', amount, input.note ?? null,
      timestamp, timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'cash_operation', id, 'cash_operation.created', {
      id, shift_id: input.shift_id, type: input.type, amount,
      note: input.note ?? null, source: input.source ?? 'cashbox',
      user_id: input.user_id ?? null,
    }, timestamp)
    return {
      id, shift_id: input.shift_id, type: input.type, amount,
      note: input.note ?? null, created_by: input.user_id ?? 'local', created_at: timestamp,
    }
  }

  listCashOperations(shiftId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    const rows = this.db.prepare(`
      SELECT id, shift_id, user_id, type, amount, notes, created_at
      FROM cash_operations
      WHERE shift_id = ? AND tenant_id = ? AND deleted_at IS NULL AND type IN ('cash_in', 'cash_out')
      ORDER BY created_at DESC
    `).all(shiftId, tenantId) as any[]
    return rows.map((row) => ({
      id: row.id,
      shift_id: row.shift_id,
      type: row.type === 'cash_in' ? 'in' : 'out',
      amount: Number(row.amount),
      note: row.notes ?? null,
      created_by: row.user_id ?? 'local',
      created_at: row.created_at,
    }))
  }

  getCashOperationSummary(shiftId: string, tenantId = DEFAULT_TENANT_ID): {
    total_in: number
    total_out: number
    net: number
  } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'cash_in' THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN type = 'cash_out' THEN amount ELSE 0 END), 0) AS total_out
      FROM cash_operations
      WHERE shift_id = ? AND tenant_id = ?
    `).get(shiftId, tenantId) as { total_in: number; total_out: number }
    const totalIn = Number(row?.total_in ?? 0)
    const totalOut = Number(row?.total_out ?? 0)
    return { total_in: totalIn, total_out: totalOut, net: totalIn - totalOut }
  }
  // Очікувана готівка у відкритій зміні (звірка каси) — з локальних даних.
  getExpectedCash(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    opening_cash: number
    cash_sales: number
    cash_returns: number
    cash_in: number
    cash_out: number
    expected_amount: number
  } | null {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) return null
    const rows = this.db.prepare(`
      SELECT type, SUM(amount) AS total
      FROM cash_operations
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
      GROUP BY type
    `).all(tenantId, shift.id) as Array<{ type: string; total: number }>
    const by: Record<string, number> = {}
    for (const r of rows) by[r.type] = Number(r.total) || 0
    const cash_sales = by['sale_cash'] ?? 0
    const cash_returns = by['return_cash'] ?? 0
    const cash_in = by['cash_in'] ?? 0
    const cash_out = (by['cash_out'] ?? 0) + (by['salary_payout'] ?? 0) + (by['supplier_payment'] ?? 0)
    const expected = shift.opening_cash + cash_sales + cash_in - cash_returns - cash_out
    return {
      opening_cash: shift.opening_cash,
      cash_sales,
      cash_returns,
      cash_in,
      cash_out,
      expected_amount: Math.max(0, expected),
    }
  }

  getShiftReport(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    shift: NonNullable<ReturnType<LocalPosRepository['getOpenShift']>>
    total_sales: number
    total_revenue: number
    by_method: { cash: number; card: number; debt: number }
    sales: Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
    }>
  } | null {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) return null
    const sales = this.db.prepare(`
      SELECT id, sale_number, total, payment_method, status, completed_at,
             cash_amount, card_amount
      FROM sales
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
      ORDER BY completed_at ASC
    `).all(tenantId, shift.id) as unknown as Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
      cash_amount: number
      card_amount: number
    }>
    const completed = sales.filter((sale) => sale.status === 'completed')
    return {
      shift,
      total_sales: completed.length,
      total_revenue: completed.reduce((sum, sale) => sum + Number(sale.total || 0), 0),
      by_method: {
        cash: completed.reduce((sum, sale) => sum + Number(sale.cash_amount || 0), 0),
        card: completed.reduce((sum, sale) => sum + Number(sale.card_amount || 0), 0),
        debt: completed
          .filter((sale) => sale.payment_method === 'debt')
          .reduce((sum, sale) => sum + Number(sale.total || 0), 0),
      },
      sales,
    }
  }

  // Зберегти звірку каси локально (оновлюємо зміну очікуваною сумою й розбіжністю).
  reconcileShift(cashierId: string, actualAmount: number, comment: string | null, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) throw new Error('LOCAL_NO_SHIFT')
    const exp = this.getExpectedCash(cashierId, tenantId)
    const expected = exp?.expected_amount ?? 0
    const variance = Math.round(actualAmount) - expected
    const ts = new Date().toISOString()
    const note = comment && comment.trim()
      ? `${shift.notes ? shift.notes + '\n' : ''}Звірка: ${comment.trim()}`
      : shift.notes
    this.db.prepare(`
      UPDATE shifts
      SET expected_cash = ?, cash_variance = ?, notes = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(expected, variance, note ?? null, ts, ts, shift.id, tenantId)
    return { ok: true }
  }

  closeShift(cashierId: string, actualAmount: number, comment: string | null, tenantId = DEFAULT_TENANT_ID): { ok: true; id: string } {
    return this.db.transaction(() => {
      const shift = this.getOpenShift(cashierId, tenantId)
      if (!shift) throw new Error('LOCAL_NO_SHIFT')
      const expected = this.getExpectedCash(cashierId, tenantId)?.expected_amount ?? 0
      const closingCash = money(actualAmount)
      const variance = closingCash - expected
      const timestamp = nowIso()
      const note = comment?.trim()
        ? `${shift.notes ? shift.notes + '\n' : ''}${comment.trim()}`
        : shift.notes

      this.db.prepare(`
        UPDATE shifts
        SET status = 'closed', closing_cash = ?, expected_cash = ?, cash_variance = ?,
            closed_at = ?, notes = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(
        closingCash,
        expected,
        variance,
        timestamp,
        note ?? null,
        timestamp,
        timestamp,
        shift.id,
        tenantId,
      )

      this.addOutbox(
        tenantId,
        'shift',
        shift.id,
        'shift.closed',
        {
          id: shift.id,
          cashier_id: cashierId,
          closing_cash: closingCash,
          expected_cash: expected,
          cash_variance: variance,
          closed_at: timestamp,
          notes: note ?? null,
        },
        timestamp,
      )
      return { ok: true, id: shift.id }
    })
  }

  checkout(input: LocalSaleCheckoutInput): LocalSaleCheckoutResult {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (input.items.length === 0) throw new Error('LOCAL_SALE_EMPTY')
    if (input.payments.length === 0) throw new Error('LOCAL_SALE_PAYMENT_REQUIRED')

    return this.db.transaction(() => {
      const timestamp = nowIso()
      const saleId = randomUUID()
      const shiftId = input.shift_id ?? this.findOpenShift(input.cashier_id, tenantId)
      if (!shiftId) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')

      const saleNumber = this.nextSaleNumber(tenantId, timestamp)
      const payments = this.summarizePayments(input.payments)
      let subtotal = 0
      const preparedItems = input.items.map((item) => {
        if (item.qty <= 0) throw new Error('LOCAL_SALE_INVALID_QTY')
        const product = item.product_id
          ? this.getProductForUpdate(item.product_id, tenantId)
          : null
        if (item.product_id && !product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')

        const unitPrice = money(item.unit_price ?? product?.retail_price ?? 0)
        if (unitPrice <= 0) throw new Error('LOCAL_SALE_INVALID_PRICE')

        const total = lineTotal(item.qty, unitPrice, item.discount ?? 0)
        subtotal += total

        return {
          id: randomUUID(),
          product,
          product_id: product?.id ?? null,
          description: item.description ?? product?.name ?? 'Вільна сума',
          sku: product?.sku ?? null,
          qty: item.qty,
          unit_price: unitPrice,
          purchase_price: product?.purchase_price ?? 0,
          discount: money(item.discount ?? 0),
          total,
        }
      })

      const bonusesSpent = money(input.bonuses_spent ?? 0)
      if (bonusesSpent > 0 && !input.customer_id) throw new Error('Для списання бонусів виберіть клієнта')
      let bonusCustomer: ReturnType<LocalPosRepository['getCustomerForMoney']> | null = null
      if (bonusesSpent > 0 && input.customer_id) {
        bonusCustomer = this.getCustomerForMoney(input.customer_id, tenantId)
        const bonusBalance = Number((bonusCustomer as any).bonus_balance ?? 0)
        if (bonusesSpent > bonusBalance) throw new Error('Недостатньо бонусів у клієнта')
      }
      const discount = money(input.discount ?? 0)
      const total = Math.max(0, subtotal - discount)
      const paidTotal = payments.cash + payments.card + payments.transfer + payments.debt
      if (paidTotal !== total) throw new Error('LOCAL_SALE_PAYMENT_MISMATCH')

      const method = paymentMethod(input.payments)
      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          fiscal_number, fiscal_qr_url,
          cash_amount, card_amount, transfer_amount, debt_amount, notes,
          completed_at, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        saleId,
        tenantId,
        saleNumber,
        input.customer_id ?? null,
        input.cashier_id,
        input.manager_id ?? null,
        shiftId,
        subtotal,
        discount,
        total,
        method,
        payments.debt > 0 ? 1 : 0,
        input.is_fiscal === true ? 1 : 0,
        input.fiscal_number ?? null,
        input.fiscal_qr_url ?? null,
        payments.cash,
        payments.card,
        payments.transfer,
        payments.debt,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )

      for (const item of preparedItems) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          tenantId,
          saleId,
          item.product_id,
          item.description,
          item.sku,
          item.qty,
          item.unit_price,
          item.purchase_price,
          item.discount,
          item.total,
          timestamp,
          timestamp,
        )

        if (item.product && item.product.is_service !== 1) {
          const qtyAfter = Number(item.product.qty_on_hand) - Number(item.qty)
          this.db.prepare(`
            UPDATE products
            SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(qtyAfter, timestamp, timestamp, item.product.id, tenantId)

          this.db.prepare(`
            INSERT INTO inventory_movements (
              id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
              unit_cost, notes, dirty_at, created_at, updated_at
            )
            VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            tenantId,
            item.product.id,
            saleId,
            -Number(item.qty),
            qtyAfter,
            item.purchase_price,
            `Sale ${saleNumber}`,
            timestamp,
            timestamp,
            timestamp,
          )
        }
      }

      for (const payment of input.payments) {
        this.db.prepare(`
          INSERT INTO sale_payments (
            id, tenant_id, sale_id, method, amount, is_fiscal, fiscal_number,
            bank_auth_code, terminal_rrn, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          saleId,
          payment.method,
          payment.amount,
          payment.is_fiscal === true ? 1 : 0,
          payment.fiscal_number ?? null,
          payment.bank_auth_code ?? null,
          payment.terminal_rrn ?? null,
          timestamp,
          timestamp,
        )
      }

      if (bonusesSpent > 0 && input.customer_id && bonusCustomer) {
        const balanceAfter = Number((bonusCustomer as any).bonus_balance ?? 0) - bonusesSpent
        this.db.prepare(`
          UPDATE customers SET bonus_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(balanceAfter, timestamp, timestamp, input.customer_id, tenantId)
        this.db.prepare(`
          INSERT INTO bonus_transactions (
            id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
            description, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'spend', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), tenantId, input.customer_id, -bonusesSpent, saleId,
          `Списання бонусів за чеком ${saleNumber}`, input.cashier_id,
          timestamp, timestamp, timestamp,
        )
      }
      if (payments.debt > 0 && input.customer_id) {
        const customer = this.getCustomerForMoney(input.customer_id, tenantId)
        this.db.prepare(`
          UPDATE customers
          SET debt_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(Number(customer.debt_balance ?? 0) + payments.debt, timestamp, timestamp, input.customer_id, tenantId)
      }
      if (input.customer_id && payments.debt === 0) {
        const customer = this.getCustomerForMoney(input.customer_id, tenantId)
        const cashbackPct = customer.loyalty_mode === 'cashback' ? Number(customer.discount_pct ?? 0) : 0
        const cashback = cashbackPct > 0 ? Math.round(total * cashbackPct / 100) : 0
        if (cashback > 0) {
          const balanceAfter = Number(customer.deposit_balance ?? 0) + cashback
          const transactionId = randomUUID()
          const notes = 'Накопичення ' + cashbackPct + '% з чека ' + saleNumber
          this.db.prepare(`
            UPDATE customers
            SET deposit_balance = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(balanceAfter, timestamp, timestamp, input.customer_id, tenantId)
          this.db.prepare(`
            INSERT INTO customer_deposit_transactions (
              id, tenant_id, customer_id, amount, balance_after, method, sale_id, shift_id,
              notes, created_by, dirty_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'cashback', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            transactionId, tenantId, input.customer_id, cashback, balanceAfter, saleId, shiftId,
            notes, input.cashier_id, timestamp, timestamp, timestamp,
          )
          this.addOutbox(tenantId, 'customer', input.customer_id, 'customer.deposit_changed', {
            customer_id: input.customer_id, transaction_id: transactionId, amount: cashback, method: 'cashback',
            sale_id: saleId, shift_id: shiftId, notes, created_by: input.cashier_id, created_at: timestamp,
          }, timestamp)
        }
      }
      if (payments.cash > 0) {
        this.db.prepare(`
          INSERT INTO cash_operations (
            id, tenant_id, shift_id, user_id, type, source, amount, sale_id,
            notes, dirty_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'sale_cash', 'cashbox', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          shiftId,
          input.cashier_id,
          payments.cash,
          saleId,
          `Cash payment ${saleNumber}`,
          timestamp,
          timestamp,
          timestamp,
        )
      }

      const outboxSequence = this.addOutbox(
        tenantId,
        'sale',
        saleId,
        'sale.completed',
        {
          sale_id: saleId,
          sale_number: saleNumber,
          shift_id: shiftId,
          customer_id: input.customer_id ?? null,
          cashier_id: input.cashier_id,
          manager_id: input.manager_id ?? null,
          subtotal,
          discount,
          bonuses_spent: bonusesSpent,
          total,
          payment_method: method,
          is_fiscal: input.is_fiscal === true,
          fiscal_number: input.fiscal_number ?? null,
          fiscal_qr_url: input.fiscal_qr_url ?? null,
          payments: input.payments,
          items: preparedItems.map((item) => ({
            product_id: item.product_id,
            description: item.description,
            sku: item.sku,
            qty: item.qty,
            unit_price: item.unit_price,
            purchase_price: item.purchase_price,
            discount: item.discount,
            total: item.total,
          })),
          completed_at: timestamp,
        },
        timestamp,
      )

      this.addAudit(
        tenantId,
        input.cashier_id,
        'sale.completed',
        'sale',
        saleId,
        { sale_number: saleNumber, total, payment_method: method },
        timestamp,
      )

      return {
        sale_id: saleId,
        sale_number: saleNumber,
        total,
        subtotal,
        payment_method: method,
        outbox_sequence: outboxSequence,
      }
    })
  }

  listReturns(input: { tenant_id?: string; page?: number; per_page?: number } = {}): {
    data: any[]
    pagination: { page: number; per_page: number; total: number; total_pages: number }
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(100, Number(input.per_page ?? 20) || 20))
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total FROM customer_returns
      WHERE tenant_id = ? AND deleted_at IS NULL
    `).get(tenantId) as { total: number }
    const rows = this.db.prepare(`
      SELECT r.*, s.sale_number, s.total AS sale_total, c.phone AS customer_phone, c.full_name AS customer_name
      FROM customer_returns r
      JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
      LEFT JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(tenantId, perPage, (page - 1) * perPage) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateReturn(row, tenantId)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  getReturn(returnId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT r.*, s.sale_number, s.total AS sale_total, c.phone AS customer_phone, c.full_name AS customer_name
      FROM customer_returns r
      JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
      LEFT JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
      WHERE r.id = ? AND r.tenant_id = ? AND r.deleted_at IS NULL
      LIMIT 1
    `).get(returnId, tenantId) as any
    if (!row) throw new Error('Повернення не знайдено')
    return this.decorateReturn(row, tenantId)
  }

  getSaleForReturn(saleId: string, tenantId = DEFAULT_TENANT_ID): any {
    const sale = this.getSale(saleId, tenantId)
    if (!['completed', 'returned'].includes(sale.status)) {
      throw new Error('Цей чек не можна повернути')
    }
    const items = this.db.prepare(`
      SELECT si.id, si.product_id, COALESCE(p.name, si.description, '') AS product_name,
             COALESCE(si.sku, p.sku, '') AS sku, COALESCE(p.unit, 'шт') AS unit,
             si.qty, si.unit_price, si.total,
             COALESCE((
               SELECT SUM(ri.quantity)
               FROM customer_return_items ri
               JOIN customer_returns r ON r.id = ri.return_id
               WHERE ri.sale_item_id = si.id AND ri.deleted_at IS NULL AND r.deleted_at IS NULL
             ), 0) AS already_returned_qty
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
      ORDER BY si.created_at ASC
    `).all(saleId, tenantId) as any[]
    return {
      sale: {
        id: sale.id,
        sale_number: sale.sale_number,
        status: sale.status,
        customer_id: sale.customer_id,
        total: sale.total,
        completed_at: sale.completed_at,
        is_fiscal: sale.is_fiscal,
        fiscal_number: sale.fiscal_number,
      },
      items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        product_name: item.product_name,
        sku: item.sku,
        unit: item.unit,
        qty: Number(item.qty),
        unit_price: Number(item.unit_price),
        total: Number(item.total),
        already_returned_qty: Number(item.already_returned_qty),
        available_qty: Math.max(0, Number(item.qty) - Number(item.already_returned_qty)),
      })),
    }
  }

  createReturn(input: any): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const sale = this.getSale(input.sale_id, tenantId)
    const available = this.getSaleForReturn(input.sale_id, tenantId)
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('Оберіть товар для повернення')
    }
    const availableById = new Map(available.items.map((item: any) => [item.id, item]))
    const normalized = input.items.map((item: any) => {
      const source = availableById.get(item.sale_item_id) as any
      const quantity = Number(item.quantity ?? 0)
      if (!source || source.product_id !== item.product_id) throw new Error('Позицію чека не знайдено')
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > source.available_qty) {
        throw new Error(`Для ${source.product_name} доступно до повернення: ${source.available_qty}`)
      }
      return {
        id: randomUUID(),
        sale_item_id: source.id,
        product_id: source.product_id,
        quantity,
        unit_price: Number(source.unit_price),
        total: money(quantity * Number(source.unit_price)),
        condition: String(item.condition ?? 'good'),
      }
    })
    const refund = normalized.reduce((sum: number, item: any) => sum + item.total, 0)
    const returnId = randomUUID()
    const timestamp = nowIso()
    const approvedBy = input.approved_by ?? sale.cashier_id ?? 'local'
    const shiftId = input.shift_id ?? this.findOpenShift(approvedBy, tenantId) ?? sale.shift_id ?? null

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO customer_returns (
          id, tenant_id, sale_id, customer_id, return_type, reason, reason_note,
          refund_method, refund_kopecks, stock_action, status, approved_by,
          fiscal_number, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'customer_return', ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
      `).run(
        returnId, tenantId, sale.id, sale.customer_id ?? null,
        String(input.reason ?? 'other'), input.reason_note ?? null,
        String(input.refund_method ?? 'cash'), refund, String(input.stock_action ?? 'return_to_stock'),
        approvedBy, input.fiscal_number ?? null, timestamp, timestamp, timestamp,
      )

      for (const item of normalized) {
        this.db.prepare(`
          INSERT INTO customer_return_items (
            id, tenant_id, return_id, sale_item_id, product_id, quantity,
            unit_price_kopecks, total_kopecks, condition, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, tenantId, returnId, item.sale_item_id, item.product_id,
          item.quantity, item.unit_price, item.total, item.condition, timestamp, timestamp,
        )
        if (input.stock_action === 'return_to_stock' && item.product_id) {
          const product = this.getProductForUpdate(item.product_id, tenantId)
          if (product) {
            const nextQty = Number(product.qty_on_hand ?? 0) + item.quantity
            this.db.prepare(`
              UPDATE products SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ?
            `).run(nextQty, timestamp, timestamp, item.product_id, tenantId)
            this.db.prepare(`
              INSERT INTO inventory_movements (
                id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
                unit_cost, notes, dirty_at, created_at, updated_at
              ) VALUES (?, ?, ?, 'customer_return', ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              randomUUID(), tenantId, item.product_id, returnId, item.quantity, nextQty,
              item.unit_price, `Повернення за чеком ${sale.sale_number}`, timestamp, timestamp, timestamp,
            )
          }
        }
      }

      if (input.refund_method === 'cash') {
        this.addCashOperation(
          tenantId, shiftId, approvedBy, 'return_cash', refund,
          `Повернення за чеком ${sale.sale_number}`, timestamp,
        )
      } else if (sale.customer_id && input.refund_method === 'debt_reduction') {
        this.db.prepare(`
          UPDATE customers
          SET debt_balance = MAX(0, debt_balance - ?), dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(refund, timestamp, timestamp, sale.customer_id, tenantId)
      } else if (sale.customer_id && input.refund_method === 'credit') {
        const customer = this.getCustomerForMoney(sale.customer_id, tenantId)
        const balanceAfter = Number(customer.deposit_balance ?? 0) + refund
        this.db.prepare(`
          UPDATE customers SET deposit_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(balanceAfter, timestamp, timestamp, sale.customer_id, tenantId)
        this.db.prepare(`
          INSERT INTO customer_deposit_transactions (
            id, tenant_id, customer_id, amount, balance_after, method, sale_id,
            shift_id, notes, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'return_credit', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), tenantId, sale.customer_id, refund, balanceAfter, sale.id,
          shiftId, `Повернення за чеком ${sale.sale_number}`, approvedBy, timestamp, timestamp, timestamp,
        )
      }

      const remaining = this.getSaleForReturn(sale.id, tenantId).items
        .reduce((sum: number, item: any) => sum + Number(item.available_qty ?? 0), 0)
      if (remaining <= 0) {
        this.db.prepare(`
          UPDATE sales SET status = 'returned', dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(timestamp, timestamp, sale.id, tenantId)
      }
      this.addOutbox(tenantId, 'customer_return', returnId, 'return.created', {
        id: returnId,
        sale_id: sale.id,
        reason: input.reason,
        reason_note: input.reason_note ?? null,
        refund_method: input.refund_method,
        stock_action: input.stock_action,
        fiscal_number: input.fiscal_number ?? null,
        refund_kopecks: refund,
        items: normalized,
      }, timestamp)
      this.addAudit(tenantId, approvedBy, 'return.created', 'customer_return', returnId, {
        sale_id: sale.id, refund_kopecks: refund,
      }, timestamp)
    })
    return this.getReturn(returnId, tenantId)
  }

  private decorateReturn(row: any, tenantId: string): any {
    const items = this.db.prepare(`
      SELECT * FROM customer_return_items
      WHERE return_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).all(row.id, tenantId) as any[]
    return {
      id: row.id,
      sale_id: row.sale_id,
      customer_id: row.customer_id ?? null,
      return_type: row.return_type,
      reason: row.reason,
      reason_note: row.reason_note ?? null,
      refund_method: row.refund_method,
      refund_kopecks: Number(row.refund_kopecks ?? 0),
      stock_action: row.stock_action,
      status: row.status,
      approved_by: row.approved_by ?? 'local',
      created_at: row.created_at,
      fiscal_number: row.fiscal_number ?? null,
      sale: { id: row.sale_id, sale_number: row.sale_number, total: Number(row.sale_total ?? 0) },
      customer: row.customer_id ? {
        id: row.customer_id,
        phone: row.customer_phone ?? '',
        full_name: row.customer_name ?? null,
      } : null,
      return_items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price_kopecks: Number(item.unit_price_kopecks),
        total_kopecks: Number(item.total_kopecks),
        condition: item.condition,
      })),
    }
  }
  private decorateSale(row: any, tenantId: string): any {
    const items = this.db.prepare(`
      SELECT si.*, p.name AS product_name, p.unit AS product_unit, p.qty_on_hand AS product_qty
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
      ORDER BY si.created_at ASC
    `).all(row.id, tenantId) as any[]
    return {
      id: row.id,
      sale_number: row.sale_number,
      customer_id: row.customer_id ?? null,
      cashier_id: row.cashier_id,
      manager_id: row.manager_id ?? null,
      shift_id: row.shift_id,
      status: row.status,
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      total: Number(row.total ?? 0),
      payment_method: row.payment_method,
      is_debt: row.is_debt === 1,
      notes: row.notes ?? null,
      completed_at: row.completed_at ?? row.created_at,
      is_fiscal: row.is_fiscal === 1,
      fiscal_number: row.fiscal_number ?? null,
      bank_auth_code: row.bank_auth_code ?? null,
      cash_amount: Number(row.cash_amount ?? 0),
      card_amount: Number(row.card_amount ?? 0),
      pickup_cell: row.pickup_cell ?? null,
      customer: row.customer_id ? {
        id: row.customer_id,
        phone: row.customer_phone ?? '',
        full_name: row.customer_name ?? null,
      } : null,
      sale_items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        qty: Number(item.qty),
        unit_price: Number(item.unit_price),
        purchase_price: Number(item.purchase_price ?? 0),
        discount: Number(item.discount),
        total: Number(item.total),
        core_deposit_amount: Number(item.core_deposit_amount ?? 0),
        core_return_status: item.core_return_status ?? 'none',
        product: item.product_id ? {
          id: item.product_id,
          sku: item.sku ?? '',
          name: item.product_name ?? item.description ?? '',
          unit: item.product_unit ?? 'шт',
          qty_on_hand: Number(item.product_qty ?? 0),
        } : undefined,
      })),
      returns: [],
    }
  }
  private decorateCustomer(row: any): any {
    let tags: string[] = []
    try { tags = JSON.parse(row.tags_json ?? '[]') } catch { tags = [] }
    return {
      id: row.id,
      phone: row.phone ?? '',
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      birth_date: row.birth_date ?? null,
      debt_balance: Number(row.debt_balance ?? 0),
      deposit_balance: Number(row.deposit_balance ?? 0),
      notes: row.notes ?? null,
      tags,
      price_tier_id: row.price_tier_id ?? null,
      price_tier: null,
      bonus_balance: Number(row.bonus_balance ?? 0),
      vip_level: row.vip_level ?? 'standard',
      risk_profile: row.risk_profile ?? 'low',
      discount_pct: Number(row.discount_pct ?? 0),
      client_status: row.client_status ?? 'client',
      card_barcode: row.card_barcode ?? null,
      primary_vin: row.primary_vin ?? null,
      car_count: Number(row.car_count ?? 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at ?? null,
    }
  }

  private addCustomerVehicle(customerId: string, tenantId: string, vehicle: any, timestamp: string): boolean {
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
    this.db.prepare(`
      INSERT INTO customer_vehicles (
        id, tenant_id, customer_id, brand, model, year, vin, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), tenantId, customerId, vehicle.brand ?? '', vehicle.model ?? '',
      vehicle.year ?? null, vin, vehicle.notes ?? null, timestamp, timestamp, timestamp,
    )
    return true
  }
  private nextSaleNumber(tenantId: string, timestamp: string): string {
    const scope = `${tenantId}:sale:${dayStamp(new Date(timestamp))}`
    const row = this.db.prepare(`
      INSERT INTO local_sequences(scope, value, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET
        value = value + 1,
        updated_at = excluded.updated_at
      RETURNING value
    `).get(scope, timestamp) as { value: number } | undefined

    const sequence = row?.value ?? 1
    return `L-${dayStamp(new Date(timestamp))}-${String(sequence).padStart(6, '0')}`
  }

  private getProductForUpdate(productId: string, tenantId: string): LocalProduct | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, is_active, is_service, storage_bin
      FROM products
      WHERE id = ?
        AND tenant_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
    `).get(productId, tenantId) as LocalProduct | undefined
    return row ?? null
  }

  private summarizePayments(payments: LocalSalePaymentInput[]): {
    cash: number
    card: number
    transfer: number
    debt: number
  } {
    return payments.reduce((acc, payment) => {
      acc[payment.method] += money(payment.amount)
      return acc
    }, { cash: 0, card: 0, transfer: 0, debt: 0 })
  }

  private getCustomerForMoney(customerId: string, tenantId: string): {
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

  private addCashOperation(
    tenantId: string,
    shiftId: string | null,
    userId: string | null,
    type: 'cash_in' | 'cash_out' | 'return_cash',
    amount: number,
    notes: string,
    timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'cashbox', ?, ?, ?, ?, ?)
    `).run(randomUUID(), tenantId, shiftId, userId, type, amount, notes, timestamp, timestamp, timestamp)
  }
  private addOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    operationType: string,
    payload: unknown,
    timestamp: string,
  ): number | bigint {
    const result = this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      aggregateType,
      aggregateId,
      operationType,
      JSON.stringify(payload),
      timestamp,
    ) as { lastInsertRowid: number | bigint }
    return result.lastInsertRowid
  }

  private addAudit(
    tenantId: string,
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    after: unknown,
    timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO audit_log (
        event_id, tenant_id, device_id, user_id, action, entity_type, entity_id,
        after_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      userId,
      action,
      entityType,
      entityId,
      JSON.stringify(after),
      timestamp,
    )
  }
}
