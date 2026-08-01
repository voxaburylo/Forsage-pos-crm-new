import { createHash } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createSaleSchema, calculatePriceSchema, saleListSchema } from '../validators/saleSchema.js'
import * as saleService from '../services/saleService.js'
import { assertTenantSyncGeneration } from '../services/syncGeneration.js'
import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'

const router = Router()
router.use(requireAuth)

const quickItemSchema = z.object({
  kind: z.enum(['tire_service', 'free_sale', 'bag']),
})

// Системні позиції для платежів, які не мають складського товару.
// Вони є сервісними, тому не змінюють залишки, але проходять через звичайний чек.
router.post('/quick-item', async (req, res, next) => {
  try {
    const parsed = quickItemSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний тип швидкої позиції', 422)

    const presets = {
      tire_service: { sku: 'POS-TIRE-SERVICE', name: 'Послуги шиномонтажу', retail_price: 0 },
      free_sale: { sku: 'POS-FREE-SALE', name: 'Продаж товару', retail_price: 0 },
      bag: { sku: 'POS-BAG', name: 'Пакет', retail_price: 500 },
    } as const
    const preset = presets[parsed.data.kind]

    const { data: existing, error: existingError } = await db
      .from('products')
      .select('id,sku,name,unit,retail_price,qty_on_hand,is_service,is_active,deleted_at')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('sku', preset.sku)
      .maybeSingle()

    if (existingError) throw new AppError('DB_ERROR', existingError.message, 500)
    if (existing) {
      if (existing.deleted_at || !existing.is_active || !existing.is_service) {
        const { data: restored, error: restoreError } = await db
          .from('products')
          .update({
            name: preset.name,
            unit: 'шт',
            purchase_price: 0,
            retail_price: preset.retail_price,
            qty_on_hand: 0,
            is_active: true,
            is_service: true,
            deleted_at: null,
          })
          .eq('id', existing.id)
          .eq('tenant_id', req.user!.tenant_id)
          .select('id,sku,name,unit,retail_price,qty_on_hand,is_service')
          .single()
        if (restoreError || !restored) {
          throw new AppError('DB_ERROR', restoreError?.message ?? 'Не вдалося відновити позицію', 500)
        }
        res.json({ data: restored })
        return
      }
      // Товар живий, але назва могла застаріти (напр. перейменували службову
      // позицію) — синхронізуємо, щоб у чеку була актуальна назва.
      if (existing.name !== preset.name) {
        const { data: renamed } = await db
          .from('products')
          .update({ name: preset.name })
          .eq('id', existing.id)
          .eq('tenant_id', req.user!.tenant_id)
          .select('id,sku,name,unit,retail_price,qty_on_hand,is_service')
          .single()
        res.json({ data: renamed ?? { ...existing, name: preset.name } })
        return
      }
      res.json({ data: existing })
      return
    }

    const { data, error } = await db
      .from('products')
      .insert({
        tenant_id: req.user!.tenant_id,
        ...preset,
        unit: 'шт',
        purchase_price: 0,
        qty_on_hand: 0,
        is_active: true,
        is_service: true,
        deleted_at: null,
      })
      .select('id,sku,name,unit,retail_price,qty_on_hand,is_service')
      .single()

    if (error || !data) throw new AppError('DB_ERROR', error?.message ?? 'Не вдалося створити позицію', 500)
    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/sales/suspend — відкласти чек (без списання залишків і RPC)
const suspendSaleSchema = z.object({
  confirmed_by_cashier: z.literal(true),
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

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    )
  }
  return value
}

function suspendedSaleRequestHash(value: z.infer<typeof suspendSaleSchema>): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex')
}

router.post('/suspend', async (req, res, next) => {
  try {
    const parsed = suspendSaleSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { shift_id, customer_id, manager_id, items, payment_method, notes, pickup_cell, expires_at } = parsed.data
    const idempotencyKey = String(req.get('X-Idempotency-Key') ?? '').trim()
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new AppError('VALIDATION_ERROR', 'Некоректний X-Idempotency-Key', 400)
    }
    const tenantId = req.user!.tenant_id
    const cashierId = req.user!.id
    const subtotal = items.reduce((s, i) => s + i.unit_price * i.qty, 0)
    const totalDiscount = items.reduce((s, i) => s + i.discount, 0)
    const total = Math.max(0, subtotal - totalDiscount)
    const productIds = [...new Set(items.map((item) => item.product_id))]
    const requestHash = suspendedSaleRequestHash(parsed.data)

    const result = await runTransaction(async (client) => {
      // The idempotency claim, document and child rows commit together. A retry
      // after a timeout either waits for this transaction or returns its result.
      const claim = await client.query(
        `INSERT INTO idempotency_keys (
           key, tenant_id, status, response, request_hash, created_at
         ) VALUES ($1, $2, 'processing', NULL, $3, clock_timestamp())
         ON CONFLICT (key, tenant_id) DO NOTHING
         RETURNING key`,
        [idempotencyKey, tenantId, requestHash],
      )
      if (claim.rowCount === 0) {
        const existingResult = await client.query(
          `SELECT status, response, request_hash
           FROM idempotency_keys
           WHERE key = $1 AND tenant_id = $2
           FOR UPDATE`,
          [idempotencyKey, tenantId],
        )
        const existing = existingResult.rows[0]
        if (!existing) {
          throw new AppError('DB_ERROR', 'Не вдалося перевірити повтор запиту', 500)
        }
        if (existing.request_hash && existing.request_hash !== requestHash) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Цей номер операції вже використано для іншого відкладеного чека',
            409,
          )
        }
        if (existing.status === 'completed' && existing.response) {
          return existing.response
        }
        throw new AppError('SALE_PROCESSING', 'Відкладення чека вже обробляється', 409)
      }

      const shiftResult = await client.query(
        `SELECT id
         FROM shifts
         WHERE id = $1
           AND tenant_id = $2
           AND cashier_id = $3
           AND status = 'open'
         FOR SHARE`,
        [shift_id, tenantId, cashierId],
      )
      if (shiftResult.rowCount === 0) {
        throw new AppError('NO_OPEN_SHIFT', 'Активну зміну касира не знайдено', 400)
      }

      let customer: Record<string, unknown> | null = null
      if (customer_id) {
        const customerResult = await client.query(
          `SELECT id, phone, full_name
           FROM customers
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           FOR SHARE`,
          [customer_id, tenantId],
        )
        if (customerResult.rowCount === 0) {
          throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
        }
        customer = customerResult.rows[0]
      }

      const productsResult = await client.query(
        `SELECT id
         FROM products
         WHERE tenant_id = $2
           AND id = ANY($1::uuid[])
           AND deleted_at IS NULL
           AND is_active = true
         FOR SHARE`,
        [productIds, tenantId],
      )
      if (productsResult.rowCount !== productIds.length) {
        throw new AppError('PRODUCT_NOT_FOUND', 'Один або кілька товарів не знайдено', 404)
      }

      const numberResult = await client.query<{ sale_number: string }>(
        'SELECT public.next_suspend_number() AS sale_number',
      )
      const saleNumber = numberResult.rows[0]?.sale_number
      if (!saleNumber) throw new AppError('DB_ERROR', 'Не вдалося створити номер чека', 500)

      const saleResult = await client.query(
        `INSERT INTO sales (
           tenant_id, sale_number, customer_id, cashier_id, shift_id, manager_id,
           payment_method, status, subtotal, discount, total, notes, pickup_cell,
           is_debt, completed_at, created_at, updated_at, expires_at,
           client_operation_id, client_payload_hash
         )
         SELECT
           $1, $2, $3, $4, $5, $6, $7, 'suspended', $8, $9, $10, $11, $12,
           $13, stamp.at, stamp.at, stamp.at, $14, $15, $16
         FROM (SELECT clock_timestamp() AS at) AS stamp
         RETURNING *`,
        [
          tenantId, saleNumber, customer_id ?? null, cashierId, shift_id,
          manager_id ?? cashierId, payment_method, subtotal, totalDiscount, total,
          notes ?? null, pickup_cell ?? null, payment_method === 'debt',
          expires_at ?? null, idempotencyKey, requestHash,
        ],
      )
      const sale = saleResult.rows[0]
      if (!sale) throw new AppError('DB_ERROR', 'Не вдалося зберегти чек', 500)

      const saleItemsResult = await client.query(
        `INSERT INTO sale_items (
           tenant_id, sale_id, product_id, qty, unit_price, discount, total, created_at
         )
         SELECT $1, $2, item.product_id, item.qty, item.unit_price,
                item.discount, item.total, clock_timestamp()
         FROM jsonb_to_recordset($3::jsonb) AS item(
           product_id UUID, qty NUMERIC, unit_price INTEGER, discount INTEGER, total INTEGER
         )
         RETURNING *`,
        [
          tenantId,
          sale.id,
          JSON.stringify(items.map((item) => ({
            ...item,
            total: item.unit_price * item.qty - item.discount,
          }))),
        ],
      )

      // Stamp the parent only after every child exists. Delta pull can now
      // never observe and permanently cache an incomplete suspended receipt.
      const finalSaleResult = await client.query(
        `UPDATE sales
         SET updated_at = clock_timestamp()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [sale.id, tenantId],
      )
      const response = {
        ...finalSaleResult.rows[0],
        customer,
        sale_items: saleItemsResult.rows,
      }
      await client.query(
        `UPDATE idempotency_keys
         SET status = 'completed', response = $3::jsonb, request_hash = $4
         WHERE key = $1 AND tenant_id = $2`,
        [idempotencyKey, tenantId, JSON.stringify(response), requestHash],
      )
      return response
    })

    res.status(201).json({ data: result })
  } catch (err) { next(err) }
})

// POST /api/v1/sales/calculate-price — розрахунок ціни (до /:id щоб не конфліктувати)
router.post('/calculate-price', async (req, res, next) => {
  try {
    const parsed = calculatePriceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await saleService.calculatePrice(parsed.data, req.user!.tenant_id)
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
      .eq('tenant_id', req.user!.tenant_id)
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
    const result = await saleService.listSales(q.data, req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/v1/sales — створити продаж
router.post('/', async (req, res, next) => {
  try {
    const rawGeneration = req.get('X-Sync-Reset-Generation')
    const clientResetGeneration = rawGeneration === undefined ? 0 : Number(rawGeneration)
    if (!Number.isInteger(clientResetGeneration) || clientResetGeneration < 0) {
      throw new AppError('VALIDATION_ERROR', 'Некоректне покоління локальної бази', 400)
    }
    await assertTenantSyncGeneration(req.user!.tenant_id, clientResetGeneration)

    const parsed = createSaleSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані продажу', 422, parsed.error.flatten())
    
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined
    if (!idempotencyKey) {
      throw new AppError('VALIDATION_ERROR', 'Заголовок X-Idempotency-Key є обов\'язковим для створення продажу', 400)
    }

    // RBAC: знижки дозволені лише owner/admin/manager
    const canDiscount = ['owner', 'admin', 'manager'].includes(req.user!.role)
    const hasDiscount = parsed.data.discount > 0 || parsed.data.items.some(i => i.discount > 0)
    if (hasDiscount && !canDiscount) {
      throw new AppError('FORBIDDEN', 'Знижки доступні лише менеджерам та адміністраторам', 403)
    }

    const sale = await saleService.createSale(
      req.user!.id,
      req.user!.tenant_id,
      parsed.data,
      idempotencyKey,
      clientResetGeneration,
    )
    res.status(201).json({ data: sale })
  } catch (err) { next(err) }
})

// GET /api/v1/sales/suspended — відкладені чеки (ОБОВ'ЯЗКОВО перед /:id!)
router.get('/suspended', async (req, res, next) => {
  try {
    const { db } = await import('../db/supabase.js')
    const { data, error } = await db
      .from('sales')
      .select('*, customer:customers(id,phone,full_name), shift:shifts(id), sale_items(id)')
      .eq('tenant_id', req.user!.tenant_id)
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
    const sale = await saleService.resumeSale(String(req.params.id), req.user!.tenant_id)
    res.json({ data: sale })
  } catch (err) { next(err) }
})

router.post('/:id/resume/confirm', async (req, res, next) => {
  try {
    const sale = await saleService.confirmResumedSale(
      String(req.params.id),
      req.user!.tenant_id,
      req.user!.id,
      req.user!.role,
    )
    res.json({ data: sale })
  } catch (err) { next(err) }
})

// DELETE /api/v1/sales/:id/suspended — прибрати випадково відкладений кошик.
// Фінансового продажу тут ще не було, але запис лишається cancelled для аудиту.
router.delete('/:id/suspended', async (req, res, next) => {
  try {
    const sale = await saleService.discardSuspendedSale(
      String(req.params.id),
      req.user!.tenant_id,
      req.user!.id,
      req.user!.role,
    )
    res.json({ data: sale })
  } catch (err) { next(err) }
})

// POST /api/v1/sales/:id/ready-for-pickup — позначити як готовий до видачі
router.post('/:id/ready-for-pickup', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const sale = await saleService.markReadyForPickup(String(req.params.id), req.user!.tenant_id)
    res.json({ data: sale })
  } catch (err) { next(err) }
})

// GET /api/v1/sales/ready-for-pickup — список готових до видачі
router.get('/ready-for-pickup', async (req, res, next) => {
  try {
    const { db } = await import('../db/supabase.js')
    const { data, error } = await db
      .from('sales')
      .select('*, customer:customers(id,phone,full_name)')
      .eq('tenant_id', req.user!.tenant_id)
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
    const sale = await saleService.getSale(String(req.params.id), req.user!.tenant_id)
    res.json({ data: sale })
  } catch (err) { next(err) }
})

export default router
