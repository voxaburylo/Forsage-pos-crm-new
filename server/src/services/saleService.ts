import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { getCurrentShift } from './shiftService.js'
import { logAction } from './auditService.js'
import { logger } from '../lib/logger.js'
import type { CreateSaleInput, CalculatePriceInput, SaleListQuery } from '../validators/saleSchema.js'
import { getTerminalAdapter, getFiscalAdapter, TerminalAdapter } from './integrations/adapterFactory.js'

const TABLE = 'sales'

export async function allocateSaleNumber(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  tenantId: string,
): Promise<string> {
  // Серіалізуємо нумерацію в межах магазину. Sequence міг відстати після
  // імпорту/відновлення БД, через що новий чек отримував уже наявний номер.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sale_number:${tenantId}`])
  const result = await client.query(
    `SELECT COALESCE(MAX(
       CASE WHEN sale_number ~ '^[0-9]+$' THEN sale_number::bigint ELSE 0 END
     ), 0) AS max_number
     FROM sales
     WHERE tenant_id = $1`,
    [tenantId],
  )
  const nextNumber = Number(result.rows[0]?.max_number ?? 0) + 1
  return String(nextNumber).padStart(6, '0')
}


export async function listSales(query: SaleListQuery, tenantId: string) {
  const { shift_id, customer_id, sale_number, search, date_from, date_to, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*, sale_items(id,qty,product:products(id,sku,name,unit)), customer:customers(id,phone,full_name)', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('completed_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (shift_id) q = q.eq('shift_id', shift_id)
  if (customer_id) q = q.eq('customer_id', customer_id)
  if (sale_number) q = q.eq('sale_number', sale_number)

  if (search) {
    // 1. Пошук клієнтів за телефоном або ім'ям
    const { data: cust } = await db
      .from('customers')
      .select('id')
      .eq('tenant_id', tenantId)
      .or(`phone.ilike.%${search}%,full_name.ilike.%${search}%`)

    const customerIds: string[] = (cust || []).map((c: any) => c.id)

    // 2. Пошук за VIN-кодом у обох таблицях авто
    const { data: vehs } = await db
      .from('customer_vehicles')
      .select('customer_id')
      .eq('tenant_id', tenantId)
      .ilike('vin', `%${search}%`)
    vehs?.forEach((v: any) => customerIds.push(v.customer_id))

    const { data: cars } = await db
      .from('customer_cars')
      .select('customer_id')
      .eq('tenant_id', tenantId)
      .ilike('vin', `%${search}%`)
    cars?.forEach((c: any) => customerIds.push(c.customer_id))

    const uniqueIds = Array.from(new Set(customerIds.filter(Boolean)))

    // 3. Фільтруємо продажі за номером чека або за знайденими клієнтами
    if (uniqueIds.length > 0) {
      q = q.or(`sale_number.ilike.%${search}%,customer_id.in.(${uniqueIds.join(',')})`)
    } else {
      q = q.ilike('sale_number', `%${search}%`)
    }
  }

  if (date_from) q = q.gte('completed_at', date_from)
  if (date_to) q = q.lte('completed_at', date_to)

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  }
}

export async function getSale(id: string, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, sale_items(*, product:products(id,sku,name,unit)), customer:customers(id,phone,full_name)')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()

  if (error || !data) throw new AppError('SALE_NOT_FOUND', 'Продаж не знайдено', 404)
  return data
}

