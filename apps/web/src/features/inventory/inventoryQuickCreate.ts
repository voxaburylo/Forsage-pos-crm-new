export function inventoryQuickCreateSeed(seed: string) {
  const value = seed.trim()
  const isBarcode = /^\d{6,}$/.test(value)
  const isArticle = !isBarcode && value.length > 0 && value.length <= 64 && !/\s/.test(value)
  return {
    sku: isBarcode || isArticle ? value : '',
    barcode: isBarcode ? value : '',
    name: isBarcode || isArticle ? '' : value,
  }
}

export function hasSuspiciousInventorySku(sku: string, name: string): boolean {
  const normalizedSku = sku.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
  const normalizedName = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
  if (!normalizedSku) return false
  if (normalizedSku === normalizedName) return true
  return normalizedSku.split(' ').filter(Boolean).length >= 4
}
