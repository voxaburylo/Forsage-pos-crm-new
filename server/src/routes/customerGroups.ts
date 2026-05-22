import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/customer-groups — список груп (з кількістю учасників)
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('customer_groups')
      .select('*, members:customer_group_members(count)')
      .eq('tenant_id', req.user!.tenant_id)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-groups — створити групу
router.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(100),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#6366F1'),
      sort_order: z.number().int().min(0).default(0),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { data, error } = await db
      .from('customer_groups')
      .insert({ tenant_id: req.user!.tenant_id, ...parsed.data })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// PATCH /api/v1/customer-groups/:id — оновити групу
router.patch('/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      sort_order: z.number().int().min(0).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { data, error } = await db
      .from('customer_groups')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customer-groups/:id — видалити групу
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await db.from('customer_groups').delete().eq('id', req.params.id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

// POST /api/v1/customer-groups/:groupId/members — додати клієнтів до групи
router.post('/:groupId/members', async (req, res, next) => {
  try {
    const schema = z.object({ customer_ids: z.array(z.string().uuid()).min(1) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const rows = parsed.data.customer_ids.map((cid) => ({
      customer_id: cid,
      group_id: req.params.groupId,
    }))

    const { error } = await db.from('customer_group_members').upsert(rows, { onConflict: 'customer_id, group_id' })
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    res.status(201).json({ data: { added: rows.length } })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customer-groups/:groupId/members/:customerId — видалити клієнта з групи
router.delete('/:groupId/members/:customerId', async (req, res, next) => {
  try {
    const { error } = await db
      .from('customer_group_members')
      .delete()
      .eq('group_id', req.params.groupId)
      .eq('customer_id', req.params.customerId)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
