import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

const carSchema = z.object({
  customer_id: z.string().uuid(),
  make:        z.string().min(1).max(100),
  model:       z.string().min(1).max(100),
  year:        z.number().int().min(1900).max(2100).optional().nullable(),
  vin:         z.string().length(17).optional().nullable(),
  notes:       z.string().max(2000).optional().nullable(),
})

// GET /api/v1/customer-cars/:customerId — список авто клієнта
router.get('/:customerId', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('customer_cars')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('customer_id', req.params.customerId)
      .order('created_at', { ascending: false })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-cars — додати авто
router.post('/', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = carSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    // Перевірка чи клієнт існує
    const { data: customer } = await db
      .from('customers')
      .select('id')
      .eq('id', parsed.data.customer_id)
      .is('deleted_at', null)
      .maybeSingle()
    if (!customer) throw new AppError('NOT_FOUND', 'Клієнта не знайдено', 404)

    // Унікальність VIN
    if (parsed.data.vin) {
      const { data: existing } = await db
        .from('customer_cars')
        .select('id')
        .eq('vin', parsed.data.vin)
        .maybeSingle()
      if (existing) throw new AppError('VIN_DUPLICATE', 'Цей VIN-код вже додано до іншого авто', 409)
    }

    const { data, error } = await db
      .from('customer_cars')
      .insert({ ...parsed.data, tenant_id: req.user!.tenant_id })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// PUT /api/v1/customer-cars/:id — оновити авто
router.put('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = carSchema.partial().safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { data, error } = await db
      .from('customer_cars')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error || !data) throw new AppError('NOT_FOUND', 'Авто не знайдено', 404)
    res.json({ data })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customer-cars/:id — видалити авто
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { error } = await db
      .from('customer_cars')
      .delete()
      .eq('id', req.params.id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
