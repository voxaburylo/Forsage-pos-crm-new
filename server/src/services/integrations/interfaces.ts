export interface TerminalPaymentResult {
  success:    boolean
  authCode:   string | null
  rrn:        string | null
  panMasked?: string | null
  error?:     string
}

export interface TerminalAdapter {
  processPayment(amountKopecks: number, saleNumber: string): Promise<TerminalPaymentResult>
  cancelPayment(authCode: string | null, rrn: string | null): Promise<boolean>
}

export interface FiscalItem {
  name: string
  qty: number
  unit_price: number  // копійки
  discount: number    // копійки
}

export interface FiscalResult {
  success: boolean
  fiscal_number: string | null
  qr_url: string | null
  receipt_url?: string | null
  error?: string
}

export interface FiscalAdapter {
  fiscalize(
    saleId: string,
    saleNumber: string,
    totalKopecks: number,
    items: FiscalItem[],
    paymentMethod: 'cash' | 'card' | 'mixed' | 'transfer' | 'debt',
  ): Promise<FiscalResult>
}
