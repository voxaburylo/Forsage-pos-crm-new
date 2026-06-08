import { Router } from 'express'
import * as adminService from '../services/adminService.js'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { notifyStatusUpdate } from '../services/telegramBot.js'
import { calculateAndRecordCommission } from '../services/commissionService.js'
import { getTerminalAdapter, getFiscalAdapter } from '../services/integrations/adapterFactory.js'

const router = Router()
router.use(requireAuth)

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
router.post('/', async (req, res, next) => {
  try {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const input = parsed.data
    const totalAmount = input.items.reduce((s, i) => s + i.sell_price * i.qty, 0)

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
    const itemsToInsert = input.items.map((item) => ({
      order_id: order.id,
      product_id: item.product_id ?? null,
      sku: item.sku ?? null,
      name: item.name,
      supplier_id: item.supplier_id ?? null,
      source_type: item.source_type,
      item_status: 'pending',
      buy_price: item.buy_price,
      sell_price: item.sell_price,
      qty: item.qty,
      is_draft_note: item.is_draft_note ?? false,
      expected_date: item.expected_date ?? null,
      variants: item.variants && item.variants.length > 0 ? item.variants : [],
    }))

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

    // Резервуємо товари, якщо статус новий або в процесі
    if (order.status === 'new' || order.status === 'in_progress') {
      const { error: reserveErr } = await db.rpc('reserve_order_items', {
        p_tenant_id: req.user!.tenant_id,
        p_order_id: order.id,
        p_user_id: req.user!.id
      })
      if (reserveErr) {
        if (reserveErr.message.includes('INSUFFICIENT_STOCK')) {
          throw new AppError('INSUFFICIENT_STOCK', reserveErr.message, 422)
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
    const perPage    = Math.min(parseInt(String(req.query.per_page ?? '200'), 10) || 200, 500)
    const offset     = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)

    let query = db
      .from('customer_orders')
      .select('*, customer:customers(id, phone, full_name), items:customer_order_items(*)')
      .eq('tenant_id', req.user!.tenant_id)

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
router.put('/:id/draft', async (req, res, next) => {
  try {
    const schema = z.object({
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

    const orderId = req.params.id

    // Оновлюємо основні поля
    const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() }
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

    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/convert — конвертувати чернетку в замовлення з вибраними варіантами
router.post('/:id/convert', async (req, res, next) => {
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

    // Розраховуємо загальну суму для нового замовлення
    const totalAmount = parsed.data.items.reduce((sum, item) => sum + item.selected_variant.price, 0)

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
      return {
        order_id:      newOrder.id,
        product_id:    pId,
        sku:           item.selected_variant.sku || (draftItem ? draftItem.sku : null),
        name:          name,
        source_type:   sType,
        item_status:   'pending',
        buy_price:     0,
        sell_price:    item.selected_variant.price,
        qty:           qty,
        is_draft_note: false,
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

    res.status(201).json({ data: newOrder })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/send-telegram — відправити КП в Telegram
router.post('/:id/send-telegram', async (req, res, next) => {
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
    const kpNum = order.kp_number ?? `#${order.id.slice(0, 8)}`
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

  const { data: currentOrder } = await db.from('customer_orders').select('status').eq('id', orderId).single()
  if (!currentOrder || currentOrder.status === newStatus) return

  // Встановлюємо дедлайн при переході в ready
  if (newStatus === 'ready') {
    const { data: settings } = await db.from('shop_settings').select('pickup_deadline_days').maybeSingle()
    const days = (settings as any)?.pickup_deadline_days ?? 14
    const deadline = new Date(Date.now() + days * 86400000).toISOString()
    await db.from('customer_orders').update({
      pickup_deadline_at: deadline,
    }).eq('id', orderId)
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
  notifyStatusUpdate(orderId, newStatus).catch(() => {})

  // Авто-Telegram при готовності
  if (newStatus === 'ready') {
    try {
      const { data: order } = await db
        .from('customer_orders')
        .select('*, customer:customers(id, full_name, phone)')
        .eq('id', orderId)
        .single()

      if (order?.customer) {
        const { data: chat } = await db
          .from('messenger_chats')
          .select('platform_chat_id, channel:messenger_channels(id, platform, credentials)')
          .eq('customer_id', order.customer.id)
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
router.patch('/:id/items/:itemId/status', async (req, res, next) => {
  try {
    const schema = z.object({
      item_status: z.enum(['pending', 'ordered', 'arrived', 'handed', 'canceled']),
      supplier_expected_date: z.string().optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)

    const updateData: Record<string, unknown> = {
      item_status: parsed.data.item_status,
    }
    if (parsed.data.supplier_expected_date) {
      updateData.expected_date = parsed.data.supplier_expected_date
    }

    const { error } = await db.from('customer_order_items').update(updateData).eq('id', req.params.itemId)
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Логуємо
    await db.from('order_activity_log').insert({
      order_id: req.params.id,
      user_id: req.user!.id,
      action: `item_status:${parsed.data.item_status}`,
      details: { item_id: req.params.itemId },
    })

    // Авто-оновлення загального статусу
    await updateOrderStatus(req.params.id, req.user!.tenant_id, req.user!.id)

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// PATCH /api/v1/customer-orders/:id/status — змінити статус замовлення
router.patch('/:id/status', async (req, res, next) => {
  try {
    const schema = z.object({
      status: z.enum(['lead', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready', 'completed', 'canceled', 'archived']),
      callback_at: z.string().optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)

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

    // Сповіщення в Telegram при зміні статусу менеджером
    notifyStatusUpdate(req.params.id, parsed.data.status).catch(() => {})

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

    // Сповіщення клієнту про завершення
    notifyStatusUpdate(order.id, 'completed').catch(() => {})

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
      const users = await adminService.listUsers()
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
router.post('/bulk-arrival', async (req, res, next) => {
  try {
    const schema = z.object({ item_ids: z.array(z.string().uuid()).min(1) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422)

    // Отримуємо унікальні order_id
    const { data: items } = await db
      .from('customer_order_items')
      .select('id, order_id')
      .in('id', parsed.data.item_ids)

    const orderIds = [...new Set((items ?? []).map((i) => i.order_id))]

    // Оновлюємо всі позиції на arrived
    const { error } = await db
      .from('customer_order_items')
      .update({ item_status: 'arrived' })
      .in('id', parsed.data.item_ids)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Авто-перерахунок статусів замовлень
    for (const oid of orderIds) {
      await updateOrderStatus(oid, req.user!.tenant_id, req.user!.id)
      await db.from('order_activity_log').insert({
        order_id: oid, user_id: req.user!.id, action: 'bulk_arrival',
        details: { items_count: parsed.data.item_ids.length },
      })
    }

    res.json({ data: { updated: parsed.data.item_ids.length, orders: orderIds.length } })
  } catch (err) { next(err) }
})

// POST /api/v1/customer-orders/:id/cancel — скасувати з можливістю повернення
router.post('/:id/cancel', async (req, res, next) => {
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

    // Сповіщення клієнту про скасування
    notifyStatusUpdate(order.id, 'canceled').catch(() => {})

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})


// PUT /api/v1/customer-orders/:id — оновити замовлення
router.put('/:id', async (req, res, next) => {
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
        buy_price:      z.number().int().min(0).default(0),
        sell_price:     z.number().int().min(0).default(0),
        qty:            z.number().min(0.001).default(1),
        is_draft_note:  z.boolean().default(false),
        expected_date:  z.string().optional().nullable(),
      })).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const orderId = req.params.id

    // Отримуємо поточне замовлення
    const { data: order } = await db.from('customer_orders').select('*').eq('id', orderId).single()
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
      // Розраховуємо total_amount
      const totalAmount = parsed.data.items.reduce((s, i) => s + i.sell_price * i.qty, 0)
      updateFields.total_amount = totalAmount

      // Видаляємо старі позиції
      await db.from('customer_order_items').delete().eq('order_id', orderId)

      if (parsed.data.items.length > 0) {
        await db.from('customer_order_items').insert(
          parsed.data.items.map((item) => ({
            order_id: orderId,
            product_id: item.product_id ?? null,
            supplier_id: item.supplier_id ?? null,
            name: item.name,
            sku: item.sku ?? null,
            qty: item.qty,
            sell_price: item.sell_price,
            buy_price: item.buy_price,
            source_type: item.supplier_id ? 'supplier' : 'warehouse',
            item_status: 'pending',
            is_draft_note: item.is_draft_note,
            expected_date: item.expected_date ?? null,
          }))
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

    res.json({ data: updatedOrder })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customer-orders/:id — видалити чернетку/замовлення
router.delete('/:id', async (req, res, next) => {
  try {
    const orderId = req.params.id

    // Отримуємо поточне замовлення
    const { data: order } = await db.from('customer_orders').select('*').eq('id', orderId).single()
    if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)

    // Дозволяємо видаляти тільки чернетки (lead)
    if (order.status !== 'lead') {
      throw new AppError('FORBIDDEN', 'Можна видаляти тільки чернетки', 403)
    }

    // Вивільняємо резерви
    await db.from('inventory_reserves').update({ released_at: new Date().toISOString() }).eq('order_id', orderId)

    // Видаляємо позиції
    await db.from('customer_order_items').delete().eq('order_id', orderId)

    // Видаляємо замовлення
    await db.from('customer_orders').delete().eq('id', orderId)

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router


