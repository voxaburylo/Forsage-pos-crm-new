import { FiscalAdapter, FiscalItem, FiscalResult } from './interfaces.js'
import { kashalotLogin, kashalotGetCurrentShift, kashalotOpenShift, kashalotFiscalize } from './KashalotService.js'
import { fiscalizeSale } from './MockPrroService.js'
import { db } from '../../db/supabase.js'
import { logger } from '../../lib/logger.js'

export class MockFiscalAdapter implements FiscalAdapter {
  async fiscalize(
    saleId: string,
    saleNumber: string,
    totalKopecks: number,
    _items: FiscalItem[],
    _paymentMethod: 'cash' | 'card' | 'mixed' | 'transfer' | 'debt',
  ): Promise<FiscalResult> {
    const res = await fiscalizeSale(saleId, saleNumber, totalKopecks)
    return {
      success: res.success,
      fiscal_number: res.fiscal_number,
      qr_url: null,
      error: res.error,
    }
  }
}

export class KashalotFiscalAdapter implements FiscalAdapter {
  private config: { license_key: string; pin: string; active_shift?: string }

  constructor(config: { license_key: string; pin: string; active_shift?: string }) {
    this.config = config
  }

  async fiscalize(
    _saleId: string,
    saleNumber: string,
    totalKopecks: number,
    items: FiscalItem[],
    paymentMethod: 'cash' | 'card' | 'mixed' | 'transfer' | 'debt',
  ): Promise<FiscalResult> {
    try {
      const token = await kashalotLogin({
        license_key: this.config.license_key,
        pin:         this.config.pin,
      })

      let shiftId = this.config.active_shift ?? await kashalotGetCurrentShift(token)
      if (!shiftId) {
        shiftId = await kashalotOpenShift(token)
        await db.from('shop_settings').update({ kashalot_active_shift: shiftId })
      }

      const res = await kashalotFiscalize(
        token,
        shiftId,
        saleNumber,
        totalKopecks,
        items,
        paymentMethod,
      )

      return {
        success: res.success,
        fiscal_number: res.fiscal_number,
        qr_url: res.qr_url,
        receipt_url: res.receipt_url,
        error: res.error,
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Kashalot adapter: pomilka integracii')
      return {
        success: false,
        fiscal_number: null,
        qr_url: null,
        error: err.message,
      }
    }
  }
}
