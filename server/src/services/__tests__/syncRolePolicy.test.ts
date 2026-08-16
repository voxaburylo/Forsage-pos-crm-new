import { describe, expect, it } from 'vitest'
import {
  buildStaffSyncPayload,
  canPullStaffDirectory,
  canPullSupplyData,
  isSyncOperationAllowed,
  sanitizeCommercialFieldsForRole,
  sanitizeShopSettingsForRole,
} from '../syncRolePolicy.js'

describe('sync role policy', () => {
  it('denies POS and outbox writes for tire worker and read-only STO roles', () => {
    const protectedOperations = [
      'sale.completed',
      'order.payment_added',
      'order.completed',
      'cash_operation.created',
      'product.upsert',
    ]
    for (const role of ['tire_worker', 'sto_viewer']) {
      for (const operation of protectedOperations) {
        expect(isSyncOperationAllowed(role, operation)).toBe(false)
      }
    }
    expect(isSyncOperationAllowed('unknown', 'sale.completed')).toBe(false)
    expect(isSyncOperationAllowed('cashier', 'sale.completed')).toBe(true)
    expect(isSyncOperationAllowed('storekeeper', 'product.upsert')).toBe(true)
  })
  it('allows cashier receiving and inventory operations permitted by the application', () => {
    const cashierOperations = [
      'product.upsert',
      'supplier_invoice.created',
      'supplier_invoice.updated',
      'supplier_invoice.posted',
      'supplier_invoice.payment_added',
      'supplier_invoice.deleted',
      'inventory.created',
      'inventory.started',
      'inventory.completed',
      'inventory.deleted',
    ]
    for (const operation of cashierOperations) {
      expect(isSyncOperationAllowed('cashier', operation)).toBe(true)
    }
    expect(isSyncOperationAllowed('cashier', 'supplier_invoice.cancelled')).toBe(false)
  })
  it('allows storekeepers to synchronize the supply and inventory operations they can perform', () => {
    for (const operation of [
      'supplier_invoice.created',
      'supplier_invoice.updated',
      'supplier_invoice.posted',
      'supplier_invoice.payment_added',
      'inventory.created',
      'inventory.started',
      'inventory.deleted',
    ]) {
      expect(isSyncOperationAllowed('storekeeper', operation)).toBe(true)
    }
    expect(isSyncOperationAllowed('storekeeper', 'inventory.completed')).toBe(false)
    expect(isSyncOperationAllowed('owner', 'inventory.completed')).toBe(true)
  })
  it('syncs the safe staff directory to every local workstation role', () => {
    for (const role of ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker']) {
      expect(canPullStaffDirectory(role)).toBe(true)
    }
    expect(canPullStaffDirectory('unknown')).toBe(false)
  })
  it('keeps the legacy staff payload private while exposing a salary-safe directory', () => {
    const staff = [{
      id: 'worker-1',
      full_name: 'Новий працівник',
      phone: '+380501234567',
      role: 'cashier',
      is_active: true,
      base_rate: 250000,
      rate_period: 'month',
      created_at: '2026-08-15T08:00:00.000Z',
      updated_at: '2026-08-15T08:00:00.000Z',
    }]

    const cashier = buildStaffSyncPayload(staff, 'cashier')
    expect(cashier.staff).toEqual([])
    expect(cashier.staff_snapshot_included).toBe(false)
    expect(cashier.staff_directory_snapshot_included).toBe(true)
    expect(cashier.staff_directory).toEqual([{
      id: 'worker-1',
      full_name: 'Новий працівник',
      phone: '+380501234567',
      role: 'cashier',
      is_active: true,
      created_at: '2026-08-15T08:00:00.000Z',
      updated_at: '2026-08-15T08:00:00.000Z',
    }])

    const owner = buildStaffSyncPayload(staff, 'owner')
    expect(owner.staff).toBe(staff)
    expect(owner.staff_directory).toEqual([])
    expect(owner.staff_snapshot_included).toBe(true)
    expect(owner.staff_directory_snapshot_included).toBe(false)
  })

  it('exposes supply documents to every role allowed to receive goods', () => {
    expect(canPullSupplyData('sto_viewer')).toBe(false)
    expect(canPullSupplyData('tire_worker')).toBe(false)
    for (const role of ['owner', 'admin', 'manager', 'cashier', 'storekeeper']) {
      expect(canPullSupplyData(role)).toBe(true)
    }
  })

  it('keeps only cashdesk settings for non-admin roles', () => {
    const source = {
      shop_name: 'Форсаж',
      allow_negative_qty: true,
      label_settings: { width_mm: 58 },
      pos_quick_items: ['coffee'],
      auto_print_receipt: true,
      receipt_width_mm: 58,
      price_rounding_step: 100,
      markup_rules: [{ minPrice: 0, maxPrice: 100, markupPct: 20 }],
      vin_decoder_url: 'https://decoder.example',
      vin_decoder_api_key: 'secret-vin-key',
      owner_telegram_chat_id: 12345,
      kashalot_license_key: 'secret-license',
      ai_api_key_encrypted: 'secret-ai-key',
    }

    for (const role of ['cashier', 'manager', 'storekeeper']) {
      const result = sanitizeShopSettingsForRole(source, role)!
      expect(result.shop_name).toBe('Форсаж')
      expect(result.label_settings).toEqual({ width_mm: 58 })
      expect(result.pos_quick_items).toEqual(['coffee'])
      expect(result.vin_decoder_url).toBeUndefined()
      expect(result.vin_decoder_api_key).toBeUndefined()
      expect(result.owner_telegram_chat_id).toBeUndefined()
      expect(result.kashalot_license_key).toBeUndefined()
      expect(result.markup_rules).toBeUndefined()
      expect(result.ai_api_key_encrypted).toBeUndefined()
    }

    const owner = sanitizeShopSettingsForRole(source, 'owner')!
    expect(owner.vin_decoder_api_key).toBe('secret-vin-key')
    expect(owner.owner_telegram_chat_id).toBe(12345)
    expect(owner.markup_rules).toBeDefined()
    expect(owner.ai_api_key_encrypted).toBeUndefined()
  })

  it('removes purchase and cost fields recursively only for cashier', () => {
    const rows = [{
      id: 'sale-item',
      cost_price: 500,
      product: { id: 'product', purchase_price: 450, name: 'Товар' },
      order: { buy_price: 400, total: 1000 },
    }]
    const cashier = sanitizeCommercialFieldsForRole(rows, 'cashier')
    expect(cashier).toEqual([{
      id: 'sale-item',
      product: { id: 'product', name: 'Товар' },
      order: { total: 1000 },
    }])
    expect(sanitizeCommercialFieldsForRole(rows, 'manager')).toBe(rows)
  })
})