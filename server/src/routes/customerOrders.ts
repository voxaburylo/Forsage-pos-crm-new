import { Router, type Request, type Response, type NextFunction } from 'express'
import * as adminService from '../services/adminService.js'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { notifyStatusUpdate } from '../services/telegramBot.js'
import { calculateAndRecordCommission } from '../services/commissionService.js'
import { notifyWaitlistCustomers } from './waitlist.js'
import { logAction } from '../services/auditService.js'
import { addOrderPayment } from '../services/orderPaymentService.js'
import { markOrderItemsArrived } from '../services/orderBulkArrivalService.js'
import { cancelOrderSafely } from '../services/orderCancellationService.js'

const router = Router()
router.use(requireAuth)

async function ensureCustomerCar(
  customerId: string | null | undefined,
  vehicleInfo: { make?: string; model?: string; year?: number; vin?: string } | null | undefined,
  tenantId: string,
) {
  const vin = vehicleInfo?.vin?.trim().toUpperCase()
  if (!customerId || !vin || vin.length > 17) return

  const { data: existing, error: findError } = await db
    .from('customer_cars')
    .select('id, customer_id')
    .eq('tenant_id', tenantId)
    .eq('vin', vin)
    .maybeSingle()

  if (findError) {
    logger.warn({ error: findError.message, vin }, 'Failed to check customer car from order')
    return
  }
  if (existing) return

  const { error } = await db.from('customer_cars').insert({
    tenant_id: tenantId,
    customer_id: customerId,
    make: vehicleInfo?.make?.trim() || 'Авто',
    model: vehicleInfo?.model?.trim() || '—',
    year: vehicleInfo?.year ?? null,
    vin,
  })
  if (error) logger.warn({ error: error.message, customerId, vin }, 'Failed to add customer car from order')
}

async function requireTenantOrder(req: Request, _res: Response, next: NextFunction, orderId: string) {
  try {
    const { data, error } = await db.from('customer_orders')
      .select('id')
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    if (!data) throw new AppError('ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    next()
  } catch (error) {
    next(error)
  }
}

router.param('id', requireTenantOrder)
router.param('orderId', requireTenantOrder)

// ── Захист маржі ─────────────────────────────────────────────────────────────
// Касир бачить замовлення на касі (видача/оплата), але закупівельні ціни
// позицій — це маржа магазину: вирізаємо їх з УСІХ відповідей роутера.
// Менеджер замовлень працює з цінами постачальників — йому лишаємо.
const ORDER_MARGIN_FIELDS = new Set(['buy_price', 'purchase_price', 'cost_price'])
function stripOrderMargin(obj: any): any {
  if (Array.isArray(obj)) { for (const el of obj) stripOrderMargin(el); return obj }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (ORDER_MARGIN_FIELDS.has(k)) delete obj[k]
      else stripOrderMargin(obj[k])
    }
  }
  return obj
}
router.use((req, res, next) => {
  if (req.user?.role === 'cashier') {
    const orig = res.json.bind(res)
    res.json = ((body: any) => orig(stripOrderMargin(body))) as any
  }
  next()
})

function orderLabel(order: any): string {
  return order?.order_number ? `Замовлення #${order.order_number}` : `Замовлення ${String(order?.id ?? '').slice(0, 8)}`
}

async function auditOrder(
  req: Request,
  action: string,
  orderId: string,
  oldValue?: unknown,
  newValue?: unknown,
  note?: string,
) {
  await logAction({
    tenantId: req.user!.tenant_id,
    userId: req.user!.id,
    userRole: req.user!.role ?? 'user',
    action,
    entityType: 'customer_order',
    entityId: orderId,
    entityLabel: orderLabel((newValue as any) ?? (oldValue as any) ?? { id: orderId }),
    oldValue,
    newValue,
    note,
  })
}

const createOrderSchema = z.object({
  customer_id:           z.string().uuid().optional().nullable(),
  chat_id:               z.string().uuid().optional().nullable(),
  vehicle_info:          z.object({
    make: z.string().optional(),
    model: z.string().optional(),
    year: z.number().optional(),
    engine_volume: z.string().optional(),
    vin: z.string().optional(),
  }).optional().nullable(),
  comment:               z.string().max(2000).optional().nullable(),
  source:                z.enum(['walk_in', 'messenger', 'telegram_bot', 'mobile_draft', 'phone']).default('walk_in'),
  prepayment:            z.number().int().min(0).default(0),
  prepayment_method:     z.enum(['cash', 'card', 'transfer']).optional().nullable(),
  prepayment_is_fiscal:  z.boolean().default(false),
  parent_draft_id:       z.string().uuid().optional().nullable(),
  exchange_source_order_id: z.string().uuid().optional().nullable(),
  items: z.array(z.object({
    sku:          z.string().max(100).optional().nullable(),
    name:         z.string().min(1).max(500),
    product_id:   z.string().uuid().optional().nullable(),
    supplier_id:  z.string().uuid().optional().nullable(),
    source_type:  z.enum(['warehouse', 'supplier']).default('supplier'),
    item_type:    z.enum(['product', 'service']).default('product'),
    buy_price:    z.number().int().min(0).default(0),
    sell_price:   z.number().int().min(0).default(0),
    qty:          z.number().min(0.001).default(1),
    is_draft_note: z.boolean().default(false),
    expected_date: z.string().optional().nullable(),
    variants:     z.array(z.object({
      brand:          z.string().max(200),
      price:          z.number().int().min(0),
      notes:          z.string().max(500).optional().nullable(),
      is_recommended: z.boolean().default(false),
    })).default([]),
  })).min(0).default([]),
})

