import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

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

    const map: Record<string, { employee_id: string; employee_name: string; salary: number; bonus: number; advance: number; penalty: number; total: number }> = {}
    for (const row of data ?? []) {
      if (!map[row.employee_id]) {
        map[row.employee_id] = {
          employee_id: row.employee_id,
          employee_name: row.employee_name,
          salary: 0, bonus: 0, advance: 0, penalty: 0, total: 0,
        }
      }
      map[row.employee_id][row.type as 'salary' | 'bonus' | 'advance' | 'penalty'] += row.amount
      map[row.employee_id].total += row.type === 'penalty' ? -row.amount : row.amount
    }

    res.json({ data: Object.values(map) })
  } catch (err) { next(err) }
})

// POST /api/v1/salary — додати виплату
router.post('/', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const period = parsed.data.period ?? new Date().toISOString().slice(0, 7)

    const { data, error } = await db
      .from('salary_payments')
      .insert({
        tenant_id:     req.user!.tenant_id,
        employee_id:   parsed.data.employee_id,
        employee_name: parsed.data.employee_name,
        amount:        parsed.data.amount,
        type:          parsed.data.type,
        method:        parsed.data.method,
        period,
        note:          parsed.data.note ?? null,
        created_by:    req.user!.id,
      })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
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
