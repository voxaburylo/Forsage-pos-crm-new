import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { pool, runTransaction } from '../db/pg.js'
import * as adminService from '../services/adminService.js'
import { kyivDateKey } from '../lib/businessDate.js'

const router = Router()
router.use(requireAuth)

const createSchema = z.object({
  employee_id:   z.string().uuid(),
  employee_name: z.string().min(1).max(200),
  amount:        z.number().int().min(1),
  type:          z.enum(['salary', 'bonus', 'advance', 'penalty']).default('salary'),
  method:        z.enum(['cash', 'card', 'transfer']).default('cash'),
  period:        z.string().regex(/^\d{4}-\d{2}$/).optional().nullable(),
  note:          z.string().max(1000).optional().nullable(),
  shift_id:      z.string().uuid().optional().nullable(),
  work_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})


async function assertCashAvailable(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> },
  shiftId: string,
  tenantId: string,
  amount: number,
): Promise<void> {
  const shift = await client.query(
    `SELECT id FROM shifts
     WHERE id = $1 AND tenant_id = $2 AND status = 'open'
     LIMIT 1 FOR UPDATE`,
    [shiftId, tenantId],
  )
  if (!shift.rowCount) throw new AppError('SHIFT_CLOSED', 'Касова зміна не відкрита', 409)
  const cash = await client.query(
    `SELECT GREATEST(0,
       COALESCE(s.opening_cash, 0)
       + COALESCE((SELECT SUM(COALESCE(sale.cash_amount, 0))
         FROM sales sale
         WHERE sale.shift_id = s.id AND sale.tenant_id = s.tenant_id
           AND sale.status IN ('completed', 'returned')), 0)
       + COALESCE((SELECT SUM(CASE WHEN operation.type = 'in' THEN operation.amount ELSE -operation.amount END)
         FROM cash_operations operation
         WHERE operation.shift_id = s.id AND operation.tenant_id = s.tenant_id), 0)
     )::bigint AS available
     FROM shifts s WHERE s.id = $1 AND s.tenant_id = $2`,
    [shiftId, tenantId],
  )
  const available = Number(cash.rows[0]?.available ?? 0)
  if (amount > available) {
    throw new AppError(
      'CASHBOX_INSUFFICIENT_FUNDS',
      `У касі недостатньо готівки: доступно ${(available / 100).toFixed(2)} грн`,
      409,
    )
  }
}

const tireCashHandoverSchema = z.object({
  employee_id: z.string().uuid(),
  employee_name: z.string().min(1).max(200),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shift_id: z.string().uuid(),
  amount: z.number().int().positive(),
  operation_id: z.string().uuid(),
})

function plusDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

async function ownerPayrollIds(tenantId: string): Promise<Set<string>> {
  const users = await adminService.listUsers(tenantId)
  return new Set(users.filter((user) => user.role === 'owner').map((user) => user.id))
}

async function withoutOwnerPayrollRows<T extends { employee_id: string }>(tenantId: string, rows: T[]): Promise<T[]> {
  const owners = await ownerPayrollIds(tenantId)
  return rows.filter((row) => !owners.has(row.employee_id))
}

