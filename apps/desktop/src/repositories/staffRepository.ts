import { pbkdf2Sync, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

type SalaryType = 'salary' | 'bonus' | 'advance' | 'penalty'
type SalaryMethod = 'cash' | 'card' | 'transfer'

function nowIso(): string { return new Date().toISOString() }
function currentPeriod(): string { return nowIso().slice(0, 7) }
function currentDate(): string { return nowIso().slice(0, 10) }
function money(value: unknown): number {
  const parsed = Math.round(Number(value ?? 0))
  return Number.isFinite(parsed) ? parsed : 0
}
function hashSecret(secret: string, userId: string): string {
  return pbkdf2Sync(secret, userId, 10_000, 64, 'sha512').toString('hex')
}

function normalizePhone(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.startsWith('380')) return digits
  if (digits.startsWith('80')) return `3${digits}`
  if (digits.startsWith('0')) return `38${digits}`
  return digits
}

function phoneToEmail(phone: string): string {
  const digits = normalizePhone(phone)
  return `${digits || 'local'}@forsage.local`
}
export class LocalStaffRepository {
  constructor(private readonly db: LocalDatabase) {}

  listUsers(tenantId = DEFAULT_TENANT_ID): any[] {
    return (this.db.prepare(`
      SELECT id, phone, full_name, role, is_active, base_rate, rate_period, created_at
      FROM staff_users
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY is_active DESC, full_name COLLATE NOCASE ASC
    `).all(tenantId) as any[]).map((row) => ({
      ...row,
      phone: row.phone ?? '',
      email: '',
      is_active: Number(row.is_active) === 1,
      base_rate: money(row.base_rate),
      rate_period: row.rate_period === 'month' ? 'month' : 'day',
    }))
  }

