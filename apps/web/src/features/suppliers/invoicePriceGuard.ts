interface PriceRow { client_key: string; purchase_price: number; retail_price: number; category_id: string | null }
export interface InvoicePriceRequest {
  key: string; sequence: number; purchase: number; retail: number; category: string | null
}
/** Apply a calculation only to the same unchanged row and only from its latest request. */
export class InvoicePriceGuard {
  private sequence = 0
  private latest = new Map<string, number>()
  begin(row: PriceRow): InvoicePriceRequest {
    const sequence = ++this.sequence
    this.latest.set(row.client_key, sequence)
    return { key: row.client_key, sequence, purchase: row.purchase_price, retail: row.retail_price, category: row.category_id }
  }
  invalidate(key: string): void { this.latest.delete(key) }
  prune(keys: string[]): void {
    const active = new Set(keys)
    for (const key of this.latest.keys()) if (!active.has(key)) this.latest.delete(key)
  }
  apply<T extends PriceRow>(rows: T[], results: Array<{ request: InvoicePriceRequest; retail: number }>): T[] {
    const byKey = new Map(results.map(result => [result.request.key, result]))
    return rows.map(row => {
      const result = byKey.get(row.client_key)
      if (!result) return row
      const { request, retail } = result
      if (this.latest.get(request.key) !== request.sequence || row.purchase_price !== request.purchase
        || row.retail_price !== request.retail || row.category_id !== request.category
        || !Number.isSafeInteger(retail) || retail < 0) return row
      this.latest.delete(request.key)
      return { ...row, retail_price: retail }
    })
  }
}