export async function calculatePrice(input: CalculatePriceInput, tenantId: string) {
  const productIds = input.items.map((i) => i.product_id)
  const { data: products, error } = await db
    .from('products')
    .select('id, sku, name, retail_price, qty_on_hand, unit')
    .in('id', productIds)
    .eq('tenant_id', tenantId)
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
// Decomposed helpers for createSale
interface TerminalResult {
  bankAuthCode: string | null;
  terminalRrn: string | null;
  activeTerminalAdapter: TerminalAdapter | null;
  isCharged: boolean;
  paymentRef: string | null;
}

/**
 * Записує платіж, що потребує ручної звірки (термінал міг списати кошти, але
 * результат невідомий або не вдалось автоскасувати). Раніше це лише губилось у логах.
 */
async function recordReconciliation(params: {
  tenantId: string
  paymentRef: string | null
  saleId?: string | null
  amountKopecks: number
  rrn?: string | null
  authCode?: string | null
  panMasked?: string | null
  status: 'unknown' | 'charged_not_reversed'
  reason: string
}): Promise<void> {
  try {
    await db.from('payment_reconciliation').insert({
      tenant_id:      params.tenantId,
      payment_ref:    params.paymentRef,
      sale_id:        params.saleId ?? null,
      amount_kopecks: params.amountKopecks,
      rrn:            params.rrn ?? null,
      auth_code:      params.authCode ?? null,
      pan_masked:     params.panMasked ?? null,
      status:         params.status,
      reason:         params.reason,
    })
    logger.error({ paymentRef: params.paymentRef, status: params.status, amount: params.amountKopecks },
      'PAYMENT RECONCILIATION — потрібна ручна звірка платежу на терміналі')
  } catch (e: any) {
    logger.error({ err: e.message }, 'КРИТИЧНО: не вдалося записати payment_reconciliation')
  }
}

async function checkIdempotencyLock(idempotencyKey: string, tenantId: string): Promise<any> {
  // Скільки часу «processing»-лок вважається живим. Якщо сервер упав/зник струм
  // між блокуванням і завершенням — старий лок інакше блокував би цю вкладку НАЗАВЖДИ.
  const PROCESSING_TTL_MS = 2 * 60 * 1000

  const { data: cached } = await db
    .from('idempotency_keys')
    .select('status, response, created_at')
    .eq('key', idempotencyKey)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (cached) {
    if (cached.status === 'completed') {
      logger.info({ idempotencyKey }, 'Idempotency hit (completed) — повертаємо кешовану відповідь')
      return cached.response as any
    }
    if (cached.status === 'processing') {
      const ageMs = Date.now() - new Date(cached.created_at).getTime()
      if (ageMs < PROCESSING_TTL_MS) {
        logger.warn({ idempotencyKey }, 'Idempotency hit (processing) — паралельний запит відхилено')
        throw new AppError('PAYMENT_PROCESSING', 'Запит на оплату вже обробляється. Будь ласка, зачекайте.', 409)
      }
      // Лок «завис» (попередній запит не завершився через збій/струм) — прибираємо й пробуємо знову
      logger.warn({ idempotencyKey, ageMs }, 'Idempotency stale processing lock — очищаємо застряглий лок')
      try {
        await db.from('idempotency_keys').delete().eq('key', idempotencyKey).eq('tenant_id', tenantId)
      } catch {}
    }
    if (cached.status === 'failed') {
      try {
        await db.from('idempotency_keys').delete().eq('key', idempotencyKey).eq('tenant_id', tenantId)
      } catch {}
    }
  }

  // Lock-Before-Work
  const { error: insertErr } = await db.from('idempotency_keys').insert({
    key: idempotencyKey,
    tenant_id: tenantId,
    status: 'processing',
    response: null
  })

  if (insertErr) {
    logger.warn({ idempotencyKey, err: insertErr.message }, 'Idempotency insert conflict — паралельний запит')
    throw new AppError('PAYMENT_PROCESSING', 'Запит на оплату вже обробляється. Будь ласка, зачекайте.', 409)
  }
}

async function verifyActiveShift(cashierId: string, shiftId: string, tenantId: string): Promise<any> {
  const shift = await getCurrentShift(cashierId, tenantId)
  if (!shift) throw new AppError('NO_OPEN_SHIFT', 'Спочатку відкрийте зміну', 400)
  if (shift.id !== shiftId) throw new AppError('WRONG_SHIFT', 'Невірна зміна', 400)
  return shift
}

function calculateSaleAmounts(input: CreateSaleInput, discountedTotal: number): { cashAmount: number; cardAmount: number; bonusesEarned: number } {
  let cashAmount = 0
  let cardAmount = 0
  if (input.payment_method === 'mixed') {
    cashAmount = input.cash_amount ?? 0
    cardAmount = input.card_amount ?? 0
  } else if (input.payment_method === 'cash') {
    cashAmount = discountedTotal
  } else if (input.payment_method === 'card') {
    cardAmount = discountedTotal
  }

  let bonusesEarned = 0
  return { cashAmount, cardAmount, bonusesEarned }
}

async function processTerminalPayment(input: CreateSaleInput, cardAmount: number, tenantId: string): Promise<TerminalResult> {
  let isCharged = false
  let activeTerminalAdapter: TerminalAdapter | null = null
  let bankAuthCode: string | null = null
  let terminalRrn:  string | null = null
  let paymentRef:   string | null = null

  if (input.payment_method === 'card' || input.payment_method === 'mixed') {
    const settings = await (await import('./adminService.js')).getSettings(tenantId)
    const provider = settings.terminal_provider ?? 'mock'

    if (provider === 'manual' || !settings.bank_terminal_enabled) {
      bankAuthCode = (input as any).terminal_auth_code ?? null
      logger.info({ bankAuthCode }, 'Термінал: ручне підтвердження (manual mode)')
    } else {
      activeTerminalAdapter = getTerminalAdapter(settings)
      if (activeTerminalAdapter) {
        // Стабільний референс для кореляції зі звіркою в банку (замість TMP-timestamp)
        paymentRef = `POS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        logger.info({ provider, cardAmount, paymentRef }, 'Ініціюємо оплату через інтегрований термінал...')
        const terminalResult = await activeTerminalAdapter.processPayment(cardAmount, paymentRef)

        // Невідомий результат (таймаут/обрив): картку могли списати. НЕ записуємо продаж,
        // НЕ списуємо повторно — фіксуємо для ручної звірки й просимо касира перевірити.
        if (terminalResult.unknown) {
          await recordReconciliation({
            tenantId, paymentRef, amountKopecks: cardAmount,
            rrn: terminalResult.rrn, authCode: terminalResult.authCode, panMasked: terminalResult.panMasked,
            status: 'unknown', reason: terminalResult.error ?? 'Невідомий результат оплати на терміналі',
          })
          throw new AppError(
            'TERMINAL_UNKNOWN',
            'Невідомий результат оплати на терміналі. Перевірте чек термінала: якщо кошти списано — НЕ повторюйте продаж; якщо ні — повторіть.',
            409,
          )
        }
        if (!terminalResult.success) {
          throw new AppError('TERMINAL_DECLINED', terminalResult.error ?? 'Термінал відхилив оплату', 402)
        }
        bankAuthCode = terminalResult.authCode
        terminalRrn  = terminalResult.rrn ?? null
        isCharged = true
        logger.info({ rrn: terminalRrn, paymentRef }, 'Оплата успішна.')
      }
    }
  }

  return { bankAuthCode, terminalRrn, activeTerminalAdapter, isCharged, paymentRef }
}

async function executeSaleTransaction(
  cashierId: string,
  tenantId: string,
  input: CreateSaleInput,
  useBonusAtomic: boolean,
  bonusesEarned: number,
  cashAmount: number,
  cardAmount: number
): Promise<any> {
  return runTransaction(async (client) => {
    // Set local lock timeout to 2 seconds to prevent indefinitely hanging transaction locks
    await client.query("SET LOCAL lock_timeout = '2s'")

    // 1. Get allow_negative_qty
    const settingsRes = await client.query(
      'SELECT allow_negative_qty FROM shop_settings WHERE tenant_id = $1 LIMIT 1',
      [tenantId]
    )
    const allowNeg = settingsRes.rows[0]?.allow_negative_qty ?? true

    // 2. Generate next sale number without colliding with imported/restored data
    const saleNumber = await allocateSaleNumber(client, tenantId)

    // 3. sum subtotal and verify products/stock (Pass 1)
    let subtotal = 0
    const productsInfo = new Map()

    for (const item of input.items) {
      subtotal += item.unit_price * item.qty

      // Select and lock row
      const prodRes = await client.query(
        'SELECT qty_on_hand, is_service, COALESCE(purchase_price, 0) as cost_price, requires_core_return, core_deposit_amount FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
        [item.product_id, tenantId]
      )
      if (prodRes.rowCount === 0) {
        throw new AppError('PRODUCT_NOT_FOUND', `Товар ${item.product_id} не знайдено`, 404)
      }

      const product = prodRes.rows[0]
      const qtyOnHand = parseFloat(product.qty_on_hand)
      const isService = !!product.is_service
      const costPrice = parseInt(product.cost_price, 10)
      const requiresCoreReturn = !!product.requires_core_return
      const coreDepositAmount = parseInt(product.core_deposit_amount, 10) || 0

      // Add to subtotal: item price + core deposit (if applicable)
      const itemCoreDeposit = requiresCoreReturn ? coreDepositAmount : 0
      subtotal += (itemCoreDeposit * item.qty)

      productsInfo.set(item.product_id, {
        qty_on_hand: qtyOnHand,
        is_service: isService,
        cost_price: costPrice,
        requires_core_return: requiresCoreReturn,
        core_deposit_amount: coreDepositAmount
      })

      if (!isService) {
        const reserveRes = await client.query(
          `SELECT COALESCE(SUM(qty), 0) as reserved FROM inventory_reserves 
           WHERE product_id = $1 AND tenant_id = $2 AND released_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
          [item.product_id, tenantId]
        )
        const qtyReserved = parseFloat(reserveRes.rows[0].reserved)
        const qtyAvailable = qtyOnHand - qtyReserved

        if (qtyAvailable < item.qty && !allowNeg) {
          throw new AppError(
            'INSUFFICIENT_STOCK',
            `Недостатньо доступного залишку. Наявно: ${qtyOnHand}, в резерві: ${qtyReserved}, доступно: ${qtyAvailable}, потрібно: ${item.qty}`,
            422
          )
        }
      }
    }

    // 4. Verify client bonus balance
    const bonusesSpent = input.bonuses_spent ?? 0
    if (useBonusAtomic && bonusesSpent > 0 && input.customer_id) {
      const custRes = await client.query(
        'SELECT COALESCE(bonus_balance, 0) as bonus_balance FROM customers WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [input.customer_id, tenantId]
      )
      if (custRes.rowCount === 0) {
        throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
      }
      const bonusBalance = custRes.rows[0].bonus_balance
      if (bonusBalance < bonusesSpent) {
        throw new AppError(
          'INSUFFICIENT_BONUS',
          `Недостатньо бонусів. Є: ${bonusBalance}, потрібно: ${bonusesSpent}`,
          400
        )
      }
    }

    const total = Math.max(0, subtotal - input.discount)

    // 5. Create sale record
    const saleInsertRes = await client.query(
      `INSERT INTO sales (
        tenant_id, sale_number, customer_id, cashier_id, shift_id,
        status, subtotal, discount, total, payment_method,
        is_debt, notes, manager_id, cash_amount, card_amount,
        bonuses_spent, bonuses_earned
      ) VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        tenantId,
        saleNumber,
        input.customer_id ?? null,
        cashierId,
        input.shift_id,
        subtotal,
        input.discount,
        total,
        input.payment_method,
        input.payment_method === 'debt',
        input.notes ?? null,
        input.manager_id ?? cashierId,
        cashAmount,
        cardAmount,
        useBonusAtomic ? bonusesSpent : 0,
        useBonusAtomic ? bonusesEarned : 0
      ]
    )
    const sale = saleInsertRes.rows[0]

    // 6. Insert items & update product stock
    for (const item of input.items) {
      const pInfo = productsInfo.get(item.product_id)
      const requiresCore = pInfo.requires_core_return
      const coreDeposit = requiresCore ? pInfo.core_deposit_amount : 0
      const coreStatus = requiresCore ? 'pending' : 'none'
      
      const itemTotal = item.unit_price * item.qty - item.discount + (coreDeposit * item.qty)

      await client.query(
        `INSERT INTO sale_items (tenant_id, sale_id, product_id, qty, unit_price, discount, total, cost_price, core_deposit_amount, core_return_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tenantId,
          sale.id,
          item.product_id,
          item.qty,
          item.unit_price,
          item.discount,
          itemTotal,
          pInfo.cost_price,
          coreDeposit,
          coreStatus
        ]
      )

      if (!pInfo.is_service) {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
          [item.qty, item.product_id, tenantId]
        )
      }
    }

    // 7. Update customer debt if payment_method === 'debt'
    if (input.payment_method === 'debt' && input.customer_id) {
      await client.query(
        'UPDATE customers SET debt_balance = debt_balance + $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
        [total, input.customer_id, tenantId]
      )
    }

    // 8. Atomic loyalty bonus spent
    if (useBonusAtomic && bonusesSpent > 0 && input.customer_id) {
      await client.query(
        'UPDATE customers SET bonus_balance = bonus_balance - $1 WHERE id = $2 AND tenant_id = $3',
        [bonusesSpent, input.customer_id, tenantId]
      )

      await client.query(
        `INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description)
         VALUES ($1, $2, $3, 'spend', $4, 'Списано при покупці')`,
        [tenantId, input.customer_id, -bonusesSpent, sale.id]
      )
    }

    // 9. Atomic loyalty bonus earned
    if (useBonusAtomic && bonusesEarned > 0 && input.customer_id) {
      await client.query(
        'UPDATE customers SET bonus_balance = COALESCE(bonus_balance, 0) + $1 WHERE id = $2',
        [bonusesEarned, input.customer_id]
      )

      await client.query(
        `INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description)
         VALUES ($1, $2, $3, 'earn', $4, 'Нараховано за покупку')`,
        [tenantId, input.customer_id, bonusesEarned, sale.id]
      )
    }

    // 10. Link and complete customer order if customer_order_id is provided
    if (input.customer_order_id) {
      const orderRes = await client.query(
        'SELECT id, status FROM customer_orders WHERE id = $1 FOR UPDATE',
        [input.customer_order_id]
      )
      if (orderRes.rows && orderRes.rows.length > 0) {
        const order = orderRes.rows[0]
        if (order.status !== 'completed') {
          // Release reserves
          await client.query(
            'UPDATE inventory_reserves SET released_at = NOW() WHERE order_id = $1 AND released_at IS NULL',
            [input.customer_order_id]
          )
          // Update customer order items status to \'handed\'
          await client.query(
            "UPDATE customer_order_items SET item_status = 'handed' WHERE order_id = $1 AND item_status NOT IN ('canceled', 'handed')",
            [input.customer_order_id]
          )
          // Update customer order status & link to sale
          await client.query(
            "UPDATE customer_orders SET status = 'completed', sale_id = $1, updated_at = NOW() WHERE id = $2",
            [sale.id, input.customer_order_id]
          )
          // Insert order activity log
          await client.query(
            `INSERT INTO order_activity_log (order_id, user_id, action, details)
             VALUES ($1, $2, 'completed', $3)`,
            [
              input.customer_order_id,
              cashierId,
              'completed',
              JSON.stringify({ sale_id: sale.id, method: input.payment_method, note: 'Видано через касу (POS)' })
            ]
          )
        }
      }
    }

    return sale
  })
}

