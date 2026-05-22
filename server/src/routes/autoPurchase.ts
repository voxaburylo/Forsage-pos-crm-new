import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager'))

// GET /api/v1/auto-purchase/suggestions — пропозиції закупки
router.get('/suggestions', async (req, res, next) => {
  try {
    const { data, error } = await db.rpc('generate_purchase_suggestions', {
      p_tenant_id: req.user!.tenant_id,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

const ruleSchema = z.object({
  product_id:  z.string().uuid(),
  supplier_id: z.string().uuid().optional().nullable(),
  min_qty:     z.number().positive().default(1),
  max_qty:     z.number().positive().default(100),
  is_active:   z.boolean().default(true),
})

// GET /api/v1/auto-purchase/rules — список правил
router.get('/rules', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('auto_purchase_rules')
      .select('*, product:products(id, sku, name, qty_on_hand, reorder_point), supplier:suppliers(id, name)')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/auto-purchase/rules — створити правило
router.post('/rules', async (req, res, next) => {
  try {
    const parsed = ruleSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 400, parsed.error.flatten())

    const { data, error } = await db
      .from('auto_purchase_rules')
      .upsert({
        tenant_id:   req.user!.tenant_id,
        product_id:  parsed.data.product_id,
        supplier_id: parsed.data.supplier_id ?? null,
        min_qty:     parsed.data.min_qty,
        max_qty:     parsed.data.max_qty,
        is_active:   parsed.data.is_active,
      }, { onConflict: 'tenant_id,product_id' })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// DELETE /api/v1/auto-purchase/rules/:id — видалити правило
router.delete('/rules/:id', async (req, res, next) => {
  try {
    const { error } = await db
      .from('auto_purchase_rules')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
