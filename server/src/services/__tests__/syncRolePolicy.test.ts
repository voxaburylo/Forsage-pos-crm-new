import { describe, expect, it } from 'vitest'
import {
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
  it('does not expose supply documents to cashier roles', () => {
    expect(canPullSupplyData('cashier')).toBe(false)
    expect(canPullSupplyData('sto_viewer')).toBe(false)
    for (const role of ['owner', 'admin', 'manager', 'storekeeper']) {
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