async function fiscalizeSale(sale: any, input: CreateSaleInput): Promise<{ fiscalNumber: string | null; fiscalQrUrl: string | null }> {
  let fiscalNumber: string | null = null
  let fiscalQrUrl:  string | null = null

  if (input.is_fiscal) {
    const settings = await (await import('./adminService.js')).getSettings(sale.tenant_id)
    const fiscalAdapter = getFiscalAdapter(settings)
    try {
      // Назви товарів для чека (а не UUID) + застави за старі деталі окремими рядками,
      // інакше сума рядків не зійдеться з payments і ПРРО відхилить чек
      const { data: prods } = await db
        .from('products')
        .select('id, name, requires_core_return, core_deposit_amount')
        .eq('tenant_id', sale.tenant_id)
        .in('id', input.items.map((i) => i.product_id))
      const prodMap = new Map((prods ?? []).map((p: any) => [p.id, p]))

      const fiscalItems = input.items.map((i) => ({
        name:       prodMap.get(i.product_id)?.name ?? i.product_id,
        qty:        i.qty,
        unit_price: i.unit_price,
        discount:   i.discount,
      }))

      // Загальна знижка чека (бонуси тощо) понад порядкові знижки розподіляється
      // по товарних рядках пропорційно їх вартості — інакше сума рядків
      // не зійдеться з payments. Порядкові знижки вже сидять у discount рядків.
      const itemDiscountSum = input.items.reduce((s, i) => s + i.discount, 0)
      const extraDiscount = Math.max(0, (input.discount ?? 0) - itemDiscountSum)
      if (extraDiscount > 0) {
        const lineValues = fiscalItems.map((it) => Math.max(0, it.unit_price * it.qty - it.discount))
        const base = lineValues.reduce((s, v) => s + v, 0)
        if (base > 0) {
          const target = Math.min(extraDiscount, base)
          const shares = lineValues.map((v) => Math.floor((target * v) / base))
          // залишкові копійки після округлення — на рядки, де ще є запас
          let remainder = target - shares.reduce((s, v) => s + v, 0)
          for (let i = 0; remainder > 0 && i < shares.length; i++) {
            const add = Math.min(lineValues[i] - shares[i], remainder)
            shares[i] += add
            remainder -= add
          }
          fiscalItems.forEach((it, i) => { it.discount += shares[i] })
        }
      }

      for (const i of input.items) {
        const p = prodMap.get(i.product_id)
        if (p?.requires_core_return && (p.core_deposit_amount ?? 0) > 0) {
          fiscalItems.push({
            name:       `Застава (обмін): ${p.name}`,
            qty:        i.qty,
            unit_price: p.core_deposit_amount,
            discount:   0,
          })
        }
      }

      const fiscalResult = await fiscalAdapter.fiscalize(
        sale.id,
        sale.sale_number ?? sale.id,
        sale.total,
        fiscalItems,
        input.payment_method,
      )

      if (fiscalResult.success) {
        fiscalNumber = fiscalResult.fiscal_number
        fiscalQrUrl  = fiscalResult.qr_url
      } else {
        logger.warn({ error: fiscalResult.error }, 'Фіскалізація: не вдалось фіскалізувати')
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Фіскалізація: помилка інтеграції')
    }
  }

  return { fiscalNumber, fiscalQrUrl }
}

async function processLegacyBonuses(sale: any, input: CreateSaleInput): Promise<void> {
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
    const settings = await (await import('./loyaltyService.js')).getSettings(sale.tenant_id)
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
    }).eq('id', sale.id).eq('tenant_id', sale.tenant_id)
    sale.bonuses_spent = bonusSpent
    sale.bonuses_earned = bonusEarned
  }
}

