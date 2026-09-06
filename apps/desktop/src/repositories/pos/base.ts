/**
 * Спільна основа каси: черга на сервер, журнал дій, доступ до товару, нумерація чеків.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import type { LocalDatabase } from '../../db/localDatabase'
import type { LocalProduct, LocalSalePaymentInput } from '../../db/localTypes'
import { dayStamp, money } from './posShared'
import { randomUUID } from 'node:crypto'

export class LocalPosBase {
  constructor(protected readonly db: LocalDatabase) {}

  protected decorateReturn(row: any, tenantId: string): any {
    const items = this.db.prepare(`
      SELECT * FROM customer_return_items
      WHERE return_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).all(row.id, tenantId) as any[]
    return {
      id: row.id,
      sale_id: row.sale_id,
      customer_id: row.customer_id ?? null,
      return_type: row.return_type,
      reason: row.reason,
      reason_note: row.reason_note ?? null,
      refund_method: row.refund_method,
      refund_kopecks: Number(row.refund_kopecks ?? 0),
      stock_action: row.stock_action,
      status: row.status,
      approved_by: row.approved_by ?? 'local',
      created_at: row.created_at,
      fiscal_number: row.fiscal_number ?? null,
      sale: { id: row.sale_id, sale_number: row.sale_number, total: Number(row.sale_total ?? 0) },
      customer: row.customer_id ? {
        id: row.customer_id,
        phone: row.customer_phone ?? '',
        full_name: row.customer_name ?? null,
      } : null,
      return_items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price_kopecks: Number(item.unit_price_kopecks),
        total_kopecks: Number(item.total_kopecks),
        condition: item.condition,
      })),
    }
  }

  protected decorateSale(row: any, tenantId: string): any {
    const items = this.db.prepare(`
      SELECT si.*, p.name AS product_name, p.unit AS product_unit, p.qty_on_hand AS product_qty
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
      ORDER BY si.created_at ASC
    `).all(row.id, tenantId) as any[]
    return {
      id: row.id,
      sale_number: row.sale_number,
      customer_id: row.customer_id ?? null,
      cashier_id: row.cashier_id,
      manager_id: row.manager_id ?? null,
      shift_id: row.shift_id,
      status: row.status,
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      total: Number(row.total ?? 0),
      payment_method: row.payment_method,
      is_debt: row.is_debt === 1,
      notes: row.notes ?? null,
      completed_at: row.completed_at ?? row.created_at,
      is_fiscal: row.is_fiscal === 1,
      fiscal_number: row.fiscal_number ?? null,
      bank_auth_code: row.bank_auth_code ?? null,
      cash_amount: Number(row.cash_amount ?? 0),
      card_amount: Number(row.card_amount ?? 0),
      transfer_amount: Number(row.transfer_amount ?? 0),
      debt_amount: Number(row.debt_amount ?? 0),
      is_order_sale: row.is_order_sale === 1 || row.is_order_sale === true,
      pickup_cell: row.pickup_cell ?? null,
      customer: row.customer_id ? {
        id: row.customer_id,
        phone: row.customer_phone ?? '',
        full_name: row.customer_name ?? null,
      } : null,
      sale_items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        qty: Number(item.qty),
        unit_price: Number(item.unit_price),
        purchase_price: Number(item.purchase_price ?? 0),
        discount: Number(item.discount),
        total: Number(item.total),
        core_deposit_amount: Number(item.core_deposit_amount ?? 0),
        core_return_status: item.core_return_status ?? 'none',
        product: item.product_id ? {
          id: item.product_id,
          sku: item.sku ?? '',
          name: item.product_name ?? item.description ?? '',
          unit: item.product_unit ?? 'шт',
          qty_on_hand: Number(item.product_qty ?? 0),
        } : undefined,
      })),
      returns: [],
    }
  }

  protected decorateCustomer(row: any): any {
    let tags: string[] = []
    try { tags = JSON.parse(row.tags_json ?? '[]') } catch { tags = [] }
    return {
      id: row.id,
      phone: row.phone ?? '',
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      birth_date: row.birth_date ?? null,
      debt_balance: Number(row.debt_balance ?? 0),
      deposit_balance: Number(row.deposit_balance ?? 0),
      notes: row.notes ?? null,
      tags,
      price_tier_id: row.price_tier_id ?? null,
      price_tier: null,
      bonus_balance: Number(row.bonus_balance ?? 0),
      vip_level: row.vip_level ?? 'standard',
      risk_profile: row.risk_profile ?? 'low',
      discount_pct: Number(row.discount_pct ?? 0),
      client_status: row.client_status ?? 'client',
      card_barcode: row.card_barcode ?? null,
      primary_vin: row.primary_vin ?? null,
      car_count: Number(row.car_count ?? 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at ?? null,
    }
  }

  protected allowsNegativeStock(): boolean {
    const row = this.db.prepare(
      "SELECT value_json FROM app_meta WHERE key = 'shop_settings' LIMIT 1",
    ).get() as { value_json: string } | undefined
    if (!row?.value_json) return false
    try {
      return JSON.parse(row.value_json)?.allow_negative_qty === true
    } catch {
      return false
    }
  }

  protected nextSaleNumber(tenantId: string, timestamp: string): string {
    const date = dayStamp(new Date(timestamp))
    const device = this.db.deviceId.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase().padEnd(4, '0')
    const scope = `${tenantId}:sale:${date}:${device}`
    const row = this.db.prepare(`
      INSERT INTO local_sequences(scope, value, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET
        value = value + 1,
        updated_at = excluded.updated_at
      RETURNING value
    `).get(scope, timestamp) as { value: number } | undefined

    return `L-${date.slice(2)}-${device}-${String(row?.value ?? 1).padStart(4, '0')}`
  }

  protected getProductForUpdate(productId: string, tenantId: string): LocalProduct | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, is_active, is_service, storage_bin
      FROM products
      WHERE id = ?
        AND tenant_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
    `).get(productId, tenantId) as LocalProduct | undefined
    return row ?? null
  }

  protected summarizePayments(payments: LocalSalePaymentInput[]): {
    cash: number
    card: number
    transfer: number
    debt: number
  } {
    return payments.reduce((acc, payment) => {
      acc[payment.method] += money(payment.amount)
      return acc
    }, { cash: 0, card: 0, transfer: 0, debt: 0 })
  }

  protected addOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    operationType: string,
    payload: unknown,
    timestamp: string,
  ): number | bigint {
    const result = this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      aggregateType,
      aggregateId,
      operationType,
      JSON.stringify(payload),
      timestamp,
    ) as { lastInsertRowid: number | bigint }
    return result.lastInsertRowid
  }

  protected addAudit(
    tenantId: string,
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    after: unknown,
    timestamp: string,
    operationId = randomUUID(),
  ): void {
    this.db.prepare(`
      INSERT INTO audit_log (
        event_id, tenant_id, device_id, user_id, action, entity_type, entity_id,
        after_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      userId,
      action,
      entityType,
      entityId,
      JSON.stringify(after),
      timestamp,
    )
  }
}
