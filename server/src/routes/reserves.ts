import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { ReserveService } from '../services/reserveService.js'
import * as adminService from '../services/adminService.js'

const router = Router()
router.use(requireAuth)

const createManualReserveSchema = z.object({
  product_id: z.string().uuid(),
  qty: z.number().positive(),
  order_id: z.string().uuid().optional().nullable(),
  customer_id: z.string().uuid().optional().nullable(),
  expires_at: z.string().datetime(),
})

// GET /api/v1/reserves — получить список активных резервов
router.get('/', async (req, res, next) => {
  try {
    const { data: reserves, error } = await db
      .from('inventory_reserves')
      .select('*, product:products(id, name, sku), customer:customers(id, full_name, phone)')
      .eq('tenant_id', req.user!.tenant_id)
      .is('released_at', null)
      .order('created_at', { ascending: false })

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Fetch orders manually to avoid PostgREST relationship issues
    const orderIds = (reserves ?? []).map(r => r.order_id).filter(Boolean) as string[]
    const ordersMap = new Map<string, any>()
    if (orderIds.length > 0) {
      const { data: orders } = await db
        .from('customer_orders')
        .select('id, number, status')
        .in('id', orderIds)
      if (orders) {
        orders.forEach(o => ordersMap.set(o.id, o))
      }
    }

    // Fetch users (staff)
    const users = await adminService.listUsers().catch(() => [])
    const usersMap = new Map(users.map(u => [u.id, u]))

    const result = (reserves ?? []).map(r => ({
      ...r,
      order: r.order_id ? ordersMap.get(r.order_id) || { id: r.order_id, number: 'Unknown', status: 'unknown' } : null,
      user: r.reserved_by ? usersMap.get(r.reserved_by) || { id: r.reserved_by, full_name: 'Manager' } : null
    }))

    res.json({ data: result })
  } catch (err) { next(err) }
})

// POST /api/v1/reserves — ручное создание резерва
router.post('/', async (req, res, next) => {
  try {
    const parsed = createManualReserveSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Невірні дані для резервування', 422, parsed.error.flatten())
    }

    const reserve = await ReserveService.createManualReserve({
      tenantId: req.user!.tenant_id,
      productId: parsed.data.product_id,
      qty: parsed.data.qty,
      orderId: parsed.data.order_id,
      customerId: parsed.data.customer_id,
      expiresAt: parsed.data.expires_at,
      userId: req.user!.id
    })

    res.status(201).json({ data: reserve })
  } catch (err) { next(err) }
})

// DELETE /api/v1/reserves/:id — ручное снятие резерва
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const { data: existing, error: findError } = await db
      .from('inventory_reserves')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', req.user!.tenant_id)
      .is('released_at', null)
      .maybeSingle()

    if (findError) throw new AppError('DB_ERROR', findError.message, 500)
    if (!existing) throw new AppError('NOT_FOUND', 'Резерв не знайдено або вже знято', 404)

    const { error } = await db
      .from('inventory_reserves')
      .update({ released_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', req.user!.tenant_id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router
