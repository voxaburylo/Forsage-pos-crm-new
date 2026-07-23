import { describe, expect, it } from 'vitest'
import { mergePulledShopSettings, parseStoredSettings } from '../src/repositories/settingsMerge'

describe('desktop shop settings pull merge', () => {
  it('preserves local fields omitted by a role-filtered response', () => {
    const stored = {
      id: 'local-shop',
      shop_name: 'Стара назва',
      markup_rules: [{ minPrice: 0, maxPrice: 10000, markupPct: 30 }],
      price_tiers: [{ id: 'retail', name: 'Роздріб', discount_pct: 0 }],
      category_markups: [{ category_id: 'filters', markup_pct: 25 }],
      vin_decoder_api_key: 'local-secret',
      kashalot_license_key: 'fiscal-secret',
    }

    expect(mergePulledShopSettings(stored, {
      shop_name: 'Нова назва',
      price_rounding_step: 100,
    })).toEqual({
      ...stored,
      shop_name: 'Нова назва',
      price_rounding_step: 100,
    })
  })

  it('accepts explicit non-secret remote updates but never imports the AI secret', () => {
    const merged = mergePulledShopSettings(
      { vin_decoder_api_key: 'old', ai_api_key_encrypted: 'keep-local' },
      { vin_decoder_api_key: 'new', ai_api_key_encrypted: 'remote-secret' },
    )
    expect(merged.vin_decoder_api_key).toBe('new')
    expect(merged.ai_api_key_encrypted).toBe('keep-local')
  })

  it('handles corrupt stored JSON without blocking a pull', () => {
    expect(parseStoredSettings('{broken')).toEqual({})
    expect(parseStoredSettings(JSON.stringify({ shop_name: 'Форсаж' }))).toEqual({ shop_name: 'Форсаж' })
  })
})