// POST /api/v1/customer-orders — створити замовлення
router.post('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const input = parsed.data
    if (input.prepayment > 0) {
      throw new AppError(
        'PAYMENT_IN_POS_ONLY',
        'Передоплата за замовлення приймається тільки через касу',
        422,
      )
    }

    if (input.customer_id) {
      const { data } = await db.from('customers').select('id')
        .eq('id', input.customer_id).eq('tenant_id', req.user!.tenant_id).maybeSingle()
      if (!data) throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    }
    if (input.chat_id) {
      const { data } = await db.from('messenger_chats').select('id')
        .eq('id', input.chat_id).eq('tenant_id', req.user!.tenant_id).maybeSingle()
      if (!data) throw new AppError('CHAT_NOT_FOUND', 'Чат не знайдено', 404)
    }
    if (input.parent_draft_id) {
      const { data } = await db.from('customer_orders').select('id')
        .eq('id', input.parent_draft_id).eq('tenant_id', req.user!.tenant_id).maybeSingle()
      if (!data) throw new AppError('ORDER_NOT_FOUND', 'Батьківську чернетку не знайдено', 404)
    }
    if (input.exchange_source_order_id) {
      const { data: priorExchange, error: priorError } = await db.from('customer_orders')
        .select('*, items:customer_order_items(*)')
        .eq('tenant_id', req.user!.tenant_id)
        .eq('exchange_source_order_id', input.exchange_source_order_id)
        .is('deleted_at', null)
        .maybeSingle()
      if (priorError) throw new AppError('DB_ERROR', priorError.message, 500)
      if (priorExchange) {
        res.status(200).json({ data: priorExchange, replayed: true })
        return
      }
      const { data: sourceOrder } = await db.from('customer_orders')
        .select('id,status,sale_id')
        .eq('id', input.exchange_source_order_id)
        .eq('tenant_id', req.user!.tenant_id)
        .is('deleted_at', null)
        .maybeSingle()
      if (!sourceOrder || sourceOrder.status !== 'completed' || !sourceOrder.sale_id) {
        throw new AppError('EXCHANGE_SOURCE_INVALID', 'Обмін можна створити тільки для виданого замовлення з чеком', 409)
      }
    }

    const supplierIds = [...new Set(input.items.map((item) => item.supplier_id).filter(Boolean) as string[])]
    if (supplierIds.length > 0) {
      const { data } = await db.from('suppliers').select('id')
        .in('id', supplierIds).eq('tenant_id', req.user!.tenant_id)
      if ((data?.length ?? 0) !== supplierIds.length) {
        throw new AppError('SUPPLIER_NOT_FOUND', 'Один або кілька постачальників не знайдено', 404)
      }
    }
    
    // Отримуємо інформацію про продукти для застав
    const productIds = input.items.map(i => i.product_id).filter(Boolean) as string[]
    const { data: prods } = productIds.length > 0
      ? await db.from('products').select('id, requires_core_return, core_deposit_amount, purchase_price')
          .in('id', productIds).eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
      : { data: [] }
    if ((prods?.length ?? 0) !== new Set(productIds).size) {
      throw new AppError('PRODUCT_NOT_FOUND', 'Один або кілька товарів не знайдено', 404)
    }
    const prodMap = new Map((prods ?? []).map((p: any) => [p.id, p]))

    const totalAmount = input.items.reduce((s, i) => {
      const prodData = i.product_id ? prodMap.get(i.product_id) : null
      const coreDeposit = prodData?.requires_core_return ? (prodData.core_deposit_amount ?? 0) : 0
      return s + (i.sell_price * i.qty) + (coreDeposit * i.qty)
    }, 0)

    const { data: order, error: orderErr } = await db
      .from('customer_orders')
      .insert({
        tenant_id: req.user!.tenant_id,
        customer_id: input.customer_id,
        chat_id: input.chat_id ?? null,
        manager_id: req.user!.id,
        vehicle_info: input.vehicle_info ?? null,
        status: 'lead',
        prepayment: 0,
        prepayment_method: input.prepayment_method ?? null,
        prepayment_is_fiscal: false,
        total_amount: totalAmount,
        total_paid: 0,
        comment: input.comment ?? null,
        source: input.source,
        parent_draft_id: input.parent_draft_id ?? null,
        exchange_source_order_id: input.exchange_source_order_id ?? null,
        discount_amount: 0,
      })
      .select()
      .single()

    if (orderErr || !order) throw new AppError('DB_ERROR', orderErr?.message ?? 'Create failed', 500)

    // Один клієнт може мати багато авто: VIN із нового замовлення автоматично
    // потрапляє в його гараж, а не створює окрему картку клієнта.
    await ensureCustomerCar(input.customer_id, input.vehicle_info, req.user!.tenant_id)

    // Додаємо позиції (підтримка variants для чернеток)
    const itemsToInsert = input.items.map((item) => {
      const prodData = item.product_id ? prodMap.get(item.product_id) : null
      const requiresCore = prodData?.requires_core_return ?? false
      const coreDeposit = requiresCore ? (prodData?.core_deposit_amount ?? 0) : 0
      const coreStatus = requiresCore ? 'pending' : 'none'
      return {
        order_id: order.id,
        product_id: item.product_id ?? null,
        sku: item.sku ?? null,
        name: item.name,
        supplier_id: item.supplier_id ?? null,
        source_type: item.source_type,
        item_type: item.item_type,
        item_status: 'pending',
        buy_price: item.buy_price,
        sell_price: item.sell_price,
        qty: item.qty,
        is_draft_note: item.is_draft_note ?? false,
        expected_date: item.expected_date ?? null,
        variants: item.variants && item.variants.length > 0 ? item.variants : [],
        core_deposit_amount: coreDeposit,
        core_return_status: coreStatus,
      }
    })

    const { error: itemsErr } = await db.from('customer_order_items').insert(itemsToInsert)
    if (itemsErr) {
      // rollback order draft
      await db.from('customer_orders').delete().eq('id', order.id).eq('tenant_id', req.user!.tenant_id)
      throw new AppError('DB_ERROR', itemsErr.message, 500)
    }

    // Логуємо дію
    await db.from('order_activity_log').insert({
      order_id: order.id,
      user_id: req.user!.id,
      action: 'created',
      details: { source: input.source, items_count: input.items.length, prepayment: input.prepayment },
    })

    await auditOrder(req, 'order_created', order.id, null, {
      ...order,
      items_count: input.items.length,
    })

    // Резервуємо товари, якщо статус новий або в процесі
    if (order.status === 'new' || order.status === 'in_progress') {
      const { error: reserveErr } = await db.rpc('reserve_order_items', {
        p_tenant_id: req.user!.tenant_id,
        p_order_id: order.id,
        p_user_id: req.user!.id
      })
      if (reserveErr) {
        // Не лишаємо замовлення-привид: без передоплати — повний відкат (items
        // підуть каскадом), з передоплатою — деградація в лід, щоб не втратити
        // слід грошей (термінал/каса вже провели платіж)
        const hasPrepayment = (order.total_paid ?? 0) > 0 || input.prepayment > 0
        if (hasPrepayment) {
          await db.from('customer_orders').update({ status: 'lead' }).eq('id', order.id).eq('tenant_id', req.user!.tenant_id)
        } else {
          await db.from('customer_orders').delete().eq('id', order.id).eq('tenant_id', req.user!.tenant_id)
        }
        if (reserveErr.message.includes('INSUFFICIENT_STOCK')) {
          throw new AppError(
            'INSUFFICIENT_STOCK',
            hasPrepayment
              ? `${reserveErr.message}. Замовлення збережено як лід (передоплату враховано).`
              : reserveErr.message,
            422
          )
        }
        throw new AppError('DB_ERROR', `Failed to reserve order items: ${reserveErr.message}`, 500)
      }
    }

    res.status(201).json({ data: order })
  } catch (err) { next(err) }
})

