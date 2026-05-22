import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

// POST /api/v1/inventory — створити сесію
router.post('/', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const schema = z.object({ name: z.string().min(1).max(200) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна назва', 422)

    const { data, error } = await db
      .from('inventory_sessions')
      .insert({ tenant_id: req.user!.tenant_id, name: parsed.data.name, status: 'draft', created_by: req.user!.id })
      .select()
      .single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/inventory — список сесій
router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await db
      .from('inventory_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// GET /api/v1/inventory/:id — сесія + товари
router.get('/:id', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const sessionId = String(req.params.id)
    const [sessionRes, itemsRes] = await Promise.all([
      db.from('inventory_sessions').select('*').eq('id', sessionId).single(),
      db.from('inventory_items').select('*, product:products(id, sku, name, barcode, unit)').eq('session_id', sessionId).order('created_at'),
    ])
    if (sessionRes.error || !sessionRes.data) throw new AppError('NOT_FOUND', 'Сесію не знайдено', 404)
    if (itemsRes.error) throw new AppError('DB_ERROR', itemsRes.error.message, 500)
    res.json({ data: { ...sessionRes.data, items: itemsRes.data ?? [] } })
  } catch (err) { next(err) }
})

// POST /api/v1/inventory/:id/start — почати ревізію
router.post('/:id/start', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('inventory_sessions')
      .update({ status: 'in_progress' })
      .eq('id', req.params.id)
      .eq('status', 'draft')
      .select()
      .single()
    if (error || !data) throw new AppError('NOT_FOUND', 'Сесію не знайдено або вже розпочато', 400)
    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/inventory/:id/scan — сканувати товар
router.post('/:id/scan', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const schema = z.object({
      barcode:    z.string().optional(),
      product_id: z.string().uuid().optional(),
    }).refine((d) => d.barcode || d.product_id, { message: 'Потрібен barcode або product_id' })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const sessionId = String(req.params.id)
    let productId = parsed.data.product_id

    // Знаходимо товар по штрих-коду
    if (parsed.data.barcode) {
      const { data: prod } = await db.from('products').select('id, qty_on_hand')
        .is('deleted_at', null)
        .or(`barcode.eq.${parsed.data.barcode},additional_barcodes.cs.${parsed.data.barcode}`)
        .maybeSingle()
      if (!prod) throw new AppError('NOT_FOUND', 'Товар з таким штрих-кодом не знайдено', 404)
      productId = prod.id
    }

    // Додаємо або оновлюємо запис в inventory_items
    const { data: existing } = await db
      .from('inventory_items')
      .select('id, counted_stock')
      .eq('session_id', sessionId)
      .eq('product_id', productId)
      .maybeSingle()

    if (existing) {
      await db.from('inventory_items').update({ counted_stock: existing.counted_stock + 1 }).eq('id', existing.id)
    } else {
      const { data: prod } = await db.from('products').select('qty_on_hand').eq('id', productId).single()
      await db.from('inventory_items').insert({
        session_id: sessionId,
        product_id: productId,
        expected_stock: Math.round(prod?.qty_on_hand ?? 0),
        counted_stock: 1,
      })
    }

    const { data: items } = await db.from('inventory_items').select('*, product:products(id, sku, name, barcode, unit)')
      .eq('session_id', sessionId).order('created_at')
    res.json({ data: items ?? [] })
  } catch (err) { next(err) }
})

// PUT /api/v1/inventory/:id/items/:itemId — оновити кількість вручну
router.put('/:id/items/:itemId', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const schema = z.object({ counted_stock: z.number().int().min(0) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна кількість', 422)

    const { data, error } = await db
      .from('inventory_items')
      .update({ counted_stock: parsed.data.counted_stock })
      .eq('id', req.params.itemId)
      .select()
      .single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/inventory/:id/complete — завершити ревізію
router.post('/:id/complete', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const sessionId = String(req.params.id)

    // Отримуємо всі items сесії
    const { data: items, error: itemsErr } = await db
      .from('inventory_items')
      .select('product_id, expected_stock, counted_stock')
      .eq('session_id', sessionId)

    if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

    // Оновлюємо stock для кожного товару
    for (const item of items ?? []) {
      if (item.counted_stock !== item.expected_stock) {
        await db.from('products').update({
          qty_on_hand: item.counted_stock,
          updated_at: new Date().toISOString(),
        }).eq('id', item.product_id)
      }
    }

    // Закриваємо сесію
    const { data, error } = await db
      .from('inventory_sessions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', sessionId)
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: { ...data, items_updated: items?.length ?? 0 } })
  } catch (err) { next(err) }
})

export default router
