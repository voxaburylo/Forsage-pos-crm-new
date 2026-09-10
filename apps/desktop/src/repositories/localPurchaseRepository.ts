import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { LocalSupplyRepository } from './supplyRepository'
import { idempotentMutation } from './idempotentMutation'

export class LocalPurchaseRepository {
  constructor(private readonly db: LocalDatabase) {}

  listRules(tenantId = DEFAULT_TENANT_ID): any[] {
    return (this.db.prepare(`SELECT r.*, p.name, p.sku, p.qty_on_hand, p.reorder_point, p.is_active,
      p.deleted_at product_deleted, s.name supplier_name FROM auto_purchase_rules r
      JOIN products p ON p.id = r.product_id AND p.tenant_id = r.tenant_id
      LEFT JOIN suppliers s ON s.id = r.supplier_id AND s.tenant_id = r.tenant_id AND s.deleted_at IS NULL
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL ORDER BY p.name, r.id`).all(tenantId) as any[])
      .map(row => ({ id: row.id, min_qty: row.min_qty, max_qty: row.max_qty, is_active: row.is_active === 1 && !row.product_deleted,
        product: { id: row.product_id, name: row.name, sku: row.sku, qty_on_hand: row.qty_on_hand, reorder_point: row.reorder_point },
        supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? 'Постачальник недоступний' } : null }))
  }

  createRule(input: { tenant_id?: string; product_id: string; supplier_id?: string | null; min_qty: number; max_qty: number }): any {
    return this.db.transaction(() => {
      const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
      const min = Number(input.min_qty), max = Number(input.max_qty)
      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) throw new Error('Вкажіть коректні мінімум і максимум')
      const product = this.db.prepare('SELECT id FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND is_active = 1 AND is_service = 0').get(input.product_id, tenantId)
      if (!product) throw new Error('Активний товар не знайдено')
      if (input.supplier_id && !this.db.prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND is_active = 1').get(input.supplier_id, tenantId)) throw new Error('Постачальника не знайдено')
      const existing = this.db.prepare('SELECT * FROM auto_purchase_rules WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL').get(tenantId, input.product_id) as any
      if (existing) {
        if (existing.min_qty === min && existing.max_qty === max && existing.supplier_id === (input.supplier_id || null)) return existing
        throw new Error('Правило для цього товару вже існує. Видаліть старе правило перед заміною.')
      }
      const id = randomUUID()
      this.db.prepare('INSERT INTO auto_purchase_rules (id, tenant_id, product_id, supplier_id, min_qty, max_qty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, tenantId, input.product_id, input.supplier_id || null, min, max, new Date().toISOString())
      return { id }
    })
  }

  deleteRule(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const row = this.db.prepare('SELECT id FROM auto_purchase_rules WHERE id = ? AND tenant_id = ?').get(id, tenantId)
    if (!row) throw new Error('Правило не знайдено')
    this.db.prepare('UPDATE auto_purchase_rules SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND tenant_id = ?').run(new Date().toISOString(), id, tenantId)
    return { ok: true }
  }

  suggestions(tenantId = DEFAULT_TENANT_ID): any[] {
    const rows = this.db.prepare(`SELECT r.id rule_id, p.id product_id, p.name product_name, p.sku, p.qty_on_hand,
      r.min_qty reorder_point, r.max_qty, r.supplier_id, s.name supplier_name, p.purchase_price,
      COALESCE((SELECT SUM(i.qty) FROM supply_invoice_items i JOIN supply_invoices h ON h.id = i.invoice_id AND h.tenant_id = i.tenant_id
        WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id AND i.deleted_at IS NULL AND h.deleted_at IS NULL AND h.status = 'draft'), 0) pending_qty
      FROM auto_purchase_rules r JOIN products p ON p.id = r.product_id AND p.tenant_id = r.tenant_id
      LEFT JOIN suppliers s ON s.id = r.supplier_id AND s.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_active = 1 AND p.is_service = 0
        AND (r.supplier_id IS NULL OR (s.deleted_at IS NULL AND s.is_active = 1)) ORDER BY p.name, p.id`).all(tenantId) as any[]
    return rows.filter(row => Number(row.qty_on_hand) + Number(row.pending_qty) < Number(row.reorder_point))
      .map(row => ({ ...row, suggest_qty: Number((Number(row.max_qty) - Number(row.qty_on_hand) - Number(row.pending_qty)).toFixed(3)) }))
  }

  generateInvoices(input: { operation_id: string; tenant_id?: string; user_id?: string }): any {
    if (!input.operation_id) throw new Error('Відсутній ідентифікатор операції')
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    return idempotentMutation(this.db, 'auto-purchase:' + tenantId, input.operation_id, input, () => {
      const groups = new Map<string | null, any[]>()
      for (const row of this.suggestions(tenantId)) groups.set(row.supplier_id, [...(groups.get(row.supplier_id) ?? []), row])
      const supply = new LocalSupplyRepository(this.db)
      const invoices = [...groups.entries()].map(([supplier_id, rows]) => supply.createInvoice({ tenant_id: tenantId, supplier_id, user_id: input.user_id,
        notes: 'Автозакупівля: перевірте ціни та кількості перед проведенням.', paid_amount: 0,
        items: rows.map(row => ({ product_id: row.product_id, qty: row.suggest_qty, purchase_price: row.purchase_price })) }))
      return { count: invoices.length, invoices }
    })
  }

  supplierNeeds(tenantId = DEFAULT_TENANT_ID): any[] {
    const rows = this.db.prepare(`SELECT i.*, o.order_number, o.status order_status, o.created_at order_created,
      s.name supplier_name, s.phone supplier_phone FROM customer_order_items i
      JOIN customer_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      LEFT JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND o.deleted_at IS NULL AND i.source_type = 'supplier' AND i.item_type = 'product'
      ORDER BY o.created_at DESC, o.id, i.supplier_id, i.id`).all(tenantId) as any[]
    const groups = new Map<string, any>()
    for (const row of rows) {
      const key = row.order_id + ':' + (row.supplier_id ?? 'none')
      const group = groups.get(key) ?? { id: key, po_number: `Замовлення #${row.order_number ?? '—'}`, order_id: row.order_id, status: 'draft', notes: null, created_at: row.order_created,
        supplier: row.supplier_id ? { id: row.supplier_id, name: row.supplier_name ?? 'Постачальник', phone: row.supplier_phone } : null, items: [] }
      group.items.push({ id: row.id, qty: row.qty, state: row.order_status === 'canceled' ? 'canceled' : row.item_status,
        product: { id: row.product_id, name: row.name, sku: row.sku }, customer_order_item: { id: row.id, order_id: row.order_id, order: { order_number: row.order_number } } })
      groups.set(key, group)
    }
    return [...groups.values()].map(group => {
      const active = group.items.filter((item: any) => item.state !== 'canceled')
      return { ...group, items: active.length ? active : group.items, status: !active.length ? 'cancelled' : active.every((item: any) => ['arrived', 'handed', 'returned'].includes(item.state)) ? 'received' : active.some((item: any) => item.state === 'ordered') ? 'ordered' : 'draft' }
    })
  }
}
