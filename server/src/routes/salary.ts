import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { runTransaction } from '../db/pg.js'

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
  work_date:     z.string().regex(/^\d{4}-\d{2}$/).optional(),
})

const dailyPayoutSchema = z.object({
  employee_id:   z.string().uuid(),
  employee_name: z.string().min(1).max(200),
  method:        z.enum(['cash', 'card', 'transfer']).default('cash'),
  shift_id:      z.string().uuid().optional().nullable(),
  work_date:     z.string().regex(/^\d{4}-\d{2}$/),
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
    const date = String(req.query.date ?? new Date().toISOString().slice(0, 10))
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
    if (!employee || employee.user_metadata?.tenant_id !== req.user!.tenant_id) {
      throw new AppError('NOT_FOUND', 'Співробітника не знайдено', 404)
    }
    const dailyRate = employee.user_metadata?.rate_period === 'day'
      ? Number(employee.user_metadata?.base_rate ?? 0)
      : 0
    const period = input.work_date.slice(0, 7)

    const result = await runTransaction(async (client) => {
      if (input.shift_id) {
        const shift = await client.query(
          `SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2 AND status='open'`,
          [input.shift_id, req.user!.tenant_id],
        )
        if (shift.rowCount === 0) throw new AppError('SHIFT_CLOSED', 'Касова зміна не відкрита', 409)
      }

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

    const period = parsed.data.period ?? new Date().toISOString().slice(0, 7)

    if (parsed.data.type === 'advance' && parsed.data.method === 'cash' && !parsed.data.shift_id) {
      throw new AppError('SHIFT_REQUIRED', 'Для виплати готівкою потрібна відкрита касова зміна', 422)
    }
    const workDate = parsed.data.work_date ?? new Date().toISOString().slice(0, 10)
    const data = await runTransaction(async (client) => {
      let cashOperationId: string | null = null
      if (parsed.data.type === 'advance' && parsed.data.method === 'cash') {
        const shift = await client.query(
          `SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2 AND status='open'`,
          [parsed.data.shift_id, req.user!.tenant_id],
        )
        if (shift.rowCount === 0) throw new AppError('SHIFT_CLOSED', 'Касова зміна не відкрита', 409)
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

    // Вже нараховані комісії за цей місяць (тип bonus з прив'язкою до замовлення)
    let commQuery = db
      .from('salary_payments')
      .select('employee_id, employee_name, amount')
      .eq('tenant_id', tenantId)
      .eq('type', 'bonus')
      .eq('period', period)
      .not('commission_source_order_id', 'is', null)
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
    const { error } = await db
      .from('salary_payments')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router