export async function createSale(cashierId: string, tenantId: string, input: CreateSaleInput, idempotencyKey?: string) {
  if (idempotencyKey) {
    const cachedResponse = await checkIdempotencyLock(idempotencyKey, tenantId)
    if (cachedResponse) return cachedResponse
  }

  const useBonusAtomic = process.env.USE_BONUS_ATOMIC_SALE !== 'false'
  let isCharged = false
  let activeTerminalAdapter: TerminalAdapter | null = null
  let bankAuthCode: string | null = null
  let terminalRrn:  string | null = null
  let terminalPaymentRef: string | null = null
  let cardChargeAmount = 0   // сума картки — для запису звірки при невдалому відкаті

  try {
    await verifyActiveShift(cashierId, input.shift_id, tenantId)

    // Calculate sums
    const subtotalItems = input.items.reduce((s, i) => s + i.unit_price * i.qty, 0)
    const discountedTotal = Math.max(0, subtotalItems - input.discount)

    // Застава за старі деталі: входить у суму до оплати (готівка/карта/термінал),
    // але НЕ в базу нарахування бонусів — це не виручка, а поворотний депозит
    let coreDepositTotal = 0
    const saleProductIds = input.items.map((i) => i.product_id)
    if (saleProductIds.length > 0) {
      const { data: coreProds } = await db
        .from('products')
        .select('id, requires_core_return, core_deposit_amount')
        .in('id', saleProductIds)
        .eq('tenant_id', tenantId)
      const coreMap = new Map((coreProds ?? []).map((p: any) => [p.id, p]))
      coreDepositTotal = input.items.reduce((s, i) => {
        const p = coreMap.get(i.product_id)
        return s + (p?.requires_core_return ? (p.core_deposit_amount ?? 0) * i.qty : 0)
      }, 0)
    }
    const paymentTotal = discountedTotal + coreDepositTotal

    let { cashAmount, cardAmount, bonusesEarned } = calculateSaleAmounts(input, paymentTotal)
    cardChargeAmount = cardAmount

    if (useBonusAtomic && input.customer_id && input.payment_method !== 'debt') {
      const { getSettings } = await import('./loyaltyService.js')
      const loyaltySettings = await getSettings(tenantId)
      if (loyaltySettings.is_enabled && discountedTotal >= (loyaltySettings.min_purchase_kopecks ?? 0)) {
        bonusesEarned = Math.round(discountedTotal * ((loyaltySettings.accrual_pct ?? 0) / 100))
      }
    }

    const termResult = await processTerminalPayment(input, cardAmount, tenantId)
    bankAuthCode = termResult.bankAuthCode
    terminalRrn = termResult.terminalRrn
    activeTerminalAdapter = termResult.activeTerminalAdapter
    isCharged = termResult.isCharged
    terminalPaymentRef = termResult.paymentRef

    const sale = await executeSaleTransaction(cashierId, tenantId, input, useBonusAtomic, bonusesEarned, cashAmount, cardAmount)

    const { fiscalNumber, fiscalQrUrl } = await fiscalizeSale(sale, input)

    const extraData: Record<string, unknown> = {}
    if (input.is_fiscal) extraData.is_fiscal = true
    if (fiscalNumber)    extraData.fiscal_number = fiscalNumber
    if (fiscalQrUrl)     extraData.fiscal_qr_url  = fiscalQrUrl
    if (bankAuthCode)    extraData.bank_auth_code  = bankAuthCode
    if (terminalRrn)     extraData.terminal_rrn    = terminalRrn

    if (Object.keys(extraData).length > 0) {
      await db.from('sales').update(extraData).eq('id', sale.id).eq('tenant_id', tenantId)
      Object.assign(sale, extraData)
    }

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

    if (input.pickup_cell) {
      await db.from('sales').update({ pickup_cell: input.pickup_cell })
        .eq('id', sale.id).eq('tenant_id', tenantId)
      sale.pickup_cell = input.pickup_cell
    }

    if (!useBonusAtomic) {
      await processLegacyBonuses(sale, input)
    }

    if (idempotencyKey) {
      await db.from('idempotency_keys')
        .update({
          status: 'completed',
          response: sale,
        })
        .eq('key', idempotencyKey)
        .eq('tenant_id', tenantId)
    }

    if (input.customer_order_id) {
      try {
        const { calculateAndRecordCommission } = await import('./commissionService.js')
        await calculateAndRecordCommission(input.customer_order_id, tenantId, cashierId)
      } catch (commErr: any) {
        logger.error({ orderId: input.customer_order_id, error: commErr?.message || String(commErr) }, 'Failed to calculate manager commission')
      }

      try {
        const { notifyStatusUpdate } = await import('./telegramBot.js')
        notifyStatusUpdate(input.customer_order_id, 'completed', tenantId).catch(() => {})
      } catch (notifyErr: any) {
        logger.error({ orderId: input.customer_order_id, error: notifyErr?.message || String(notifyErr) }, 'Failed to send completion notification')
      }
    } else {
      // Прямий продаж на касі (без замовлення) — комісія за категоріями продавцям
      try {
        const { calculateSaleCommission } = await import('./commissionService.js')
        await calculateSaleCommission(sale.id, tenantId, cashierId)
      } catch (commErr: any) {
        logger.error({ saleId: sale.id, error: commErr?.message || String(commErr) }, 'Failed to calculate sale commission')
      }
    }

    return sale
  } catch (err: any) {
    logger.error({ error: err.message, idempotencyKey }, 'Помилка в createSale. Запускаємо відкат...')

    if (isCharged && activeTerminalAdapter) {
      try {
        logger.info({ terminalRrn, bankAuthCode }, 'Спроба скасування транзакції на терміналі...')
        const cancelled = await activeTerminalAdapter.cancelPayment(bankAuthCode, terminalRrn)
        if (cancelled) {
          logger.info('Транзакцію успішно скасовано.')
        } else {
          logger.error('КРИТИЧНО: Не вдалося автоматично скасувати транзакцію на терміналі! Потрібне ручне втручання.')
          await recordReconciliation({
            tenantId, paymentRef: terminalPaymentRef, amountKopecks: cardChargeAmount,
            rrn: terminalRrn, authCode: bankAuthCode, status: 'charged_not_reversed',
            reason: `Списано на терміналі, автоскасування повернуло false. Помилка продажу: ${err.message}`,
          })
        }
      } catch (cancelErr: any) {
        logger.error({ cancelError: cancelErr.message }, 'КРИТИЧНО: Помилка при спробі скасування транзакції на терміналі!')
        await recordReconciliation({
          tenantId, paymentRef: terminalPaymentRef, amountKopecks: cardChargeAmount,
          rrn: terminalRrn, authCode: bankAuthCode, status: 'charged_not_reversed',
          reason: `Списано на терміналі, помилка скасування: ${cancelErr.message}. Помилка продажу: ${err.message}`,
        })
      }
    }

    if (idempotencyKey) {
      try {
        await db.from('idempotency_keys')
          .update({ status: 'failed' })
          .eq('key', idempotencyKey)
          .eq('tenant_id', tenantId)
      } catch {}
      try {
        await db.from('idempotency_keys')
          .delete()
          .eq('key', idempotencyKey)
          .eq('tenant_id', tenantId)
      } catch {}
    }

    throw err
  }
}

