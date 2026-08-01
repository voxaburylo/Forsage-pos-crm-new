import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { assertTenantSyncGenerationInTransaction } from './syncGeneration.js'
import { AppError } from '../middleware/errorHandler.js'
import { getCurrentShift } from './shiftService.js'
import { logAction } from './auditService.js'
import { logger } from '../lib/logger.js'
import type { CreateSaleInput, CalculatePriceInput, SaleListQuery } from '../validators/saleSchema.js'
import { getTerminalAdapter, getFiscalAdapter, TerminalAdapter } from './integrations/adapterFactory.js'
import { calculateSaleAmounts, saleRequestHash } from './salePayment.js'
import { computeCommissionMap, type CommissionItem, type ProductsMap } from './commissionCalculator.js'

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
  const { shift_id, customer_id, sale_number, search, status, product_barcode, date_from, date_to, page, per_page } = query
  const offset = (page - 1) * per_page

  let productSaleIds: string[] | null = null
  const barcode = product_barcode?.trim()
  if (barcode) {
    const productIds = new Set<string>()

    const { data: byBarcode, error: byBarcodeError } = await db
      .from('products')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('barcode', barcode)
      .is('deleted_at', null)
    if (byBarcodeError) throw new AppError('DB_ERROR', byBarcodeError.message, 500)
    byBarcode?.forEach((p: any) => productIds.add(p.id))

    const { data: bySku, error: bySkuError } = await db
      .from('products')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('sku', barcode)
      .is('deleted_at', null)
    if (bySkuError) throw new AppError('DB_ERROR', bySkuError.message, 500)
    bySku?.forEach((p: any) => productIds.add(p.id))

    const { data: extraBarcodes, error: extraBarcodeError } = await db
      .from('product_barcodes')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .eq('barcode', barcode)
      .is('deleted_at', null)
    if (extraBarcodeError) throw new AppError('DB_ERROR', extraBarcodeError.message, 500)
    extraBarcodes?.forEach((p: any) => productIds.add(p.product_id))

    const ids = Array.from(productIds).filter(Boolean)
    if (ids.length === 0) {
      return { data: [], pagination: { page, per_page, total: 0, total_pages: 0 } }
    }

    const { data: saleItems, error: saleItemsError } = await db
      .from('sale_items')
      .select('sale_id')
      .eq('tenant_id', tenantId)
      .in('product_id', ids)
      .is('deleted_at', null)
      .limit(1000)
    if (saleItemsError) throw new AppError('DB_ERROR', saleItemsError.message, 500)
    productSaleIds = Array.from(new Set((saleItems ?? []).map((item: any) => item.sale_id).filter(Boolean)))
    if (productSaleIds.length === 0) {
      return { data: [], pagination: { page, per_page, total: 0, total_pages: 0 } }
    }
  }

  let q = db
    .from(TABLE)
    .select('*, sale_items(id,qty,product:products(id,sku,name,unit)), customer:customers(id,phone,full_name)', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('completed_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (shift_id) q = q.eq('shift_id', shift_id)
  if (customer_id) q = q.eq('customer_id', customer_id)
  if (sale_number) q = q.eq('sale_number', sale_number)
  if (status) q = q.eq('status', status)
  if (productSaleIds) q = q.in('id', productSaleIds)

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
      .is('deleted_at', null)
      .ilike('vin', `%${search}%`)
    vehs?.forEach((v: any) => customerIds.push(v.customer_id))

    const { data: cars } = await db
      .from('customer_cars')
      .select('customer_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
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
    .select('*, sale_items(*, product:products(id,sku,name,unit)), customer:customers(id,phone,full_name), returns(id, refund_kopecks, refund_method, fiscal_number, created_at)')
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

async function checkIdempotencyLock(idempotencyKey: string, tenantId: string, requestHash: string): Promise<any> {
  // Скільки часу «processing»-лок вважається живим. Якщо сервер упав/зник струм
  // між блокуванням і завершенням — старий лок інакше блокував би цю вкладку НАЗАВЖДИ.
  const PROCESSING_TTL_MS = 2 * 60 * 1000

  const { data: cached } = await db
    .from('idempotency_keys')
    .select('status, response, created_at, request_hash')
    .eq('key', idempotencyKey)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (cached) {
    if (cached.request_hash && cached.request_hash !== requestHash) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'Цей номер операції вже використано для іншого продажу',
        409,
      )
    }
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
      const { data: committedSale } = await db
        .from('sales')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('client_operation_id', idempotencyKey)
        .maybeSingle()
      if (committedSale) {
        await db.from('idempotency_keys').update({
          status: 'completed',
          response: committedSale,
          request_hash: requestHash,
        }).eq('key', idempotencyKey).eq('tenant_id', tenantId)
        return committedSale
      }
      // Лок «завис» до створення продажу — прибираємо й пробуємо знову.
      logger.warn({ idempotencyKey, ageMs }, 'Idempotency stale processing lock — очищаємо застряглий лок')
      try {
        await db.from('idempotency_keys').delete().eq('key', idempotencyKey).eq('tenant_id', tenantId)
      } catch {}
    }
    if (cached.status === 'failed') {
      if ((cached.response as any)?.retry_blocked === true) {
        throw new AppError(
          'PAYMENT_RECONCILIATION_REQUIRED',
          'Повтор оплати заблоковано: спочатку звірте операцію на банківському терміналі',
          409,
        )
      }
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
    response: null,
    request_hash: requestHash,
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
  bonusExpiresAt: string | null,
  cashAmount: number,
  cardAmount: number,
  transferAmount: number,
  idempotencyKey: string | undefined,
  requestHash: string,
  clientResetGeneration: number,
): Promise<any> {
  return runTransaction(async (client) => {
    // Set local lock timeout to 2 seconds to prevent indefinitely hanging transaction locks
    await client.query("SET LOCAL lock_timeout = '2s'")
    await assertTenantSyncGenerationInTransaction(client, tenantId, clientResetGeneration)

    // 1. Get allow_negative_qty
    const settingsRes = await client.query(
      'SELECT allow_negative_qty FROM shop_settings WHERE tenant_id = $1 LIMIT 1',
      [tenantId]
    )
    const allowNeg = settingsRes.rows[0]?.allow_negative_qty ?? false

    // 2. Generate next sale number without colliding with imported/restored data
    const saleNumber = await allocateSaleNumber(client, tenantId)

    // 3. sum subtotal and verify products/stock (Pass 1)
    let subtotal = 0
    const productsInfo = new Map()

    for (const item of input.items) {
      subtotal += item.unit_price * item.qty

      // Select and lock row
      const prodRes = await client.query(
        'SELECT qty_on_hand, is_service, COALESCE(purchase_price, 0) as cost_price, requires_core_return, core_deposit_amount, brand_id, category_id, sku FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
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
        core_deposit_amount: coreDepositAmount,
        brand_id: product.brand_id ?? null,
        category_id: product.category_id ?? null,
        sku: product.sku ?? null,
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

    // 4. Lock customer, apply expired bonuses and verify the usable balance.
    const bonusesSpent = input.bonuses_spent ?? 0
    let customerInfo: any | null = null
    let cashbackPct = 0
    if (input.customer_id) {
      const custRes = await client.query(
        `SELECT id, COALESCE(bonus_balance, 0) AS bonus_balance,
                COALESCE(deposit_balance, 0) AS deposit_balance,
                loyalty_mode, COALESCE(discount_pct, 0) AS discount_pct, price_tier_id
         FROM customers
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1 FOR UPDATE`,
        [input.customer_id, tenantId],
      )
      if (!custRes.rowCount) throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
      customerInfo = custRes.rows[0]

      const expiryTotals = await client.query(
        `SELECT
           COALESCE(SUM(amount) FILTER (
             WHERE transaction_type = 'earn' AND amount > 0
               AND expires_at IS NOT NULL AND expires_at <= NOW()
           ), 0)::bigint AS expired_earned,
           COALESCE(-SUM(amount) FILTER (WHERE transaction_type = 'spend' AND amount < 0), 0)::bigint AS spent,
           COALESCE(-SUM(amount) FILTER (WHERE transaction_type = 'manual' AND amount < 0), 0)::bigint AS manual_spent,
           COALESCE(-SUM(amount) FILTER (WHERE transaction_type = 'expire' AND amount < 0), 0)::bigint AS already_expired
         FROM bonus_transactions
         WHERE customer_id = $1 AND tenant_id = $2`,
        [input.customer_id, tenantId],
      )
      const expiry = expiryTotals.rows[0] ?? {}
      const expiredAmount = Math.min(Number(customerInfo.bonus_balance ?? 0), Math.max(0,
        Number(expiry.expired_earned ?? 0)
        - Number(expiry.spent ?? 0)
        - Number(expiry.manual_spent ?? 0)
        - Number(expiry.already_expired ?? 0),
      ))
      if (expiredAmount > 0) {
        customerInfo.bonus_balance = Number(customerInfo.bonus_balance ?? 0) - expiredAmount
        await client.query(
          'UPDATE customers SET bonus_balance = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
          [customerInfo.bonus_balance, input.customer_id, tenantId],
        )
        await client.query(
          `INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, description)
           VALUES ($1, $2, $3, 'expire', 'Закінчився строк дії бонусів')`,
          [tenantId, input.customer_id, -expiredAmount],
        )
      }
      if (useBonusAtomic && bonusesSpent > Number(customerInfo.bonus_balance ?? 0)) {
        throw new AppError(
          'INSUFFICIENT_BONUS',
          `Недостатньо бонусів. Є: ${customerInfo.bonus_balance}, потрібно: ${bonusesSpent}`,
          400,
        )
      }
      cashbackPct = Number(customerInfo.discount_pct ?? 0)
      if (customerInfo.price_tier_id) {
        const tier = await client.query(
          'SELECT COALESCE(discount_pct, 0) AS discount_pct FROM price_tiers WHERE id = $1 AND tenant_id = $2 LIMIT 1',
          [customerInfo.price_tier_id, tenantId],
        )
        if (tier.rowCount) cashbackPct = Number(tier.rows[0].discount_pct ?? cashbackPct)
      }
    }

    const total = Math.max(0, subtotal - input.discount)

    // 5. Create sale record
    const saleInsertRes = await client.query(
      `INSERT INTO sales (
        tenant_id, sale_number, customer_id, cashier_id, shift_id,
        status, subtotal, discount, total, payment_method,
        is_debt, notes, manager_id, cash_amount, card_amount,
        bonuses_spent, bonuses_earned, transfer_amount, client_operation_id,
        client_payload_hash, fiscal_status
      ) VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
        useBonusAtomic ? bonusesEarned : 0,
        transferAmount,
        idempotencyKey ?? null,
        idempotencyKey ? requestHash : null,
        input.is_fiscal ? 'pending' : 'not_requested',
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
        `INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description, created_by)
         VALUES ($1, $2, $3, 'spend', $4, 'Списано при покупці', $5)`,
        [tenantId, input.customer_id, -bonusesSpent, sale.id, cashierId]
      )
    }

    // 9. Atomic loyalty bonus earned
    if (useBonusAtomic && bonusesEarned > 0 && input.customer_id) {
      await client.query(
        'UPDATE customers SET bonus_balance = COALESCE(bonus_balance, 0) + $1 WHERE id = $2 AND tenant_id = $3',
        [bonusesEarned, input.customer_id, tenantId]
      )

      await client.query(
        `INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, source_sale_id, description, created_by, expires_at)
         VALUES ($1, $2, $3, 'earn', $4, 'Нараховано за покупку', $5, $6)`,
        [tenantId, input.customer_id, bonusesEarned, sale.id, cashierId, bonusExpiresAt]
      )
    }

    // Cashback is part of the sale transaction, so a completed sale can never
    // exist without the matching customer-account movement.
    if (
      input.customer_id
      && customerInfo?.loyalty_mode === 'cashback'
      && input.payment_method !== 'debt'
      && cashbackPct > 0
    ) {
      const cashbackBase = Math.max(0,
        input.items.reduce((sum, item) => sum + item.unit_price * item.qty, 0) - input.discount,
      )
      const cashback = Math.round(cashbackBase * cashbackPct / 100)
      if (cashback > 0) {
        const balanceAfter = Number(customerInfo.deposit_balance ?? 0) + cashback
        await client.query(
          'UPDATE customers SET deposit_balance = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
          [balanceAfter, input.customer_id, tenantId],
        )
        await client.query(
          `INSERT INTO customer_deposit_transactions
            (tenant_id, customer_id, amount, balance_after, method, sale_id, shift_id, notes, created_by)
           VALUES ($1, $2, $3, $4, 'cashback', $5, $6, $7, $8)`,
          [tenantId, input.customer_id, cashback, balanceAfter, sale.id, input.shift_id,
            `Накопичення ${cashbackPct}% з чека #${sale.sale_number ?? ''}`, cashierId],
        )
        customerInfo.deposit_balance = balanceAfter
      }
    }

    // 10. Link and complete customer order if customer_order_id is provided
    let commissionManagerId: string | null = input.manager_id ?? cashierId
    const commissionContext = input.customer_order_id ? 'order' : 'pos'
    if (input.customer_order_id) {
      const orderRes = await client.query(
        'SELECT id, status, sale_id, manager_id FROM customer_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [input.customer_order_id, tenantId]
      )
      if (!orderRes.rows || orderRes.rows.length === 0) {
        throw new AppError('ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
      }
      const order = orderRes.rows[0]
      commissionManagerId = order.manager_id ?? commissionManagerId
      if (order.status === 'completed' && order.sale_id) {
        throw new AppError('ORDER_ALREADY_COMPLETED', 'Замовлення вже завершено', 409)
      }

      await client.query(
        'UPDATE inventory_reserves SET released_at = NOW() WHERE order_id = $1 AND tenant_id = $2 AND released_at IS NULL',
        [input.customer_order_id, tenantId]
      )
      await client.query(
        `UPDATE customer_order_items i
         SET item_status = 'handed'
         WHERE i.order_id = $1
           AND i.item_status NOT IN ('canceled', 'handed')
           AND EXISTS (
             SELECT 1 FROM customer_orders o
             WHERE o.id = i.order_id AND o.tenant_id = $2
           )`,
        [input.customer_order_id, tenantId]
      )
      await client.query(
        "UPDATE customer_orders SET status = 'completed', sale_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3",
        [sale.id, input.customer_order_id, tenantId]
      )
      await client.query(
        `INSERT INTO order_activity_log (order_id, user_id, action, details)
         VALUES ($1, $2, 'completed', $3)`,
        [
          input.customer_order_id,
          cashierId,
          JSON.stringify({ sale_id: sale.id, method: input.payment_method, note: 'Видано через касу (POS)' })
        ]
      )
    }

    // Salary commission is committed together with the sale. This also keeps
    // desktop/server behavior identical for personal and whole-cashbox rules.
    const rulesResult = await client.query(
      'SELECT * FROM commission_rules WHERE tenant_id = $1',
      [tenantId],
    )
    if (rulesResult.rowCount) {
      const productsMap: ProductsMap = {}
      const commissionItems: CommissionItem[] = input.items.map((item) => {
        const product = productsInfo.get(item.product_id)
        productsMap[item.product_id] = {
          brand_id: product?.brand_id ?? null,
          category_id: product?.category_id ?? null,
          sku: product?.sku ?? null,
        }
        return {
          product_id: item.product_id,
          sell_price: item.unit_price,
          buy_price: product?.cost_price ?? 0,
          qty: Number(item.qty),
        }
      })
      const commissions = computeCommissionMap(
        commissionItems,
        productsMap,
        rulesResult.rows,
        commissionManagerId,
        commissionContext,
      )
      for (const [employeeId, amount] of commissions) {
        const employee = await client.query(
          `SELECT COALESCE(raw_user_meta_data->>'full_name', email, 'Співробітник') AS full_name
           FROM auth.users WHERE id = $1 LIMIT 1`,
          [employeeId],
        )
        const employeeName = employee.rows[0]?.full_name
          ?? (employeeId === commissionManagerId ? 'Менеджер' : 'Співробітник')
        await client.query(
          `INSERT INTO salary_payments (
             tenant_id, employee_id, employee_name, amount, type, method, period,
             work_date, source, note, created_by, commission_source_sale_id,
             commission_source_order_id
           ) VALUES (
             $1, $2, $3, $4, 'bonus', 'cash',
             to_char(NOW() AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM'),
             (NOW() AT TIME ZONE 'Europe/Kyiv')::date,
             'commission', $5, $6, $7, $8
           )
           ON CONFLICT DO NOTHING`,
          [
            tenantId,
            employeeId,
            employeeName,
            amount,
            input.customer_order_id
              ? `Комісія за замовлення #${sale.sale_number}`
              : `Комісія за продаж (чек #${sale.sale_number})`,
            cashierId,
            sale.id,
            input.customer_order_id ?? null,
          ],
        )
      }
    }

    if (idempotencyKey) {
      const completed = await client.query(
        `UPDATE idempotency_keys
         SET status = 'completed', response = $1::jsonb, request_hash = $2
         WHERE key = $3 AND tenant_id = $4`,
        [JSON.stringify(sale), requestHash, idempotencyKey, tenantId],
      )
      if (completed.rowCount !== 1) {
        throw new AppError('IDEMPOTENCY_LOST', 'Не вдалося зафіксувати захист від повторного продажу', 500)
      }
    }

    return sale
  })
}

async function fiscalizeSale(sale: any, input: CreateSaleInput): Promise<{ fiscalNumber: string | null; fiscalQrUrl: string | null; error: string | null }> {
  let fiscalNumber: string | null = null
  let fiscalQrUrl:  string | null = null
  let fiscalError: string | null = null

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
        fiscalError = fiscalResult.error ?? 'ПРРО не повернув фіскальний номер'
        logger.warn({ error: fiscalResult.error }, 'Фіскалізація: не вдалось фіскалізувати')
      }
    } catch (err: any) {
      fiscalError = err.message ?? 'Помилка зв’язку з ПРРО'
      logger.error({ error: err.message }, 'Фіскалізація: помилка інтеграції')
    }
  }

  return { fiscalNumber, fiscalQrUrl, error: fiscalError }
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