  saveServerUser(input: {
    id: string
    phone: string
    full_name: string
    role: string
    is_active?: boolean
    base_rate?: number
    rate_period?: 'day' | 'month'
    created_at?: string
    updated_at?: string
  }, password: string, tenantId = DEFAULT_TENANT_ID): any {
    const id = String(input.id ?? '').trim()
    const fullName = String(input.full_name ?? '').trim()
    const phone = String(input.phone ?? '').trim()
    if (!id) throw new Error('Сервер не повернув ідентифікатор співробітника')
    if (!fullName) throw new Error('Вкажіть ім’я співробітника')
    if (!phone) throw new Error('Вкажіть телефон співробітника')
    if (String(password).length < 6) throw new Error('Пароль має містити щонайменше 6 символів')

    const timestamp = nowIso()
    const createdAt = input.created_at || timestamp
    const updatedAt = input.updated_at || timestamp
    const duplicate = (this.db.prepare(`
      SELECT id, phone
      FROM staff_users
      WHERE tenant_id = ? AND id <> ? AND deleted_at IS NULL
    `).all(tenantId, id) as Array<{ id: string; phone: string | null }>)
      .find((candidate) => normalizePhone(candidate.phone ?? '') === normalizePhone(phone))

    return this.db.transaction(() => {
      // Old desktop builds could create a local UUID first. Keep that row only
      // as an inactive FK anchor and stop its unsupported outbox operation.
      if (duplicate) {
        this.db.prepare(`
          UPDATE staff_users
          SET is_active = 0, deleted_at = ?, dirty_at = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(timestamp, timestamp, duplicate.id, tenantId)
        this.db.prepare(`
          DELETE FROM sync_outbox
          WHERE aggregate_type = 'staff_user'
            AND aggregate_id = ?
            AND status IN ('pending', 'failed', 'sending')
        `).run(duplicate.id)
      }

      this.db.prepare(`
        INSERT INTO staff_users (
          id, tenant_id, full_name, role, phone, is_active, base_rate, rate_period,
          password_hash, remote_updated_at, dirty_at, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          tenant_id = excluded.tenant_id,
          full_name = excluded.full_name,
          role = excluded.role,
          phone = excluded.phone,
          is_active = excluded.is_active,
          base_rate = excluded.base_rate,
          rate_period = excluded.rate_period,
          password_hash = excluded.password_hash,
          remote_updated_at = excluded.remote_updated_at,
          dirty_at = NULL,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        id,
        tenantId,
        fullName,
        input.role || 'cashier',
        phone,
        input.is_active === false ? 0 : 1,
        money(input.base_rate),
        input.rate_period === 'month' ? 'month' : 'day',
        hashSecret(password, id),
        updatedAt,
        createdAt,
        updatedAt,
      )
      this.db.prepare(`
        DELETE FROM sync_outbox
        WHERE aggregate_type = 'staff_user'
          AND aggregate_id = ?
          AND status IN ('pending', 'failed', 'sending')
      `).run(id)
      return this.listUsers(tenantId).find((user) => user.id === id)
    })
  }

  saveServerPassword(id: string, password: string, tenantId = DEFAULT_TENANT_ID): { success: true } {
    this.requireUser(id, tenantId)
    if (String(password).length < 6) throw new Error('Пароль має містити щонайменше 6 символів')
    this.db.prepare(`
      UPDATE staff_users SET password_hash = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(hashSecret(password, id), nowIso(), id, tenantId)
    return { success: true }
  }

  updateUser(id: string, input: any, tenantId = DEFAULT_TENANT_ID): any {
    const current = this.requireUser(id, tenantId)
    const fullName = input.full_name === undefined ? current.full_name : String(input.full_name).trim()
    const phone = input.phone === undefined ? current.phone : String(input.phone).trim()
    if (!fullName) throw new Error('Вкажіть ім’я співробітника')
    if (phone) {
      const duplicate = this.db.prepare(`
        SELECT id FROM staff_users
        WHERE tenant_id = ? AND phone = ? AND id <> ? AND deleted_at IS NULL LIMIT 1
      `).get(tenantId, phone, id)
      if (duplicate) throw new Error('Співробітник з таким телефоном вже існує')
    }
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE staff_users SET
        full_name = ?, phone = ?, role = ?, is_active = ?, base_rate = ?, rate_period = ?,
        dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(
      fullName, phone || null, input.role ?? current.role,
      input.is_active === undefined ? current.is_active : (input.is_active ? 1 : 0),
      input.base_rate === undefined ? current.base_rate : money(input.base_rate),
      input.rate_period === 'month' ? 'month' : (input.rate_period === 'day' ? 'day' : current.rate_period),
      timestamp, timestamp, id, tenantId,
    )
    this.addOutbox(tenantId, 'staff_user', id, 'staff_user.updated', {
      id, full_name: fullName, phone: phone || null, role: input.role ?? current.role,
      is_active: input.is_active === undefined ? Number(current.is_active) === 1 : Boolean(input.is_active),
      base_rate: input.base_rate === undefined ? money(current.base_rate) : money(input.base_rate),
      rate_period: input.rate_period ?? current.rate_period,
    }, timestamp)
    return this.listUsers(tenantId).find((user) => user.id === id)
  }

  deleteUser(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    this.requireUser(id, tenantId)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE staff_users SET is_active = 0, deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, timestamp, id, tenantId)
    this.addOutbox(tenantId, 'staff_user', id, 'staff_user.deleted', { id }, timestamp)
    return { ok: true }
  }


  loginWithPassword(phone: string, password: string, tenantId = DEFAULT_TENANT_ID): any {
    const normalizedPhone = normalizePhone(phone)
    const row = (this.db.prepare(`
      SELECT id, tenant_id, full_name, role, phone, password_hash, is_active, created_at, updated_at
      FROM staff_users
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY is_active DESC, updated_at DESC
    `).all(tenantId) as any[]).find((candidate) => normalizePhone(candidate.phone) === normalizedPhone)

    if (!row || Number(row.is_active) !== 1) throw new Error('Невірний номер телефону або пароль')
    if (!row.password_hash) throw new Error('Для цього співробітника локальний пароль ще не налаштовано')
    if (row.password_hash !== hashSecret(password, row.id)) throw new Error('Невірний номер телефону або пароль')

    return {
      id: row.id,
      tenant_id: row.tenant_id,
      full_name: row.full_name,
      role: row.role,
      phone: row.phone ?? '',
      email: phoneToEmail(row.phone ?? phone),
      is_active: true,
      created_at: row.created_at,
    }
  }

  setPin(userId: string, pin: string, tenantId = DEFAULT_TENANT_ID): { success: true } {
    this.requireUser(userId, tenantId)
    if (!/^\d{4}$/.test(pin)) throw new Error('PIN-код має складатися з 4 цифр')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE staff_users SET pin_hash = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(hashSecret(pin, userId), timestamp, timestamp, userId, tenantId)
    return { success: true }
  }

  verifyPin(userId: string, pin: string, tenantId = DEFAULT_TENANT_ID): { valid: boolean; error?: string } {
    if (!/^\d{4}$/.test(pin)) return { valid: false }
    const row = this.db.prepare(`
      SELECT pin_hash FROM staff_users
      WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL LIMIT 1
    `).get(userId, tenantId) as { pin_hash: string | null } | undefined
    if (!row) return { valid: false, error: 'Співробітника не знайдено' }
    if (!row.pin_hash) return { valid: false, error: 'PIN-код не налаштовано' }
    return { valid: row.pin_hash === hashSecret(pin, userId) }
  }

  listCommissionRules(tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT id, tenant_id, user_id, brand_id, category_id, pct_from_revenue,
             pct_from_profit, rule_type, created_at, updated_at
      FROM commission_rules
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all(tenantId) as any[]
  }

  createCommissionRule(input: any, tenantId = DEFAULT_TENANT_ID): any {
    const revenue = Number(input.pct_from_revenue ?? 0)
    const profit = Number(input.pct_from_profit ?? 0)
    if (revenue < 0 || revenue > 100 || profit < 0 || profit > 100) throw new Error('Відсоток має бути від 0 до 100')
    if (input.user_id) this.requireUser(input.user_id, tenantId)
    const timestamp = nowIso()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO commission_rules (
        id, tenant_id, user_id, brand_id, category_id, pct_from_revenue,
        pct_from_profit, rule_type, dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, input.user_id ?? null, input.brand_id ?? null, input.category_id ?? null,
      revenue, profit, input.rule_type || 'personal_sales', timestamp, timestamp, timestamp,
    )
    const rule = this.listCommissionRules(tenantId).find((item) => item.id === id)
    this.addOutbox(tenantId, 'commission_rule', id, 'commission_rule.created', rule, timestamp)
    return rule
  }

  deleteCommissionRule(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE commission_rules SET deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(timestamp, timestamp, timestamp, id, tenantId)
    if (Number(result.changes) === 0) throw new Error('Правило комісії не знайдено')
    this.addOutbox(tenantId, 'commission_rule', id, 'commission_rule.deleted', { id }, timestamp)
    return { ok: true }
  }

  listSalary(input: { tenant_id?: string; period?: string; employee_id?: string } = {}): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const params: Array<string | number | null> = [tenantId]
    let where = ''
    if (input.period) { where += ' AND period = ?'; params.push(input.period) }
    if (input.employee_id) { where += ' AND employee_id = ?'; params.push(input.employee_id) }
    return this.db.prepare(`
      SELECT id, employee_id, employee_name, amount, type, method, period, note,
             work_date, source, shift_id, cash_operation_id, created_at
      FROM salary_payments
      WHERE tenant_id = ? AND deleted_at IS NULL
    ` + where + ' ORDER BY created_at DESC LIMIT 200').all(...params) as any[]
  }

  salarySummary(period = currentPeriod(), tenantId = DEFAULT_TENANT_ID): any[] {
    return this.aggregateSalary(this.listSalary({ tenant_id: tenantId, period }))
  }

  dailySummary(workDate = currentDate(), tenantId = DEFAULT_TENANT_ID): any[] {
    const rows = this.db.prepare(`
      SELECT employee_id, employee_name, amount, type
      FROM salary_payments
      WHERE tenant_id = ? AND work_date = ? AND deleted_at IS NULL
    `).all(tenantId, workDate) as any[]
    const map = new Map<string, any>()
    for (const row of rows) {
      const value = map.get(row.employee_id) ?? {
        employee_id: row.employee_id, employee_name: row.employee_name,
        earned: 0, paid: 0, penalty: 0, balance: 0,
      }
      if (row.type === 'salary' || row.type === 'bonus') value.earned += money(row.amount)
      if (row.type === 'advance') value.paid += money(row.amount)
      if (row.type === 'penalty') value.penalty += money(row.amount)
      map.set(row.employee_id, value)
    }
    for (const value of map.values()) value.balance = value.earned - value.paid - value.penalty
    return [...map.values()]
  }

  createSalary(input: {
    tenant_id?: string
    employee_id: string
    employee_name?: string
    amount: number
    type: SalaryType
    method: SalaryMethod
    period?: string | null
    note?: string | null
    shift_id?: string | null
    work_date?: string
    user_id?: string | null
  }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const employee = this.requireUser(input.employee_id, tenantId)
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть коректну суму')
    const timestamp = nowIso()
    return this.db.transaction(() => this.insertSalary({
      tenantId,
      employeeId: employee.id,
      employeeName: input.employee_name || employee.full_name,
      amount,
      type: input.type,
      method: input.method,
      period: input.period || currentPeriod(),
      workDate: input.work_date || currentDate(),
      source: 'manual',
      note: input.note ?? null,
      shiftId: input.shift_id ?? null,
      userId: input.user_id ?? null,
      timestamp,
    }))
  }

  dailyPayout(input: {
    tenant_id?: string
    employee_id: string
    employee_name?: string
    method: SalaryMethod
    shift_id?: string | null
    work_date: string
    user_id?: string | null
  }): { payment: any; amount: number; earned: number; previously_paid: number; penalty: number } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const employee = this.requireUser(input.employee_id, tenantId)
    const timestamp = nowIso()
    return this.db.transaction(() => {
      if (money(employee.base_rate) > 0 && employee.rate_period === 'day') {
        const existing = this.db.prepare(`
          SELECT id FROM salary_payments
          WHERE tenant_id = ? AND employee_id = ? AND work_date = ?
            AND source = 'daily_rate' AND deleted_at IS NULL LIMIT 1
        `).get(tenantId, employee.id, input.work_date)
        if (!existing) {
          this.insertSalary({
            tenantId, employeeId: employee.id, employeeName: input.employee_name || employee.full_name,
            amount: money(employee.base_rate), type: 'salary', method: 'cash',
            period: input.work_date.slice(0, 7), workDate: input.work_date, source: 'daily_rate',
            note: 'Денна ставка', shiftId: null, userId: input.user_id ?? null, timestamp,
          })
        }
      }
      const totals = this.dailySummary(input.work_date, tenantId).find((item) => item.employee_id === employee.id)
      const earned = money(totals?.earned)
      const paid = money(totals?.paid)
      const penalty = money(totals?.penalty)
      const amount = earned - paid - penalty
      if (amount <= 0) throw new Error('За сьогодні немає невиплаченого заробітку')
      const payment = this.insertSalary({
        tenantId, employeeId: employee.id, employeeName: input.employee_name || employee.full_name,
        amount, type: 'advance', method: input.method,
        period: input.work_date.slice(0, 7), workDate: input.work_date, source: 'daily_payout',
        note: `Виплата заробітку за ${input.work_date}`, shiftId: input.shift_id ?? null,
        userId: input.user_id ?? null, timestamp,
      })
      return { payment, amount, earned, previously_paid: paid, penalty }
    })
  }

  deleteSalary(id: string, tenantId = DEFAULT_TENANT_ID): { success: true } {
    const row = this.db.prepare(`
      SELECT id, cash_operation_id FROM salary_payments
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1
    `).get(id, tenantId) as { id: string; cash_operation_id: string | null } | undefined
    if (!row) throw new Error('Операцію не знайдено')
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE salary_payments SET deleted_at = ?, dirty_at = ?, updated_at = ? WHERE id = ?
      `).run(timestamp, timestamp, timestamp, id)
      if (row.cash_operation_id) {
        this.db.prepare(`
          UPDATE cash_operations SET deleted_at = ?, dirty_at = ?, updated_at = ? WHERE id = ?
        `).run(timestamp, timestamp, timestamp, row.cash_operation_id)
      }
      this.addOutbox(tenantId, 'salary_payment', id, 'salary_payment.deleted', { id }, timestamp)
    })
    return { success: true }
  }