// GET /api/v1/customer-orders — список замовлень
router.get('/', async (req, res, next) => {
  try {
    const status     = req.query.status as string | undefined
    const customerId = req.query.customer_id as string | undefined
    const chatId     = req.query.chat_id as string | undefined
    const searchRaw  = String(req.query.search ?? '').trim()
    const perPage    = Math.min(parseInt(String(req.query.per_page ?? '200'), 10) || 200, 500)
    const offset     = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)

    let query = db
      .from('customer_orders')
      .select('*, customer:customers(id, phone, full_name, card_barcode), items:customer_order_items(*)')
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)

    if (customerId) query = query.eq('customer_id', customerId)
    if (chatId) query = query.eq('chat_id', chatId)
    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean)
      if (statuses.length === 1) query = query.eq('status', statuses[0])
      else query = query.in('status', statuses)
    }
    if (searchRaw) {
      const safeSearch = searchRaw.replace(/[(),%]/g, ' ').trim()
      const digits = searchRaw.replace(/\D/g, '')
      const numericOrder = searchRaw.replace(/^(ORD-?|#)/i, '')
      const customerIds: string[] = []

      if (safeSearch || digits) {
        const customerOr = [
          ...(safeSearch ? [
            `full_name.ilike.%${safeSearch}%`,
            `phone.ilike.%${safeSearch}%`,
            `card_barcode.ilike.%${safeSearch}%`,
          ] : []),
          ...(digits && digits !== safeSearch ? [
            `phone.ilike.%${digits}%`,
            `card_barcode.ilike.%${digits}%`,
          ] : []),
        ]

        if (customerOr.length > 0) {
          const { data: customers, error: customersError } = await db
            .from('customers')
            .select('id')
            .eq('tenant_id', req.user!.tenant_id)
            .is('deleted_at', null)
            .or(customerOr.join(','))
            .limit(100)

          if (customersError) throw new AppError('DB_ERROR', customersError.message, 500)
          customerIds.push(...(customers ?? []).map((c) => c.id))
        }
      }

      const orderFilters: string[] = []
      const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      if (uuidLike.test(searchRaw)) orderFilters.push(`id.eq.${searchRaw}`)
      if (/^\d+$/.test(numericOrder)) orderFilters.push(`order_number.eq.${Number(numericOrder)}`)
      if (safeSearch) {
        orderFilters.push(`kp_number.ilike.%${safeSearch}%`)
      }
      if (customerIds.length > 0) {
        orderFilters.push(`customer_id.in.(${customerIds.join(',')})`)
      }

      if (orderFilters.length > 0) {
        query = query.or(orderFilters.join(','))
      } else {
        query = query.eq('id', '00000000-0000-0000-0000-000000000000')
      }
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + perPage - 1)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// PUT /api/v1/customer-orders/:id/draft — оновити чернетку (items + comment)
router.put('/:id/draft', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const schema = z.object({
      customer_id: z.string().uuid().optional().nullable(),
      comment:     z.string().max(2000).optional().nullable(),
      vehicle_info: z.any().optional(),
      items: z.array(z.object({
        id:             z.string().uuid().optional(),
        name:           z.string().min(1).max(500),
        sku:            z.string().optional().nullable(),
        qty:            z.number().min(0.001).default(1),
        sell_price:     z.number().int().min(0).default(0),
        is_draft_note:  z.boolean().default(false),
        variants:       z.array(z.object({
          brand:          z.string().max(200),
          price:          z.number().int().min(0),
          notes:          z.string().max(500).optional().nullable(),
          is_recommended: z.boolean().default(false),
        })).default([]),
      })).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const orderId = String(req.params.id)
    const { data: oldOrder, error: oldOrderError } = await db.from('customer_orders')
      .select('*, items:customer_order_items(*)')
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .maybeSingle()
    if (oldOrderError) throw new AppError('DB_ERROR', oldOrderError.message, 500)
    if (!oldOrder) throw new AppError('ORDER_NOT_FOUND', 'Чернетку не знайдено', 404)
    if (!['lead', 'quoted'].includes(oldOrder.status)) {
      throw new AppError('NOT_A_DRAFT', 'Редагувати як чернетку можна лише відкриту чернетку', 409)
    }

    if (parsed.data.customer_id) {
      const { data: customer } = await db.from('customers').select('id')
        .eq('id', parsed.data.customer_id).eq('tenant_id', req.user!.tenant_id).maybeSingle()
      if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    }

    // Оновлюємо основні поля
    const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsed.data.customer_id !== undefined) updateFields.customer_id = parsed.data.customer_id
    if (parsed.data.comment !== undefined) updateFields.comment = parsed.data.comment
    if (parsed.data.vehicle_info !== undefined) updateFields.vehicle_info = parsed.data.vehicle_info

    const { error: draftUpdateError } = await db.from('customer_orders')
      .update(updateFields)
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
    if (draftUpdateError) throw new AppError('DB_ERROR', draftUpdateError.message, 500)

    // Parent was tenant-scoped above; customer_order_items itself has no tenant_id.
    if (parsed.data.items) {
      const { error: deleteError } = await db.from('customer_order_items').delete().eq('order_id', orderId)
      if (deleteError) throw new AppError('DB_ERROR', deleteError.message, 500)

      if (parsed.data.items.length > 0) {
        const { error: insertError } = await db.from('customer_order_items').insert(
          parsed.data.items.map((item) => ({
            order_id: orderId,
            name: item.name,
            sku: item.sku ?? null,
            qty: item.qty,
            sell_price: item.sell_price,
            buy_price: 0,
            source_type: 'supplier',
            item_status: 'pending',
            is_draft_note: item.is_draft_note,
            variants: item.variants,
          }))
        )
        if (insertError) throw new AppError('DB_ERROR', insertError.message, 500)
      }

      const total = parsed.data.items.reduce((sum, item) => sum + item.sell_price * item.qty, 0)
      const { error: totalError } = await db.from('customer_orders')
        .update({ total_amount: total })
        .eq('id', orderId)
        .eq('tenant_id', req.user!.tenant_id)
      if (totalError) throw new AppError('DB_ERROR', totalError.message, 500)
    }

    const { data, error: readError } = await db.from('customer_orders')
      .select('*, customer:customers(id, phone, full_name), items:customer_order_items(*)')
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
      .single()
    if (readError) throw new AppError('DB_ERROR', readError.message, 500)

    await auditOrder(req, 'order_draft_updated', orderId, oldOrder, data)
    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/convert — конвертувати чернетку в замовлення з вибраними варіантами
router.post('/:id/convert', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const convertSchema = z.object({
      items: z.array(z.object({
        item_id: z.string().uuid(),
        selected_variant: z.object({
          brand: z.string().max(200).optional().nullable(),
          price: z.number().int().min(0),
          sku: z.string().max(100).optional().nullable(),
          product_id: z.string().uuid().optional().nullable(),
        })
      })).min(1),
    })

    const parsed = convertSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані конвертації', 422, parsed.error.flatten())

    const draftId = String(req.params.id)

    const { data: draftOrder, error: draftError } = await db.from('customer_orders')
      .select('*, items:customer_order_items(*)')
      .eq('id', draftId)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .maybeSingle()

    if (draftError) throw new AppError('DB_ERROR', draftError.message, 500)
    if (!draftOrder) throw new AppError('NOT_FOUND', 'Чернетку не знайдено', 404)
    if (!['lead', 'quoted'].includes(draftOrder.status)) {
      throw new AppError('NOT_A_DRAFT', 'Перетворити можна лише чернетку', 409)
    }

    const draftItems = (draftOrder.items as any[]) ?? []
    const draftItemsById = new Map(draftItems.map((item) => [String(item.id), item]))
    const requestedIds = parsed.data.items.map((item) => item.item_id)
    if (new Set(requestedIds).size !== requestedIds.length) {
      throw new AppError('VALIDATION_ERROR', 'Одна позиція чернетки вибрана кілька разів', 422)
    }

    const selections = parsed.data.items.map((item) => {
      const draftItem = draftItemsById.get(item.item_id)
      if (!draftItem) {
        throw new AppError('ITEM_NOT_FOUND', 'Позиція не належить цій чернетці', 404)
      }
      return {
        request: item,
        draftItem,
        productId: item.selected_variant.product_id ?? draftItem.product_id ?? null,
      }
    })

    const productIds = [...new Set(selections.map((item) => item.productId).filter(Boolean) as string[])]
    const { data: prods, error: productsError } = productIds.length > 0
      ? await db.from('products').select('id, requires_core_return, core_deposit_amount, purchase_price')
          .in('id', productIds).eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
      : { data: [], error: null }
    if (productsError) throw new AppError('DB_ERROR', productsError.message, 500)
    if ((prods?.length ?? 0) !== productIds.length) {
      throw new AppError('PRODUCT_NOT_FOUND', 'Один або кілька товарів не знайдено', 404)
    }
    const prodMap = new Map((prods ?? []).map((product: any) => [product.id, product]))

    const totalAmount = selections.reduce((sum, selection) => {
      const product = selection.productId ? prodMap.get(selection.productId) : null
      const coreDeposit = product?.requires_core_return ? (product.core_deposit_amount ?? 0) : 0
      return sum + (selection.request.selected_variant.price + coreDeposit) * selection.draftItem.qty
    }, 0)

    // Створюємо нове замовлення
    const { data: newOrder, error: orderErr } = await db.from('customer_orders').insert({
      tenant_id:          req.user!.tenant_id,
      customer_id:        draftOrder.customer_id,
      manager_id:         draftOrder.manager_id,
      vehicle_info:       draftOrder.vehicle_info,
      comment:            draftOrder.comment,
      source:             draftOrder.source || 'walk_in',
      parent_draft_id:    draftId,
      status:             'new',
      total_amount:       totalAmount,
    }).select().single()

    if (orderErr || !newOrder) throw new AppError('DB_ERROR', orderErr?.message ?? 'Convert failed', 500)

    // Вставляємо вибрані позиції як реальні
    const newItems = selections.map(({ request, draftItem, productId }) => {
      const name = request.selected_variant.brand
        ? `${draftItem.name} (${request.selected_variant.brand})`
        : draftItem.name
      const product = productId ? prodMap.get(productId) : null
      const requiresCore = product?.requires_core_return ?? false
      const coreDeposit = requiresCore ? (product?.core_deposit_amount ?? 0) : 0
      const coreStatus = requiresCore ? 'pending' : 'none'
      const buyPrice = product ? (product.purchase_price ?? 0) : (draftItem.buy_price ?? 0)
      return {
        order_id:      newOrder.id,
        product_id:    productId,
        sku:           request.selected_variant.sku || draftItem.sku || null,
        name,
        source_type:   productId ? 'warehouse' : 'supplier',
        item_status:   'pending',
        buy_price:     buyPrice,
        sell_price:    request.selected_variant.price,
        qty:           draftItem.qty,
        is_draft_note: false,
        core_deposit_amount: coreDeposit,
        core_return_status: coreStatus,
      }
    })

    if (newItems.length > 0) {
      const { error: itemsErr } = await db.from('customer_order_items').insert(newItems)
      if (itemsErr) {
        await db.from('customer_orders').delete()
          .eq('id', newOrder.id).eq('tenant_id', req.user!.tenant_id)
        throw new AppError('DB_ERROR', itemsErr.message, 500)
      }
    }

    const { error: reserveError } = await db.rpc('reserve_order_items', {
      p_tenant_id: req.user!.tenant_id,
      p_order_id:  newOrder.id,
      p_user_id:   req.user!.id
    })
    if (reserveError) {
      await db.from('customer_orders').delete()
        .eq('id', newOrder.id).eq('tenant_id', req.user!.tenant_id)
      if (reserveError.message.includes('INSUFFICIENT_STOCK')) {
        throw new AppError('INSUFFICIENT_STOCK', reserveError.message, 422)
      }
      throw new AppError('DB_ERROR', reserveError.message, 500)
    }

    // Додаємо лог активності
    await db.from('order_activity_log').insert({
      order_id: newOrder.id,
      user_id:  req.user!.id,
      action:   'created_from_draft',
      details:  { parent_draft_id: draftId },
    })

    await auditOrder(req, 'order_created_from_draft', newOrder.id, draftOrder, {
      ...newOrder,
      items: newItems,
    }, `Створено з чернетки ${orderLabel(draftOrder)}`)
    res.status(201).json({ data: newOrder })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/send-telegram — відправити КП в Telegram
router.post('/:id/send-telegram', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { data: order } = await db
      .from('customer_orders')
      .select('*, customer:customers(id, full_name, phone, telegram_chat_id), items:customer_order_items(*)')
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .single()

    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)

    const customer = order.customer as any
    if (!customer?.telegram_chat_id) {
      throw new AppError('NO_TELEGRAM', 'Клієнт не має Telegram', 400)
    }

    // Формуємо КП
    const kpNum = order.order_number != null ? `#${order.order_number}` : (order.kp_number ?? `#${order.id.slice(0, 8)}`)
    const vehicle = order.vehicle_info as any
    const vehicleLine = vehicle
      ? `🚗 ${[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ')}${vehicle.vin ? ` | VIN: ${vehicle.vin}` : ''}\n`
      : ''

    const items = (order.items as any[]) ?? []
    let itemsText = ''
    items.forEach((item: any, i: number) => {
      const variants = Array.isArray(item.variants) && item.variants.length > 0
        ? item.variants
        : null

      if (variants) {
        itemsText += `\n*${i + 1}. ${item.name}* (${item.qty} шт)\n`
        variants.forEach((v: any, vi: number) => {
          const star = v.is_recommended ? ' ⭐' : ''
          const price = (v.price / 100).toFixed(0)
          itemsText += `   ${vi + 1}) ${v.brand} — *${price} грн*${star}\n`
          if (v.notes) itemsText += `      ↳ ${v.notes}\n`
        })
      } else if (!item.is_draft_note) {
        const price = item.sell_price > 0 ? ` — *${(item.sell_price / 100).toFixed(0)} грн*` : ''
        itemsText += `\n${i + 1}. ${item.name} (${item.qty} шт)${price}\n`
      }
    })

    const msg = `🔧 *Комерційна пропозиція ${kpNum}*\n${vehicleLine}${itemsText}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Будь ласка, оберіть варіанти і напишіть нам або зателефонуйте. Чекаємо! 🚀`

    // Відправляємо через telegramBot
    const { sendTelegramMessage } = await import('../services/telegramBot.js')
    const ok = await sendTelegramMessage(parseInt(customer.telegram_chat_id), msg)

    if (!ok) throw new AppError('SEND_FAILED', 'Не вдалося відправити. Перевірте підключення Telegram.', 502)

    await db.from('customer_orders').update({
      sent_to_telegram_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('tenant_id', req.user!.tenant_id)

    await db.from('order_activity_log').insert({
      order_id: req.params.id,
      user_id: req.user!.id,
      action: 'kp_sent_telegram',
      details: { telegram_chat_id: customer.telegram_chat_id },
    })

    await auditOrder(req, 'order_sent_to_telegram', String(req.params.id), {
      sent_to_telegram_at: order.sent_to_telegram_at,
    }, {
      sent_to_telegram_at: new Date().toISOString(),
      telegram_chat_id: customer.telegram_chat_id,
    })
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/payments — додати платіж
router.post('/:id/payments', requireRole('owner', 'admin', 'cashier'), async (req, res, next) => {
  try {
    const schema = z.object({
      payment_id: z.string().uuid(),
      amount:     z.number().int().min(1),
      method:     z.enum(['cash', 'card', 'transfer', 'account']),
      is_fiscal:  z.boolean().default(false),
      shift_id:   z.string().uuid().optional().nullable(),
      notes:      z.string().max(500).optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Невірні дані платежу', 422, parsed.error.flatten())
    }

    const result = await addOrderPayment({
      ...parsed.data,
      order_id: String(req.params.id),
      tenant_id: req.user!.tenant_id,
      user_id: req.user!.id,
    })

    if (!result.replayed) {
      await auditOrder(
        req,
        'order_payment_added',
        String(req.params.id),
        result.order_before,
        {
          ...result.order_after,
          payment: result.payment,
        },
      )
    }

    res.status(result.replayed ? 200 : 201).json({
      data: result.payment,
      replayed: result.replayed,
    })
  } catch (err) { next(err) }
})

// GET /api/v1/customer-orders/:id/payments — список платежів
router.get('/:id/payments', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('order_payments')
      .select('*')
      .eq('order_id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: true })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

/**
 * Оновлює загальний статус замовлення на основі статусів позицій
 */
export async function updateOrderStatus(orderId: string, tenantId: string, userId: string) {
  const { data: currentOrder } = await db.from('customer_orders').select('status')
    .eq('id', orderId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!currentOrder || ['completed', 'canceled', 'archived'].includes(currentOrder.status)) return

  // Parent is tenant-scoped above; customer_order_items has no tenant_id column.
  const { data: items } = await db
    .from('customer_order_items')
    .select('item_status')
    .eq('order_id', orderId)

  const activeItems = (items ?? []).filter((item) => item.item_status !== 'canceled')
  if (activeItems.length === 0) return

  const allReady = activeItems.every((item) => ['arrived', 'handed'].includes(item.item_status))
  const hasPending = activeItems.some((item) => item.item_status === 'pending')
  const hasOrdered = activeItems.some((item) => item.item_status === 'ordered')

  let newStatus: string
  // Even if every line was manually marked handed, only complete_customer_order may
  // set completed because it creates the receipt and writes off stock atomically.
  if (allReady) newStatus = 'ready'
  else if (hasOrdered) newStatus = 'ordered'
  else if (hasPending) newStatus = 'new'
  else newStatus = 'new'

  if (currentOrder.status === newStatus) {
    const { error: touchError } = await db.from('customer_orders')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('tenant_id', tenantId)
    if (touchError) throw new AppError('DB_ERROR', touchError.message, 500)
    return
  }

  // Встановлюємо дедлайн при переході в ready
  if (newStatus === 'ready') {
    const { data: settings } = await db.from('shop_settings').select('pickup_deadline_days')
      .eq('tenant_id', tenantId).maybeSingle()
    const days = (settings as any)?.pickup_deadline_days ?? 14
    const deadline = new Date(Date.now() + days * 86400000).toISOString()
    await db.from('customer_orders').update({
      pickup_deadline_at: deadline,
    }).eq('id', orderId).eq('tenant_id', tenantId)
  }

  // Оновлюємо статус через RPC
  const { error: statusErr } = await db.rpc('update_customer_order_status', {
    p_tenant_id: tenantId,
    p_order_id: orderId,
    p_status: newStatus,
    p_user_id: userId
  })

  if (statusErr) {
    logger.error({ orderId, newStatus, error: statusErr.message }, 'Failed to update order status via RPC in updateOrderStatus')
    return
  }

  // Сповіщення в Telegram про зміну статусу
  notifyStatusUpdate(orderId, newStatus, tenantId).catch(() => {})

  // Авто-Telegram при готовності
  if (newStatus === 'ready') {
    try {
      const { data: order } = await db
        .from('customer_orders')
        .select('*, customer:customers(id, full_name, phone)')
        .eq('id', orderId)
        .eq('tenant_id', tenantId)
        .single()

      if (order?.customer) {
        const { data: chat } = await db
          .from('messenger_chats')
          .select('platform_chat_id, channel:messenger_channels(id, platform, credentials)')
          .eq('customer_id', order.customer.id)
          .eq('tenant_id', tenantId)
          .maybeSingle()

        if (chat) {
          const chatData = chat as any
          const channel = Array.isArray(chatData.channel) ? chatData.channel[0] : chatData.channel
          if (channel?.platform === 'telegram' && channel?.credentials?.token) {
            const remaining = order.total_amount - (order.discount_amount ?? 0) - (order.total_paid ?? order.prepayment ?? 0)
            const msg = `✅ Доброго дня${order.customer.full_name ? ', ' + order.customer.full_name : ''}! Ваше замовлення прибуло в магазин!${remaining > 0 ? ' Залишок до доплати: ' + (remaining / 100).toFixed(2) + ' грн.' : ''} Чекаємо на вас!`

            const { Telegraf } = await import('telegraf')
            const bot = new Telegraf(channel.credentials.token)
            await bot.telegram.sendMessage(chatData.platform_chat_id, msg)

            await db.from('order_activity_log').insert({
              order_id: orderId, user_id: null, action: 'telegram_sent',
              details: { message: 'order_ready_notification' },
            })
          }
        }
      }
    } catch {}
  }
}

// PATCH /api/v1/customer-orders/:id/items/:itemId/status — змінити статус позиції
router.patch('/:id/items/:itemId/status', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const schema = z.object({
      item_status: z.enum(['pending', 'ordered', 'arrived', 'canceled']),
      supplier_expected_date: z.string().optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)
    const { data: oldItem, error: oldItemError } = await db.from('customer_order_items')
      .select('*, order:customer_orders!inner(tenant_id,status)')
      .eq('id', req.params.itemId)
      .eq('order_id', req.params.id)
      .eq('order.tenant_id', req.user!.tenant_id)
      .maybeSingle()
    if (oldItemError) throw new AppError('DB_ERROR', oldItemError.message, 500)
    if (!oldItem) throw new AppError('ITEM_NOT_FOUND', 'Позицію замовлення не знайдено', 404)
    const parentOrder = Array.isArray((oldItem as any).order) ? (oldItem as any).order[0] : (oldItem as any).order
    if (['completed', 'canceled', 'archived'].includes(String(parentOrder?.status ?? ''))) {
      throw new AppError('ORDER_IMMUTABLE', 'Позиції завершеного, скасованого або архівного замовлення змінювати не можна', 409)
    }

    const updateData: Record<string, unknown> = {
      item_status: parsed.data.item_status,
    }
    if (parsed.data.supplier_expected_date) {
      updateData.expected_date = parsed.data.supplier_expected_date
    }

    const { error } = await db.from('customer_order_items').update(updateData)
      .eq('id', req.params.itemId).eq('order_id', req.params.id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    await db.from('customer_orders')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('tenant_id', req.user!.tenant_id)

    // Логуємо
    await db.from('order_activity_log').insert({
      order_id: req.params.id,
      user_id: req.user!.id,
      action: `item_status:${parsed.data.item_status}`,
      details: { item_id: req.params.itemId },
    })

    // ORD-19/ORD-14: ланцюг «Замовлено → лист очікування → нагадування при надходженні»
    if (parsed.data.item_status === 'ordered' || parsed.data.item_status === 'arrived') {
      try {
        const { data: item } = await db
          .from('customer_order_items')
          .select('product_id, order:customer_orders!inner(customer_id)')
          .eq('id', req.params.itemId)
          .eq('order_id', req.params.id)
          .eq('order.tenant_id', req.user!.tenant_id)
          .maybeSingle()
        const productId = (item as any)?.product_id
        const customerId = (item as any)?.order?.customer_id
        if (productId) {
          if (parsed.data.item_status === 'ordered' && customerId) {
            // Реєструємо клієнта в листі очікування на цей товар (ORD-19)
            const { data: existing } = await db.from('product_waitlist').select('id')
              .eq('product_id', productId).eq('customer_id', customerId)
              .eq('tenant_id', req.user!.tenant_id).maybeSingle()
            if (!existing) {
              await db.from('product_waitlist').insert({
                tenant_id: req.user!.tenant_id, product_id: productId,
                customer_id: customerId, status: 'waiting',
              })
            }
          } else if (parsed.data.item_status === 'arrived') {
            // Надходження очікуваного товару — авто-сповіщення тих, хто чекав (ORD-14)
            notifyWaitlistCustomers(productId, req.user!.tenant_id).catch(() => {})
          }
        }
      } catch (chainErr) {
        logger.error({ error: chainErr instanceof Error ? chainErr.message : chainErr }, 'Waitlist chain error')
      }
    }

    // Скасування/відновлення позиції: перераховуємо суму замовлення по активних
    // позиціях і оновлюємо складські резерви (скасована позиція не тримає сток)
    if (parsed.data.item_status === 'canceled' || parsed.data.item_status === 'pending') {
      const { data: allItems } = await db
        .from('customer_order_items')
        .select('item_status, sell_price, qty, core_deposit_amount')
        .eq('order_id', req.params.id)
      if (allItems) {
        const newTotal = allItems
          .filter((i) => i.item_status !== 'canceled')
          .reduce((s, i) => s + i.sell_price * i.qty + (i.core_deposit_amount ?? 0) * i.qty, 0)
        await db.from('customer_orders').update({ total_amount: newTotal }).eq('id', req.params.id).eq('tenant_id', req.user!.tenant_id)
      }
      await db.rpc('reserve_order_items', {
        p_tenant_id: req.user!.tenant_id,
        p_order_id: req.params.id,
        p_user_id: req.user!.id,
      }).then(({ error: resErr }) => {
        if (resErr) logger.error({ error: resErr.message, orderId: req.params.id }, 'Failed to refresh reserves after item status change')
      })
    }

    // Авто-оновлення загального статусу
    await updateOrderStatus(String(req.params.id), req.user!.tenant_id, req.user!.id)

    await auditOrder(req, 'order_item_status_changed', String(req.params.id), oldItem, {
      ...oldItem,
      ...updateData,
    }, `Позиція: ${oldItem?.name ?? req.params.itemId}`)
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// PATCH /api/v1/customer-orders/:id/status — змінити статус замовлення
router.patch('/:id/status', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const schema = z.object({
      status: z.enum(['lead', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready']),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)

    // Отримуємо поточний статус перед оновленням
    const { data: oldOrder } = await db
      .from('customer_orders')
      .select('status')
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .maybeSingle()
    if (!oldOrder) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
    if (['completed', 'canceled', 'archived'].includes(oldOrder.status)) {
      throw new AppError('ORDER_IMMUTABLE', 'Статус завершеного, скасованого або архівного замовлення змінювати не можна', 409)
    }

    const { data: order, error } = await db.rpc('update_customer_order_status', {
      p_tenant_id: req.user!.tenant_id,
      p_order_id: req.params.id,
      p_status: parsed.data.status,
      p_user_id: req.user!.id
    })

    if (error) {
      if (error.message.includes('INSUFFICIENT_STOCK')) {
        throw new AppError('INSUFFICIENT_STOCK', error.message, 422)
      }
      if (error.message.includes('NOT_FOUND')) {
        throw new AppError('NOT_FOUND', error.message, 404)
      }
      throw new AppError('DB_ERROR', error.message, 500)
    }

    await db.from('order_activity_log').insert({
      order_id: req.params.id,
      user_id: req.user!.id,
      action: 'status_changed',
      details: { new_status: parsed.data.status },
    })

    await auditOrder(req, 'order_status_changed', String(req.params.id), {
      status: oldOrder?.status,
    }, {
      status: parsed.data.status,
    })

    // Сповіщення в Telegram при зміні статусу менеджером
    notifyStatusUpdate(String(req.params.id), parsed.data.status, req.user!.tenant_id).catch(() => {})

    res.json({ data: order })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/complete — фінальний розрахунок та видача
router.post('/:id/complete', requireRole('owner', 'admin', 'cashier'), async (req, res, next) => {
  try {
    const schema = z.object({
      payment_method: z.enum(['cash', 'card', 'mixed']),
      cash_amount: z.number().int().min(0).default(0),
      card_amount: z.number().int().min(0).default(0),
      is_fiscal: z.boolean().default(false),
      shift_id: z.string().uuid().optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const { data: order, error: orderError } = await db.from('customer_orders')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .maybeSingle()
    if (orderError) throw new AppError('DB_ERROR', orderError.message, 500)
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
    if (order.status === 'completed' && order.sale_id) {
      res.json({ data: { success: true, remaining: 0, sale_id: order.sale_id, replayed: true } })
      return
    }

    const totalPaid = Math.max(order.total_paid ?? 0, order.prepayment ?? 0)
    const remaining = order.total_amount - (order.discount_amount ?? 0) - totalPaid

    if (remaining > 0) {
      throw new AppError('INCOMPLETE_PAYMENT', 'Не всі оплати проведено. Використайте POST /:id/payments для внесення платежів', 400)
    }
    if (remaining < 0) {
      throw new AppError(
        'ORDER_OVERPAID',
        `Передоплата перевищує суму замовлення на ${(Math.abs(remaining) / 100).toFixed(2)} грн. Поверніть надлишок або зарахуйте його на рахунок клієнта.`,
        409,
      )
    }

    // E-3: атомарне завершення з створенням sale-запису
    const { data: completionData, error: completionErr } = await db.rpc('complete_customer_order', {
      p_tenant_id:      req.user!.tenant_id,
      p_order_id:       order.id,
      p_cashier_id:     req.user!.id,
      p_shift_id:       parsed.data.shift_id ?? null,
      p_payment_method: parsed.data.payment_method,
      p_cash_amount:    parsed.data.cash_amount,
      p_card_amount:    parsed.data.card_amount,
    })

    if (completionErr) {
      if (completionErr.message.includes('INSUFFICIENT_STOCK')) {
        throw new AppError('INSUFFICIENT_STOCK', completionErr.message, 422)
      }
      throw new AppError('DB_ERROR', completionErr.message, 500)
    }

    const result = typeof completionData === 'string' ? JSON.parse(completionData) : completionData
    const saleId = result?.sale_id ?? null
    const replayed = result?.replayed === true

    if (!replayed) {
      await db.from('order_activity_log').insert({
        order_id: order.id,
        user_id: req.user!.id,
        action: 'completed',
        details: { paid: remaining, method: parsed.data.payment_method, fiscal: parsed.data.is_fiscal, manager_id: order.manager_id, sale_id: saleId },
      })

      await auditOrder(req, 'order_completed', order.id, order, {
        ...order,
        status: 'completed',
        sale_id: saleId,
        payment_method: parsed.data.payment_method,
      })

      notifyStatusUpdate(order.id, 'completed', req.user!.tenant_id).catch(() => {})

      try {
        await calculateAndRecordCommission(order.id, req.user!.tenant_id, req.user!.id)
      } catch (commErr: any) {
        logger.error({ orderId: order.id, error: commErr.message }, 'Failed to calculate manager commission')
      }
    }

    res.json({ data: { success: true, remaining: Math.max(0, remaining), sale_id: saleId, replayed } })
  } catch (err) { next(err) }
})

// GET /api/v1/customer-orders/pending-items?supplier_id= — список позицій для приймання
// ВАЖЛИВО: цей роут має бути ПЕРЕД GET /:id, щоб не перехоплювався як wildcard
router.get('/pending-items', async (req, res, next) => {
  try {
    const supplierId = String(req.query.supplier_id ?? '')
    if (!supplierId) throw new AppError('VALIDATION_ERROR', 'supplier_id обов\'язковий', 400)

    const { data, error } = await db
      .from('customer_order_items')
      .select('*, order:customer_orders!inner(id, customer_id, total_amount, prepayment, customer:customers(id, phone, full_name))')
      .eq('item_status', 'ordered')
      .eq('supplier_id', supplierId)
      .eq('order.tenant_id', req.user!.tenant_id)
      .is('order.deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// GET /api/v1/customer-orders/:id — деталі замовлення
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('customer_orders')
      .select(`
        *,
        customer:customers(id, phone, full_name),
        items:customer_order_items(*),
        activity:order_activity_log(id, action, details, created_at, user_id)
      `)
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .single()

    if (error || !data) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)

    // JOIN profile details for activity log (P1 Fix 11)
    try {
      const users = await adminService.listUsers(req.user!.tenant_id)
      const usersMap = new Map(users.map(u => [u.id, u]))
      if (data.activity) {
        data.activity = data.activity.map((act: any) => {
          const user = usersMap.get(act.user_id)
          return {
            ...act,
            user_name: user?.full_name ?? '',
            user_phone: user?.phone ?? '',
          }
        })
      }
    } catch (usersErr) {
      logger.error({ error: usersErr }, 'Failed to fetch user list for activity log mapping')
    }

    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/bulk-arrival — масове приймання
router.post('/bulk-arrival', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const schema = z.object({ item_ids: z.array(z.string().uuid()).min(1) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const items = await markOrderItemsArrived({
      tenant_id: req.user!.tenant_id,
      item_ids: parsed.data.item_ids,
    })
    const orderIds = [...new Set(items.map((item) => item.order_id))]
    const productIds = [...new Set(items.map((item) => item.product_id).filter(Boolean) as string[])]

    for (const productId of productIds) {
      notifyWaitlistCustomers(productId, req.user!.tenant_id).catch(() => {})
    }
    for (const orderId of orderIds) {
      await updateOrderStatus(orderId, req.user!.tenant_id, req.user!.id)
      await db.from('order_activity_log').insert({
        order_id: orderId,
        user_id: req.user!.id,
        action: 'bulk_arrival',
        details: { items_count: items.filter((item) => item.order_id === orderId).length },
      })
      await auditOrder(req, 'order_items_bulk_arrived', orderId, null, {
        item_ids: items.filter((item) => item.order_id === orderId).map((item) => item.id),
        items_count: items.filter((item) => item.order_id === orderId).length,
      })
    }

    res.json({ data: { updated: items.length, orders: orderIds.length } })
  } catch (err) { next(err) }
})
// POST /api/v1/customer-orders/:id/cancel — скасувати без втрати фінансової історії
router.post('/:id/cancel', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const schema = z.object({
      refund_prepayment: z.boolean().default(false),
      keep_as_credit: z.boolean().default(false),
      reason: z.string().max(500).optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const result = await cancelOrderSafely({
      order_id: String(req.params.id),
      tenant_id: req.user!.tenant_id,
      user_id: req.user!.id,
      refund_prepayment: parsed.data.refund_prepayment,
      keep_as_credit: parsed.data.keep_as_credit,
      reason: parsed.data.reason,
    })

    if (!result.replayed) {
      await auditOrder(req, 'order_canceled', String(req.params.id), result.order_before, result.order_after)
      notifyStatusUpdate(String(req.params.id), 'canceled', req.user!.tenant_id).catch(() => {})
    }
    res.json({ data: { success: true, payment_preserved: result.paid_amount, replayed: result.replayed } })
  } catch (err) { next(err) }
})

// PUT /api/v1/customer-orders/:id — оновити замовлення
router.put('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const schema = z.object({
      comment:               z.string().max(2000).optional().nullable(),
      vehicle_info:          z.object({
        make: z.string().optional(),
        model: z.string().optional(),
        year: z.number().optional(),
        engine_volume: z.string().optional(),
        vin: z.string().optional(),
      }).optional().nullable(),
      customer_id:           z.string().uuid().optional().nullable(),
      prepayment:            z.number().int().min(0).optional(),
      prepayment_method:     z.enum(['cash', 'card', 'transfer']).optional().nullable(),
      prepayment_is_fiscal:  z.boolean().optional(),
      items: z.array(z.object({
        id:             z.string().uuid().optional(),
        name:           z.string().min(1).max(500),
        sku:            z.string().optional().nullable(),
        product_id:     z.string().uuid().optional().nullable(),
        supplier_id:    z.string().uuid().optional().nullable(),
        source_type:    z.enum(['warehouse', 'supplier']).default('supplier'),
        item_type:      z.enum(['product', 'service']).default('product'),
        item_status:    z.enum(['pending', 'ordered', 'arrived', 'canceled']).optional(),
        buy_price:      z.number().int().min(0).default(0),
        sell_price:     z.number().int().min(0).default(0),
        qty:            z.number().min(0.001).default(1),
        is_draft_note:  z.boolean().default(false),
        expected_date:  z.string().optional().nullable(),
      })).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const orderId = String(req.params.id)

    // Отримуємо поточне замовлення
    const { data: order, error: orderError } = await db.from('customer_orders')
      .select('*, items:customer_order_items(*)')
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .maybeSingle()
    if (orderError) throw new AppError('DB_ERROR', orderError.message, 500)
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
    if (['completed', 'canceled', 'archived'].includes(order.status)) {
      throw new AppError('ORDER_IMMUTABLE', 'Завершене, скасоване або архівне замовлення не можна редагувати', 409)
    }

    // Оновлюємо основні поля
    const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsed.data.comment !== undefined) updateFields.comment = parsed.data.comment
    if (parsed.data.vehicle_info !== undefined) updateFields.vehicle_info = parsed.data.vehicle_info
    if (parsed.data.customer_id !== undefined) updateFields.customer_id = parsed.data.customer_id
    if ((parsed.data.prepayment ?? 0) > 0) {
      throw new AppError(
        'PAYMENT_IN_POS_ONLY',
        'Оплату замовлення не можна змінювати у формі. Використайте касу.',
        422,
      )
    }
    if (parsed.data.customer_id) {
      const { data: customer } = await db.from('customers').select('id')
        .eq('id', parsed.data.customer_id)
        .eq('tenant_id', req.user!.tenant_id)
        .is('deleted_at', null)
        .maybeSingle()
      if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    }

    // Оновлюємо позиції
    if (parsed.data.items) {
      // Отримуємо інформацію про продукти для застав
      const productIds = parsed.data.items.map(i => i.product_id).filter(Boolean) as string[]
      const uniqueProductIds = [...new Set(productIds)]
      const { data: prods, error: productsError } = uniqueProductIds.length > 0
        ? await db.from('products').select('id, requires_core_return, core_deposit_amount')
            .in('id', uniqueProductIds).eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
        : { data: [], error: null }
      if (productsError) throw new AppError('DB_ERROR', productsError.message, 500)
      if ((prods?.length ?? 0) !== uniqueProductIds.length) {
        throw new AppError('PRODUCT_NOT_FOUND', 'Один або кілька товарів не знайдено', 404)
      }
      const prodMap = new Map((prods ?? []).map((product: any) => [product.id, product]))

      const supplierIds = [...new Set(parsed.data.items.map((item) => item.supplier_id).filter(Boolean) as string[])]
      if (supplierIds.length > 0) {
        const { data: suppliers, error: suppliersError } = await db.from('suppliers').select('id')
          .in('id', supplierIds).eq('tenant_id', req.user!.tenant_id)
        if (suppliersError) throw new AppError('DB_ERROR', suppliersError.message, 500)
        if ((suppliers?.length ?? 0) !== supplierIds.length) {
          throw new AppError('SUPPLIER_NOT_FOUND', 'Один або кілька постачальників не знайдено', 404)
        }
      }

      // Розраховуємо total_amount (включаючи заставу)
      const totalAmount = parsed.data.items.reduce((s, i) => {
        const prodData = i.product_id ? prodMap.get(i.product_id) : null
        const coreDeposit = prodData?.requires_core_return ? (prodData.core_deposit_amount ?? 0) : 0
        return s + (i.sell_price * i.qty) + (coreDeposit * i.qty)
      }, 0)
      updateFields.total_amount = totalAmount

      // Зберігаємо стан застав старих позицій — інакше редагування замовлення
      // скине returned/refunded назад у pending і заставу можна буде виплатити вдруге
      const { data: oldItems } = await db
        .from('customer_order_items')
        .select('id, item_status, expected_date, product_id, core_return_status, core_deposit_amount')
        .eq('order_id', orderId)
      const oldCoreMap = new Map(
        (oldItems ?? [])
          .filter((i) => i.product_id && i.core_return_status && i.core_return_status !== 'none')
          .map((i) => [i.product_id as string, i])
      )
      // Зберігаємо статус/очікувану дату наявних позицій за їх id — щоб inline-
      // редагування (ціна/к-сть/назва) НЕ скидало «замовлено/прийшло» назад у pending
      const oldByIdMap = new Map(
        (oldItems ?? []).map((i) => [i.id as string, i])
      )
      const foreignItem = parsed.data.items.find((item) => item.id && !oldByIdMap.has(item.id))
      if (foreignItem) {
        throw new AppError('ITEM_NOT_FOUND', 'Позиція не належить цьому замовленню', 404)
      }

      // Видаляємо старі позиції тільки після tenant-scoped перевірки батьківського замовлення.
      const { error: deleteItemsError } = await db.from('customer_order_items').delete().eq('order_id', orderId)
      if (deleteItemsError) throw new AppError('DB_ERROR', deleteItemsError.message, 500)

      if (parsed.data.items.length > 0) {
        const { error: insertItemsError } = await db.from('customer_order_items').insert(
          parsed.data.items.map((item) => {
            const prodData = item.product_id ? prodMap.get(item.product_id) : null
            const requiresCore = prodData?.requires_core_return ?? false
            const coreDeposit = requiresCore ? (prodData?.core_deposit_amount ?? 0) : 0
            const oldCore = item.product_id ? oldCoreMap.get(item.product_id) : undefined
            const coreStatus = oldCore ? oldCore.core_return_status : (requiresCore ? 'pending' : 'none')
            // Наявна позиція (є id у запиті) — зберігаємо її поточний статус
            const prev = item.id ? oldByIdMap.get(item.id) : undefined
            const keptStatus = prev && prev.item_status !== 'canceled' ? prev.item_status : (prev?.item_status ?? 'pending')
            return {
              order_id: orderId,
              product_id: item.product_id ?? null,
              supplier_id: item.supplier_id ?? null,
              name: item.name,
              sku: item.sku ?? null,
              qty: item.qty,
              sell_price: item.sell_price,
              buy_price: item.buy_price,
              source_type: item.supplier_id ? 'supplier' : 'warehouse',
              item_type: item.item_type,
              item_status: item.item_status ?? (prev ? keptStatus : 'pending'),
              is_draft_note: item.is_draft_note,
              expected_date: item.expected_date ?? prev?.expected_date ?? null,
              core_deposit_amount: oldCore ? oldCore.core_deposit_amount : coreDeposit,
              core_return_status: coreStatus,
            }
          })
        )
        if (insertItemsError) throw new AppError('DB_ERROR', insertItemsError.message, 500)
      }
    }

    const { error: updateError } = await db.from('customer_orders')
      .update(updateFields)
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
    if (updateError) throw new AppError('DB_ERROR', updateError.message, 500)

    await ensureCustomerCar(
      parsed.data.customer_id === undefined ? order.customer_id : parsed.data.customer_id,
      parsed.data.vehicle_info === undefined ? order.vehicle_info : parsed.data.vehicle_info,
      req.user!.tenant_id,
    )

    // Перезапускаємо резервування товарів, якщо статус новий або в процесі
    if (order.status === 'new' || order.status === 'in_progress') {
      await db.rpc('reserve_order_items', {
        p_tenant_id: req.user!.tenant_id,
        p_order_id: orderId,
        p_user_id: req.user!.id
      })
    }

    // Логуємо дію
    await db.from('order_activity_log').insert({
      order_id: orderId,
      user_id: req.user!.id,
      action: 'updated',
      details: { items_count: parsed.data.items?.length, prepayment: parsed.data.prepayment },
    })

    const { data: updatedOrder, error: updatedOrderError } = await db.from('customer_orders')
      .select('*, customer:customers(id, phone, full_name), items:customer_order_items(*)')
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
      .single()
    if (updatedOrderError) throw new AppError('DB_ERROR', updatedOrderError.message, 500)

    await auditOrder(req, 'order_updated', orderId, order, updatedOrder)
    res.json({ data: updatedOrder })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customer-orders/:id — безпечно приховати замовлення.
// Фінансові та складські зв'язки не стираємо; повний знімок лишається в аудиті.
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const orderId = String(req.params.id)

    const { data: order } = await db.from('customer_orders')
      .select('*, customer:customers(id,phone,full_name), items:customer_order_items(*)')
      .eq('id', orderId)
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)
      .single()
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)

    const { data: payments, error: paymentsError } = await db.from('order_payments')
      .select('id,amount')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('order_id', orderId)
      .is('deleted_at', null)
    if (paymentsError) throw new AppError('DB_ERROR', paymentsError.message, 500)
    const paidInLedger = (payments ?? []).reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0)
    if (!['lead', 'quoted', 'new'].includes(order.status)
      || Number(order.prepayment ?? 0) !== 0
      || Number(order.total_paid ?? 0) !== 0
      || paidInLedger !== 0
      || (payments?.length ?? 0) > 0
      || order.sale_id) {
      throw new AppError('ORDER_DELETE_FORBIDDEN', 'Видалити можна лише неоплачений чернетковий заказ. Інший заказ можна скасувати або архівувати.', 409)
    }

    const deletedAt = new Date().toISOString()
    const { error } = await db.from('customer_orders').update({
      deleted_at: deletedAt,
      deleted_by: req.user!.id,
      updated_at: deletedAt,
    }).eq('id', orderId).eq('tenant_id', req.user!.tenant_id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Активне приховане замовлення більше не повинно утримувати товар у резерві.
    if (!['completed', 'canceled'].includes(order.status)) {
      await db.from('inventory_reserves')
        .update({ released_at: deletedAt })
        .eq('order_id', orderId)
        .is('released_at', null)
    }

    await auditOrder(req, 'order_deleted', orderId, order, {
      id: orderId,
      deleted_at: deletedAt,
      deleted_by: req.user!.id,
    }, `Видалено зі списку: ${orderLabel(order)}`)

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router


