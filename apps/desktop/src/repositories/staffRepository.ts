import { createHash, randomUUID } from 'node:crypto'
import { hashSecret, secretHashNeedsUpgrade, verifySecret } from '../security/secretHash'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { idempotentMutation } from './idempotentMutation'
import { allocateReceiptRevenue } from '../lib/receiptRevenue'
import { stockUnits } from './stockQuantity'
import { LocalProblemRepository } from './problemRepository'
import { legacyCommissionDecisionKey, legacyCommissionReviewKey, planLegacyCommissionReturn } from './legacyCommissionReturn'
import { commissionBasisKey, parseCommissionBasis, returnedCommission, type CommissionBasis, type CommissionLineBasis } from './commissionBasis'

type SalaryType = 'salary' | 'bonus' | 'advance' | 'penalty'
type SalaryMethod = 'cash' | 'card' | 'transfer'
type SalaryFundSource = 'cashbox' | 'owner_funds'

function nowIso(): string { return new Date().toISOString() }
function commissionReversalId(returnId: string, employeeId: string): string {
  const hex = createHash('sha256').update(`commission-reversal:${returnId}:${employeeId}`).digest('hex').slice(0, 32)
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const businessDateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
function businessDate(value: string | Date = new Date()): string {
  const parsed = value instanceof Date ? value : new Date(value)
  return businessDateFormatter.format(Number.isNaN(parsed.getTime()) ? new Date() : parsed)
}
function currentDate(): string { return businessDate() }
function currentPeriod(): string { return currentDate().slice(0, 7) }
function money(value: unknown): number {
  const parsed = Math.round(Number(value ?? 0))
  return Number.isFinite(parsed) ? parsed : 0
}

function localRuleType(rule: any): string {
  return String(rule?.rule_type || 'personal_sales')
}

function localBestRule(rules: any[], userId: string, types: string[], item: any): any | null {
  for (const type of types) {
    let best: any | null = null
    let bestScore = -1
    for (const rule of rules) {
      if (localRuleType(rule) !== type) continue
      if (rule.user_id != null && rule.user_id !== userId) continue
      if (rule.brand_id != null && rule.brand_id !== item.brand_id) continue
      if (rule.category_id != null && rule.category_id !== item.category_id) continue
      const score = (rule.user_id ? 100 : 0) + (rule.brand_id ? 10 : 0) + (rule.category_id ? 1 : 0)
      if (score > bestScore) { best = rule; bestScore = score }
    }
    if (best) return best
  }
  return null
}

function localCommissionBreakdown(
  items: any[],
  rules: any[],
  activeManagerId: string | null,
  context: 'pos' | 'order',
): Map<string, { amount: number; lines: CommissionLineBasis[] }> {
  const result = new Map<string, Map<string, number>>()
  const cashboxUsers = new Set<string>(
    rules.filter((rule) => localRuleType(rule) === 'total_cashbox' && rule.user_id)
      .map((rule) => String(rule.user_id)),
  )
  const add = (userId: string, rule: any, item: any) => {
    const revenue = item.commission_revenue
    const profit = revenue - Math.round(money(item.buy_price) * Number(item.qty))
    const amount = Math.round(revenue * Number(rule.pct_from_revenue ?? 0) / 100)
      + Math.round(profit * Number(rule.pct_from_profit ?? 0) / 100)
    if (!Number.isSafeInteger(amount)) throw new Error('Некоректний розрахунок зарплати')
    const lines = result.get(userId) ?? new Map<string, number>()
    lines.set(item.id, (lines.get(item.id) ?? 0) + amount)
    result.set(userId, lines)
  }
  for (const item of items) {
    if (item.item_status === 'canceled') continue
    if (activeManagerId) {
      const isTireService = context === 'pos' && String(item.sku ?? '') === 'POS-TIRE-SERVICE'
      const types = context === 'order'
        ? ['order_sales', 'personal_sales']
        : isTireService
          ? ['tire_service', 'pos_sales', 'personal_sales']
          : ['pos_sales', 'personal_sales']
      const rule = localBestRule(rules, activeManagerId, types, item)
      if (rule) add(activeManagerId, rule, item)
    }
    for (const userId of cashboxUsers) {
      const rule = localBestRule(rules, userId, ['total_cashbox'], item)
      if (rule) add(userId, rule, item)
    }
  }
  const breakdown = new Map<string, { amount: number; lines: CommissionLineBasis[] }>()
  for (const [userId, lines] of result) {
    const amount = [...lines.values()].reduce((sum, value) => sum + value, 0)
    if (amount <= 0) continue
    // Loss-making lines reduce the receipt's award. Distribute the remaining
    // positive award once, so returning items can never claw back more than paid.
    const allocated = allocateReceiptRevenue(amount, [...lines].filter(([, value]) => value > 0).map(([id, total]) => ({ id, total })))
    breakdown.set(userId, { amount, lines: items.filter(item => allocated.has(item.id)).map(item => ({
      id: item.id, quantity_units: stockUnits(Number(item.qty)), amount: allocated.get(item.id)!,
    })) })
  }
  return breakdown
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
  private readonly pinAttempts = new Map<string, { failures: number; blockedUntil: number }>()
  private readonly passwordAttempts = new Map<string, { failures: number; blockedUntil: number }>()

  constructor(private readonly db: LocalDatabase, private readonly diagnose: (reason: string) => void = () => {}) {}

  listUsers(tenantId = DEFAULT_TENANT_ID, includeArchived = false): any[] {
    return (this.db.prepare(`
      SELECT id, phone, full_name, role, is_active, base_rate, rate_period, created_at, deleted_at
      FROM staff_users
      WHERE tenant_id = ? AND (? = 1 OR deleted_at IS NULL)
      ORDER BY is_active DESC, full_name COLLATE NOCASE ASC
    `).all(tenantId, includeArchived ? 1 : 0) as any[]).map((row) => ({
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
    phone?: string
    full_name: string
    role: string
    is_active?: boolean
    base_rate?: number
    rate_period?: 'day' | 'month'
    created_at?: string
    updated_at?: string
  }, password = '', tenantId = DEFAULT_TENANT_ID): any {
    const id = String(input.id ?? '').trim()
    const fullName = String(input.full_name ?? '').trim()
    const phone = String(input.phone ?? '').trim()
    const noProgramAccess = input.role === 'tire_worker'
    if (!id) throw new Error('Сервер не повернув ідентифікатор співробітника')
    if (!fullName) throw new Error('Вкажіть ім’я співробітника')
    if (!noProgramAccess && !phone) throw new Error('Вкажіть телефон співробітника')
    if (!noProgramAccess && String(password).length < 8) throw new Error('Пароль має містити щонайменше 8 символів')

    const timestamp = nowIso()
    const createdAt = input.created_at || timestamp
    const updatedAt = input.updated_at || timestamp
    const duplicate = (this.db.prepare(`
      SELECT id, phone
      FROM staff_users
      WHERE tenant_id = ? AND id <> ? AND deleted_at IS NULL
    `).all(tenantId, id) as Array<{ id: string; phone: string | null }>)
      .find((candidate) => Boolean(phone) && normalizePhone(candidate.phone ?? '') === normalizePhone(phone))

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
        phone || null,
        input.is_active === false ? 0 : 1,
        money(input.base_rate),
        input.rate_period === 'month' ? 'month' : 'day',
        noProgramAccess ? null : hashSecret(password),
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
    const user = this.requireUser(id, tenantId)
    if (user.role === 'tire_worker') throw new Error('Шиномонтажник не має доступу до програми')
    if (String(password).length < 8) throw new Error('Пароль має містити щонайменше 8 символів')
    this.db.prepare(`
      UPDATE staff_users SET password_hash = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(hashSecret(password), nowIso(), id, tenantId)
    this.passwordAttempts.delete(`${tenantId}:${normalizePhone(user.phone)}`)
    return { success: true }
  }

  updateUser(id: string, input: any, tenantId = DEFAULT_TENANT_ID): any {
    return this.db.transaction(() => this.updateUserInTransaction(id, input, tenantId))
  }

  private updateUserInTransaction(id: string, input: any, tenantId: string): any {
    const current = this.requireUser(id, tenantId)
    const fullName = input.full_name === undefined ? current.full_name : String(input.full_name).trim()
    const role = input.role ?? current.role
    const noProgramAccess = role === 'tire_worker'
    const phone = noProgramAccess ? '' : `+${normalizePhone(input.phone === undefined ? current.phone : String(input.phone))}`
    if (!fullName) throw new Error('Вкажіть ім’я співробітника')
    if (!['owner','admin','manager','cashier','storekeeper','sto_viewer','tire_worker'].includes(role)) throw new Error('Некоректна роль працівника')
    if (!noProgramAccess && !/^\+380\d{9}$/.test(phone)) throw new Error('Невірний формат телефону (+380XXXXXXXXX)')
    if (input.base_rate !== undefined && (!Number.isSafeInteger(input.base_rate) || input.base_rate < 0)) throw new Error('Некоректна ставка')
    if (current.role === 'owner' && (role !== 'owner' || input.is_active === false)) this.requireAnotherOwner(id, tenantId)
    if (phone) {
      const candidates = this.db.prepare(`
        SELECT id, phone FROM staff_users
        WHERE tenant_id = ? AND id <> ? AND deleted_at IS NULL
      `).all(tenantId, id) as Array<{id: string; phone: string | null}>
      const duplicate = candidates.find(row => normalizePhone(row.phone ?? '') === normalizePhone(phone))
      if (duplicate) throw new Error('Співробітник з таким телефоном вже існує')
    }
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE staff_users SET
        full_name = ?, phone = ?, role = ?, is_active = ?, base_rate = ?, rate_period = ?,
        password_hash = CASE WHEN ? = 1 THEN NULL ELSE password_hash END,
        pin_hash = CASE WHEN ? = 1 THEN NULL ELSE pin_hash END,
        dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(
      fullName, phone || null, role,
      input.is_active === undefined ? current.is_active : (input.is_active ? 1 : 0),
      input.base_rate === undefined ? current.base_rate : money(input.base_rate),
      input.rate_period === 'month' ? 'month' : (input.rate_period === 'day' ? 'day' : current.rate_period),
      noProgramAccess ? 1 : 0, noProgramAccess ? 1 : 0,
      timestamp, timestamp, id, tenantId,
    )
    this.addOutbox(tenantId, 'staff_user', id, 'staff_user.updated', {
      id, full_name: fullName, phone: phone || null, role,
      is_active: input.is_active === undefined ? Number(current.is_active) === 1 : Boolean(input.is_active),
      base_rate: input.base_rate === undefined ? money(current.base_rate) : money(input.base_rate),
      rate_period: input.rate_period ?? current.rate_period,
    }, timestamp)
    return this.listUsers(tenantId).find((user) => user.id === id)
  }

  deleteUser(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    return this.db.transaction(() => {
    const current = this.requireUser(id, tenantId)
    if (current.role === 'owner') this.requireAnotherOwner(id, tenantId)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE staff_users SET is_active = 0, deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, timestamp, id, tenantId)
    this.addOutbox(tenantId, 'staff_user', id, 'staff_user.deleted', { id }, timestamp)
    return { ok: true }
    })
  }

  restoreUser(id: string, tenantId = DEFAULT_TENANT_ID): any {
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM staff_users WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any
      if (!current) throw new Error('Працівника не знайдено')
      if (!current.deleted_at) return this.listUsers(tenantId).find(user => user.id === id)
      const phone = normalizePhone(current.phone)
      if (phone && this.listUsers(tenantId).some(user => user.id !== id && normalizePhone(user.phone) === phone)) {
        throw new Error('Цей телефон уже належить іншому працівнику. Змініть його в активній картці перед відновленням.')
      }
      const timestamp = nowIso()
      this.db.prepare('UPDATE staff_users SET deleted_at = NULL, is_active = 1, dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run(timestamp, timestamp, id, tenantId)
      const restored = this.listUsers(tenantId).find(user => user.id === id)
      this.addOutbox(tenantId, 'staff_user', id, 'staff_user.updated', { ...restored, deleted_at: null }, timestamp)
      this.passwordAttempts.delete(`${tenantId}:${phone}`)
      this.pinAttempts.delete(`${tenantId}:${id}`)
      return restored
    })
  }

  private requireAnotherOwner(id: string, tenantId: string): void {
    const other = this.db.prepare("SELECT id FROM staff_users WHERE tenant_id = ? AND id <> ? AND role = 'owner' AND is_active = 1 AND deleted_at IS NULL LIMIT 1").get(tenantId, id)
    if (!other) throw new Error('Не можна вимкнути або видалити останнього власника')
  }

  saveUserSettings(id: string, input: any, rules: any[], tenantId = DEFAULT_TENANT_ID): any {
    if (!Array.isArray(rules) || rules.length > 3) throw new Error('Некоректні правила зарплати')
    const managedTypes = ['personal_sales', 'pos_sales', 'order_sales', 'tire_service']
    const unique = new Set<string>()
    for (const rule of rules) {
      if (!['pos_sales', 'order_sales', 'tire_service'].includes(rule.rule_type) || unique.has(rule.rule_type)) throw new Error('Некоректне або повторне правило зарплати')
      unique.add(rule.rule_type)
      for (const value of [rule.pct_from_revenue, rule.pct_from_profit]) {
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Відсоток має бути від 0 до 100')
      }
    }
    return this.db.transaction(() => {
      const user = this.updateUser(id, input, tenantId)
      for (const old of this.listCommissionRules(tenantId)) {
        if (old.user_id === id && !old.brand_id && !old.category_id && managedTypes.includes(old.rule_type)) this.deleteCommissionRule(old.id, tenantId)
      }
      for (const rule of rules) this.createCommissionRule({ ...rule, user_id: id, brand_id: null, category_id: null }, tenantId)
      return user
    })
  }

  adoptServerAuthenticatedPassword(
    serverUserId: string,
    phone: string,
    password: string,
    tenantId = DEFAULT_TENANT_ID,
  ): any {
    const normalizedPhone = normalizePhone(phone)
    const row = this.db.prepare(`
      SELECT id, phone, role, is_active
      FROM staff_users
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(serverUserId, tenantId) as { id: string; phone: string | null; role: string; is_active: number } | undefined

    if (!row || row.role === 'tire_worker' || Number(row.is_active) !== 1 || normalizePhone(row.phone ?? '') !== normalizedPhone) {
      throw new Error('Обліковий запис сервера не відповідає локальному співробітнику')
    }
    if (!password) throw new Error('Пароль не може бути порожнім')

    this.db.prepare(`
      UPDATE staff_users SET password_hash = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(hashSecret(password), nowIso(), row.id, tenantId)

    return this.loginWithPassword(phone, password, tenantId)
  }

  loginWithPassword(phone: string, password: string, tenantId = DEFAULT_TENANT_ID): any {
    const normalizedPhone = normalizePhone(phone)
    const attemptKey = `${tenantId}:${normalizedPhone}`
    const attempt = this.passwordAttempts.get(attemptKey)
    if (attempt && attempt.blockedUntil > Date.now()) {
      throw new Error('Забагато спроб входу. Спробуйте через 15 хвилин')
    }

    const row = (this.db.prepare(`
      SELECT id, tenant_id, full_name, role, phone, password_hash, is_active, created_at, updated_at, deleted_at
      FROM staff_users
      WHERE tenant_id = ?
      ORDER BY (deleted_at IS NULL) DESC, is_active DESC, updated_at DESC
    `).all(tenantId) as any[]).find((candidate) => normalizePhone(candidate.phone) === normalizedPhone)

    if (row?.deleted_at) { this.diagnose('account-archived'); throw new Error('[LOCAL_AUTH_ARCHIVED] Працівника видалено. Власник може відновити його в архіві команди.') }
    if (row && Number(row.is_active) !== 1) { this.diagnose('account-disabled'); throw new Error('[LOCAL_AUTH_DISABLED] Доступ працівника вимкнено. Зверніться до власника.') }
    if (row?.role === 'tire_worker' && normalizedPhone) { this.diagnose('role-no-access'); throw new Error('[LOCAL_AUTH_DISABLED] Шиномонтажник не має доступу до програми') }
    if (row && row.role !== 'tire_worker' && !row.password_hash) { this.diagnose('local-credentials-missing'); throw new Error('[LOCAL_AUTH_MISSING] На цьому ПК ще немає пароля працівника. Для першого входу потрібен інтернет.') }
    const valid = Boolean(
      row
      && Number(row.is_active) === 1
      && row.role !== 'tire_worker'
      && row.password_hash
      && verifySecret(row.password_hash, password, row.id),
    )
    if (!valid) {
      this.diagnose(row ? 'password-mismatch' : 'account-not-found')
      const failures = (attempt?.failures ?? 0) + 1
      this.passwordAttempts.set(attemptKey, {
        failures: failures >= 10 ? 0 : failures,
        blockedUntil: failures >= 10 ? Date.now() + 15 * 60_000 : 0,
      })
      throw new Error(failures >= 10
        ? 'Забагато спроб входу. Спробуйте через 15 хвилин'
        : 'Невірний номер телефону або пароль')
    }

    this.passwordAttempts.delete(attemptKey)
    this.diagnose('login-ok')
    if (secretHashNeedsUpgrade(row.password_hash)) {
      this.db.prepare(`
        UPDATE staff_users SET password_hash = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).run(hashSecret(password), nowIso(), row.id, tenantId)
    }

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
    const user = this.requireUser(userId, tenantId)
    if (user.role === 'tire_worker') throw new Error('Шиномонтажник не має доступу до програми')
    if (!/^\d{4}$/.test(pin)) throw new Error('PIN-код має складатися з 4 цифр')
    const timestamp = nowIso()
    const pinHash = hashSecret(pin)
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE staff_users SET pin_hash = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(pinHash, timestamp, userId, tenantId)
      this.addOutbox(tenantId, 'staff_pin', userId, 'staff_pin.updated', {
        user_id: userId,
        pin_hash: pinHash,
        updated_at: timestamp,
      }, timestamp)
      return { success: true }
    })
  }
  verifyPin(userId: string, pin: string, tenantId = DEFAULT_TENANT_ID): { valid: boolean; error?: string } {
    if (!/^\d{4}$/.test(pin)) return { valid: false }
    const attemptKey = `${tenantId}:${userId}`
    const attempt = this.pinAttempts.get(attemptKey)
    if (attempt && attempt.blockedUntil > Date.now()) {
      return { valid: false, error: 'Забагато спроб. Спробуйте через 5 хвилин' }
    }

    const row = this.db.prepare(`
      SELECT pin_hash, role FROM staff_users
      WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL LIMIT 1
    `).get(userId, tenantId) as { pin_hash: string | null; role: string } | undefined
    if (!row) return { valid: false, error: 'Співробітника не знайдено' }
    if (row.role === 'tire_worker') return { valid: false, error: 'Шиномонтажник не має доступу до програми' }
    if (!row.pin_hash) return { valid: false, error: 'PIN-код не налаштовано' }

    const valid = verifySecret(row.pin_hash, pin, userId)
    if (valid) {
      this.pinAttempts.delete(attemptKey)
      if (secretHashNeedsUpgrade(row.pin_hash)) this.setPin(userId, pin, tenantId)
      return { valid: true }
    }

    const failures = (attempt?.failures ?? 0) + 1
    this.pinAttempts.set(attemptKey, {
      failures: failures >= 5 ? 0 : failures,
      blockedUntil: failures >= 5 ? Date.now() + 5 * 60_000 : 0,
    })
    return {
      valid: false,
      ...(failures >= 5 ? { error: 'Забагато спроб. Спробуйте через 5 хвилин' } : {}),
    }
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
    return this.db.transaction(() => this.createCommissionRuleInTransaction(input, tenantId))
  }

  private createCommissionRuleInTransaction(input: any, tenantId: string): any {
    const revenue = Number(input.pct_from_revenue ?? 0)
    const profit = Number(input.pct_from_profit ?? 0)
    if (!Number.isFinite(revenue) || !Number.isFinite(profit) || revenue < 0 || revenue > 100 || profit < 0 || profit > 100) throw new Error('Відсоток має бути від 0 до 100')
    if (input.user_id) {
      const employee = this.requireUser(input.user_id, tenantId)
      if (employee.role === 'owner') throw new Error('Власник не входить до зарплатної відомості працівників')
    }
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
    return this.db.transaction(() => {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE commission_rules SET deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(timestamp, timestamp, timestamp, id, tenantId)
    if (Number(result.changes) === 0) throw new Error('Правило комісії не знайдено')
    this.addOutbox(tenantId, 'commission_rule', id, 'commission_rule.deleted', { id }, timestamp)
    return { ok: true }
    })
  }

  listSalary(input: { tenant_id?: string; period?: string; employee_id?: string; page?: number; per_page?: number } = {}, unlimited = false): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const params: Array<string | number | null> = [tenantId]
    let where = ''
    if (input.period) { where += ' AND period = ?'; params.push(input.period) }
    if (input.employee_id) { where += ' AND employee_id = ?'; params.push(input.employee_id) }
    if (!unlimited) {
      const size = Number(input.per_page ?? 200), page = Number(input.page ?? 1)
      if (!Number.isSafeInteger(size) || size < 1 || size > 500 || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new Error('Некоректна сторінка історії зарплати')
      params.push(size, (page - 1) * size)
    }
    return this.db.prepare(`
      SELECT id, employee_id, employee_name, amount, type, method, period, note,
             work_date, source, shift_id, cash_operation_id, created_at
      FROM salary_payments
      WHERE tenant_id = ? AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM staff_users owner
          WHERE owner.id = salary_payments.employee_id
            AND owner.tenant_id = salary_payments.tenant_id
            AND owner.role = 'owner' AND owner.deleted_at IS NULL
        )
    ` + where + ' ORDER BY created_at DESC, id DESC' + (unlimited ? '' : ' LIMIT ? OFFSET ?')).all(...params) as any[]
  }

  salarySummary(period = currentPeriod(), tenantId = DEFAULT_TENANT_ID): any[] {
    return this.aggregateSalary(this.listSalary({ tenant_id: tenantId, period }, true))
  }

  dailySummary(workDate = currentDate(), tenantId = DEFAULT_TENANT_ID): any[] {
    const rows = this.db.prepare(`
      SELECT employee_id, employee_name, amount, type
      FROM salary_payments
      WHERE tenant_id = ? AND work_date = ? AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM staff_users owner
          WHERE owner.id = salary_payments.employee_id
            AND owner.tenant_id = salary_payments.tenant_id
            AND owner.role = 'owner' AND owner.deleted_at IS NULL
        )
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

  tireServiceReport(workDate = currentDate(), tenantId = DEFAULT_TENANT_ID): any {
    const workers = this.db.prepare(`
      SELECT id AS employee_id, full_name AS employee_name, base_rate, rate_period
      FROM staff_users
      WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL AND role = 'tire_worker'
      ORDER BY full_name COLLATE NOCASE
    `).all(tenantId) as any[]
    const salaryRows = this.db.prepare(`
      SELECT employee_id,
        COALESCE(SUM(CASE WHEN type IN ('salary','bonus') THEN amount ELSE 0 END), 0) AS earned,
        COALESCE(SUM(CASE WHEN type = 'advance' THEN amount ELSE 0 END), 0) AS paid,
        COALESCE(SUM(CASE WHEN type = 'penalty' THEN amount ELSE 0 END), 0) AS penalty,
        COALESCE(SUM(CASE WHEN source IN ('commission','commission_reversal') THEN amount ELSE 0 END), 0) AS commission_earned,
        COALESCE(SUM(CASE WHEN source = 'daily_rate' THEN amount ELSE 0 END), 0) AS daily_rate
      FROM salary_payments
      WHERE tenant_id = ? AND work_date = ? AND deleted_at IS NULL
      GROUP BY employee_id
    `).all(tenantId, workDate) as any[]
    const salaryByWorker = new Map(salaryRows.map((row) => [String(row.employee_id), row]))
    const salaryOperations = this.db.prepare(`
      SELECT p.id, p.employee_id, p.type, p.source, p.amount, p.method, p.note,
        p.work_date, p.created_at, p.created_by, p.commission_source_sale_id AS sale_id,
        u.full_name AS cashier_name, c.source AS fund_source
      FROM salary_payments p
      JOIN staff_users employee ON employee.id = p.employee_id AND employee.tenant_id = p.tenant_id AND employee.role = 'tire_worker'
      LEFT JOIN staff_users u ON u.id = p.created_by AND u.tenant_id = p.tenant_id
      LEFT JOIN cash_operations c ON c.id = p.cash_operation_id AND c.tenant_id = p.tenant_id
      WHERE p.tenant_id = ? AND p.work_date = ? AND p.deleted_at IS NULL
      ORDER BY p.created_at, p.id
    `).all(tenantId, workDate) as any[]
    const candidateReceipts = this.db.prepare(`
      SELECT sale.id, sale.sale_number, sale.completed_at, sale.manager_id AS employee_id,
        sale.payment_method, sale.total, sale.cash_amount, sale.notes, sale.cashier_id,
        cashier.full_name AS cashier_name,
        json_group_array(json_object('id', item.id, 'description', COALESCE(NULLIF(item.description, ''), product.name, 'Послуги шиномонтажу'),
          'qty', item.qty, 'unit_price', item.unit_price, 'total', item.total)) AS services_json,
        COALESCE(SUM(item.qty), 0) AS services_qty,
        COALESCE(SUM(item.total), 0) AS service_revenue
      FROM sales sale
      JOIN sale_items item ON item.sale_id = sale.id AND item.tenant_id = sale.tenant_id AND item.deleted_at IS NULL
      LEFT JOIN products product ON product.id = item.product_id AND product.tenant_id = item.tenant_id
      LEFT JOIN staff_users cashier ON cashier.id = sale.cashier_id AND cashier.tenant_id = sale.tenant_id
      WHERE sale.tenant_id = ? AND sale.status = 'completed' AND sale.deleted_at IS NULL
        AND sale.manager_id IS NOT NULL
        AND COALESCE(NULLIF(item.sku, ''), product.sku, '') = 'POS-TIRE-SERVICE'
        AND datetime(sale.completed_at) >= datetime(?, '-1 day')
        AND datetime(sale.completed_at) < datetime(?, '+2 day')
      GROUP BY sale.id
      ORDER BY datetime(sale.completed_at), sale.id
    `).all(tenantId, workDate, workDate) as any[]
    const workerNames = new Map(workers.map((worker) => [String(worker.employee_id), String(worker.employee_name)]))
    const receipts = candidateReceipts
      .filter((row) => businessDate(String(row.completed_at)) === workDate && workerNames.has(String(row.employee_id)))
      .map((row) => {
        const serviceRevenue = money(row.service_revenue)
        const saleTotal = money(row.total)
        const cashAmount = row.payment_method === 'cash'
          ? money(row.cash_amount) || saleTotal
          : money(row.cash_amount)
        const cashRevenue = saleTotal > 0 ? Math.min(serviceRevenue, Math.round(serviceRevenue * cashAmount / saleTotal)) : 0
        return {
          id: row.id, sale_number: row.sale_number, completed_at: row.completed_at,
          employee_id: row.employee_id, employee_name: workerNames.get(String(row.employee_id)) ?? 'Шиномонтажник',
          services_qty: Number(row.services_qty ?? 0), service_revenue: serviceRevenue,
          cash_revenue: cashRevenue, payment_method: row.payment_method, total: saleTotal,
          cashier_id: row.cashier_id, cashier_name: row.cashier_name ?? null, notes: row.notes ?? null,
          services: JSON.parse(row.services_json),
          commission_earned: salaryOperations.filter(operation => operation.sale_id === row.id
            && operation.employee_id === row.employee_id && operation.source === 'commission')
            .reduce((sum, operation) => sum + money(operation.amount), 0),
        }
      })
    const handovers = this.db.prepare(`
      SELECT employee_id, COALESCE(SUM(amount), 0) AS amount
      FROM cash_operations
      WHERE tenant_id = ? AND type = 'cash_in' AND source = 'cashbox' AND work_date = ?
        AND employee_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY employee_id
    `).all(tenantId, workDate) as any[]
    const handedByWorker = new Map(handovers.map((row) => [String(row.employee_id), money(row.amount)]))
    const cashHandovers = this.db.prepare(`
      SELECT c.id, c.employee_id, c.amount, c.work_date, c.created_at, c.notes AS note,
        c.user_id AS created_by, u.full_name AS cashier_name
      FROM cash_operations c
      JOIN staff_users employee ON employee.id = c.employee_id AND employee.tenant_id = c.tenant_id AND employee.role = 'tire_worker'
      LEFT JOIN staff_users u ON u.id = c.user_id AND u.tenant_id = c.tenant_id
      WHERE c.tenant_id = ? AND c.type = 'cash_in' AND c.source = 'cashbox' AND c.work_date = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at, c.id
    `).all(tenantId, workDate)
    const availableOn = new Date(`${workDate}T12:00:00Z`)
    availableOn.setUTCDate(availableOn.getUTCDate() + 2)
    const salaryAvailableOn = availableOn.toISOString().slice(0, 10)
    const matured = currentDate() >= salaryAvailableOn
    const data = workers.map((worker) => {
      const salary = salaryByWorker.get(String(worker.employee_id)) ?? {}
      const workerReceipts = receipts.filter((receipt) => receipt.employee_id === worker.employee_id)
      const serviceRevenue = workerReceipts.reduce((sum, receipt) => sum + receipt.service_revenue, 0)
      const cashRevenue = workerReceipts.reduce((sum, receipt) => sum + receipt.cash_revenue, 0)
      const cashHandedOver = handedByWorker.get(String(worker.employee_id)) ?? 0
      const cashPending = Math.max(0, cashRevenue - cashHandedOver)
      const recordedDailyRate = money(salary.daily_rate)
      const projectedDailyRate = recordedDailyRate === 0 && worker.rate_period === 'day' && workerReceipts.length > 0
        ? money(worker.base_rate)
        : 0
      const earned = money(salary.earned) + projectedDailyRate
      const paid = money(salary.paid)
      const penalty = money(salary.penalty)
      const balance = earned - paid - penalty
      const due = Math.max(0, balance)
      const salaryReady = matured && cashPending === 0
      return {
        employee_id: worker.employee_id, employee_name: worker.employee_name,
        services_qty: workerReceipts.reduce((sum, receipt) => sum + receipt.services_qty, 0),
        service_revenue: serviceRevenue, cash_revenue: cashRevenue, cash_handed_over: cashHandedOver, cash_pending: cashPending,
        commission_earned: money(salary.commission_earned), daily_rate: recordedDailyRate + projectedDailyRate,
        daily_rate_projected: projectedDailyRate,
        earned, paid, penalty, balance, due, salary_available_on: salaryAvailableOn,
        salary_ready: salaryReady, payable_due: salaryReady ? due : 0,
      }
    })
    return {
      data, receipts, salary_operations: salaryOperations, cash_handovers: cashHandovers, details_version: 1, date: workDate, totals: {
        services_qty: data.reduce((sum, row) => sum + row.services_qty, 0),
        service_revenue: data.reduce((sum, row) => sum + row.service_revenue, 0),
        cash_revenue: data.reduce((sum, row) => sum + row.cash_revenue, 0),
        cash_handed_over: data.reduce((sum, row) => sum + row.cash_handed_over, 0),
        cash_pending: data.reduce((sum, row) => sum + row.cash_pending, 0),
        due: data.reduce((sum, row) => sum + row.due, 0),
        payable_due: data.reduce((sum, row) => sum + row.payable_due, 0),
      },
    }
  }

  tireCashHandover(input: {
    tenant_id?: string; employee_id: string; employee_name?: string; work_date: string
    shift_id: string; amount: number; operation_id: string; user_id?: string | null
  }): { amount: number; remaining: number } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('Вкажіть коректну суму внесення')
    if (typeof input.operation_id !== 'string' || !input.operation_id.trim()) throw new Error('Відсутній номер операції внесення')
    return idempotentMutation(this.db, 'tire-handover:' + tenantId, input.operation_id, input,
      () => this.tireCashHandoverInTransaction(input, tenantId))
  }

  private tireCashHandoverInTransaction(input: Parameters<LocalStaffRepository['tireCashHandover']>[0], tenantId: string): { amount: number; remaining: number } {
    const amount = input.amount
    // Upgrade replay safety without posting a second copy of a pre-upgrade handover.
    const existing = this.db.prepare('SELECT * FROM cash_operations WHERE id = ? LIMIT 1').get(input.operation_id) as any
    if (existing) {
      if (existing.tenant_id !== tenantId || existing.type !== 'cash_in' || existing.source !== 'cashbox'
        || existing.employee_id !== input.employee_id || existing.work_date !== input.work_date
        || existing.shift_id !== input.shift_id || existing.user_id !== (input.user_id ?? null)
        || Number(existing.amount) !== amount || existing.deleted_at) {
        throw new Error('Ідентифікатор внесення вже використано іншою операцією')
      }
      const row = this.tireServiceReport(input.work_date, tenantId).data
        .find((item: any) => item.employee_id === input.employee_id)
      return { amount, remaining: money(row?.cash_pending) }
    }
    const employee = this.requireUser(input.employee_id, tenantId)
    if (employee.role !== 'tire_worker') throw new Error('Оберіть шиномонтажника')
    const shift = this.db.prepare(`
      SELECT id, cashier_id FROM shifts WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL LIMIT 1
    `).get(input.shift_id, tenantId) as { id: string; cashier_id: string } | undefined
    if (!shift) throw new Error('Спочатку відкрийте касову зміну')
    if (input.user_id && shift.cashier_id !== input.user_id) throw new Error('Операція доступна тільки у власній касовій зміні')
    const report = this.tireServiceReport(input.work_date, tenantId)
    const row = report.data.find((item: any) => item.employee_id === input.employee_id)
    const pending = money(row?.cash_pending)
    if (pending <= 0) throw new Error('Каса за цей день уже внесена')
    if (amount > pending) throw new Error(`Залишилось внести ${(pending / 100).toFixed(2)} грн`)
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO cash_operations (
          id, tenant_id, shift_id, user_id, type, source, amount, employee_id, work_date, notes,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'cash_in', 'cashbox', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.operation_id, tenantId, input.shift_id, input.user_id ?? null, amount, employee.id, input.work_date,
        `Каса шиномонтажу за ${input.work_date}: ${input.employee_name || employee.full_name}`,
        timestamp, timestamp, timestamp,
      )
      this.addOutbox(tenantId, 'cash_operation', input.operation_id, 'cash_operation.created', {
        id: input.operation_id, shift_id: input.shift_id, type: 'in', amount, source: 'cashbox',
        employee_id: employee.id, work_date: input.work_date, user_id: input.user_id ?? null,
        note: `Каса шиномонтажу за ${input.work_date}: ${input.employee_name || employee.full_name}`,
        created_at: timestamp,
      }, timestamp)
    })
    return { amount, remaining: Math.max(0, pending - amount) }
  }
  createSalary(input: {
    operation_id?: string
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
    if (input.operation_id) return idempotentMutation(this.db, 'salary:' + (input.tenant_id ?? DEFAULT_TENANT_ID), input.operation_id, input, () => this.createSalary({ ...input, operation_id: undefined }))
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const employee = this.requireUser(input.employee_id, tenantId)
    if (employee.role === 'owner') throw new Error('Власник не входить до зарплатної відомості працівників')
    const amount = money(input.amount)
    if (!Number.isSafeInteger(input.amount) || amount <= 0) throw new Error('Вкажіть коректну суму')
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
    operation_id?: string
    tenant_id?: string
    employee_id: string
    employee_name?: string
    method: SalaryMethod
    fund_source?: SalaryFundSource
    shift_id?: string | null
    work_date: string
    user_id?: string | null
  }): { payment: any; amount: number; earned: number; previously_paid: number; penalty: number } {
    if (input.operation_id) return idempotentMutation(this.db, 'daily-salary:' + (input.tenant_id ?? DEFAULT_TENANT_ID), input.operation_id, input,
      () => this.dailyPayout({ ...input, operation_id: undefined }))
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const employee = this.requireUser(input.employee_id, tenantId)
    if (employee.role === 'owner') throw new Error('Власник не входить до зарплатної відомості працівників')
    if (employee.role === 'tire_worker') {
      const tireRow = this.tireServiceReport(input.work_date, tenantId).data
        .find((row: any) => row.employee_id === employee.id)
      if (!tireRow?.salary_ready) {
        if (money(tireRow?.cash_pending) > 0) throw new Error('Спочатку внесіть усю готівкову касу шиномонтажу за цей день')
        throw new Error(`Зарплата стане доступною ${tireRow?.salary_available_on ?? ''}`)
      }
    }
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
        userId: input.user_id ?? null, timestamp, fundSource: input.fund_source ?? 'cashbox',
      })
      return { payment, amount, earned, previously_paid: paid, penalty }
    })
  }

  deleteSalary(id: string, tenantId = DEFAULT_TENANT_ID): { success: true } {
    return this.db.transaction(() => this.deleteSalaryInTransaction(id, tenantId))
  }

  private deleteSalaryInTransaction(id: string, tenantId: string): { success: true } {
    const row = this.db.prepare(`
      SELECT id,employee_id,employee_name,amount,type,method,period,work_date,source,note,shift_id,cash_operation_id,
             commission_source_sale_id,commission_source_order_id,commission_source_return_id,created_by,created_at FROM salary_payments
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1
    `).get(id, tenantId) as Record<string, any> | undefined
    if (!row) throw new Error('Операцію не знайдено')
    if (row.source !== 'manual') {
      throw new Error('Автоматичне нарахування не можна видалити; виправте джерело операції')
    }
    if (row.cash_operation_id && !this.db.prepare(`
      SELECT c.id FROM cash_operations c
      JOIN shifts s ON s.id = c.shift_id AND s.tenant_id = c.tenant_id
      WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
        AND s.status = 'open' AND s.deleted_at IS NULL
    `).get(row.cash_operation_id, tenantId)) {
      throw new Error('Виплату із закритої касової зміни не можна видалити. Історію та підсумок каси збережено.')
    }
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
      this.addOutbox(tenantId, 'salary_payment', id, 'salary_payment.deleted', { id, deleted_payment: row }, timestamp)
    })
    return { success: true }
  }

  recordOrderCommissions(orderId: string, tenantId = DEFAULT_TENANT_ID, createdBy: string | null = null): any[] {
    const order = this.db.prepare(`
      SELECT sale_id FROM customer_orders
      WHERE id = ? AND tenant_id = ? AND status = 'completed' AND deleted_at IS NULL
    `).get(orderId, tenantId) as { sale_id: string | null } | undefined
    // The issued receipt is the immutable source for both orders and POS.
    return order?.sale_id ? this.recordSaleCommissions(order.sale_id, tenantId, createdBy) : []
  }

  recordSaleCommissions(saleId: string, tenantId = DEFAULT_TENANT_ID, createdBy: string | null = null): any[] {
    return this.db.transaction(() => this.recordSaleCommissionsInTransaction(saleId, tenantId, createdBy))
  }

  private recordSaleCommissionsInTransaction(saleId: string, tenantId: string, createdBy: string | null): any[] {
    const key = commissionBasisKey(tenantId, saleId)
    if (this.db.prepare('SELECT key FROM app_meta WHERE key=?').get(key)) return []
    const sale = this.db.prepare(`
      SELECT id, sale_number, manager_id, completed_at, total
      FROM sales WHERE id = ? AND tenant_id = ? AND status = 'completed' AND deleted_at IS NULL
    `).get(saleId, tenantId) as any
    if (!sale) return []
    const order = this.db.prepare(`
      SELECT id, manager_id FROM customer_orders
      WHERE sale_id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1
    `).get(saleId, tenantId) as any
    // A pre-upgrade award must never be rebuilt using today's percentages.
    const existing = this.db.prepare(`
      SELECT id FROM salary_payments
      WHERE tenant_id=? AND source='commission' AND deleted_at IS NULL
        AND (commission_source_sale_id=? OR (? IS NOT NULL AND commission_source_order_id=?))
      LIMIT 1
    `).get(tenantId, saleId, order?.id ?? null, order?.id ?? null)
    if (existing) return []
    const items = this.db.prepare(`
      SELECT i.id, i.product_id, i.qty, i.unit_price AS sell_price, i.purchase_price AS buy_price,
             i.total, i.core_deposit_amount, p.brand_id, p.category_id, COALESCE(NULLIF(i.sku,''),p.sku) AS sku
      FROM sale_items i
      LEFT JOIN products p ON p.id = i.product_id AND p.tenant_id = i.tenant_id
      WHERE i.sale_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
      ORDER BY i.id
    `).all(saleId, tenantId) as any[]
    const net = allocateReceiptRevenue(money(sale.total), items.map(item => ({
      id: item.id, total: money(item.total), coreTotal: Math.round(money(item.core_deposit_amount) * Number(item.qty)),
    })))
    for (const item of items) item.commission_revenue = Math.max(0,
      net.get(item.id)! - Math.round(money(item.core_deposit_amount) * Number(item.qty)))
    const commissions = localCommissionBreakdown(items, this.listCommissionRules(tenantId), order?.manager_id ?? sale.manager_id ?? null, order ? 'order' : 'pos')
    const workDate = businessDate(String(sale.completed_at ?? nowIso())), timestamp = nowIso()
    const basis: CommissionBasis = { version: 1, tenant_id: tenantId, sale_id: saleId, employees: [] }
    const created: any[] = []
    for (const [employeeId, allocation] of commissions) {
      const employee = this.db.prepare(`
        SELECT id, full_name, role FROM staff_users
        WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
      `).get(employeeId, tenantId) as any
      if (!employee || employee.role === 'owner') continue
      const payment = this.insertSalary({
        tenantId, employeeId, employeeName: employee.full_name, amount: allocation.amount,
        type: 'bonus', method: 'cash', period: workDate.slice(0, 7), workDate,
        source: 'commission', note: `Комісія за продаж (чек #${sale.sale_number})`,
        shiftId: null, userId: createdBy, timestamp, commissionSaleId: saleId, commissionOrderId: order?.id ?? null,
      })
      created.push(payment)
      basis.employees.push({ employee_id: employeeId, payment_id: payment.id, amount: allocation.amount, lines: allocation.lines })
    }
    // Also persist a zero award: adding a rule tomorrow cannot change this sale.
    this.db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES (?,?,?)').run(key, JSON.stringify(basis), timestamp)
    return created
  }

  recordReturnCommissionReversals(
    returnId: string,
    saleId: string,
    _returnedItems: Array<{ product_id: string; sale_item_id: string; quantity: number }>,
    tenantId = DEFAULT_TENANT_ID,
    createdBy: string | null = null,
  ): any[] {
    const sale = this.db.prepare(`
      SELECT id, sale_number FROM sales
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1
    `).get(saleId, tenantId) as { id: string; sale_number: string } | undefined
    if (!sale) return []
    const saved = this.db.prepare('SELECT value_json FROM app_meta WHERE key=?')
      .get(commissionBasisKey(tenantId, saleId)) as { value_json: string } | undefined
    if (saved) return this.reverseSavedCommissions(returnId, saleId, saved.value_json, tenantId, createdBy)
    return this.reverseLegacyCommissions(returnId, sale, tenantId, createdBy)
  }

  private reverseLegacyCommissions(returnId: string, sale: { id: string; sale_number: string }, tenantId: string, createdBy: string | null): any[] {
    return this.db.transaction(() => {
      const returned = this.db.prepare(`
        SELECT created_at FROM customer_returns
        WHERE id=? AND sale_id=? AND tenant_id=? AND status='completed' AND deleted_at IS NULL
      `).get(returnId, sale.id, tenantId) as { created_at: string } | undefined
      if (!returned) throw new Error('Повернення для сторно зарплати не знайдено')
      const decisionKey = legacyCommissionDecisionKey(tenantId, returnId)
      if (this.db.prepare('SELECT key FROM app_meta WHERE key=?').get(decisionKey)) return []
      const relatedOrders = new Set((this.db.prepare(`
        SELECT id FROM customer_orders WHERE tenant_id=? AND sale_id=?
      `).all(tenantId, sale.id) as Array<{ id: string }>).map(row => row.id))
      const awards = this.db.prepare(`
        SELECT p.* FROM salary_payments p WHERE p.tenant_id=? AND p.source='commission'
          AND (p.commission_source_sale_id=? OR EXISTS (
            SELECT 1 FROM customer_orders o WHERE o.tenant_id=p.tenant_id
              AND o.id=p.commission_source_order_id AND o.sale_id=?
          ))
      `).all(tenantId, sale.id, sale.id) as any[]
      const reversals = this.db.prepare(`
        SELECT p.*, r.sale_id returned_sale_id, r.status returned_status, r.deleted_at returned_deleted_at
        FROM salary_payments p
        LEFT JOIN customer_returns r ON r.id=p.commission_source_return_id AND r.tenant_id=p.tenant_id
        WHERE p.tenant_id=? AND p.source='commission_reversal'
          AND (p.commission_source_sale_id=? OR r.sale_id=?)
      `).all(tenantId, sale.id, sale.id) as any[]
      // A completed historical operation must not be recalculated on a direct retry.
      if (reversals.some(row => row.commission_source_return_id === returnId)) return []
      const lines = this.db.prepare(`
        SELECT id,qty,deleted_at FROM sale_items WHERE tenant_id=? AND sale_id=?
      `).all(tenantId, sale.id) as Array<{ id: string; qty: number; deleted_at: string | null }>
      const quantities = this.db.prepare(`
        SELECT i.sale_item_id,SUM(i.quantity) quantity FROM customer_return_items i
        JOIN customer_returns r ON r.id=i.return_id AND r.tenant_id=i.tenant_id
        WHERE r.tenant_id=? AND r.sale_id=? AND r.status='completed'
          AND r.deleted_at IS NULL AND i.deleted_at IS NULL GROUP BY i.sale_item_id
      `).all(tenantId, sale.id) as Array<{ sale_item_id: string; quantity: number }>
      const reviewKey = legacyCommissionReviewKey(tenantId, sale.id)
      const plan = planLegacyCommissionReturn({
        manualReview: !!this.db.prepare('SELECT key FROM app_meta WHERE key=?').get(reviewKey),
        awards: awards.map(row => ({ ...row, valid_source:
          (!row.commission_source_sale_id || row.commission_source_sale_id === sale.id)
          && (!row.commission_source_order_id || relatedOrders.has(row.commission_source_order_id)) })),
        reversals: reversals.map(row => ({ ...row, valid_source:
          (!row.commission_source_sale_id || row.commission_source_sale_id === sale.id)
          && row.returned_sale_id === sale.id && row.returned_status === 'completed' && !row.returned_deleted_at })),
        lines, returned: quantities,
      })
      const timestamp = nowIso(), created: any[] = []
      if (plan.kind === 'review') {
        // Sticky per receipt: closing a journal message does not prove that a
        // manual payroll correction was (or was not) made. Never deduct it twice.
        this.db.prepare('INSERT OR IGNORE INTO app_meta(key,value_json,updated_at) VALUES (?,?,?)')
          .run(reviewKey, JSON.stringify({ version: 1, sale_id: sale.id, first_return_id: returnId, reason: plan.reason }), timestamp)
        const code = 'salary.legacy_commission_review'
        new LocalProblemRepository(this.db).record({
          tenant_id: tenantId, source: 'app', code, severity: 'warning',
          title: `Чек #${String(sale.sale_number).slice(0, 64)}: перевірити зарплату за поверненням`,
          detail: 'legacy commission review', entity_type: 'customer_return', entity_id: returnId,
        })
        // This is an accounting follow-up, not optional telemetry. A technical
        // failure to save it must roll back, never leave an untracked refund.
        if (!this.db.prepare(`SELECT id FROM problem_log WHERE tenant_id=? AND source='app'
          AND code=? AND entity_type='customer_return' AND entity_id=? AND resolved_at IS NULL`)
          .get(tenantId, code, returnId)) {
          throw new Error('Не вдалося зберегти позначку перевірки зарплати. Повернення не проведено; спробуйте ще раз.')
        }
      } else if (plan.kind === 'exact') {
        const workDate = businessDate(returned.created_at)
        for (const { original, amount } of plan.corrections) {
          created.push(this.insertSalary({
            tenantId, employeeId: original.employee_id, employeeName: original.employee_name,
            amount: -amount, type: 'bonus', method: 'cash', period: workDate.slice(0, 7), workDate,
            source: 'commission_reversal', note: 'Сторно за початковим нарахуванням старого чека',
            shiftId: null, userId: createdBy, timestamp, commissionReturnId: returnId, commissionSaleId: sale.id,
            id: commissionReversalId(returnId, original.employee_id),
          }))
        }
      }
      this.db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES (?,?,?)').run(decisionKey,
        JSON.stringify({ version: 1, sale_id: sale.id, return_id: returnId, outcome: plan.kind,
          reason: plan.kind === 'review' ? plan.reason : null, salary_ids: created.map(row => row.id) }), timestamp)
      return created
    })
  }

  private reverseSavedCommissions(returnId: string, saleId: string, raw: string, tenantId: string, createdBy: string | null): any[] {
    return this.db.transaction(() => {
      const basis = parseCommissionBasis(raw, tenantId, saleId)
      const returned = this.db.prepare(`
        SELECT id, created_at FROM customer_returns
        WHERE id=? AND sale_id=? AND tenant_id=? AND status='completed' AND deleted_at IS NULL
      `).get(returnId, saleId, tenantId) as { created_at: string } | undefined
      if (!returned) throw new Error('Повернення для сторно зарплати не знайдено')
      const originals = this.db.prepare(`
        SELECT id, employee_id, amount, employee_name FROM salary_payments
        WHERE tenant_id=? AND commission_source_sale_id=? AND source='commission' AND deleted_at IS NULL
      `).all(tenantId, saleId) as Array<{ id: string; employee_id: string; amount: number; employee_name: string }>
      const originalById = new Map(originals.map(row => [row.id, row]))
      if (originals.length !== basis.employees.length) throw new Error('Нарахування зарплати не відповідає збереженому розрахунку')
      const saleLines = this.db.prepare(`
        SELECT id,qty FROM sale_items WHERE tenant_id=? AND sale_id=? AND deleted_at IS NULL
      `).all(tenantId, saleId) as Array<{ id: string; qty: number }>
      const soldByLine = new Map(saleLines.map(row => [row.id, stockUnits(Number(row.qty))]))
      for (const employee of basis.employees) {
        if (employee.lines.some(line => soldByLine.get(line.id) !== line.quantity_units)) {
          throw new Error('Збережений розрахунок зарплати пошкоджений. Рядки не відповідають чеку.')
        }
      }
      const quantities = this.db.prepare(`
        SELECT i.sale_item_id, SUM(i.quantity) quantity
        FROM customer_return_items i
        JOIN customer_returns r ON r.id=i.return_id AND r.tenant_id=i.tenant_id
        WHERE r.sale_id=? AND r.tenant_id=? AND r.status='completed' AND r.deleted_at IS NULL AND i.deleted_at IS NULL
        GROUP BY i.sale_item_id
      `).all(saleId, tenantId) as Array<{ sale_item_id: string; quantity: number }>
      const byLine = new Map(quantities.map(row => [row.sale_item_id, stockUnits(Number(row.quantity))]))
      const created: any[] = [], timestamp = nowIso(), workDate = businessDate(returned.created_at)
      for (const employee of basis.employees) {
        const original = originalById.get(employee.payment_id)
        if (!original || original.employee_id !== employee.employee_id || Number(original.amount) !== employee.amount) {
          throw new Error('Нарахування зарплати не відповідає збереженому розрахунку')
        }
        const replay = this.db.prepare(`
          SELECT id FROM salary_payments WHERE tenant_id=? AND employee_id=?
            AND commission_source_return_id=? AND source='commission_reversal' AND deleted_at IS NULL
        `).get(tenantId, employee.employee_id, returnId)
        if (replay) continue
        const target = employee.lines.reduce((sum, line) => sum
          + returnedCommission(line.amount, byLine.get(line.id) ?? 0, line.quantity_units), 0)
        const reversed = this.db.prepare(`
          SELECT COALESCE(-SUM(p.amount),0) amount FROM salary_payments p
          JOIN customer_returns r ON r.id=p.commission_source_return_id AND r.tenant_id=p.tenant_id
          WHERE p.tenant_id=? AND p.employee_id=? AND p.source='commission_reversal' AND p.deleted_at IS NULL
            AND r.sale_id=? AND r.status='completed' AND r.deleted_at IS NULL
        `).get(tenantId, employee.employee_id, saleId) as { amount: number }
        const amount = target - Number(reversed.amount)
        if (!Number.isSafeInteger(amount) || amount < 0 || target > employee.amount) throw new Error('Некоректна історія сторно зарплати')
        if (amount === 0) continue
        created.push(this.insertSalary({
          tenantId, employeeId: employee.employee_id, employeeName: original.employee_name,
          amount: -amount, type: 'bonus', method: 'cash', period: workDate.slice(0, 7), workDate,
          source: 'commission_reversal', note: 'Сторно комісії за повернення',
          shiftId: null, userId: createdBy, timestamp, commissionReturnId: returnId, commissionSaleId: saleId,
          id: commissionReversalId(returnId, employee.employee_id),
        }))
      }
      return created
    })
  }

  private insertSalary(input: {
    tenantId: string; employeeId: string; employeeName: string; amount: number
    type: SalaryType; method: SalaryMethod; period: string; workDate: string; source: string
    note: string | null; shiftId: string | null; userId: string | null; timestamp: string
    commissionSaleId?: string | null; commissionOrderId?: string | null; commissionReturnId?: string | null
    fundSource?: SalaryFundSource
    id?: string
  }): any {
    let cashOperationId: string | null = null
    if (input.fundSource && !['cashbox', 'owner_funds'].includes(input.fundSource)) throw new Error('Невідоме джерело коштів для зарплати')
    if (input.type === 'advance' && input.method === 'cash') {
      if (!input.shiftId) throw new Error('Для виплати готівкою потрібна відкрита касова зміна')
      const shift = this.db.prepare(`
        SELECT id, cashier_id FROM shifts
        WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL LIMIT 1
      `).get(input.shiftId, input.tenantId) as { id: string; cashier_id: string } | undefined
      if (!shift) throw new Error('Касова зміна не відкрита')
      if (input.userId && shift.cashier_id !== input.userId) throw new Error('Операція доступна тільки у власній касовій зміні')
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
      const fundSource = input.fundSource ?? 'cashbox'
      if (fundSource === 'cashbox' && input.amount > money(cash?.available)) {
        throw new Error('У касі недостатньо готівки для цієї виплати')
      }
      if (fundSource === 'owner_funds') {
        const ownerContributionId = randomUUID()
        const contributionNote = `Внесення власних коштів власника для зарплати за ${input.workDate}: ${input.employeeName}`
        this.db.prepare(`
          INSERT INTO cash_operations (
            id, tenant_id, shift_id, user_id, type, source, amount, employee_id, work_date, notes,
            dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'cash_in', 'owner_funds', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ownerContributionId, input.tenantId, input.shiftId, input.userId, input.amount,
          input.employeeId, input.workDate, contributionNote,
          input.timestamp, input.timestamp, input.timestamp,
        )
        this.addOutbox(input.tenantId, 'cash_operation', ownerContributionId, 'cash_operation.created', {
          id: ownerContributionId, shift_id: input.shiftId, type: 'in', amount: input.amount,
          employee_id: input.employeeId, work_date: input.workDate, source: 'owner_funds',
          note: contributionNote, user_id: input.userId, created_at: input.timestamp,
        }, input.timestamp)
      }
      cashOperationId = randomUUID()
      this.db.prepare(`
        INSERT INTO cash_operations (
          id, tenant_id, shift_id, user_id, type, source, amount, employee_id, work_date, notes,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'salary_payout', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cashOperationId, input.tenantId, input.shiftId, input.userId, fundSource, input.amount,
        input.employeeId, input.workDate, input.note || `Виплата зарплати: ${input.employeeName}`,
        input.timestamp, input.timestamp, input.timestamp,
      )
      this.addOutbox(input.tenantId, 'cash_operation', cashOperationId, 'cash_operation.created', {
        id: cashOperationId, shift_id: input.shiftId, type: 'out', amount: input.amount,
        employee_id: input.employeeId, work_date: input.workDate, source: fundSource,
        note: input.note, user_id: input.userId, created_at: input.timestamp,
      }, input.timestamp)
    }
    const id = input.id ?? randomUUID()
    this.db.prepare(`
      INSERT INTO salary_payments (
        id, tenant_id, employee_id, employee_name, amount, type, method, period,
        work_date, source, note, shift_id, cash_operation_id, commission_source_sale_id, commission_source_order_id,
        commission_source_return_id, created_by, dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.tenantId, input.employeeId, input.employeeName, input.amount, input.type,
      input.method, input.period, input.workDate, input.source, input.note, input.shiftId,
      cashOperationId, input.commissionSaleId ?? null, input.commissionOrderId ?? null, input.commissionReturnId ?? null,
      input.userId, input.timestamp, input.timestamp, input.timestamp,
    )
    // Never look for the just-written result on a paginated history page.
    const result = this.db.prepare(`
      SELECT id, employee_id, employee_name, amount, type, method, period, note,
             work_date, source, shift_id, cash_operation_id, created_at,
             commission_source_sale_id, commission_source_order_id, commission_source_return_id, created_by
      FROM salary_payments WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).get(id, input.tenantId)
    if (!result) throw new Error('Не вдалося перевірити запис зарплати')
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