export async function resumeSale(saleId: string, tenantId: string) {
  const { data, error } = await db
    .from('sales')
    // Спочатку лише читаємо знімок. Видаляємо його зі списку окремим confirm
    // тільки після того, як браузер успішно відновив локальний кошик.
    .select('*, sale_items(*, product:products(id,sku,name,unit,qty_on_hand)), customer:customers(id,phone,full_name)')
    .eq('id', saleId)
    .eq('tenant_id', tenantId)
    .eq('status', 'suspended')
    .single()

  if (error || !data) throw new AppError('SALE_NOT_FOUND', 'Відкладений чек не знайдено', 404)
  return data
}

export async function confirmResumedSale(saleId: string, tenantId: string, userId: string, userRole: string) {
  const { data, error } = await db
    .from('sales')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', saleId)
    .eq('tenant_id', tenantId)
    .eq('status', 'suspended')
    .select('id,sale_number,total,status')
    .single()

  if (error || !data) throw new AppError('SALE_NOT_FOUND', 'Відкладений чек не знайдено', 404)
  await logAction({
    tenantId,
    userId,
    userRole,
    action: 'resume',
    entityType: 'sale',
    entityId: saleId,
    entityLabel: `Відкладений чек #${data.sale_number}`,
    oldValue: { status: 'suspended' },
    newValue: { status: 'returned_to_cart' },
    note: 'Відкладений чек повернено в кошик каси',
  })
  return data
}

