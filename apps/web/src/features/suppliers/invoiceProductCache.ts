export interface CachedInvoiceProduct {
  id: string
}

export function resolveCachedInvoiceProduct<T extends CachedInvoiceProduct>(
  cache: ReadonlyMap<string, T>,
  normalizedSku: string | null,
  normalizedBarcode: string | null,
  rowLabel: string,
): T | null {
  const bySku = normalizedSku ? cache.get(`sku:${normalizedSku}`) ?? null : null
  const byBarcode = normalizedBarcode ? cache.get(`barcode:${normalizedBarcode}`) ?? null : null

  if (bySku && byBarcode && bySku.id !== byBarcode.id) {
    throw new Error(
      `У рядку «${rowLabel || normalizedSku || normalizedBarcode || 'товар'}» артикул і штрихкод належать різним товарам. Перевірте цей рядок.`,
    )
  }

  return bySku ?? byBarcode
}