  recordOrderCommissions(orderId: string, tenantId = DEFAULT_TENANT_ID, createdBy: string | null = null): any[] {
    const order = this.db.prepare(`
      SELECT id, order_number, manager_id, updated_at
      FROM customer_orders
      WHERE id = ? AND tenant_id = ? AND status = 'completed' AND deleted_at IS NULL
    `).get(orderId, tenantId) as any
    if (!order?.manager_id) return []
    const employee = this.db.prepare(`
      SELECT id, full_name FROM staff_users
      WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
    `).get(order.manager_id, tenantId) as any
    if (!employee) return []
    const rules = this.listCommissionRules(tenantId).filter((rule) =>
      (rule.user_id === order.manager_id || rule.user_id === null) &&
      (!rule.rule_type || rule.rule_type === 'personal_sales' || rule.rule_type === 'order_sales'),
    )
    if (rules.length === 0) return []
    const items = this.db.prepare(`
      SELECT i.product_id, i.qty, i.sell_price AS unit_price, i.buy_price AS purchase_price,
             p.brand_id, p.category_id
      FROM customer_order_items i
      LEFT JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
        AND i.item_status <> 'canceled'
    `).all(orderId, tenantId) as any[]
    let total = 0
    for (const item of items) {
      let best: any = null
      let score = -1
      for (const rule of rules) {
        if (rule.brand_id && rule.brand_id !== item.brand_id) continue
        if (rule.category_id && rule.category_id !== item.category_id) continue
        const typeScore = rule.rule_type === 'order_sales' ? 1000 : 0
        const nextScore = typeScore + (rule.user_id ? 100 : 0) + (rule.brand_id ? 10 : 0) + (rule.category_id ? 1 : 0)
        if (nextScore > score) { score = nextScore; best = rule }
      }
      if (!best) continue
      const revenue = money(item.unit_price) * Number(item.qty)
      const profit = (money(item.unit_price) - money(item.purchase_price)) * Number(item.qty)
      total += Math.round(revenue * Number(best.pct_from_revenue ?? 0) / 100)
        + Math.round(profit * Number(best.pct_from_profit ?? 0) / 100)
    }
    if (total <= 0) return []
    const workDate = String(order.updated_at ?? nowIso()).slice(0, 10)
    const timestamp = nowIso()
    try {
      return [this.db.transaction(() => this.insertSalary({
        tenantId, employeeId: employee.id, employeeName: employee.full_name,
        amount: total, type: 'bonus', method: 'cash', period: workDate.slice(0, 7),
        workDate, source: 'commission', note: `Комісія за замовлення #${order.order_number ?? order.id.slice(0, 8)}`,
        shiftId: null, userId: createdBy, timestamp, commissionOrderId: orderId,
      }))]
    } catch (error: any) {
      if (String(error?.message ?? '').includes('UNIQUE constraint failed')) return []
      throw error
    }
  }
  recordSaleCommissions(saleId: string, tenantId = DEFAULT_TENANT_ID, createdBy: string | null = null): any[] {
    const sale = this.db.prepare(`
      SELECT id, sale_number, manager_id, completed_at
      FROM sales WHERE id = ? AND tenant_id = ? AND status = 'completed' AND deleted_at IS NULL
    `).get(saleId, tenantId) as any
    if (!sale?.manager_id) return []
    const employee = this.db.prepare(`
      SELECT id, full_name FROM staff_users
      WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
    `).get(sale.manager_id, tenantId) as any
    if (!employee) return []
    const rules = this.listCommissionRules(tenantId).filter((rule) =>
      (rule.user_id === sale.manager_id || rule.user_id === null) &&
      (!rule.rule_type || ['personal_sales', 'pos_sales', 'tire_service'].includes(rule.rule_type)),
    )
    if (rules.length === 0) return []
    const items = this.db.prepare(`
      SELECT i.product_id, i.qty, i.unit_price, i.purchase_price,
             p.brand_id, p.category_id, p.sku, p.is_service
      FROM sale_items i
      LEFT JOIN products p ON p.id = i.product_id
      WHERE i.sale_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
    `).all(saleId, tenantId) as any[]
    let total = 0
    for (const item of items) {
      let best: any = null
      let score = -1
      for (const rule of rules) {
        const isTireService = String(item.sku ?? '') === 'POS-TIRE-SERVICE'
        const type = String(rule.rule_type ?? 'personal_sales')
        if (isTireService ? !['tire_service', 'pos_sales', 'personal_sales'].includes(type) : !['pos_sales', 'personal_sales'].includes(type)) continue
        if (rule.brand_id && rule.brand_id !== item.brand_id) continue
        if (rule.category_id && rule.category_id !== item.category_id) continue
        const typeScore = isTireService ? (type === 'tire_service' ? 1000 : type === 'pos_sales' ? 500 : 0) : (type === 'pos_sales' ? 1000 : 0)
        const nextScore = typeScore + (rule.user_id ? 100 : 0) + (rule.brand_id ? 10 : 0) + (rule.category_id ? 1 : 0)
        if (nextScore > score) { score = nextScore; best = rule }
      }
      if (!best) continue
      const revenue = money(item.unit_price) * Number(item.qty)
      const profit = (money(item.unit_price) - money(item.purchase_price)) * Number(item.qty)
      total += Math.round(revenue * Number(best.pct_from_revenue ?? 0) / 100)
        + Math.round(profit * Number(best.pct_from_profit ?? 0) / 100)
    }
    if (total <= 0) return []
    const workDate = String(sale.completed_at ?? nowIso()).slice(0, 10)
    const timestamp = nowIso()
    try {
      return [this.db.transaction(() => this.insertSalary({
        tenantId, employeeId: employee.id, employeeName: employee.full_name,
        amount: total, type: 'bonus', method: 'cash', period: workDate.slice(0, 7),
        workDate, source: 'commission', note: `Комісія за продаж (чек #${sale.sale_number})`,
        shiftId: null, userId: createdBy, timestamp, commissionSaleId: saleId,
      }))]
    } catch (error: any) {
      if (String(error?.message ?? '').includes('UNIQUE constraint failed')) return []
      throw error
    }
  }