export async function discardSuspendedSale(saleId: string, tenantId: string, userId: string, userRole: string) {
  const { data, error } = await db
    .from('sales')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', saleId)
    .eq('tenant_id', tenantId)
    .eq('status', 'suspended')
    .select('id,sale_number,total,status')
    .single()

  if (error || !data) throw new AppError('SALE_NOT_FOUND', 'Відкладений чек не знайдено', 404)
  await logAction({
    tenantId,
    userId,
    userRole,
    action: 'delete',
    entityType: 'sale',
    entityId: saleId,
    entityLabel: `Відкладений чек #${data.sale_number}`,
    oldValue: { status: 'suspended', total: data.total },
    newValue: { status: 'cancelled' },
    note: 'Відкладений чек видалено з каси',
  })
  return data
}

/** Позначити чек як готовий до видачі + надіслати сповіщення */
export async function markReadyForPickup(saleId: string, tenantId: string) {
  const { data: sale, error: saleErr } = await db
    .from('sales')
    .update({ status: 'ready_for_pickup', updated_at: new Date().toISOString() })
    .eq('id', saleId)
    .eq('tenant_id', tenantId)
    .select('*, customer:customers(id, full_name, phone)')
    .single()

  if (saleErr || !sale) throw new AppError('SALE_NOT_FOUND', 'Чек не знайдено', 404)

  // Авто-сповіщення через месенджер
  if (sale.customer) {
    const { data: settings } = await db.from('shop_settings').select('auto_notify_order_ready').eq('tenant_id', tenantId).single() as any
    if (settings?.auto_notify_order_ready !== false) {
      const { data: chat } = await db.from('messenger_chats')
        .select('platform_chat_id, channel:messenger_channels(id, platform, credentials)')
        .eq('customer_id', sale.customer.id)
        .eq('tenant_id', tenantId)
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