async function buildTireServiceReport(tenantId: string, date: string) {
  const workers = (await adminService.listUsers(tenantId))
    .filter((user) => user.is_active && user.role === 'tire_worker')
  const workerIds = workers.map((worker) => worker.id)
  if (workerIds.length === 0) {
    return { data: [], receipts: [], date, totals: { services_qty: 0, service_revenue: 0, cash_revenue: 0, cash_handed_over: 0, cash_pending: 0, due: 0, payable_due: 0 } }
  }
  const [salaryResult, receiptResult, handoverResult] = await Promise.all([
    pool.query(`
      SELECT employee_id::text,
        COALESCE(SUM(CASE WHEN type IN ('salary','bonus') THEN amount ELSE 0 END), 0)::bigint AS earned,
        COALESCE(SUM(CASE WHEN type = 'advance' THEN amount ELSE 0 END), 0)::bigint AS paid,
        COALESCE(SUM(CASE WHEN type = 'penalty' THEN amount ELSE 0 END), 0)::bigint AS penalty,
        COALESCE(SUM(CASE WHEN source IN ('commission','commission_reversal') THEN amount ELSE 0 END), 0)::bigint AS commission_earned,
        COALESCE(SUM(CASE WHEN source = 'daily_rate' THEN amount ELSE 0 END), 0)::bigint AS daily_rate
      FROM salary_payments
      WHERE tenant_id = $1 AND work_date = $2
      GROUP BY employee_id
    `, [tenantId, date]),
    pool.query(`
      WITH service_sales AS (
        SELECT sale.id, sale.sale_number, sale.completed_at, sale.manager_id AS employee_id,
          sale.payment_method, sale.total, sale.cash_amount,
          COALESCE(SUM(item.qty), 0)::float AS services_qty,
          COALESCE(SUM(item.total), 0)::bigint AS service_revenue
        FROM sales sale
        JOIN sale_items item ON item.sale_id = sale.id AND item.tenant_id = sale.tenant_id
        JOIN products product ON product.id = item.product_id AND product.tenant_id = item.tenant_id
        WHERE sale.tenant_id = $1 AND sale.status = 'completed'
          AND sale.manager_id = ANY($3::uuid[])
          AND product.sku = 'POS-TIRE-SERVICE'
          AND (sale.completed_at AT TIME ZONE 'Europe/Kyiv')::date = $2::date
        GROUP BY sale.id
      )
      SELECT *, CASE WHEN total > 0 THEN
        LEAST(service_revenue, ROUND(service_revenue::numeric *
          CASE WHEN payment_method = 'cash' THEN COALESCE(NULLIF(cash_amount, 0), total) ELSE COALESCE(cash_amount, 0) END / total
        ))::bigint ELSE 0 END AS cash_revenue
      FROM service_sales ORDER BY completed_at DESC
    `, [tenantId, date, workerIds]),
    pool.query(`
      SELECT employee_id::text, COALESCE(SUM(amount), 0)::bigint AS amount
      FROM cash_operations
      WHERE tenant_id = $1 AND type = 'in' AND source = 'cashbox' AND work_date = $2
        AND employee_id = ANY($3::uuid[])
      GROUP BY employee_id
    `, [tenantId, date, workerIds]),
  ])
  const workerNames = new Map(workers.map((worker) => [worker.id, worker.full_name]))
  const receipts = receiptResult.rows.map((row) => ({
    id: row.id, sale_number: row.sale_number, completed_at: row.completed_at,
    employee_id: row.employee_id, employee_name: workerNames.get(row.employee_id) ?? 'Шиномонтажник',
    services_qty: Number(row.services_qty ?? 0), service_revenue: Number(row.service_revenue ?? 0),
    cash_revenue: Number(row.cash_revenue ?? 0), payment_method: row.payment_method, total: Number(row.total ?? 0),
  }))
  const salaryByWorker = new Map(salaryResult.rows.map((row) => [row.employee_id, row]))
  const handedByWorker = new Map(handoverResult.rows.map((row) => [row.employee_id, Number(row.amount ?? 0)]))
  const salaryAvailableOn = plusDays(date, 2)
  const matured = kyivDateKey() >= salaryAvailableOn
  const data = workers.map((worker) => {
    const salary = salaryByWorker.get(worker.id) ?? {}
    const workerReceipts = receipts.filter((receipt) => receipt.employee_id === worker.id)
    const serviceRevenue = workerReceipts.reduce((sum, receipt) => sum + receipt.service_revenue, 0)
    const cashRevenue = workerReceipts.reduce((sum, receipt) => sum + receipt.cash_revenue, 0)
    const cashHandedOver = handedByWorker.get(worker.id) ?? 0
    const cashPending = Math.max(0, cashRevenue - cashHandedOver)
    const recordedDailyRate = Number(salary.daily_rate ?? 0)
    const projectedDailyRate = recordedDailyRate === 0 && worker.rate_period === 'day' && workerReceipts.length > 0
      ? Number(worker.base_rate ?? 0)
      : 0
    const earned = Number(salary.earned ?? 0) + projectedDailyRate
    const paid = Number(salary.paid ?? 0)
    const penalty = Number(salary.penalty ?? 0)
    const balance = earned - paid - penalty
    const due = Math.max(0, balance)
    const salaryReady = matured && cashPending === 0
    return {
      employee_id: worker.id, employee_name: worker.full_name,
      services_qty: workerReceipts.reduce((sum, receipt) => sum + receipt.services_qty, 0),
      service_revenue: serviceRevenue, cash_revenue: cashRevenue, cash_handed_over: cashHandedOver, cash_pending: cashPending,
      commission_earned: Number(salary.commission_earned ?? 0), daily_rate: recordedDailyRate + projectedDailyRate,
      earned, paid, penalty, balance, due, salary_available_on: salaryAvailableOn,
      salary_ready: salaryReady, payable_due: salaryReady ? due : 0,
    }
  })
  return { data, receipts, date, totals: {
    services_qty: data.reduce((sum, row) => sum + row.services_qty, 0),
    service_revenue: data.reduce((sum, row) => sum + row.service_revenue, 0),
    cash_revenue: data.reduce((sum, row) => sum + row.cash_revenue, 0),
    cash_handed_over: data.reduce((sum, row) => sum + row.cash_handed_over, 0),
    cash_pending: data.reduce((sum, row) => sum + row.cash_pending, 0),
    due: data.reduce((sum, row) => sum + row.due, 0),
    payable_due: data.reduce((sum, row) => sum + row.payable_due, 0),
  } }
}
const dailyPayoutSchema = z.object({
  employee_id:   z.string().uuid(),
  employee_name: z.string().min(1).max(200),
  method:        z.enum(['cash', 'card', 'transfer']).default('cash'),
  fund_source:   z.enum(['cashbox', 'owner_funds']).default('cashbox'),
  shift_id:      z.string().uuid().optional().nullable(),
  work_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

// GET /api/v1/salary — список виплат
router.get('/', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const period     = req.query.period as string | undefined
    const employeeId = req.query.employee_id as string | undefined

    let query = db
      .from('salary_payments')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })
      .limit(200)

    if (period)     query = query.eq('period', period)
    if (employeeId) query = query.eq('employee_id', employeeId)

    const { data, error } = await query
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: await withoutOwnerPayrollRows(req.user!.tenant_id, data ?? []) })
  } catch (err) { next(err) }
})

