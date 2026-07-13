import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { logAction } from '../services/auditService.js'

const router = Router()
router.use(requireAuth)

const COUNTER_ROLES = ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer'] as const
const MANAGER_ROLES = ['owner', 'admin', 'storekeeper'] as const

async function requireInventorySession(sessionId: string, tenantId: string, activeOnly = false) {
  let query = db.from('inventory_sessions').select('*')
    .eq('id', sessionId).eq('tenant_id', tenantId)
  if (activeOnly) query = query.eq('status', 'in_progress')
  const { data, error } = await query.maybeSingle()
  if (error || !data) {
    throw new AppError('NOT_FOUND', activeOnly ? 'Ревізія не активна' : 'Сесію не знайдено', 404)
  }
  return data
}

async function loadSessionData(sessionId: string, tenantId: string, userId: string) {
  const session = await requireInventorySession(sessionId, tenantId)
  const [itemsRes, priceIssuesRes, entriesRes, summaryRes] = await Promise.all([
    db.from('inventory_items')
      .select('*, product:products(id,sku,name,barcode,additional_barcodes,unit,retail_price,purchase_price,storage_bin)')
      .eq('session_id', sessionId)
      .eq('was_counted', true)
      .order('updated_at', { ascending: false })
      .limit(100),
    db.from('inventory_items')
      .select('id,product_id,observed_retail_price,updated_at,last_counted_by,product:products(id,sku,name,unit,retail_price)')
      .eq('session_id', sessionId)
      .not('observed_retail_price', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(200),
    db.from('inventory_count_entries')
      .select('id,product_id,qty,price_checked,observed_retail_price,created_at,counted_by,product:products(id,sku,name,unit,retail_price)')
      .eq('session_id', sessionId)
      .eq('counted_by', userId)
      .order('created_at', { ascending: false })
      .limit(20),
    db.rpc('get_inventory_session_summary', {
      p_session_id: sessionId,
      p_tenant_id: tenantId,
    }),
  ])
  if (itemsRes.error) throw new AppError('DB_ERROR', itemsRes.error.message, 500)
  if (priceIssuesRes.error) throw new AppError('DB_ERROR', priceIssuesRes.error.message, 500)
  if (entriesRes.error) throw new AppError('DB_ERROR', entriesRes.error.message, 500)
  if (summaryRes.error) throw new AppError('DB_ERROR', summaryRes.error.message, 500)
  return {
    ...session,
    items: itemsRes.data ?? [],
    price_issues: (priceIssuesRes.data ?? []).filter((issue: any) =>
      issue.observed_retail_price !== issue.product?.retail_price
    ),
    my_entries: entriesRes.data ?? [],
    summary: summaryRes.data ?? {},
  }
}

// Усі учасники бачать список, але створення/керування доступне лише відповідальним.
router.get('/', requireRole(...COUNTER_ROLES), async (req, res, next) => {
  try {
    const { data, error } = await db.from('inventory_sessions').select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (error) { next(error) }
})

router.post('/', requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1).max(200),
      created_by: z.string().uuid().optional(),
      created_at: z.string().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна назва або параметри', 422)
    const { data, error } = await db.from('inventory_sessions').insert({
      tenant_id: req.user!.tenant_id,
      name: parsed.data.name,
      status: 'draft',
      created_by: parsed.data.created_by || req.user!.id,
      ...(parsed.data.created_at ? { created_at: parsed.data.created_at } : {}),
    }).select().single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (error) { next(error) }
})

router.get('/:id', requireRole(...COUNTER_ROLES), async (req, res, next) => {
  try {
    res.json({ data: await loadSessionData(String(req.params.id), req.user!.tenant_id, req.user!.id) })
  } catch (error) { next(error) }
})

router.post('/:id/start', requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const sessionId = String(req.params.id)
    const { data, error } = await db.rpc('start_inventory_session', {
      p_session_id: sessionId,
      p_tenant_id: req.user!.tenant_id,
      p_user_id: req.user!.id,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 400)
    res.json({ data })
  } catch (error) { next(error) }
})