  private insertSalary(input: {
    tenantId: string; employeeId: string; employeeName: string; amount: number
    type: SalaryType; method: SalaryMethod; period: string; workDate: string; source: string
    note: string | null; shiftId: string | null; userId: string | null; timestamp: string
    commissionSaleId?: string | null; commissionOrderId?: string | null
  }): any {
    let cashOperationId: string | null = null
    if (input.type === 'advance' && input.method === 'cash') {
      if (!input.shiftId) throw new Error('Для виплати готівкою потрібна відкрита касова зміна')
      const shift = this.db.prepare(`
        SELECT id FROM shifts
        WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL LIMIT 1
      `).get(input.shiftId, input.tenantId)
      if (!shift) throw new Error('Касова зміна не відкрита')
      const cash = this.db.prepare(`
        SELECT s.opening_cash + COALESCE(SUM(CASE
          WHEN c.type IN ('sale_cash', 'cash_in') THEN c.amount
          WHEN c.type IN ('return_cash', 'cash_out', 'salary_payout', 'supplier_payment') THEN -c.amount
          ELSE 0 END), 0) AS available
        FROM shifts s
        LEFT JOIN cash_operations c ON c.shift_id = s.id AND c.tenant_id = s.tenant_id AND c.deleted_at IS NULL
        WHERE s.id = ? AND s.tenant_id = ?
        GROUP BY s.id, s.opening_cash
      `).get(input.shiftId, input.tenantId) as { available: number } | undefined
      if (input.amount > money(cash?.available)) throw new Error('У касі недостатньо готівки для цієї виплати')
      cashOperationId = randomUUID()
      this.db.prepare(`
        INSERT INTO cash_operations (
          id, tenant_id, shift_id, user_id, type, source, amount, employee_id, notes,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'salary_payout', 'cashbox', ?, ?, ?, ?, ?, ?)
      `).run(
        cashOperationId, input.tenantId, input.shiftId, input.userId, input.amount,
        input.employeeId, input.note || `Виплата зарплати: ${input.employeeName}`,
        input.timestamp, input.timestamp, input.timestamp,
      )
      this.addOutbox(input.tenantId, 'cash_operation', cashOperationId, 'cash_operation.created', {
        id: cashOperationId, shift_id: input.shiftId, type: 'out', amount: input.amount,
        employee_id: input.employeeId, source: 'cashbox', note: input.note,
      }, input.timestamp)
    }
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO salary_payments (
        id, tenant_id, employee_id, employee_name, amount, type, method, period,
        work_date, source, note, shift_id, cash_operation_id, commission_source_sale_id, commission_source_order_id,
        created_by, dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.tenantId, input.employeeId, input.employeeName, input.amount, input.type,
      input.method, input.period, input.workDate, input.source, input.note, input.shiftId,
      cashOperationId, input.commissionSaleId ?? null, input.commissionOrderId ?? null, input.userId, input.timestamp,
      input.timestamp, input.timestamp,
    )
    const result = this.listSalary({ tenant_id: input.tenantId }).find((item) => item.id === id)
    this.addOutbox(input.tenantId, 'salary_payment', id, 'salary_payment.created', result, input.timestamp)
    return result
  }

  private aggregateSalary(rows: any[]): any[] {
    const map = new Map<string, any>()
    for (const row of rows) {
      const value = map.get(row.employee_id) ?? {
        employee_id: row.employee_id, employee_name: row.employee_name,
        salary: 0, bonus: 0, advance: 0, penalty: 0,
        earned: 0, paid: 0, balance: 0, total: 0,
      }
      value[row.type] += money(row.amount)
      map.set(row.employee_id, value)
    }
    for (const value of map.values()) {
      value.earned = value.salary + value.bonus
      value.paid = value.advance
      value.balance = value.earned - value.paid - value.penalty
      value.total = value.balance
    }
    return [...map.values()]
  }

  private requireUser(id: string, tenantId: string): any {
    const row = this.db.prepare(`
      SELECT id, tenant_id, full_name, role, phone, is_active, base_rate, rate_period
      FROM staff_users
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1
    `).get(id, tenantId) as any
    if (!row) throw new Error('Співробітника не знайдено')
    return row
  }

  private addOutbox(
    tenantId: string, aggregateType: string, aggregateId: string,
    operationType: string, payload: unknown, timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(), tenantId, this.db.deviceId, aggregateType, aggregateId,
      operationType, JSON.stringify(payload), timestamp,
    )
  }
}


