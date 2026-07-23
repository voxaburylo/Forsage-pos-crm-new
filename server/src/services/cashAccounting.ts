export type SaleReceipt = {
  id: string
  total: number
  payment_method: string
  cash_amount?: number | null
  card_amount?: number | null
  transfer_amount?: number | null
  debt_amount?: number | null
  is_fiscal?: boolean | null
}

export type OrderPaymentReceipt = {
  amount: number
  method: string
  is_fiscal?: boolean | null
}

export type PaymentReceiptSummary = {
  cash: number
  card: number
  transfer: number
  account: number
  debt: number
  total: number
}

function amount(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Turnover belongs to the sale completion date. Money movement belongs to the
 * moment a payment was accepted. Therefore an order-linked sale is excluded
 * here and its order_payments are added for their own shift/date instead.
 */
export function summarizePaymentReceipts(
  sales: SaleReceipt[],
  orderSaleIds: ReadonlySet<string>,
  orderPayments: OrderPaymentReceipt[],
): PaymentReceiptSummary {
  const result: PaymentReceiptSummary = {
    cash: 0,
    card: 0,
    transfer: 0,
    account: 0,
    debt: 0,
    total: 0,
  }

  for (const sale of sales) {
    if (orderSaleIds.has(sale.id)) continue
    const total = amount(sale.total)
    const cash = sale.payment_method === 'cash'
      ? amount(sale.cash_amount) || total
      : amount(sale.cash_amount)
    const card = sale.payment_method === 'card'
      ? amount(sale.card_amount) || total
      : amount(sale.card_amount)
    const transfer = sale.payment_method === 'transfer'
      ? amount(sale.transfer_amount) || total
      : amount(sale.transfer_amount)
    const debt = sale.payment_method === 'debt'
      ? amount(sale.debt_amount) || total
      : amount(sale.debt_amount)
    result.cash += cash
    result.card += card
    result.transfer += transfer
    result.debt += debt
  }

  for (const payment of orderPayments) {
    const paid = amount(payment.amount)
    if (payment.method === 'cash') result.cash += paid
    else if (payment.method === 'card') result.card += paid
    else if (payment.method === 'transfer') result.transfer += paid
    else if (payment.method === 'account') result.account += paid
  }

  // Борг входить до обороту продажу, але не є отриманими грошима.
  result.total = result.cash + result.card + result.transfer + result.account
  return result
}

export function calculateExpectedCash(input: {
  openingCash: number
  regularSaleCash: number
  cashIn: number
  returnCash: number
  cashOut: number
}): number {
  return Math.max(0,
    amount(input.openingCash)
    + amount(input.regularSaleCash)
    + amount(input.cashIn)
    - amount(input.returnCash)
    - amount(input.cashOut),
  )
}
