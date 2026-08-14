import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { pool, runTransaction } from '../db/pg.js'
import * as adminService from '../services/adminService.js'

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

const dailyPayoutSchema = z.object({
  employee_id:   z.string().uuid(),
  employee_name: z.string().min(1).max(200),
  method:        z.enum(['cash', 'card', 'transfer']).default('cash'),
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
    res.json({ data: data ?? [] })
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

    for (const row of data ?? []) {
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
    for (const row of data ?? []) {
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
// Практичний денний звіт: виконані послуги, виручка, нараховано, виплачено і залишок.
router.get('/tire-service-report', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const date = String(req.query.date ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('VALIDATION_ERROR', 'Невірна дата', 422)
    const workers = (await adminService.listUsers(req.user!.tenant_id))
      .filter((user) => user.is_active && user.role === 'tire_worker')
    if (workers.length === 0) {
      res.json({ data: [], date, totals: { services_qty: 0, service_revenue: 0, due: 0 } })
      return
    }
    const workerIds = workers.map((worker) => worker.id)
    const result = await pool.query(
      [
        'WITH salary AS (',
        '  SELECT employee_id,',
        "    COALESCE(SUM(CASE WHEN type IN ('salary','bonus') THEN amount ELSE 0 END), 0)::bigint AS earned,",
        "    COALESCE(SUM(CASE WHEN type = 'advance' THEN amount ELSE 0 END), 0)::bigint AS paid,",
        "    COALESCE(SUM(CASE WHEN type = 'penalty' THEN amount ELSE 0 END), 0)::bigint AS penalty,",
        "    COALESCE(SUM(CASE WHEN source IN ('commission','commission_reversal') THEN amount ELSE 0 END), 0)::bigint AS commission_earned,",
        "    COALESCE(SUM(CASE WHEN source = 'daily_rate' THEN amount ELSE 0 END), 0)::bigint AS daily_rate",
        '  FROM salary_payments',
        '  WHERE tenant_id = $1 AND work_date = $2',
        '  GROUP BY employee_id',
        '), employee_sales AS (',
        '  SELECT DISTINCT employee_id, commission_source_sale_id AS sale_id',
        '  FROM salary_payments',
        "  WHERE tenant_id = $1 AND work_date = $2 AND source = 'commission'",
        '    AND commission_source_sale_id IS NOT NULL',
        '), service_work AS (',
        '  SELECT linked.employee_id, COALESCE(SUM(item.qty), 0) AS services_qty,',
        '    COALESCE(SUM(item.total), 0)::bigint AS service_revenue',
        '  FROM employee_sales linked',
        '  JOIN sale_items item ON item.sale_id = linked.sale_id AND item.tenant_id = $1',
        '  JOIN products product ON product.id = item.product_id AND product.tenant_id = item.tenant_id',
        "  WHERE product.sku = 'POS-TIRE-SERVICE'",
        '  GROUP BY linked.employee_id',
        ')',
        'SELECT COALESCE(salary.employee_id, work.employee_id)::text AS employee_id,',
        '  COALESCE(work.services_qty, 0)::float AS services_qty,',
        '  COALESCE(work.service_revenue, 0)::bigint AS service_revenue,',
        '  COALESCE(salary.commission_earned, 0)::bigint AS commission_earned,',
        '  COALESCE(salary.daily_rate, 0)::bigint AS daily_rate,',
        '  COALESCE(salary.earned, 0)::bigint AS earned,',
        '  COALESCE(salary.paid, 0)::bigint AS paid,',
        '  COALESCE(salary.penalty, 0)::bigint AS penalty',
        'FROM salary FULL JOIN service_work work ON work.employee_id = salary.employee_id',
        'WHERE COALESCE(salary.employee_id, work.employee_id) = ANY($3::uuid[])',
      ].join('\n'),
      [req.user!.tenant_id, date, workerIds],
    )
    const byEmployee = new Map(result.rows.map((row) => [row.employee_id, row]))
    const data = workers.map((worker) => {
      const row = byEmployee.get(worker.id) ?? {}
      const earned = Number(row.earned ?? 0)
      const recordedDailyRate = Number(row.daily_rate ?? 0)
      const projectedDailyRate = recordedDailyRate === 0 && worker.rate_period === 'day' ? Number(worker.base_rate ?? 0) : 0
      const earnedWithRate = earned + projectedDailyRate
      const paid = Number(row.paid ?? 0)
      const penalty = Number(row.penalty ?? 0)
      const balance = earnedWithRate - paid - penalty
      return {
        employee_id: worker.id, employee_name: worker.full_name,
        services_qty: Number(row.services_qty ?? 0), service_revenue: Number(row.service_revenue ?? 0),
        commission_earned: Number(row.commission_earned ?? 0), daily_rate: recordedDailyRate + projectedDailyRate,
        earned: earnedWithRate, paid, penalty, balance, due: Math.max(0, balance),
      }
    })
    res.json({ data, date, totals: {
      services_qty: data.reduce((sum, row) => sum + row.services_qty, 0),
      service_revenue: data.reduce((sum, row) => sum + row.service_revenue, 0),
      due: data.reduce((sum, row) => sum + row.due, 0),
    } })
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
    const dailyRate = employee.app_metadata?.rate_period === 'day'
      ? Number(employee.app_metadata?.base_rate ?? 0)
      : 0
    const period = input.work_date.slice(0, 7)

    const result = await runTransaction(async (client) => {
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
        await assertCashAvailable(client, input.shift_id!, req.user!.tenant_id, amount)
        const cash = await client.query(
          `INSERT INTO cash_operations
           (tenant_id, shift_id, type, amount, note, created_by, source)
           VALUES ($1,$2,'out',$3,$4,$5,'cashbox') RETURNING id`,
          [req.user!.tenant_id, input.shift_id, amount, `Зарплата за ${input.work_date}: ${input.employee_name}`, req.user!.id],
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
      return { payment: payout.rows[0], amount, earned, previously_paid: paid, penalty }
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

    // Агрегуємо
    const map: Record<string, {
      employee_id: string
      employee_name: string
      sales_count: number
      revenue: number
      commission_paid: number
    }> = {}

    for (const s of commissions ?? []) {
      if (!map[s.employee_id]) {
        map[s.employee_id] = { employee_id: s.employee_id, employee_name: s.employee_name, sales_count: 0, revenue: 0, commission_paid: 0 }
      }
      map[s.employee_id].commission_paid += s.amount
    }

    for (const s of sales ?? []) {
      if (!s.manager_id) continue
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