// Точне розпізнавання штрихкоду/артикула без автоматичного додавання кількості.
router.get('/:id/product', requireRole(...COUNTER_ROLES), async (req, res, next) => {
  try {
    const parsedQuery = z.object({
      code: z.string().trim().min(1).max(100).optional(),
      product_id: z.string().uuid().optional(),
    }).refine((value) => value.code || value.product_id).parse(req.query)
    const code = parsedQuery.code
    const sessionId = String(req.params.id)
    await requireInventorySession(sessionId, req.user!.tenant_id, true)

    let product: any = null
    if (parsedQuery.product_id) {
      const byId = await db.from('products')
        .select('id,sku,name,barcode,additional_barcodes,unit,qty_on_hand,retail_price,purchase_price,storage_bin')
        .eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
        .eq('id', parsedQuery.product_id).maybeSingle()
      product = byId.data
    }
    if (!product && code) {
      const byBarcode = await db.from('products')
        .select('id,sku,name,barcode,additional_barcodes,unit,qty_on_hand,retail_price,purchase_price,storage_bin')
        .eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
        .eq('barcode', code).maybeSingle()
      product = byBarcode.data
    }
    if (!product && code) {
      const bySku = await db.from('products')
        .select('id,sku,name,barcode,additional_barcodes,unit,qty_on_hand,retail_price,purchase_price,storage_bin')
        .eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
        .ilike('sku', code).limit(1).maybeSingle()
      product = bySku.data
    }
    if (!product && code) {
      const additional = await db.from('products')
        .select('id,sku,name,barcode,additional_barcodes,unit,qty_on_hand,retail_price,purchase_price,storage_bin')
        .eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
        .contains('additional_barcodes', [code]).limit(1).maybeSingle()
      product = additional.data
    }
    if (!product) throw new AppError('NOT_FOUND', 'Товар не знайдено', 404)

    const { data: item } = await db.from('inventory_items')
      .select('id,expected_stock,counted_stock,price_checked,observed_retail_price')
      .eq('session_id', sessionId).eq('product_id', product.id).maybeSingle()
    res.json({ data: { ...product, inventory_item: item ?? null } })
  } catch (error) {
    if (error instanceof z.ZodError) next(new AppError('VALIDATION_ERROR', 'Введіть штрихкод або артикул', 422))
    else next(error)
  }
})

const countSchema = z.object({
  product_id: z.string().uuid(),
  qty: z.number().min(0).max(1_000_000),
  price_checked: z.boolean().default(false),
  observed_retail_price: z.number().int().min(0).optional().nullable(),
})

