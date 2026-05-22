import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

const itemSchema = z.object({
  product_id:   z.string().uuid().optional().nullable(),
  product_name: z.string().min(1).max(500),
  sku:          z.string().max(100).optional().nullable(),
  qty:          z.number().int().min(1),
  buy_price:    z.number().int().min(0),
})

const createSchema = z.object({
  employee_id:   z.string().uuid(),
  employee_name: z.string().min(1).max(200),
  items:         z.array(itemSchema).min(1),
  note:          z.string().max(1000).optional().nullable(),
})

// GET /api/v1/internal-consumptions
router.get('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const employeeId = req.query.employee_id as string | undefined
    const month      = req.query.month as string | undefined

    let query = db
      .from('internal_consumptions')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })
      .limit(200)

    if (employeeId) query = query.eq('employee_id', employeeId)
    if (month) {
      const from = `${month}-01`
      const to   = new Date(new Date(from).getFullYear(), new Date(from).getMonth() + 1, 1).toISOString().split('T')[0]
      query = query.gte('created_at', from).lt('created_at', to)
    }

    const { data, error } = await query
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// GET /api/v1/internal-consumptions/summary — зведення по співробітниках
router.get('/summary', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7)
    const from  = `${month}-01`
    const to    = new Date(new Date(from).getFullYear(), new Date(from).getMonth() + 1, 1).toISOString().split('T')[0]

    const { data, error } = await db
      .from('internal_consumptions')
      .select('employee_id, employee_name, total_cost, items')
      .eq('tenant_id', req.user!.tenant_id)
      .gte('created_at', from)
      .lt('created_at', to)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const map: Record<string, { employee_id: string; employee_name: string; total_cost: number; items_count: number }> = {}
    for (const row of data ?? []) {
      if (!map[row.employee_id]) {
        map[row.employee_id] = {
          employee_id: row.employee_id,
          employee_name: row.employee_name,
          total_cost: 0,
          items_count: 0,
        }
      }
      map[row.employee_id].total_cost  += row.total_cost
      map[row.employee_id].items_count += (row.items as any[]).reduce((s: number, i: any) => s + i.qty, 0)
    }

    res.json({ data: Object.values(map) })
  } catch (err) { next(err) }
})

// POST /api/v1/internal-consumptions
router.post('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const items      = parsed.data.items
    const totalCost  = items.reduce((s, i) => s + i.buy_price * i.qty, 0)
    const itemsJson  = items.map((i) => ({ ...i, total: i.buy_price * i.qty }))

    const { data, error } = await db.rpc('process_internal_consumption', {
      p_tenant_id:     req.user!.tenant_id,
      p_employee_id:   parsed.data.employee_id,
      p_employee_name: parsed.data.employee_name,
      p_items:         itemsJson,
      p_total_cost:    totalCost,
      p_note:          parsed.data.note ?? null,
      p_created_by:    req.user!.id,
    })

    if (error) {
      if (error.message.includes('INSUFFICIENT_STOCK')) {
        throw new AppError('INSUFFICIENT_STOCK', error.message, 422)
      }
      if (error.message.includes('PRODUCT_NOT_FOUND')) {
        throw new AppError('PRODUCT_NOT_FOUND', error.message, 422)
      }
      throw new AppError('DB_ERROR', error.message, 500)
    }

    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// DELETE /api/v1/internal-consumptions/:id
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { error } = await db
      .from('internal_consumptions')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router