// GET /api/v1/salary/summary — зведення по співробітниках за місяць
router.get('/summary', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const period = (req.query.period as string) ?? new Date().toISOString().slice(0, 7)

    const { data, error } = await db
      .from('salary_payments')
      .select('employee_id, employee_name, amount, type')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('period', period)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const map: Record<string, {
      employee_id: string
      employee_name: string
      salary: number
      bonus: number
      advance: number
      penalty: number
      earned: number
      paid: number
      balance: number
      total: number
    }> = {}

    for (const row of await withoutOwnerPayrollRows(req.user!.tenant_id, data ?? [])) {
      if (!map[row.employee_id]) {
        map[row.employee_id] = {
          employee_id: row.employee_id,
          employee_name: row.employee_name,
          salary: 0, bonus: 0, advance: 0, penalty: 0,
          earned: 0, paid: 0, balance: 0, total: 0,
        }
      }
      map[row.employee_id][row.type as 'salary' | 'bonus' | 'advance' | 'penalty'] += row.amount
    }

    for (const empId of Object.keys(map)) {
      const e = map[empId]
      e.earned = e.salary + e.bonus
      e.paid = e.advance
      e.balance = e.earned - e.paid - e.penalty
      e.total = e.balance // total matches the corrected balance
    }

    res.json({ data: Object.values(map) })
  } catch (err) { next(err) }
})

