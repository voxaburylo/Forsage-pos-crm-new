import { TerminalAdapter, TerminalPaymentResult } from './interfaces.js'
import { processCardPayment, cancelCardPayment } from './MockBankTerminalService.js'
import { privatbankProcessPayment, privatbankCancelPayment } from './PrivatBankTerminalService.js'

export class MockTerminalAdapter implements TerminalAdapter {
  async processPayment(amountKopecks: number, saleNumber: string): Promise<TerminalPaymentResult> {
    const res = await processCardPayment(amountKopecks, 'pre-order', saleNumber)
    return {
      success: res.success,
      authCode: res.auth_code,
      rrn: null,
      error: res.error,
    }
  }

  async cancelPayment(authCode: string | null, _rrn: string | null): Promise<boolean> {
    if (!authCode) return false
    return cancelCardPayment(authCode)
  }
}

export class PrivatBankTerminalAdapter implements TerminalAdapter {
  private config: { ip: string; port: number; merchant_id: string }

  constructor(config: { ip: string; port: number; merchant_id: string }) {
    this.config = config
  }

  async processPayment(amountKopecks: number, saleNumber: string): Promise<TerminalPaymentResult> {
    const res = await privatbankProcessPayment(this.config, amountKopecks, saleNumber)
    return {
      success: res.success,
      authCode: res.auth_code,
      rrn: res.rrn,
      panMasked: res.pan_masked,
      error: res.error,
    }
  }

  async cancelPayment(_authCode: string | null, rrn: string | null): Promise<boolean> {
    if (!rrn) return false
    return privatbankCancelPayment(this.config, rrn)
  }
}
