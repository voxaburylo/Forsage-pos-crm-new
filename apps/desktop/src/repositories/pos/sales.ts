/**
 * Продажі: чек, відкладені чеки, ціни.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import type { LocalSaleCheckoutInput, LocalSaleCheckoutResult } from '../../db/localTypes'
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import { LocalStaffRepository } from '../staffRepository'
import { lineTotal, money, nowIso, operationId, payloadHash, paymentMethod } from './posShared'
import { randomUUID } from 'node:crypto'
import { LocalPosCustomers } from './customers'

export class LocalPosSales extends LocalPosCustomers {
  getSale(saleId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT s.*, c.phone AS customer_phone, c.full_name AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `).get(saleId, tenantId) as any
    if (!row) throw new Error('Чек не знайдено')
    return this.decorateSale(row, tenantId)
  }

  listSales(input: { tenant_id?: string; search?: string; status?: string; product_barcode?: string; date_from?: string; date_to?: string; page?: number; per_page?: number } = {}): {
    data: any[]
    pagination: { page: number; per_page: number; total: number; total_pages: number }
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(200, Number(input.per_page ?? 20) || 20))
    const where = ['s.tenant_id = ?', 's.deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (input.status) {
      where.push('s.status = ?')
      params.push(input.status)
    }
    const productBarcode = String(input.product_barcode ?? '').trim()
    if (productBarcode) {
      where.push(`EXISTS (
        SELECT 1
        FROM sale_items si
        LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
        LEFT JOIN product_barcodes pb ON pb.product_id = si.product_id AND pb.tenant_id = si.tenant_id AND pb.deleted_at IS NULL
        WHERE si.sale_id = s.id
          AND si.tenant_id = s.tenant_id
          AND si.deleted_at IS NULL
          AND (COALESCE(p.barcode, '') = ? OR COALESCE(p.sku, '') = ? OR COALESCE(pb.barcode, '') = ?)
      )`)
      params.push(productBarcode, productBarcode, productBarcode)
    }
    if (input.date_from) {
      where.push('COALESCE(s.completed_at, s.created_at) >= ?')
      params.push(input.date_from)
    }
    if (input.date_to) {
      where.push('COALESCE(s.completed_at, s.created_at) <= ?')
      params.push(input.date_to)
    }
    const raw = String(input.search ?? '').trim()
    if (raw) {
      const lower = raw.toLocaleLowerCase('uk-UA')
      const title = lower.replace(/(^|\s)\S/g, (char) => char.toLocaleUpperCase('uk-UA'))
      const q = `%${raw}%`
      where.push(`(
        s.sale_number LIKE ?
        OR COALESCE(c.phone, '') LIKE ?
        OR COALESCE(c.card_barcode, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR EXISTS (
          SELECT 1 FROM customer_vehicles v
          WHERE v.customer_id = c.id AND v.tenant_id = s.tenant_id
            AND v.deleted_at IS NULL AND upper(COALESCE(v.vin, '')) LIKE upper(?)
        )
      )`)
      params.push(q, q, q, q, `%${title}%`, q)
    }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE ${whereSql}
    `).get(...params) as { total: number }
    const rows = this.db.prepare(`
      SELECT s.*, c.phone AS customer_phone, c.full_name AS customer_name,
             EXISTS (
               SELECT 1 FROM customer_orders o
               WHERE o.tenant_id = s.tenant_id
                 AND o.sale_id = s.id
                 AND o.deleted_at IS NULL
             ) AS is_order_sale
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE ${whereSql}
      ORDER BY COALESCE(s.completed_at, s.created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, (page - 1) * perPage) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateSale(row, tenantId)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  calculatePrices(items: Array<{ product_id: string; qty: number }>, tenantId = DEFAULT_TENANT_ID): any[] {
    return items.map((item) => {
      const product = this.getProductForUpdate(item.product_id, tenantId)
      if (!product) throw new Error('Товар не знайдено')
      const qty = Number(item.qty ?? 0)
      return {
        product_id: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        unit_price: Number(product.retail_price ?? 0),
        qty,
        total: Number(product.retail_price ?? 0) * qty,
        in_stock: Number(product.qty_on_hand ?? 0) >= qty,
        qty_on_hand: Number(product.qty_on_hand ?? 0),
      }
    })
  }

  suspendSale(input: any): { data: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!input.shift_id) throw new Error('Касову зміну не відкрито')
    const timestamp = nowIso()
    const saleId = randomUUID()
    const saleNumber = this.nextSaleNumber(tenantId, timestamp)
    const prepared = (input.items ?? []).map((item: any) => {
      const product = this.getProductForUpdate(item.product_id, tenantId)
      if (!product) throw new Error('Товар не знайдено')
      const qty = Number(item.qty ?? 0)
      if (qty <= 0) throw new Error('Некоректна кількість')
      const unitPrice = money(item.unit_price ?? product.retail_price)
      const discount = money(item.discount ?? 0)
      return {
        id: randomUUID(), product_id: product.id, description: product.name, sku: product.sku,
        qty, unit_price: unitPrice, purchase_price: product.purchase_price,
        discount, total: lineTotal(qty, unitPrice, discount),
      }
    })
    if (!prepared.length) throw new Error('Чек порожній')
    const subtotal = prepared.reduce((sum: number, item: any) => sum + item.total, 0)
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          cash_amount, card_amount, transfer_amount, debt_amount, pickup_cell, notes,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'suspended', ?, 0, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?)
      `).run(
        saleId, tenantId, saleNumber, input.customer_id ?? null,
        input.cashier_id ?? input.manager_id ?? 'local', input.manager_id ?? null, input.shift_id,
        subtotal, subtotal, input.payment_method ?? 'cash', input.pickup_cell ?? null,
        input.notes ?? null, timestamp, timestamp, timestamp,
      )
      for (const item of prepared) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, tenantId, saleId, item.product_id, item.description, item.sku,
          item.qty, item.unit_price, item.purchase_price, item.discount, item.total,
          timestamp, timestamp,
        )
      }
      this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended', {
        id: saleId, sale_number: saleNumber, ...input, subtotal, total: subtotal, created_at: timestamp,
      }, timestamp)
    })
    return { data: this.getSale(saleId, tenantId) }
  }

  listSuspendedSales(tenantId = DEFAULT_TENANT_ID): any[] {
    return this.listSales({ tenant_id: tenantId, status: 'suspended', page: 1, per_page: 200 }).data
  }

  resumeSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    return { data: sale }
  }

  confirmResumeSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE sales SET status = 'cancelled', dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, saleId, tenantId)
    this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended_resumed', { id: saleId }, timestamp)
    return { data: { ...sale, status: 'cancelled' } }
  }

  discardSuspendedSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE sales SET status = 'cancelled', deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, timestamp, saleId, tenantId)
    this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended_deleted', { id: saleId }, timestamp)
    return { data: { ...sale, status: 'cancelled' } }
  }

  checkSaleAfterPayment(shiftId: string, after: string, tenantId = DEFAULT_TENANT_ID): any | null {
    const row = this.db.prepare(`
      SELECT id FROM sales
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
        AND status = 'completed' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(tenantId, shiftId, after) as { id: string } | undefined
    return row ? this.getSale(row.id, tenantId) : null
  }

  checkout(input: LocalSaleCheckoutInput): LocalSaleCheckoutResult {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const clientOperationId = operationId(input.client_operation_id)
    const checkoutHash = this.checkoutPayloadHash(input, tenantId)
    if (clientOperationId) {
      const existing = this.existingCheckoutResult(tenantId, clientOperationId, checkoutHash)
      if (existing) return existing
    }
    this.assertCheckoutReady(input)
    if (input.is_fiscal === true) {
      if (!clientOperationId) throw new Error('FISCAL_OPERATION_ID_REQUIRED')
      this.assertFiscalIntentCanCheckout(clientOperationId, checkoutHash, input.fiscal_number)
    }

    return this.db.transaction(() => {
      if (clientOperationId) {
        const existing = this.existingCheckoutResult(tenantId, clientOperationId, checkoutHash)
        if (existing) return existing
      }
      if (input.is_fiscal === true && clientOperationId) {
        this.assertFiscalIntentCanCheckout(clientOperationId, checkoutHash, input.fiscal_number)
      }
      this.assertSaleStockAvailable(input.items, tenantId)
      const timestamp = nowIso()
      const saleId = randomUUID()
      const shiftId = input.shift_id ?? this.findOpenShift(input.cashier_id, tenantId)
      if (!shiftId) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')

      const saleNumber = this.nextSaleNumber(tenantId, timestamp)
      const payments = this.summarizePayments(input.payments)
      let subtotal = 0
      let itemDiscountTotal = 0
      const preparedItems = input.items.map((item) => {
        if (item.qty <= 0) throw new Error('LOCAL_SALE_INVALID_QTY')
        const product = item.product_id
          ? this.getProductForUpdate(item.product_id, tenantId)
          : null
        if (item.product_id && !product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')

        const unitPrice = money(item.unit_price ?? product?.retail_price ?? 0)
        if (unitPrice <= 0) throw new Error('LOCAL_SALE_INVALID_PRICE')

        const gross = money(item.qty * unitPrice)
        const itemDiscount = Math.min(gross, money(item.discount ?? 0))
        const coreDepositAmount = product?.requires_core_return === 1
          ? money(product.core_deposit_amount ?? 0)
          : 0
        const total = gross - itemDiscount + money(coreDepositAmount * item.qty)
        subtotal += gross + money(coreDepositAmount * item.qty)
        itemDiscountTotal += itemDiscount

        return {
          id: randomUUID(),
          product,
          product_id: product?.id ?? null,
          description: item.description ?? product?.name ?? 'Вільна сума',
          sku: product?.sku ?? null,
          qty: item.qty,
          unit_price: unitPrice,
          purchase_price: product?.purchase_price ?? 0,
          discount: itemDiscount,
          total,
          core_deposit_amount: coreDepositAmount,
          core_return_status: coreDepositAmount > 0 ? 'pending' : 'none',
        }
      })

      const bonusesSpent = money(input.bonuses_spent ?? 0)
      if (bonusesSpent > 0 && !input.customer_id) throw new Error('Для списання бонусів виберіть клієнта')
      let bonusCustomer: ReturnType<LocalPosSales['getCustomerForMoney']> | null = null
      if (bonusesSpent > 0 && input.customer_id) {
        bonusCustomer = this.getCustomerForMoney(input.customer_id, tenantId)
        const bonusBalance = Number((bonusCustomer as any).bonus_balance ?? 0)
        if (bonusesSpent > bonusBalance) throw new Error('Недостатньо бонусів у клієнта')
      }
      const discount = itemDiscountTotal + money(input.discount ?? 0)
      const total = Math.max(0, subtotal - discount)
      const paidTotal = payments.cash + payments.card + payments.transfer + payments.debt
      if (paidTotal !== total) throw new Error('LOCAL_SALE_PAYMENT_MISMATCH')

      const method = paymentMethod(input.payments)
      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          fiscal_number, fiscal_qr_url, client_operation_id, client_payload_hash,
          cash_amount, card_amount, transfer_amount, debt_amount, notes,
          completed_at, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        saleId,
        tenantId,
        saleNumber,
        input.customer_id ?? null,
        input.cashier_id,
        input.manager_id ?? null,
        shiftId,
        subtotal,
        discount,
        total,
        method,
        payments.debt > 0 ? 1 : 0,
        input.is_fiscal === true ? 1 : 0,
        input.fiscal_number ?? null,
        input.fiscal_qr_url ?? null,
        clientOperationId,
        clientOperationId ? checkoutHash : null,
        payments.cash,
        payments.card,
        payments.transfer,
        payments.debt,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )

      for (const item of preparedItems) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, core_deposit_amount, core_return_status,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          tenantId,
          saleId,
          item.product_id,
          item.description,
          item.sku,
          item.qty,
          item.unit_price,
          item.purchase_price,
          item.discount,
          item.total,
          item.core_deposit_amount,
          item.core_return_status,
          timestamp,
          timestamp,
        )

        if (item.product && item.product.is_service !== 1) {
          const qtyAfter = Number(item.product.qty_on_hand) - Number(item.qty)
          this.db.prepare(`
            UPDATE products
            SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(qtyAfter, timestamp, timestamp, item.product.id, tenantId)

          this.db.prepare(`
            INSERT INTO inventory_movements (
              id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
              unit_cost, notes, dirty_at, created_at, updated_at
            )
            VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            tenantId,
            item.product.id,
            saleId,
            -Number(item.qty),
            qtyAfter,
            item.purchase_price,
            `Sale ${saleNumber}`,
            timestamp,
            timestamp,
            timestamp,
          )
        }
      }

      for (const payment of input.payments) {
        this.db.prepare(`
          INSERT INTO sale_payments (
            id, tenant_id, sale_id, method, amount, is_fiscal, fiscal_number,
            bank_auth_code, terminal_rrn, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          saleId,
          payment.method,
          payment.amount,
          payment.is_fiscal === true ? 1 : 0,
          payment.fiscal_number ?? null,
          payment.bank_auth_code ?? null,
          payment.terminal_rrn ?? null,
          timestamp,
          timestamp,
        )
      }

      if (bonusesSpent > 0 && input.customer_id && bonusCustomer) {
        const balanceAfter = Number((bonusCustomer as any).bonus_balance ?? 0) - bonusesSpent
        this.db.prepare(`
          UPDATE customers SET bonus_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(balanceAfter, timestamp, timestamp, input.customer_id, tenantId)
        this.db.prepare(`
          INSERT INTO bonus_transactions (
            id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
            description, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'spend', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), tenantId, input.customer_id, -bonusesSpent, saleId,
          `Списання бонусів за чеком ${saleNumber}`, input.cashier_id,
          timestamp, timestamp, timestamp,
        )
      }
      if (payments.debt > 0 && input.customer_id) {
        const customer = this.getCustomerForMoney(input.customer_id, tenantId)
        this.db.prepare(`
          UPDATE customers
          SET debt_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(Number(customer.debt_balance ?? 0) + payments.debt, timestamp, timestamp, input.customer_id, tenantId)
      }
      if (input.customer_id && payments.debt === 0) {
        const customer = this.getCustomerForMoney(input.customer_id, tenantId)
        const cashbackPct = customer.loyalty_mode === 'cashback' ? Number(customer.discount_pct ?? 0) : 0
        const coreDepositTotal = preparedItems.reduce(
          (sum, item) => sum + money(item.core_deposit_amount * item.qty),
          0,
        )
        const cashbackBase = Math.max(0, total - coreDepositTotal)
        const cashback = cashbackPct > 0 ? Math.round(cashbackBase * cashbackPct / 100) : 0
        if (cashback > 0) {
          const balanceAfter = Number(customer.deposit_balance ?? 0) + cashback
          const transactionId = randomUUID()
          const notes = 'Накопичення ' + cashbackPct + '% з чека ' + saleNumber
          this.db.prepare(`
            UPDATE customers
            SET deposit_balance = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(balanceAfter, timestamp, timestamp, input.customer_id, tenantId)
          this.db.prepare(`
            INSERT INTO customer_deposit_transactions (
              id, tenant_id, customer_id, amount, balance_after, method, sale_id, shift_id,
              notes, created_by, dirty_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'cashback', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            transactionId, tenantId, input.customer_id, cashback, balanceAfter, saleId, shiftId,
            notes, input.cashier_id, timestamp, timestamp, timestamp,
          )
          this.addOutbox(tenantId, 'customer', input.customer_id, 'customer.deposit_changed', {
            customer_id: input.customer_id, transaction_id: transactionId, amount: cashback, method: 'cashback',
            sale_id: saleId, shift_id: shiftId, notes, created_by: input.cashier_id, created_at: timestamp,
          }, timestamp)
        }
      }
      if (payments.cash > 0) {
        this.db.prepare(`
          INSERT INTO cash_operations (
            id, tenant_id, shift_id, user_id, type, source, amount, sale_id,
            notes, dirty_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'sale_cash', 'cashbox', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          shiftId,
          input.cashier_id,
          payments.cash,
          saleId,
          `Cash payment ${saleNumber}`,
          timestamp,
          timestamp,
          timestamp,
        )
      }

      const outboxSequence = this.addOutbox(
        tenantId,
        'sale',
        saleId,
        'sale.completed',
        {
          sale_id: saleId,
          sale_number: saleNumber,
          shift_id: shiftId,
          customer_id: input.customer_id ?? null,
          cashier_id: input.cashier_id,
          manager_id: input.manager_id ?? null,
          subtotal,
          discount,
          bonuses_spent: bonusesSpent,
          total,
          payment_method: method,
          is_fiscal: input.is_fiscal === true,
          fiscal_number: input.fiscal_number ?? null,
          client_operation_id: clientOperationId,
          fiscal_qr_url: input.fiscal_qr_url ?? null,
          payments: input.payments,
          items: preparedItems.map((item) => ({
            id: item.id,
            product_id: item.product_id,
            description: item.description,
            sku: item.sku,
            qty: item.qty,
            unit_price: item.unit_price,
            purchase_price: item.purchase_price,
            discount: item.discount,
            total: item.total,
            core_deposit_amount: item.core_deposit_amount,
            core_return_status: item.core_return_status,
          })),
          completed_at: timestamp,
        },
        timestamp,
      )

      this.addAudit(
        tenantId,
        input.cashier_id,
        'sale.completed',
        'sale',
        saleId,
        { sale_number: saleNumber, total, payment_method: method },
        timestamp,
      )

      new LocalStaffRepository(this.db).recordSaleCommissions(saleId, tenantId, input.cashier_id)

      const checkoutResult: LocalSaleCheckoutResult = {
        sale_id: saleId,
        sale_number: saleNumber,
        total,
        subtotal,
        payment_method: method,
        outbox_sequence: outboxSequence,
      }
      if (input.is_fiscal === true && clientOperationId) {
        const completed = this.db.prepare(`
          UPDATE fiscal_sale_intents
          SET state = 'completed', sale_id = ?, checkout_result_json = ?,
              completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND tenant_id = ? AND state = 'fiscalized'
        `).run(
          saleId,
          JSON.stringify(checkoutResult),
          timestamp,
          timestamp,
          clientOperationId,
          tenantId,
        ) as { changes: number | bigint }
        if (Number(completed.changes) !== 1) throw new Error('FISCAL_INTENT_NOT_READY')
      }
      return checkoutResult
    })
  }

  protected checkoutIdentity(input: LocalSaleCheckoutInput, tenantId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      cashier_id: String(input.cashier_id ?? ''),
      shift_id: input.shift_id ?? null,
      customer_id: input.customer_id ?? null,
      manager_id: input.manager_id ?? null,
      notes: input.notes ?? null,
      discount: money(input.discount ?? 0),
      bonuses_spent: money(input.bonuses_spent ?? 0),
      is_fiscal: input.is_fiscal === true,
      items: input.items.map((item) => ({
        product_id: item.product_id ?? null,
        description: item.description ?? null,
        qty: Number(item.qty),
        unit_price: item.unit_price === undefined ? null : money(item.unit_price),
        discount: money(item.discount ?? 0),
      })),
      payments: input.payments.map((payment) => ({
        method: payment.method,
        amount: money(payment.amount),
        bank_auth_code: payment.bank_auth_code ?? null,
        terminal_rrn: payment.terminal_rrn ?? null,
      })),
    }
  }

  protected checkoutPayloadHash(input: LocalSaleCheckoutInput, tenantId: string): string {
    return payloadHash(this.checkoutIdentity(input, tenantId))
  }

  protected assertSaleStockAvailable(items: LocalSaleCheckoutInput['items'], tenantId: string): void {
    if (this.allowsNegativeStock()) return
    const requestedByProduct = new Map<string, number>()
    for (const item of items) {
      if (!item.product_id) continue
      requestedByProduct.set(
        item.product_id,
        (requestedByProduct.get(item.product_id) ?? 0) + Number(item.qty ?? 0),
      )
    }

    for (const [productId, requestedQty] of requestedByProduct) {
      const product = this.db.prepare(`
        SELECT id, name, qty_on_hand, is_service
        FROM products
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(productId, tenantId) as {
        id: string
        name: string
        qty_on_hand: number
        is_service: number
      } | undefined
      if (!product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')
      if (product.is_service === 1) continue

      const reserve = this.db.prepare(`
        SELECT COALESCE(SUM(qty), 0) AS qty
        FROM stock_reserves
        WHERE tenant_id = ? AND product_id = ?
          AND released_at IS NULL AND deleted_at IS NULL
          AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'))
      `).get(tenantId, productId) as { qty: number } | undefined
      const available = Number(product.qty_on_hand ?? 0) - Number(reserve?.qty ?? 0)
      if (requestedQty > available) {
        throw new Error(`Недостатньо товару «${product.name}». Доступно: ${available}, потрібно: ${requestedQty}`)
      }
    }
  }

  protected assertCheckoutReady(input: LocalSaleCheckoutInput): {
    shift_id: string
    subtotal: number
    total: number
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('LOCAL_SALE_EMPTY')
    if (!Array.isArray(input.payments) || input.payments.length === 0) throw new Error('LOCAL_SALE_PAYMENT_REQUIRED')
    const shiftId = input.shift_id ?? this.findOpenShift(input.cashier_id, tenantId)
    if (!shiftId) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')
    const shift = this.db.prepare(`
      SELECT id FROM shifts
      WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
      LIMIT 1
    `).get(shiftId, tenantId)
    if (!shift) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')

    let subtotal = 0
    let itemDiscountTotal = 0
    for (const item of input.items) {
      if (!Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0) {
        throw new Error('LOCAL_SALE_INVALID_QTY')
      }
      const product = item.product_id ? this.getProductForUpdate(item.product_id, tenantId) : null
      if (item.product_id && !product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')
      const unitPrice = money(item.unit_price ?? product?.retail_price ?? 0)
      if (unitPrice <= 0) throw new Error('LOCAL_SALE_INVALID_PRICE')
      const gross = money(Number(item.qty) * unitPrice)
      const itemDiscount = Math.min(gross, money(item.discount ?? 0))
      const coreDepositAmount = product?.requires_core_return === 1
        ? money(product.core_deposit_amount ?? 0)
        : 0
      subtotal += gross + money(coreDepositAmount * Number(item.qty))
      itemDiscountTotal += itemDiscount
    }

    this.assertSaleStockAvailable(input.items, tenantId)
    const bonusesSpent = money(input.bonuses_spent ?? 0)
    if (bonusesSpent > 0 && !input.customer_id) {
      throw new Error('Для списання бонусів виберіть клієнта')
    }
    if (bonusesSpent > 0 && input.customer_id) {
      const customer = this.getCustomerForMoney(input.customer_id, tenantId)
      if (bonusesSpent > Number(customer.bonus_balance ?? 0)) {
        throw new Error('Недостатньо бонусів у клієнта')
      }
    }
    const total = Math.max(0, subtotal - itemDiscountTotal - money(input.discount ?? 0))
    const paidTotal = input.payments.reduce((sum, payment) => sum + money(payment.amount), 0)
    if (paidTotal !== total) throw new Error('LOCAL_SALE_PAYMENT_MISMATCH')
    return { shift_id: shiftId, subtotal, total }
  }

  protected existingCheckoutResult(
    tenantId: string,
    id: string,
    expectedHash: string,
  ): LocalSaleCheckoutResult | null {
    const row = this.db.prepare(`
      SELECT s.id AS sale_id, s.sale_number, s.total, s.subtotal, s.payment_method,
             s.client_payload_hash,
             COALESCE((
               SELECT o.sequence
               FROM sync_outbox o
               WHERE o.tenant_id = s.tenant_id
                 AND o.aggregate_type = 'sale'
                 AND o.aggregate_id = s.id
                 AND o.operation_type = 'sale.completed'
               ORDER BY o.sequence DESC
               LIMIT 1
             ), 0) AS outbox_sequence
      FROM sales s
      WHERE s.tenant_id = ? AND s.client_operation_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `).get(tenantId, id) as (LocalSaleCheckoutResult & { client_payload_hash: string | null }) | undefined
    if (!row) return null
    if (row.client_payload_hash !== expectedHash) {
      throw new Error('LOCAL_PAYMENT_OPERATION_CONFLICT|Цей номер операції вже використано для іншого чека')
    }
    return {
      sale_id: row.sale_id,
      sale_number: row.sale_number,
      total: Number(row.total),
      subtotal: Number(row.subtotal),
      payment_method: row.payment_method,
      outbox_sequence: row.outbox_sequence,
    }
  }
}