export async function createSale(
  cashierId: string,
  tenantId: string,
  input: CreateSaleInput,
  idempotencyKey?: string,
  clientResetGeneration = 0,
) {
  const requestHash = saleRequestHash(input)
  if (idempotencyKey) {
    const cachedResponse = await checkIdempotencyLock(idempotencyKey, tenantId, requestHash)
    if (cachedResponse) return cachedResponse
  }

  // Bonus and sale balances must always be committed together.
  const useBonusAtomic = true
  let isCharged = false
  let activeTerminalAdapter: TerminalAdapter | null = null
  let bankAuthCode: string | null = null
  let terminalRrn:  string | null = null
  let terminalPaymentRef: string | null = null
  let cardChargeAmount = 0   // сума картки — для запису звірки при невдалому відкаті
  let committedSale: any | null = null

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

    let { cashAmount, cardAmount, transferAmount, bonusesEarned } = calculateSaleAmounts(input, paymentTotal)
    let bonusExpiresAt: string | null = null
    cardChargeAmount = cardAmount

    if (useBonusAtomic && input.customer_id && input.payment_method !== 'debt') {
      const { getSettings } = await import('./loyaltyService.js')
      const loyaltySettings = await getSettings(tenantId)
      if (loyaltySettings.is_enabled && discountedTotal >= (loyaltySettings.min_purchase_kopecks ?? 0)) {
        bonusesEarned = Math.round(discountedTotal * ((loyaltySettings.accrual_pct ?? 0) / 100))
        bonusExpiresAt = loyaltySettings.expiry_days
          ? new Date(Date.now() + Number(loyaltySettings.expiry_days) * 86400000).toISOString()
          : null
      }
    }

    const termResult = await processTerminalPayment(input, cardAmount, tenantId)
    bankAuthCode = termResult.bankAuthCode
    terminalRrn = termResult.terminalRrn
    activeTerminalAdapter = termResult.activeTerminalAdapter
    isCharged = termResult.isCharged
    terminalPaymentRef = termResult.paymentRef

    const sale = await executeSaleTransaction(
      cashierId, tenantId, input, useBonusAtomic, bonusesEarned, bonusExpiresAt,
      cashAmount, cardAmount, transferAmount, idempotencyKey, requestHash,
      clientResetGeneration,
    )
    committedSale = sale

    const { fiscalNumber, fiscalQrUrl, error: fiscalError } = await fiscalizeSale(sale, input)

    const extraData: Record<string, unknown> = {}
    if (input.is_fiscal) {
      extraData.is_fiscal = Boolean(fiscalNumber)
      extraData.fiscal_status = fiscalNumber ? 'completed' : 'failed'
      extraData.fiscal_error = fiscalNumber ? null : fiscalError ?? 'Не вдалося фіскалізувати чек'
    }
    if (fiscalNumber)    extraData.fiscal_number = fiscalNumber
    if (fiscalQrUrl)     extraData.fiscal_qr_url  = fiscalQrUrl
    if (bankAuthCode)    extraData.bank_auth_code  = bankAuthCode
    if (terminalRrn)     extraData.terminal_rrn    = terminalRrn

    if (Object.keys(extraData).length > 0) {
      await db.from('sales').update(extraData).eq('id', sale.id).eq('tenant_id', tenantId)
      Object.assign(sale, extraData)
    }

    if (idempotencyKey) {
      await db.from('idempotency_keys').update({ response: sale, request_hash: requestHash })
        .eq('key', idempotencyKey).eq('tenant_id', tenantId).eq('status', 'completed')
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

    if (input.customer_order_id) {
      try {
        const { notifyStatusUpdate } = await import('./telegramBot.js')
        notifyStatusUpdate(input.customer_order_id, 'completed', tenantId).catch(() => {})
      } catch (notifyErr: any) {
        logger.error({ orderId: input.customer_order_id, error: notifyErr?.message || String(notifyErr) }, 'Failed to send completion notification')
      }
    }

    return sale
  } catch (err: any) {
    logger.error({ error: err.message, idempotencyKey }, 'Помилка в createSale. Запускаємо відкат...')

    if (committedSale) {
      logger.error({ saleId: committedSale.id, error: err.message }, 'Продаж вже зафіксовано; повторну оплату та відкат термінала заборонено')
      committedSale.post_processing_warning = err.message
      return committedSale
    }

    let retryBlocked = err?.code === 'TERMINAL_UNKNOWN'
    if (isCharged && activeTerminalAdapter) {
      try {
        logger.info({ terminalRrn, bankAuthCode }, 'Спроба скасування транзакції на терміналі...')
        const cancelled = await activeTerminalAdapter.cancelPayment(bankAuthCode, terminalRrn)
        if (cancelled) {
          logger.info('Транзакцію успішно скасовано.')
        } else {
          retryBlocked = true
          logger.error('КРИТИЧНО: Не вдалося автоматично скасувати транзакцію на терміналі! Потрібне ручне втручання.')
          await recordReconciliation({
            tenantId, paymentRef: terminalPaymentRef, amountKopecks: cardChargeAmount,
            rrn: terminalRrn, authCode: bankAuthCode, status: 'charged_not_reversed',
            reason: `Списано на терміналі, автоскасування повернуло false. Помилка продажу: ${err.message}`,
          })
        }
      } catch (cancelErr: any) {
        retryBlocked = true
        logger.error({ cancelError: cancelErr.message }, 'КРИТИЧНО: Помилка при спробі скасування транзакції на терміналі!')
        await recordReconciliation({
          tenantId, paymentRef: terminalPaymentRef, amountKopecks: cardChargeAmount,
          rrn: terminalRrn, authCode: bankAuthCode, status: 'charged_not_reversed',
          reason: `Списано на терміналі, помилка скасування: ${cancelErr.message}. Помилка продажу: ${err.message}`,
        })
      }
    }

    if (idempotencyKey) {
      if (retryBlocked) {
        try {
          await db.from('idempotency_keys')
            .update({
              status: 'failed',
              response: { retry_blocked: true, reason: err.message },
              request_hash: requestHash,
            })
            .eq('key', idempotencyKey)
            .eq('tenant_id', tenantId)
        } catch {}
      } else {
        try {
          await db.from('idempotency_keys')
            .delete()
            .eq('key', idempotencyKey)
            .eq('tenant_id', tenantId)
        } catch {}
      }
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
