import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { getCurrentShift } from './shiftService.js'
import { logAction } from './auditService.js'
import { logger } from '../lib/logger.js'
import type { CreateSaleInput, CalculatePriceInput, SaleListQuery } from '../validators/saleSchema.js'

const TABLE = 'sales'


export async function listSales(query: SaleListQuery) {
  const { shift_id, customer_id, sale_number, date_from, date_to, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*, customer:customers(id,phone,full_name)', { count: 'exact' })
    .order('completed_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (shift_id) q = q.eq('shift_id', shift_id)
  if (customer_id) q = q.eq('customer_id', customer_id)
  if (sale_number) q = q.eq('sale_number', sale_number)
  if (date_from) q = q.gte('completed_at', date_from)
  if (date_to) q = q.lte('completed_at', date_to)

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  }
}

export async function getSale(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, sale_items(*, product:products(id,sku,name,unit)), customer:customers(id,phone,full_name)')
    .eq('id', id)
    .single()

  if (error || !data) throw new AppError('SALE_NOT_FOUND', 'Продаж не знайдено', 404)
  return data
}

export async function calculatePrice(input: CalculatePriceInput) {
  const productIds = input.items.map((i) => i.product_id)
  const { data: products, error } = await db
    .from('products')
    .select('id, sku, name, retail_price, qty_on_hand, unit')
    .in('id', productIds)
    .is('deleted_at', null)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return input.items.map((item) => {
    const product = products?.find((p) => p.id === item.product_id)
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', `Товар не знайдено: ${item.product_id}`, 404)
    const total = Math.round(product.retail_price * item.qty)
    return {
      product_id: item.product_id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      unit_price: product.retail_price,
      qty: item.qty,
      total,
      in_stock: product.qty_on_hand >= item.qty,
      qty_on_hand: product.qty_on_hand,
    }
  })
}




/**
 * ▐▄▄▄▄▌ Атомарне створення продажу через RPC (process_sale).
 * Вся логіка (перевірка залишків, оновлення qty_on_hand, борг клієнта)
 * виконується в єдиній транзакції PostgreSQL.
 */
export async function createSale(cashierId: string, tenantId: string, input: CreateSaleInput, idempotencyKey?: string) {
  // 0. Idempotency check — повертаємо кешовану відповідь якщо ключ вже є
  if (idempotencyKey) {
    const { data: cached } = await db
      .from('idempotency_keys')
      .select('response')
      .eq('key', idempotencyKey)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (cached) {
      logger.info({ idempotencyKey }, 'Idempotency hit — повертаємо кешовану відповідь')
      return cached.response as any
    }
  }

  // 1. Перевіряємо що зміна відкрита
  const shift = await getCurrentShift(cashierId)
  if (!shift) throw new AppError('NO_OPEN_SHIFT', 'Спочатку відкрийте зміну', 400)
  if (shift.id !== input.shift_id) throw new AppError('WRONG_SHIFT', 'Невірна зміна', 400)

  // 2. Розраховуємо суми для змішаної оплати
  const subtotalItems = input.items.reduce((s, i) => s + i.unit_price * i.qty, 0)
  const discountedTotal = Math.max(0, subtotalItems - input.discount)

  let cashAmount = 0
  let cardAmount = 0
  if (input.payment_method === 'mixed') {
    cashAmount = input.cash_amount ?? 0
    cardAmount = input.card_amount ?? 0
    if (cashAmount + cardAmount !== discountedTotal) {
      throw new AppError('SPLIT_MISMATCH', 'Сума готівки та картки не відповідає сумі чека', 422)
    }
  } else if (input.payment_method === 'cash') {
    cashAmount = discountedTotal
  } else if (input.payment_method === 'card') {
    cardAmount = discountedTotal
  } else if (input.payment_method === 'transfer') {
    // Перекази на карту — не термінал і не готівка
  }

  // 3. Формуємо items для RPC
  const items = input.items.map((i) => ({
    product_id: i.product_id,
    qty: i.qty,
    unit_price: i.unit_price,
    discount: i.discount,
  }))

  // 3a. Розраховуємо бонуси ДО RPC (щоб передати атомарно)
  const bonusesSpent = input.bonuses_spent ?? 0
  let bonusesEarned = 0
  if (process.env.USE_BONUS_ATOMIC_SALE === 'true' && input.customer_id && input.payment_method !== 'debt') {
    const { getSettings } = await import('./loyaltyService.js')
    const loyaltySettings = await getSettings()
    if (loyaltySettings.is_enabled && discountedTotal >= (loyaltySettings.min_purchase_kopecks ?? 0)) {
      bonusesEarned = Math.round(discountedTotal * ((loyaltySettings.accrual_pct ?? 0) / 100))
    }
  }

  // 3b. Термінал підтверджує ДО виклику process_sale
  // Якщо термінал відхиляє → продаж НЕ створюється
  let bankAuthCode: string | null = null
  let terminalRrn:  string | null = null
  if (input.payment_method === 'card' || input.payment_method === 'mixed') {
    const settings = await (await import('./adminService.js')).getSettings()
    const provider = settings.terminal_provider ?? 'mock'

    // manual — касир сам провів на терміналі та ввів код
    if (provider === 'manual' || !settings.bank_terminal_enabled) {
      bankAuthCode = (input as any).terminal_auth_code ?? null
      logger.info({ bankAuthCode }, 'Термінал: ручне підтвердження (manual mode)')
    } else if (provider === 'privatbank') {
      const { privatbankProcessPayment } = await import('./integrations/PrivatBankTerminalService.js')
      const terminalResult = await privatbankProcessPayment(
        {
          ip:          settings.privatbank_terminal_ip  ?? '127.0.0.1',
          port:        settings.privatbank_terminal_port ?? 8082,
          merchant_id: settings.privatbank_merchant_id  ?? '',
        },
        cardAmount,
        `TMP-${Date.now()}`,
      )
      if (!terminalResult.success) {
        throw new AppError('TERMINAL_DECLINED', terminalResult.error ?? 'Термінал відхилив оплату', 402)
      }
      bankAuthCode = terminalResult.auth_code
      terminalRrn  = terminalResult.rrn
    } else {
      const { processCardPayment } = await import('./integrations/MockBankTerminalService.js')
      const terminalResult = await processCardPayment(cardAmount)
      if (!terminalResult.success) {
        throw new AppError('TERMINAL_DECLINED', terminalResult.error ?? 'Термінал відхилив оплату', 402)
      }
      bankAuthCode = terminalResult.auth_code
    }
    logger.info({ bankAuthCode, terminalRrn }, 'Термінал підтвердив — виконуємо process_sale')
  }

  const useBonusAtomic = process.env.USE_BONUS_ATOMIC_SALE === 'true'
  const rpcName = useBonusAtomic
    ? 'process_sale_v3'
    : process.env.USE_RESERVE_AWARE_SALE === 'true' ? 'process_sale_v2' : 'process_sale'
  logger.info({ shift_id: input.shift_id, items_count: items.length, payment_method: input.payment_method, rpc: rpcName }, 'Виклик process_sale RPC')

  // 4. Викликаємо атомарну PostgreSQL функцію
  const rpcParams: Record<string, unknown> = {
    p_tenant_id:      tenantId,
    p_cashier_id:     cashierId,
    p_shift_id:       input.shift_id,
    p_customer_id:    input.customer_id ?? null,
    p_manager_id:     input.manager_id ?? cashierId,
    p_items:          JSON.stringify(items),
    p_payment_method: input.payment_method,
    p_discount:       input.discount,
    p_notes:          input.notes ?? null,
    p_cash_amount:    cashAmount,
    p_card_amount:    cardAmount,
  }
  if (useBonusAtomic) {
    rpcParams.p_bonuses_spent  = bonusesSpent
    rpcParams.p_bonuses_earned = bonusesEarned
  }
  const { data, error } = await db.rpc(rpcName, rpcParams)

  // 4. Обробка помилок RPC
  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('INSUFFICIENT_STOCK')) {
      throw new AppError('INSUFFICIENT_STOCK', msg.replace('INSUFFICIENT_STOCK: ', '').trim(), 422)
    }
    if (msg.includes('not found') || msg.includes('не знайдено')) {
      throw new AppError('PRODUCT_NOT_FOUND', msg, 404)
    }
    throw new AppError('DB_ERROR', msg, 500)
  }

  if (!data) {
    throw new AppError('DB_ERROR', 'RPC process_sale не повернув дані', 500)
  }

  // 5. Парсимо результат (JSONB -> об'єкт)
  const sale = typeof data === 'string' ? JSON.parse(data) : data

  // 5b. Фіскалізація через ПРРО
  let fiscalNumber: string | null = null
  let fiscalQrUrl:  string | null = null
  if (input.is_fiscal) {
    const settings = await (await import('./adminService.js')).getSettings()
    const prroProvider = settings.prro_provider ?? 'mock'

    if (prroProvider === 'kashalot' && settings.kashalot_license_key && settings.kashalot_pin) {
      const {
        kashalotLogin, kashalotGetCurrentShift, kashalotOpenShift, kashalotFiscalize,
      } = await import('./integrations/KashalotService.js')

      try {
        const token = await kashalotLogin({
          license_key: settings.kashalot_license_key,
          pin:         settings.kashalot_pin,
        })

        let shiftId = settings.kashalot_active_shift ?? await kashalotGetCurrentShift(token)
        if (!shiftId) {
          shiftId = await kashalotOpenShift(token)
          await db.from('shop_settings').update({ kashalot_active_shift: shiftId })
        }

        const fiscalResult = await kashalotFiscalize(
          token, shiftId, sale.sale_number ?? sale.id,
          sale.total,
          input.items.map((i) => ({
            name:       i.product_id,   // буде перезаписано після збагачення
            qty:        i.qty,
            unit_price: i.unit_price,
            discount:   i.discount,
          })),
          input.payment_method,
        )

        if (fiscalResult.success) {
          fiscalNumber = fiscalResult.fiscal_number
          fiscalQrUrl  = fiscalResult.qr_url
        } else {
          logger.warn({ error: fiscalResult.error }, 'Кашалот: не вдалось фіскалізувати')
        }
      } catch (err: any) {
        logger.error({ error: err.message }, 'Кашалот: помилка інтеграції')
      }
    } else {
      // Mock ПРРО
      const { fiscalizeSale } = await import('./integrations/MockPrroService.js')
      const fiscalResult = await fiscalizeSale(sale.id, sale.sale_number ?? '', sale.total)
      if (fiscalResult.success) fiscalNumber = fiscalResult.fiscal_number
    }
  }

  // 5c. Оновлюємо запис в БД з фіскальними та терміналь даними
  const extraData: Record<string, unknown> = {}
  if (input.is_fiscal) extraData.is_fiscal = true
  if (fiscalNumber)    extraData.fiscal_number = fiscalNumber
  if (fiscalQrUrl)     extraData.fiscal_qr_url  = fiscalQrUrl
  if (bankAuthCode)    extraData.bank_auth_code  = bankAuthCode
  if (terminalRrn)     extraData.terminal_rrn    = terminalRrn

  if (Object.keys(extraData).length > 0) {
    await db.from('sales').update(extraData).eq('id', sale.id)
    Object.assign(sale, extraData)
  }

  // 6. Аудит (await — гарантуємо запис перед відповіддю)
  await logAction({
    tenantId: tenantId,
    userId: cashierId,
    userRole: 'cashier',
    action: 'sale.created',
    entityType: 'sale',
    entityId: sale.id,
    entityLabel: '#' + (sale.sale_number ?? ''),
    newValue: {
      total: sale.total,
      payment_method: input.payment_method,
      items: input.items.length,
    },
  })

  // 5d. Оновлюємо pickup_cell якщо передано (для відкладених чеків)
  if (input.pickup_cell) {
    await db.from('sales').update({ pickup_cell: input.pickup_cell }).eq('id', sale.id)
    sale.pickup_cell = input.pickup_cell
  }

  // 5e-5g. Бонуси — якщо НЕ атомарний режим, викликаємо окремо (legacy)
  if (!useBonusAtomic) {
    let bonusSpent = 0
    if (input.bonuses_spent && input.bonuses_spent > 0 && input.customer_id) {
      const { error: spendErr } = await db.rpc('process_bonus_spend', {
        p_customer_id: input.customer_id,
        p_amount:      input.bonuses_spent,
        p_sale_id:     sale.id,
      })
      if (!spendErr) bonusSpent = input.bonuses_spent
    }

    let bonusEarned = 0
    if (input.customer_id && input.payment_method !== 'debt') {
      const settings = await (await import('./loyaltyService.js')).getSettings()
      if (settings.is_enabled && sale.total >= (settings.min_purchase_kopecks ?? 0)) {
        const earnAmount = Math.round(sale.total * ((settings.accrual_pct ?? 0) / 100))
        if (earnAmount > 0) {
          const { error: earnErr } = await db.rpc('process_bonus_earn', {
            p_customer_id: input.customer_id,
            p_amount:      earnAmount,
            p_sale_id:     sale.id,
          })
          if (!earnErr) bonusEarned = earnAmount
        }
      }
    }

    if (bonusSpent > 0 || bonusEarned > 0) {
      await db.from('sales').update({
        bonuses_spent: bonusSpent,
        bonuses_earned: bonusEarned,
      }).eq('id', sale.id)
      sale.bonuses_spent = bonusSpent
      sale.bonuses_earned = bonusEarned
    }
  }

  // 7. Зберігаємо idempotency key щоб повторний запит отримав ту ж відповідь
  if (idempotencyKey) {
    await db.from('idempotency_keys').insert({
      key: idempotencyKey,
      tenant_id: tenantId,
      response: sale,
    }).then(({ error }) => {
      if (error) logger.warn({ idempotencyKey, error: error.message }, 'Не вдалось зберегти idempotency key')
    })
  }

  return sale
}

