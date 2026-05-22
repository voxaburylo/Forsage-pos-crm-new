import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createSaleSchema, calculatePriceSchema, saleListSchema } from '../validators/saleSchema.js'
import * as saleService from '../services/saleService.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

// POST /api/v1/sales/suspend — відкласти чек (без списання залишків і RPC)
const suspendSaleSchema = z.object({
  shift_id:       z.string().uuid(),
  customer_id:    z.string().uuid().optional().nullable(),
  manager_id:     z.string().uuid().optional().nullable(),
  items:          z.array(z.object({
    product_id: z.string().uuid(),
    qty:        z.number().positive(),
    unit_price: z.number().int().positive(),
    discount:   z.number().int().min(0).default(0),
  })).min(1),
  payment_method: z.enum(['cash', 'card', 'debt', 'mixed', 'transfer']),
  notes:          z.string().max(500).optional().nullable(),
  pickup_cell:    z.string().max(50).optional().nullable(),
  expires_at:     z.string().datetime().optional().nullable(),
})

router.post('/suspend', async (req, res, next) => {
  try {
    const parsed = suspendSaleSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { shift_id, customer_id, manager_id, items, payment_method, notes, pickup_cell, expires_at } = parsed.data
    const tenantId = req.user!.tenant_id
    const cashierId = req.user!.id

    const subtotal = items.reduce((s, i) => s + i.unit_price * i.qty, 0)
    const totalDiscount = items.reduce((s, i) => s + i.discount, 0)
    const total = Math.max(0, subtotal - totalDiscount)

    // Унікальний номер через sequence (гарантована унікальність)
    const { data: seqRow, error: seqErr } = await db.rpc('next_suspend_number' as any)
    if (seqErr) throw new AppError('DB_ERROR', seqErr.message, 500)
    const saleNumber: string = seqRow as string

    const { data: sale, error: saleErr } = await db
      .from('sales')
      .insert({
        tenant_id:      tenantId,
        cashier_id:     cashierId,
        shift_id,
        customer_id:    customer_id ?? null,
        manager_id:     manager_id ?? cashierId,
        payment_method,
        status:         'suspended',
        subtotal,
        discount:       totalDiscount,
        total,
        notes:          notes ?? null,
        pickup_cell:    pickup_cell ?? null,
        sale_number:    saleNumber,
        is_debt:        payment_method === 'debt',
        completed_at:   new Date().toISOString(),
        expires_at:     expires_at ?? null,
      })
      .select('*, customer:customers(id,phone,full_name)')
      .single()

    if (saleErr || !sale) throw new AppError('DB_ERROR', saleErr?.message ?? 'Помилка збереження', 500)

    const saleItems = items.map((i) => ({
      tenant_id:  tenantId,
      sale_id:    sale.id,
      product_id: i.product_id,
      qty:        i.qty,
      unit_price: i.unit_price,
      discount:   i.discount,
      total:      i.unit_price * i.qty - i.discount,
    }))

    const { error: itemsErr } = await db.from('sale_items').insert(saleItems)
    if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

    res.status(201).json({ data: { ...sale, sale_items: saleItems } })
  } catch (err) { next(err) }
})

// POST /api/v1/sales/calculate-price — розрахунок ціни (до /:id щоб не конфліктувати)
router.post('/calculate-price', async (req, res, next) => {
  try {
    const parsed = calculatePriceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await saleService.calculatePrice(parsed.data)
    res.json({ data: result })
  } catch (err) { next(err) }
})

// GET /api/v1/sales/check-after-payment — перевірка чи продаж пройшов після краша
// Параметри: shift_id (обов'язково), after (ISO timestamp — момент спроби оплати)
router.get('/check-after-payment', async (req, res, next) => {
  try {
    const shiftId = req.query.shift_id as string | undefined
    const after   = req.query.after   as string | undefined
    if (!shiftId) throw new AppError('VALIDATION_ERROR', 'shift_id обов\'язковий', 422)

    const q = db
      .from('sales')
      .select('id, sale_number, total, payment_method, completed_at, status')
      .eq('shift_id', shiftId)
      .eq('cashier_id', req.user!.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)

    if (after) q.gte('completed_at', after)

    const { data, error } = await q
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    res.json({ data: data?.[0] ?? null })
  } catch (err) { next(err) }
})

// GET /api/v1/sales — список продажів
router.get('/', async (req, res, next) => {
  try {
    const q = saleListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await saleService.listSales(q.data)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/v1/sales — створити продаж
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSaleSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані продажу', 422, parsed.error.flatten())
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined

    // RBAC: знижки дозволені лише owner/admin/manager
    const canDiscount = ['owner', 'admin', 'manager'].includes(req.user!.role)
    const hasDiscount = parsed.data.discount > 0 || parsed.data.items.some(i => i.discount > 0)
    if (hasDiscount && !canDiscount) {
      throw new AppError('FORBIDDEN', 'Знижки доступні лише менеджерам та адміністраторам', 403)
    }

    const sale = await saleService.createSale(req.user!.id, req.user!.tenant_id, parsed.data, idempotencyKey)
    res.status(201).json({ data: sale })
  } catch (err) { next(err) }
})

// GET /api/v1/sales/suspended — відкладені чеки (ОБОВ'ЯЗКОВО перед /:id!)
router.get('/suspended', async (_req, res, next) => {
  try {
    const { db } = await import('../db/supabase.js')
    const { data, error } = await db
      .from('sales')
      .select('*, customer:customers(id,phone,full_name), shift:shifts(id)')
      .eq('status', 'suspended')
      .order('completed_at', { ascending: false })
      .limit(50)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/sales/:id/resume — відновити чек
router.post('/:id/resume', async (req, res, next) => {
  try {
    const sale = await saleService.resumeSale(String(req.params.id))
    res.json({ data: sale })
  } catch (err) { next(err) }
})

// POST /api/v1/sales/:id/ready-for-pickup — позначити як готовий до видачі
router.post('/:id/ready-for-pickup', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const sale = await saleService.markReadyForPickup(String(req.params.id))
    res.json({ data: sale })
  } catch (err) { next(err) }
})

// GET /api/v1/sales/ready-for-pickup — список готових до видачі
router.get('/ready-for-pickup', async (_req, res, next) => {
  try {
    const { db } = await import('../db/supabase.js')
    const { data, error } = await db
      .from('sales')
      .select('*, customer:customers(id,phone,full_name)')
      .eq('status', 'ready_for_pickup')
      .order('updated_at', { ascending: false })
      .limit(50)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// GET /api/v1/sales/:id — деталі продажу (в КІНЦІ, після всіх статичних роутів)
router.get('/:id', async (req, res, next) => {
  try {
    const sale = await saleService.getSale(String(req.params.id))
    res.json({ data: sale })
  } catch (err) { next(err) }
})

export default router