// GET /api/v1/salary/daily-summary?date=YYYY-MM-DD
router.get('/daily-summary', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const date = String(req.query.date ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('VALIDATION_ERROR', 'Невірна дата', 422)
    const { data, error } = await db
      .from('salary_payments')
      .select('employee_id, employee_name, amount, type')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('work_date', date)
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const map: Record<string, any> = {}
    for (const row of await withoutOwnerPayrollRows(req.user!.tenant_id, data ?? [])) {
      if (!map[row.employee_id]) map[row.employee_id] = {
        employee_id: row.employee_id, employee_name: row.employee_name,
        earned: 0, paid: 0, penalty: 0, balance: 0,
      }
      if (row.type === 'salary' || row.type === 'bonus') map[row.employee_id].earned += row.amount
      if (row.type === 'advance') map[row.employee_id].paid += row.amount
      if (row.type === 'penalty') map[row.employee_id].penalty += row.amount
    }
    for (const value of Object.values(map) as any[]) value.balance = value.earned - value.paid - value.penalty
    res.json({ data: Object.values(map), date })
  } catch (err) { next(err) }
})
// GET /api/v1/salary/tire-service-report?date=YYYY-MM-DD
router.get('/tire-service-report', requireRole('owner', 'admin', 'cashier'), async (req, res, next) => {
  try {
    const date = String(req.query.date ?? kyivDateKey())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('VALIDATION_ERROR', 'Невірна дата', 422)
    res.json(await buildTireServiceReport(req.user!.tenant_id, date))
  } catch (err) { next(err) }
})