/** Відновити відкладений чек */
export async function resumeSale(saleId: string) {
  const { data, error } = await db
    .from('sales')
    .update({ status: 'draft', updated_at: new Date().toISOString() })
    .eq('id', saleId)
    .eq('status', 'suspended')
    .select('*, sale_items(*, product:products(id,sku,name,unit)), customer:customers(id,phone,full_name)')
    .single()

  if (error || !data) throw new AppError('SALE_NOT_FOUND', 'Відкладений чек не знайдено', 404)
  return data
}

/** Позначити чек як готовий до видачі + надіслати сповіщення */
export async function markReadyForPickup(saleId: string) {
  const { data: sale, error: saleErr } = await db
    .from('sales')
    .update({ status: 'ready_for_pickup', updated_at: new Date().toISOString() })
    .eq('id', saleId)
    .select('*, customer:customers(id, full_name, phone)')
    .single()

  if (saleErr || !sale) throw new AppError('SALE_NOT_FOUND', 'Чек не знайдено', 404)

  // Авто-сповіщення через месенджер
  if (sale.customer) {
    const { data: settings } = await db.from('shop_settings').select('auto_notify_order_ready').single() as any
    if (settings?.auto_notify_order_ready !== false) {
      const { data: chat } = await db.from('messenger_chats')
        .select('platform_chat_id, channel:messenger_channels(id, platform, credentials)')
        .eq('customer_id', sale.customer.id)
        .maybeSingle()

      if (chat) {
        const totalHryvnia = (sale.total / 100).toFixed(2)
        const cell = sale.pickup_cell ?? 'біля каси'
        const msg = `✅ Доброго дня${sale.customer.full_name ? ', ' + sale.customer.full_name : ''}! Ваше замовлення зібрано і чекає на вас у магазині${cell ? ' (Ячейка: ' + cell + ')' : ''}. Сума до сплати: ${totalHryvnia} грн.`

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chatData = chat as any
        const channel = Array.isArray(chatData.channel) ? chatData.channel[0] : chatData.channel
        if (channel?.platform === 'telegram' && channel?.credentials?.token) {
          try {
            const { Telegraf } = await import('telegraf')
            const bot = new Telegraf(channel.credentials.token)
            await bot.telegram.sendMessage(chatData.platform_chat_id, msg)
          } catch {}
        }
      }
    }
  }

  return sale
}