router.post('/:id/count', requireRole(...COUNTER_ROLES), async (req, res, next) => {
  try {
    const parsed = countSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Перевірте кількість і ціну', 422)
    const sessionId = String(req.params.id)
    const { data, error } = await db.rpc('add_inventory_count', {
      p_session_id: sessionId,
      p_tenant_id: req.user!.tenant_id,
      p_product_id: parsed.data.product_id,
      p_user_id: req.user!.id,
      p_qty: parsed.data.qty,
      p_price_checked: parsed.data.price_checked,
      p_observed_retail_price: parsed.data.observed_retail_price ?? null,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 400)
    res.status(201).json({
      data,
      session: await loadSessionData(sessionId, req.user!.tenant_id, req.user!.id),
    })
  } catch (error) { next(error) }
})

// Сумісність зі старим сканером: один скан = атомарно +1.
router.post('/:id/scan', requireRole(...COUNTER_ROLES), async (req, res, next) => {
  try {
    const schema = z.object({
      barcode: z.string().trim().optional(),
      product_id: z.string().uuid().optional(),
    }).refine((value) => value.barcode || value.product_id)
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Потрібен штрихкод або товар', 422)
    let productId = parsed.data.product_id
    if (!productId && parsed.data.barcode) {
      const { data: product } = await db.from('products').select('id')
        .eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
        .eq('barcode', parsed.data.barcode).maybeSingle()
      productId = product?.id
    }
    if (!productId) throw new AppError('NOT_FOUND', 'Товар не знайдено', 404)
    const sessionId = String(req.params.id)
    const { error } = await db.rpc('add_inventory_count', {
      p_session_id: sessionId,
      p_tenant_id: req.user!.tenant_id,
      p_product_id: productId,
      p_user_id: req.user!.id,
      p_qty: 1,
      p_price_checked: false,
      p_observed_retail_price: null,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 400)
    res.json({ data: (await loadSessionData(sessionId, req.user!.tenant_id, req.user!.id)).items })
  } catch (error) { next(error) }
})

router.delete('/:id/entries/:entryId', requireRole(...COUNTER_ROLES), async (req, res, next) => {
  try {
    const allowAny = ['owner', 'admin'].includes(req.user!.role)
    const { data, error } = await db.rpc('undo_inventory_count', {
      p_entry_id: String(req.params.entryId),
      p_session_id: String(req.params.id),
      p_tenant_id: req.user!.tenant_id,
      p_user_id: req.user!.id,
      p_allow_any_user: allowAny,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 400)
    res.json({ data })
  } catch (error) { next(error) }
})

// Абсолютна ручна корекція агрегату — лише відповідальним, не рядовим учасникам.
router.put('/:id/items/:itemId', requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ counted_stock: z.number().min(0) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна кількість', 422)
    const sessionId = String(req.params.id)
    await requireInventorySession(sessionId, req.user!.tenant_id, true)
    const { data, error } = await db.from('inventory_items')
      .update({ counted_stock: parsed.data.counted_stock, was_counted: true, updated_at: new Date().toISOString() })
      .eq('id', req.params.itemId).eq('session_id', sessionId)
      .select().single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (error) { next(error) }
})

// Зміна ціни прямо з ревізії: оновлює роздрібну ціну товару (з історією цін)
// і закриває розбіжність у сесії. Ролі — ті самі, що можуть редагувати товар.
router.post('/:id/apply-price', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = z.object({
      product_id: z.string().uuid(),
      retail_price: z.number().int().min(0).max(100_000_000_000),
    }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна ціна', 422, parsed.error.flatten())
    const sessionId = String(req.params.id)
    await requireInventorySession(sessionId, req.user!.tenant_id)

    const { updateProduct } = await import('../services/productService.js')
    const product = await updateProduct(
      parsed.data.product_id,
      { retail_price: parsed.data.retail_price } as any,
      req.user!.id,
      req.user!.tenant_id,
    )

    // Розбіжність вирішено — позиція ревізії стає «ціна перевірена»
    await db.from('inventory_items')
      .update({ price_checked: true, observed_retail_price: null, updated_at: new Date().toISOString() })
      .eq('session_id', sessionId)
      .eq('product_id', parsed.data.product_id)

    void logAction({
      tenantId: req.user!.tenant_id,
      userId: req.user!.id,
      userRole: req.user!.role,
      action: 'inventory_price_applied',
      entityType: 'product',
      entityId: parsed.data.product_id,
      entityLabel: `${(product as any)?.sku ?? ''} - ${(product as any)?.name ?? ''}`,
      note: `Ціну оновлено з ревізії: ${(parsed.data.retail_price / 100).toFixed(2)} грн`,
    })

    res.json({
      data: { product },
      session: await loadSessionData(sessionId, req.user!.tenant_id, req.user!.id),
    })
  } catch (error) { next(error) }
})

router.post('/:id/complete', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const confirmation = z.object({
      confirm_unfinished: z.boolean().default(false),
      confirm_price_issues: z.boolean().default(false),
    }).parse(req.body)
    const sessionId = String(req.params.id)
    const session = await requireInventorySession(sessionId, req.user!.tenant_id, true)
    const { data: summary, error: summaryError } = await db.rpc('get_inventory_session_summary', {
      p_session_id: sessionId,
      p_tenant_id: req.user!.tenant_id,
    })
    if (summaryError) throw new AppError('DB_ERROR', summaryError.message, 500)
    const missing = Math.max(0, Number(summary?.total_products ?? 0) - Number(summary?.counted_products ?? 0))
    const priceIssues = Number(summary?.price_mismatch_products ?? 0)
    if (missing > 0 && !confirmation.confirm_unfinished) {
      throw new AppError('INVENTORY_UNFINISHED', `Не пораховано товарів: ${missing}`, 409)
    }
    if (priceIssues > 0 && !confirmation.confirm_price_issues) {
      throw new AppError('INVENTORY_PRICE_ISSUES', `Не перевірено розбіжностей цін: ${priceIssues}`, 409)
    }
    const { data, error } = await db.rpc('complete_inventory_session', {
      p_session_id: sessionId,
      p_tenant_id: req.user!.tenant_id,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 400)
    await logAction({
      tenantId: req.user!.tenant_id,
      userId: req.user!.id,
      userRole: req.user!.role,
      action: 'inventory.completed',
      entityType: 'inventory_session',
      entityId: sessionId,
      entityLabel: session.name,
      newValue: data,
    })
    res.json({ data })
  } catch (error) { next(error) }
})

export default router