router.post('/tire-cash-handover', requireRole('owner', 'admin', 'cashier'), async (req, res, next) => {
  try {
    const parsed = tireCashHandoverSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані внесення', 422, parsed.error.flatten())
    const input = parsed.data
    const worker = (await adminService.listUsers(req.user!.tenant_id))
      .find((user) => user.id === input.employee_id && user.is_active && user.role === 'tire_worker')
    if (!worker) throw new AppError('NOT_FOUND', 'Шиномонтажника не знайдено', 404)
    const result = await runTransaction(async (client) => {
      const shift = await client.query(`SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2 AND status='open' FOR UPDATE`, [input.shift_id, req.user!.tenant_id])
      if (!shift.rowCount) throw new AppError('SHIFT_CLOSED', 'Спочатку відкрийте касову зміну', 409)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${req.user!.tenant_id}:${input.employee_id}:${input.work_date}`,
      ])
      const locked = await client.query(`
        WITH service_sales AS (
          SELECT sale.total, sale.cash_amount, sale.payment_method, SUM(item.total)::bigint AS service_revenue
          FROM sales sale
          JOIN sale_items item ON item.sale_id=sale.id AND item.tenant_id=sale.tenant_id
          JOIN products product ON product.id=item.product_id AND product.tenant_id=item.tenant_id
          WHERE sale.tenant_id=$1 AND sale.manager_id=$2 AND sale.status='completed'
            AND product.sku='POS-TIRE-SERVICE'
            AND (sale.completed_at AT TIME ZONE 'Europe/Kyiv')::date=$3::date
          GROUP BY sale.id
        ), required AS (
          SELECT COALESCE(SUM(CASE WHEN total > 0 THEN LEAST(service_revenue, ROUND(service_revenue::numeric *
            CASE WHEN payment_method='cash' THEN COALESCE(NULLIF(cash_amount,0),total) ELSE COALESCE(cash_amount,0) END / total
          ))::bigint ELSE 0 END),0)::bigint AS amount FROM service_sales
        ), handed AS (
          SELECT COALESCE(SUM(amount),0)::bigint AS amount FROM cash_operations
          WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3 AND type='in' AND source='cashbox'
        )
        SELECT GREATEST(0, required.amount-handed.amount)::bigint AS pending FROM required, handed
      `, [req.user!.tenant_id, input.employee_id, input.work_date])
      const pending = Number(locked.rows[0]?.pending ?? 0)
      if (pending <= 0) throw new AppError('NOTHING_TO_HAND_OVER', 'Каса за цей день уже внесена', 409)
      if (input.amount > pending) throw new AppError('HANDOVER_TOO_LARGE', `Залишилось внести ${(pending / 100).toFixed(2)} грн`, 409)
      const inserted = await client.query(`
        INSERT INTO cash_operations
          (id, tenant_id, shift_id, type, amount, note, source, created_by, employee_id, work_date)
        VALUES ($1,$2,$3,'in',$4,$5,'cashbox',$6,$7,$8)
        ON CONFLICT (id) DO NOTHING RETURNING id
      `, [input.operation_id, req.user!.tenant_id, input.shift_id, input.amount,
        `Каса шиномонтажу за ${input.work_date}: ${worker.full_name}`, req.user!.id, input.employee_id, input.work_date])
      return { amount: input.amount, remaining: Math.max(0, pending - input.amount), created: Boolean(inserted.rowCount) }
    })
    res.status(result.created ? 201 : 200).json({ data: result })
  } catch (err) { next(err) }
})

// POST /api/v1/salary/daily-payout — нарахувати денну ставку та видати залишок за день.
router.post('/daily-payout', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = dailyPayoutSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані виплати', 422, parsed.error.flatten())
    const input = parsed.data
    if (input.method === 'cash' && !input.shift_id) {
      throw new AppError('SHIFT_REQUIRED', 'Для виплати готівкою потрібна відкрита касова зміна', 422)
    }

    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(input.employee_id)
    const employee = authData.user
    if (!employee || employee.app_metadata?.tenant_id !== req.user!.tenant_id) {
      throw new AppError('NOT_FOUND', 'Співробітника не знайдено', 404)
    }
    if (employee.app_metadata?.role === 'owner') {
      throw new AppError('OWNER_NOT_PAYROLL_EMPLOYEE', 'Власник не входить до зарплатної відомості працівників', 409)
    }
    if (employee.app_metadata?.role === 'tire_worker') {
      const tireReport = await buildTireServiceReport(req.user!.tenant_id, input.work_date)
      const tireRow = tireReport.data.find((row) => row.employee_id === input.employee_id)
      if (!tireRow?.salary_ready) {
        const reason = (tireRow?.cash_pending ?? 0) > 0
          ? 'Спочатку внесіть усю готівкову касу шиномонтажу за цей день'
          : `Зарплата стане доступною ${tireRow?.salary_available_on ?? plusDays(input.work_date, 2)}`
        throw new AppError('TIRE_SALARY_NOT_READY', reason, 409)
      }
    }
    const dailyRate = employee.app_metadata?.rate_period === 'day'
      ? Number(employee.app_metadata?.base_rate ?? 0)
      : 0
    const period = input.work_date.slice(0, 7)

    const result = await runTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `salary-payout:${req.user!.tenant_id}:${input.employee_id}:${input.work_date}`,
      ])
      if (dailyRate > 0) {
        await client.query(
          `INSERT INTO salary_payments
           (tenant_id, employee_id, employee_name, amount, type, method, period, work_date, source, note, created_by)
           VALUES ($1,$2,$3,$4,'salary','cash',$5,$6,'daily_rate','Денна ставка',$7)
           ON CONFLICT DO NOTHING`,
          [req.user!.tenant_id, input.employee_id, input.employee_name, dailyRate, period, input.work_date, req.user!.id],
        )
      }

      const totals = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type IN ('salary','bonus') THEN amount ELSE 0 END),0)::int AS earned,
           COALESCE(SUM(CASE WHEN type='advance' THEN amount ELSE 0 END),0)::int AS paid,
           COALESCE(SUM(CASE WHEN type='penalty' THEN amount ELSE 0 END),0)::int AS penalty
         FROM salary_payments
         WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3`,
        [req.user!.tenant_id, input.employee_id, input.work_date],
      )
      const earned = Number(totals.rows[0].earned)
      const paid = Number(totals.rows[0].paid)
      const penalty = Number(totals.rows[0].penalty)
      const amount = earned - paid - penalty
      if (amount <= 0) throw new AppError('NOTHING_TO_PAY', 'За сьогодні немає невиплаченого заробітку', 409)

      let cashOperationId: string | null = null
      if (input.method === 'cash') {
        if (input.fund_source === 'cashbox') {
          await assertCashAvailable(client, input.shift_id!, req.user!.tenant_id, amount)
        } else {
          const shift = await client.query(
            `SELECT id FROM shifts
             WHERE id=$1 AND tenant_id=$2 AND status='open'
             LIMIT 1 FOR UPDATE`,
            [input.shift_id, req.user!.tenant_id],
          )
          if (!shift.rowCount) throw new AppError('SHIFT_CLOSED', 'Касова зміна не відкрита', 409)
          await client.query(
            `INSERT INTO cash_operations
             (tenant_id, shift_id, type, amount, note, created_by, source, employee_id, work_date)
             VALUES ($1,$2,'in',$3,$4,$5,'owner_funds',$6,$7)`,
            [
              req.user!.tenant_id, input.shift_id, amount,
              `Внесення власних коштів власника для зарплати за ${input.work_date}: ${input.employee_name}`,
              req.user!.id, input.employee_id, input.work_date,
            ],
          )
        }
        const cash = await client.query(
          `INSERT INTO cash_operations
           (tenant_id, shift_id, type, amount, note, created_by, source, employee_id, work_date)
           VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            req.user!.tenant_id, input.shift_id, amount,
            `Зарплата за ${input.work_date}: ${input.employee_name}`,
            req.user!.id, input.fund_source, input.employee_id, input.work_date,
          ],
        )
        cashOperationId = cash.rows[0].id
      }

      const payout = await client.query(
        `INSERT INTO salary_payments
         (tenant_id, employee_id, employee_name, amount, type, method, period, work_date, source, note, created_by, cash_operation_id)
         VALUES ($1,$2,$3,$4,'advance',$5,$6,$7,'daily_payout',$8,$9,$10)
         RETURNING *`,
        [
          req.user!.tenant_id, input.employee_id, input.employee_name, amount, input.method,
          period, input.work_date, `Виплата заробітку за ${input.work_date}`, req.user!.id, cashOperationId,
        ],
      )
      return { payment: payout.rows[0], amount, earned, previously_paid: paid, penalty, fund_source: input.fund_source }
    })
    res.status(201).json({ data: result })
  } catch (err) { next(err) }
})

// POST /api/v1/salary — додати виплату
router.post('/', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(parsed.data.employee_id)
    const employee = authData.user
    if (!employee || employee.app_metadata?.tenant_id !== req.user!.tenant_id) {
      throw new AppError('NOT_FOUND', 'Співробітника не знайдено', 404)
    }
    if (employee.app_metadata?.role === 'owner') {
      throw new AppError('OWNER_NOT_PAYROLL_EMPLOYEE', 'Власник не входить до зарплатної відомості працівників', 409)
    }

    const period = parsed.data.period ?? new Date().toISOString().slice(0, 7)

    if (parsed.data.type === 'advance' && parsed.data.method === 'cash' && !parsed.data.shift_id) {
      throw new AppError('SHIFT_REQUIRED', 'Для виплати готівкою потрібна відкрита касова зміна', 422)
    }
    const workDate = parsed.data.work_date ?? new Date().toISOString().slice(0, 10)
    const data = await runTransaction(async (client) => {
      let cashOperationId: string | null = null
      if (parsed.data.type === 'advance' && parsed.data.method === 'cash') {
        await assertCashAvailable(client, parsed.data.shift_id!, req.user!.tenant_id, parsed.data.amount)
        const cash = await client.query(
          `INSERT INTO cash_operations
           (tenant_id, shift_id, type, amount, note, created_by, source)
           VALUES ($1,$2,'out',$3,$4,$5,'cashbox') RETURNING id`,
          [req.user!.tenant_id, parsed.data.shift_id, parsed.data.amount, parsed.data.note || `Виплата зарплати: ${parsed.data.employee_name}`, req.user!.id],
        )
        cashOperationId = cash.rows[0].id
      }
      const inserted = await client.query(
        `INSERT INTO salary_payments
         (tenant_id, employee_id, employee_name, amount, type, method, period, note, created_by, work_date, source, cash_operation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11) RETURNING *`,
        [
          req.user!.tenant_id, parsed.data.employee_id, parsed.data.employee_name,
          parsed.data.amount, parsed.data.type, parsed.data.method, period,
          parsed.data.note ?? null, req.user!.id, workDate, cashOperationId,
        ],
      )
      return inserted.rows[0]
    })
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/salary/commission-preview — зведення комісій по менеджерах за місяць
router.get('/commission-preview', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const period = (req.query.period as string) ?? new Date().toISOString().slice(0, 7)
    const userId = req.query.user_id as string | undefined
    const tenantId = req.user!.tenant_id

    // Вже нараховані/сторновані комісії за цей місяць: замовлення + прямі касові продажі.
    let commQuery = db
      .from('salary_payments')
      .select('employee_id, employee_name, amount')
      .eq('tenant_id', tenantId)
      .eq('type', 'bonus')
      .eq('period', period)
      .in('source', ['commission', 'commission_reversal'])
    if (userId) commQuery = commQuery.eq('employee_id', userId)
    const { data: commissions, error: commErr } = await commQuery
    if (commErr) throw new AppError('DB_ERROR', commErr.message, 500)

    // Продажі по менеджерах за поточний місяць
    const fromDate = period + '-01'
    const toDate = new Date(new Date(fromDate).setMonth(new Date(fromDate).getMonth() + 1)).toISOString().slice(0, 10)

    let salesQuery = db
      .from('sales')
      .select('manager_id, total')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .gte('completed_at', fromDate)
      .lt('completed_at', toDate)
    if (userId) salesQuery = salesQuery.eq('manager_id', userId)
    const { data: sales, error: salesErr } = await salesQuery
    if (salesErr) throw new AppError('DB_ERROR', salesErr.message, 500)

    // Власник може проводити продажі, але це не створює зарплатний борг самому собі.
    const ownerIds = await ownerPayrollIds(tenantId)

    // Агрегуємо
    const map: Record<string, {
      employee_id: string
      employee_name: string
      sales_count: number
      revenue: number
      commission_paid: number
    }> = {}

    for (const s of commissions ?? []) {
      if (ownerIds.has(s.employee_id)) continue
      if (!map[s.employee_id]) {
        map[s.employee_id] = { employee_id: s.employee_id, employee_name: s.employee_name, sales_count: 0, revenue: 0, commission_paid: 0 }
      }
      map[s.employee_id].commission_paid += s.amount
    }

    for (const s of sales ?? []) {
      if (!s.manager_id || ownerIds.has(s.manager_id)) continue
      if (!map[s.manager_id]) {
        map[s.manager_id] = { employee_id: s.manager_id, employee_name: s.manager_id.slice(0, 8), sales_count: 0, revenue: 0, commission_paid: 0 }
      }
      map[s.manager_id].sales_count += 1
      map[s.manager_id].revenue += s.total
    }

    res.json({ data: Object.values(map), period })
  } catch (err) { next(err) }
})

// DELETE /api/v1/salary/:id — видалити запис
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await runTransaction(async (client) => {
      const payment = await client.query(
        'SELECT cash_operation_id, source FROM salary_payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [req.params.id, req.user!.tenant_id],
      )
      if (!payment.rowCount) throw new AppError('NOT_FOUND', 'Запис не знайдено', 404)
      if (payment.rows[0].source !== 'manual') {
        throw new AppError('AUTOMATIC_SALARY_IMMUTABLE', 'Автоматичне нарахування не можна видалити; виправте джерело операції', 409)
      }
      const cashOperationId = payment.rows[0]?.cash_operation_id ?? null
      await client.query(
        'DELETE FROM salary_payments WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.user!.tenant_id],
      )
      if (cashOperationId) {
        await client.query(
          'DELETE FROM cash_operations WHERE id = $1 AND tenant_id = $2',
          [cashOperationId, req.user!.tenant_id],
        )
      }
      await client.query(
        `INSERT INTO sync_deletions (tenant_id, entity_type, entity_id, deleted_at)
         VALUES ($1, 'salary_payment', $2, clock_timestamp())
         ON CONFLICT (tenant_id, entity_type, entity_id)
         DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
        [req.user!.tenant_id, req.params.id],
      )
      if (cashOperationId) {
        await client.query(
          `INSERT INTO sync_deletions (tenant_id, entity_type, entity_id, deleted_at)
           VALUES ($1, 'cash_operation', $2, clock_timestamp())
           ON CONFLICT (tenant_id, entity_type, entity_id)
           DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
          [req.user!.tenant_id, cashOperationId],
        )
      }
    })
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})
export default router
