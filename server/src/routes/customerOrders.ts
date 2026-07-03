import { Router, type Request, type Response, type NextFunction } from 'express'
import * as adminService from '../services/adminService.js'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { notifyStatusUpdate } from '../services/telegramBot.js'
import { calculateAndRecordCommission } from '../services/commissionService.js'
import { getTerminalAdapter, getFiscalAdapter } from '../services/integrations/adapterFactory.js'
import { notifyWaitlistCustomers } from './waitlist.js'
import { createSupplierPOsForOrder } from '../services/supplierService.js'
import { logAction } from '../services/auditService.js'

const router = Router()
router.use(requireAuth)

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
  discount_amount:       z.number().int().min(0).default(0),
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

    // Термінальна перевірка передоплати ПЕРЕД створенням замовлення в БД (Оновлено P2 Fix 13)
    let bankAuthCode: string | null = null
    let terminalRrn:  string | null = null
    let finalIsFiscal = input.prepayment_is_fiscal

    const isCardPrepayment = input.prepayment > 0 && input.prepayment_method === 'card'

    // Створюємо замовлення спочатку в статусі 'lead' (чернетка), якщо це карткова передоплата
    const initialStatus = isCardPrepayment ? 'lead' : (input.prepayment > 0 ? 'new' : 'lead')
    const initialPrepayment = isCardPrepayment ? 0 : input.prepayment
    const initialIsFiscal = isCardPrepayment ? false : finalIsFiscal

    const { data: order, error: orderErr } = await db
      .from('customer_orders')
      .insert({
        tenant_id: req.user!.tenant_id,
        customer_id: input.customer_id,
        chat_id: input.chat_id ?? null,
        manager_id: req.user!.id,
        vehicle_info: input.vehicle_info ?? null,
        status: initialStatus,
        prepayment: initialPrepayment,
        prepayment_method: input.prepayment_method ?? null,
        prepayment_is_fiscal: initialIsFiscal,
        total_amount: totalAmount,
        total_paid: initialPrepayment,
        comment: input.comment ?? null,
        source: input.source,
        parent_draft_id: input.parent_draft_id ?? null,
        discount_amount: input.discount_amount ?? 0,
      })
      .select()
      .single()

    if (orderErr || !order) throw new AppError('DB_ERROR', orderErr?.message ?? 'Create failed', 500)

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
      await db.from('customer_orders').delete().eq('id', order.id)
      throw new AppError('DB_ERROR', itemsErr.message, 500)
    }

    // Якщо це передоплата карткою — проводимо транзакцію на терміналі
    if (isCardPrepayment) {
      try {
        finalIsFiscal = true // Термінал -> 100% ПРРО
        const { getSettings } = await import('../services/adminService.js')
        const settings = await getSettings(req.user!.tenant_id).catch(() => null)

        if (settings && settings.bank_terminal_enabled) {
          const terminalAdapter = getTerminalAdapter(settings)
          if (terminalAdapter) {
            const terminalResult = await terminalAdapter.processPayment(
              input.prepayment,
              "PREPAY-" + order.id
            )
            if (!terminalResult.success) {
              throw new AppError('TERMINAL_DECLINED', terminalResult.error ?? 'Термінал відхилив оплату', 402)
            }
            bankAuthCode = terminalResult.authCode
            terminalRrn = terminalResult.rrn ?? null
          }
        }

        // Транзакція успішна! Активуємо замовлення та оновлюємо передоплату
        const { error: updateErr } = await db
          .from('customer_orders')
          .update({
            status: 'new',
            prepayment: input.prepayment,
            total_paid: input.prepayment,
            prepayment_is_fiscal: true,
          })
          .eq('id', order.id)

        if (updateErr) throw new AppError('DB_ERROR', updateErr.message, 500)

        // Оновимо об'єкт order для подальшого коду
        order.status = 'new'
        order.prepayment = input.prepayment
        order.total_paid = input.prepayment
        order.prepayment_is_fiscal = true
      } catch (termErr) {
        // У разі відхилення терміналом або іншої помилки — видаляємо створену чернетку замовлення
        await db.from('customer_orders').delete().eq('id', order.id)
        throw termErr
      }
    }

    // Якщо є передоплата — фіскалізуємо ПРРО та записуємо платіж
    if (input.prepayment > 0) {
      let fiscalNumber: string | null = null
      let fiscalQrUrl:  string | null = null

      if (finalIsFiscal) {
        try {
          const { getSettings } = await import('../services/adminService.js')
          const settings = await getSettings(req.user!.tenant_id).catch(() => null)
          if (settings) {
            const fiscalAdapter = getFiscalAdapter(settings)
            const fiscalResult = await fiscalAdapter.fiscalize(
              order.id,
              "PREPAY-" + order.id.slice(0, 8),
              input.prepayment,
              [{ name: "Передоплата замовлення", qty: 1, unit_price: input.prepayment, discount: 0 }],
              input.prepayment_method ?? 'cash'
            )
            if (fiscalResult.success) {
              fiscalNumber = fiscalResult.fiscal_number
              fiscalQrUrl  = fiscalResult.qr_url
            } else {
              logger.warn({ error: fiscalResult.error }, 'Фіскалізація: не вдалось фіскалізувати')
            }
          }
        } catch (prroErr: any) {
          logger.error({ error: prroErr.message }, 'ПРРО: помилка інтеграції при передоплаті')
        }
      }
      try {
        const paymentNotesList = [
          'Передоплата при створенні',
          fiscalNumber ? 'Фіскальний №: ' + fiscalNumber : '',
          fiscalQrUrl ? 'QR-код чеку: ' + fiscalQrUrl : '',
          bankAuthCode ? 'Код авторизації: ' + bankAuthCode : '',
          terminalRrn ? 'RRN: ' + terminalRrn : ''
        ].filter(Boolean).join('\n')

        await db.from('order_payments').insert({
          tenant_id:  req.user!.tenant_id,
          order_id:   order.id,
          amount:     input.prepayment,
          method:     input.prepayment_method ?? 'cash',
          is_fiscal:  finalIsFiscal,
          created_by: req.user!.id,
          notes:      paymentNotesList,
        })

        // Касова операція для готівки
        if (input.prepayment_method === 'cash') {
          const { data: anyShift } = await db
            .from('shifts')
            .select('id')
            .eq('status', 'open')
            .eq('tenant_id', req.user!.tenant_id)
            .limit(1)
            .maybeSingle()

          if (anyShift) {
            await db.from('cash_operations').insert({
              tenant_id: req.user!.tenant_id,
              shift_id: anyShift.id,
              type: 'in',
              amount: input.prepayment,
              created_by: req.user!.id,
              note: "Передоплата замовлення #" + order.id.slice(0, 8),
            })
            logger.info({ orderId: order.id, amount: input.prepayment }, 'Prepayment cash operation created')
          } else {
            logger.warn({ orderId: order.id, prepayment: input.prepayment },
              'Prepayment received but no open shift found')
          }
        }
      } catch (cashErr) {
        logger.error({ error: cashErr instanceof Error ? cashErr.message : cashErr }, 'Failed to create cash operation')
      }
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
          await db.from('customer_orders').update({ status: 'lead' }).eq('id', order.id)
        } else {
          await db.from('customer_orders').delete().eq('id', order.id)
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

    // Автоматично створюємо замовлення постачальникам, якщо замовлення активне
    if (order.status === 'new' || order.status === 'in_progress') {
      await createSupplierPOsForOrder(order.id, req.user!.tenant_id).catch((err) => {
        logger.error({ error: err.message, orderId: order.id }, 'Failed to auto-create supplier POs on order create')
      })
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
    const perPage    = Math.min(parseInt(String(req.query.per_page ?? '200'), 10) || 200, 500)
    const offset     = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)

    let query = db
      .from('customer_orders')
      .select('*, customer:customers(id, phone, full_name), items:customer_order_items(*)')
      .eq('tenant_id', req.user!.tenant_id)
      .is('deleted_at', null)

    if (customerId) query = query.eq('customer_id', customerId)
    if (chatId) query = query.eq('chat_id', chatId)
    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean)
      if (statuses.length === 1) query = query.eq('status', statuses[0])
      else query = query.in('status', statuses)
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
    const { data: oldOrder } = await db.from('customer_orders')
      .select('*, items:customer_order_items(*)')
      .eq('id', orderId).eq('tenant_id', req.user!.tenant_id).single()

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

    await db.from('customer_orders').update(updateFields).eq('id', orderId)

    // Оновлюємо позиції
    if (parsed.data.items) {
      // Видаляємо старі позиції і вставляємо нові (простий підхід)
      await db.from('customer_order_items').delete().eq('order_id', orderId)

      if (parsed.data.items.length > 0) {
        await db.from('customer_order_items').insert(
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

        // Перераховуємо total
        const total = parsed.data.items.reduce((s, i) => s + i.sell_price * i.qty, 0)
        await db.from('customer_orders').update({ total_amount: total }).eq('id', orderId)
      }
    }

    const { data } = await db.from('customer_orders')
      .select('*, customer:customers(id, phone, full_name), items:customer_order_items(*)')
      .eq('id', orderId).single()

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
      })),
    })

    const parsed = convertSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані конвертації', 422, parsed.error.flatten())

    const draftId = req.params.id

    // Отримуємо вихідну чернетку
    const { data: draftOrder } = await db.from('customer_orders')
      .select('*, items:customer_order_items(*)')
      .eq('id', draftId).single()

    if (!draftOrder) throw new AppError('NOT_FOUND', 'Чернетку не знайдено', 404)

    // Отримуємо інформацію про продукти для застав
    const productIds = parsed.data.items.map(i => i.selected_variant.product_id).filter(Boolean) as string[]
    const { data: prods } = productIds.length > 0
      ? await db.from('products').select('id, requires_core_return, core_deposit_amount, purchase_price').in('id', productIds)
          .eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
      : { data: [] }
    const prodMap = new Map((prods ?? []).map((p: any) => [p.id, p]))

    // Розраховуємо загальну суму для нового замовлення (включаючи заставу)
    let totalAmount = parsed.data.items.reduce((sum, item) => sum + item.selected_variant.price, 0)
    parsed.data.items.forEach((item) => {
      const pId = item.selected_variant.product_id
      if (pId) {
        const prodData = prodMap.get(pId)
        if (prodData?.requires_core_return) {
          const draftItem = (draftOrder.items as any[]).find((di) => di.id === item.item_id)
          const qty = draftItem ? draftItem.qty : 1
          totalAmount += prodData.core_deposit_amount * qty
        }
      }
    })

    // Створюємо нове замовлення
    const { data: newOrder, error: orderErr } = await db.from('customer_orders').insert({
      tenant_id:          draftOrder.tenant_id,
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
    const newItems = parsed.data.items.map((item) => {
      const draftItem = (draftOrder.items as any[]).find((di) => di.id === item.item_id)
      const name = draftItem 
        ? (item.selected_variant.brand ? `${draftItem.name} (${item.selected_variant.brand})` : draftItem.name)
        : 'Запчастина'
      const qty = draftItem ? draftItem.qty : 1

      const pId = item.selected_variant.product_id || (draftItem ? draftItem.product_id : null);
      const sType = pId ? 'warehouse' : 'supplier';
      const prodData = pId ? prodMap.get(pId) : null
      const requiresCore = prodData?.requires_core_return ?? false
      const coreDeposit = requiresCore ? (prodData?.core_deposit_amount ?? 0) : 0
      const coreStatus = requiresCore ? 'pending' : 'none'
      const buyPrice = prodData ? (prodData.purchase_price ?? 0) : (draftItem ? (draftItem.buy_price ?? 0) : 0);
      return {
        order_id:      newOrder.id,
        product_id:    pId,
        sku:           item.selected_variant.sku || (draftItem ? draftItem.sku : null),
        name:          name,
        source_type:   sType,
        item_status:   'pending',
        buy_price:     buyPrice,
        sell_price:    item.selected_variant.price,
        qty:           qty,
        is_draft_note: false,
        core_deposit_amount: coreDeposit,
        core_return_status: coreStatus,
      }
    })

    if (newItems.length > 0) {
      const { error: itemsErr } = await db.from('customer_order_items').insert(newItems)
      if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)
    }

    // Запускаємо резервування товарів зі складу для нового замовлення
    await db.rpc('reserve_order_items', {
      p_tenant_id: req.user!.tenant_id,
      p_order_id:  newOrder.id,
      p_user_id:   req.user!.id
    })

    // Додаємо лог активності
    await db.from('order_activity_log').insert({
      order_id: newOrder.id,
      user_id:  req.user!.id,
      action:   'created_from_draft',
      details:  { parent_draft_id: draftId },
    })

    // Автоматично створюємо замовлення постачальникам
    await createSupplierPOsForOrder(newOrder.id, req.user!.tenant_id).catch((err) => {
      logger.error({ error: err.message, orderId: newOrder.id }, 'Failed to auto-create supplier POs on order convert')
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
      .eq('id', req.params.id).single()

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
    }).eq('id', req.params.id)

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
router.post('/:id/payments', async (req, res, next) => {
  try {
    const schema = z.object({
      amount:     z.number().int().min(1),
      method:     z.enum(['cash', 'card', 'transfer']),
      is_fiscal:  z.boolean().default(false),
      shift_id:   z.string().uuid().optional().nullable(),
      notes:      z.string().max(500).optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const { data: order } = await db.from('customer_orders')
      .select('*').eq('id', req.params.id).single()
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
    if (order.status === 'completed') throw new AppError('ALREADY_COMPLETED', 'Замовлення вже завершено', 400)

    const remaining = order.total_amount - (order.discount_amount ?? 0) - (order.total_paid ?? 0)
    if (parsed.data.amount > remaining) {
      throw new AppError('OVERPAYMENT', 'Сума перевищує залишок до сплати', 400)
    }

    const { data: payment, error } = await db.from('order_payments').insert({
      tenant_id:  req.user!.tenant_id,
      order_id:   order.id,
      amount:     parsed.data.amount,
      method:     parsed.data.method,
      is_fiscal:  parsed.data.is_fiscal,
      shift_id:   parsed.data.shift_id ?? null,
      created_by: req.user!.id,
      notes:      parsed.data.notes ?? null,
    }).select().single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const newTotalPaid = (order.total_paid ?? 0) + parsed.data.amount
    
    // Auto status update on payment (if payment covers prepayment requirement or is made on a draft/lead, transition to 'new')
    let updatedStatus = order.status
    if ((order.status === 'lead' || order.status === 'quoted') && newTotalPaid > 0) {
      updatedStatus = 'new'
    }

    await db.from('customer_orders').update({ 
      total_paid: newTotalPaid, 
      status: updatedStatus,
      updated_at: new Date().toISOString() 
    }).eq('id', order.id)

    // Trigger reserves if transitioning to new
    if (updatedStatus === 'new' && (order.status === 'lead' || order.status === 'quoted')) {
      await db.rpc('reserve_order_items', {
        p_tenant_id: req.user!.tenant_id,
        p_order_id:  order.id,
        p_user_id:   req.user!.id
      })
    }

    if (parsed.data.method === 'cash' && parsed.data.shift_id) {
      await db.from('cash_operations').insert({
        tenant_id:  req.user!.tenant_id,
        shift_id:   parsed.data.shift_id,
        type:       'in',
        amount:     parsed.data.amount,
        note:       `Оплата замовлення #${order.id.slice(0, 8)} (часткова)`,
        created_by: req.user!.id,
      })
    }

    await db.from('order_activity_log').insert({
      order_id: order.id, user_id: req.user!.id, action: 'payment_added',
      details: { amount: parsed.data.amount, method: parsed.data.method, remaining: newTotalPaid >= (order.total_amount - (order.discount_amount ?? 0)) ? 0 : (order.total_amount - (order.discount_amount ?? 0)) - newTotalPaid },
    })

    await auditOrder(req, 'order_payment_added', order.id, {
      total_paid: order.total_paid ?? 0,
      status: order.status,
    }, {
      total_paid: newTotalPaid,
      status: updatedStatus,
      payment: { id: payment.id, amount: parsed.data.amount, method: parsed.data.method, is_fiscal: parsed.data.is_fiscal },
    })
    res.status(201).json({ data: payment })
  } catch (err) { next(err) }
})

// GET /api/v1/customer-orders/:id/payments — список платежів
router.get('/:id/payments', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('order_payments')
      .select('*')
      .eq('order_id', req.params.id)
      .order('created_at', { ascending: true })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

/**
 * Оновлює загальний статус замовлення на основі статусів позицій
 */
export async function updateOrderStatus(orderId: string, tenantId: string, userId: string) {
  const { data: items } = await db
    .from('customer_order_items')
    .select('item_status')
    .eq('order_id', orderId)

  if (!items || items.length === 0) return

  const allHanded = items.every((i) => i.item_status === 'handed')
  const allArrived = items.every((i) => i.item_status === 'arrived')
  const hasPending = items.some((i) => i.item_status === 'pending')
  const hasOrdered = items.some((i) => i.item_status === 'ordered')

  let newStatus: string
  if (allHanded) newStatus = 'completed'
  else if (allArrived) newStatus = 'ready'
  else if (hasOrdered) newStatus = 'ordered'
  else if (hasPending) newStatus = 'new'
  else newStatus = 'new'

  const { data: currentOrder } = await db.from('customer_orders').select('status')
    .eq('id', orderId).eq('tenant_id', tenantId).single()
  if (!currentOrder || currentOrder.status === newStatus) return

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
      item_status: z.enum(['pending', 'ordered', 'arrived', 'handed', 'canceled']),
      supplier_expected_date: z.string().optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)
    const { data: oldItem } = await db.from('customer_order_items')
      .select('*').eq('id', req.params.itemId).eq('order_id', req.params.id).single()

    const updateData: Record<string, unknown> = {
      item_status: parsed.data.item_status,
    }
    if (parsed.data.supplier_expected_date) {
      updateData.expected_date = parsed.data.supplier_expected_date
    }

    const { error } = await db.from('customer_order_items').update(updateData)
      .eq('id', req.params.itemId).eq('order_id', req.params.id)
    if (error) throw new AppError('DB_ERROR', error.message, 500)

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
        await db.from('customer_orders').update({ total_amount: newTotal }).eq('id', req.params.id)
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
      status: z.enum(['lead', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready', 'completed', 'canceled', 'archived']),
      callback_at: z.string().optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)

    // Отримуємо поточний статус перед оновленням
    const { data: oldOrder } = await db
      .from('customer_orders')
      .select('status')
      .eq('id', req.params.id)
      .single()

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
      details: { new_status: parsed.data.status, callback_at: parsed.data.callback_at ?? null },
    })

    await auditOrder(req, 'order_status_changed', String(req.params.id), {
      status: oldOrder?.status,
    }, {
      status: parsed.data.status,
      callback_at: parsed.data.callback_at ?? null,
    })

    // Сповіщення в Telegram при зміні статусу менеджером
    notifyStatusUpdate(String(req.params.id), parsed.data.status, req.user!.tenant_id).catch(() => {})

    // Автоматично створюємо замовлення постачальникам, якщо замовлення перейшло з чернетки
    const isPromotedFromLead = oldOrder?.status === 'lead' && ['new', 'in_progress', 'ordered'].includes(parsed.data.status)
    if (isPromotedFromLead) {
      await createSupplierPOsForOrder(String(req.params.id), req.user!.tenant_id).catch((err) => {
        logger.error({ error: err.message, orderId: req.params.id }, 'Failed to auto-create supplier POs on status change')
      })
    }

    res.json({ data: order })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/complete — фінальний розрахунок та видача
router.post('/:id/complete', async (req, res, next) => {
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

    const { data: order } = await db.from('customer_orders').select('*').eq('id', req.params.id).single()
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
    if (order.status === 'completed') throw new AppError('ALREADY_COMPLETED', 'Замовлення вже завершено', 400)

    const totalPaid = order.total_paid ?? order.prepayment
    const remaining = order.total_amount - (order.discount_amount ?? 0) - totalPaid

    if (remaining > 0) {
      throw new AppError('INCOMPLETE_PAYMENT', 'Не всі оплати проведено. Використайте POST /:id/payments для внесення платежів', 400)
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

    // Сповіщення клієнту про завершення
    notifyStatusUpdate(order.id, 'completed', req.user!.tenant_id).catch(() => {})

    // Розрахунок та запис комісійних менеджера
    try {
      await calculateAndRecordCommission(order.id, req.user!.tenant_id, req.user!.id)
    } catch (commErr: any) {
      logger.error({ orderId: order.id, error: commErr.message }, 'Failed to calculate manager commission')
    }

    res.json({ data: { success: true, remaining, sale_id: saleId } })
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

    // Отримуємо унікальні order_id та product_id
    const { data: items } = await db
      .from('customer_order_items')
      .select('id, order_id, product_id')
      .in('id', parsed.data.item_ids)

    const orderIds = [...new Set((items ?? []).map((i) => i.order_id))]
    const productIds = [...new Set((items ?? []).map((i: any) => i.product_id).filter(Boolean))]

    // Оновлюємо всі позиції на arrived
    const { error } = await db
      .from('customer_order_items')
      .update({ item_status: 'arrived' })
      .in('id', parsed.data.item_ids)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // ORD-14: надходження очікуваних товарів — авто-сповіщення клієнтів з листа очікування
    for (const pid of productIds) {
      notifyWaitlistCustomers(pid, req.user!.tenant_id).catch(() => {})
    }

    // Авто-перерахунок статусів замовлень
    for (const oid of orderIds) {
      await updateOrderStatus(oid, req.user!.tenant_id, req.user!.id)
      await db.from('order_activity_log').insert({
        order_id: oid, user_id: req.user!.id, action: 'bulk_arrival',
        details: { items_count: parsed.data.item_ids.length },
      })
      await auditOrder(req, 'order_items_bulk_arrived', oid, null, {
        item_ids: parsed.data.item_ids,
        items_count: parsed.data.item_ids.length,
      })
    }

    res.json({ data: { updated: parsed.data.item_ids.length, orders: orderIds.length } })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/cancel — скасувати з можливістю повернення
router.post('/:id/cancel', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const schema = z.object({
      refund_prepayment: z.boolean().default(false),
      keep_as_credit: z.boolean().default(false),
      reason: z.string().max(500).optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    const { data: order } = await db.from('customer_orders').select('*').eq('id', req.params.id).single()
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
    if (order.status === 'completed') throw new AppError('ALREADY_COMPLETED', 'Завершене замовлення не можна скасувати', 400)

    // Повернення передоплати
    if (parsed.data.refund_prepayment && order.prepayment > 0) {
      const { data: anyShift } = await db
        .from('shifts').select('id').eq('status', 'open').eq('tenant_id', req.user!.tenant_id).limit(1).maybeSingle()

      await db.from('cash_operations').insert({
        tenant_id: req.user!.tenant_id, shift_id: anyShift?.id ?? null, type: 'out',
        amount: order.prepayment,
        note: `Повернення передоплати за замовленням #${order.id.slice(0, 8)}`,
        created_by: req.user!.id,
      })
    }

    // Залишити як кредит клієнту (зменшуємо debt_balance — від'ємний борг)
    if (parsed.data.keep_as_credit && order.prepayment > 0 && order.customer_id) {
      const { data: customer } = await db.from('customers').select('debt_balance').eq('id', order.customer_id).single()
      if (customer) {
        await db.from('customers').update({
          debt_balance: Math.max(0, (customer.debt_balance ?? 0) - order.prepayment),
        }).eq('id', order.customer_id)
      }
    }

    // Оновлюємо статус на canceled через RPC
    const { error: statusErr } = await db.rpc('update_customer_order_status', {
      p_tenant_id: req.user!.tenant_id,
      p_order_id: order.id,
      p_status: 'canceled',
      p_user_id: req.user!.id
    })

    if (statusErr) throw new AppError('DB_ERROR', statusErr.message, 500)

    await db.from('order_activity_log').insert({
      order_id: order.id, user_id: req.user!.id, action: 'canceled',
      details: { refund_prepayment: parsed.data.refund_prepayment, keep_as_credit: parsed.data.keep_as_credit, reason: parsed.data.reason, amount: order.prepayment },
    })

    await auditOrder(req, 'order_canceled', order.id, order, {
      ...order,
      status: 'canceled',
      refund_prepayment: parsed.data.refund_prepayment,
      keep_as_credit: parsed.data.keep_as_credit,
      reason: parsed.data.reason ?? null,
    })

    // Сповіщення клієнту про скасування
    notifyStatusUpdate(order.id, 'canceled', req.user!.tenant_id).catch(() => {})

    res.json({ data: { success: true } })
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
      discount_amount:       z.number().int().min(0).optional(),
      items: z.array(z.object({
        id:             z.string().uuid().optional(),
        name:           z.string().min(1).max(500),
        sku:            z.string().optional().nullable(),
        product_id:     z.string().uuid().optional().nullable(),
        supplier_id:    z.string().uuid().optional().nullable(),
        source_type:    z.enum(['warehouse', 'supplier']).default('supplier'),
        item_type:      z.enum(['product', 'service']).default('product'),
        item_status:    z.enum(['pending', 'ordered', 'arrived', 'handed', 'canceled', 'returned']).optional(),
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
    const { data: order } = await db.from('customer_orders')
      .select('*, items:customer_order_items(*)').eq('id', orderId).single()
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
    if (order.status === 'completed') throw new AppError('ALREADY_COMPLETED', 'Завершене замовлення не можна редагувати', 400)

    // Оновлюємо основні поля
    const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsed.data.comment !== undefined) updateFields.comment = parsed.data.comment
    if (parsed.data.vehicle_info !== undefined) updateFields.vehicle_info = parsed.data.vehicle_info
    if (parsed.data.customer_id !== undefined) updateFields.customer_id = parsed.data.customer_id
    if (parsed.data.prepayment !== undefined) {
      updateFields.prepayment = parsed.data.prepayment
      updateFields.total_paid = parsed.data.prepayment // оновлюємо також total_paid
    }
    if (parsed.data.prepayment_method !== undefined) updateFields.prepayment_method = parsed.data.prepayment_method
    if (parsed.data.prepayment_is_fiscal !== undefined) updateFields.prepayment_is_fiscal = parsed.data.prepayment_is_fiscal
    if (parsed.data.discount_amount !== undefined) updateFields.discount_amount = parsed.data.discount_amount

    // Оновлюємо позиції
    if (parsed.data.items) {
      // Отримуємо інформацію про продукти для застав
      const productIds = parsed.data.items.map(i => i.product_id).filter(Boolean) as string[]
      const { data: prods } = productIds.length > 0
        ? await db.from('products').select('id, requires_core_return, core_deposit_amount')
            .in('id', productIds).eq('tenant_id', req.user!.tenant_id).is('deleted_at', null)
        : { data: [] }
      const prodMap = new Map((prods ?? []).map((p: any) => [p.id, p]))

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

      // Видаляємо старі позиції
      await db.from('customer_order_items').delete().eq('order_id', orderId)

      if (parsed.data.items.length > 0) {
        await db.from('customer_order_items').insert(
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
      }
    }

    await db.from('customer_orders').update(updateFields).eq('id', orderId)

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

    const { data: updatedOrder } = await db.from('customer_orders')
      .select('*, customer:customers(id, phone, full_name), items:customer_order_items(*)')
      .eq('id', orderId).single()

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


