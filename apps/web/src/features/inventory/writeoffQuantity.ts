// Keep editable text separate from the quantity sent to the stock operation.
export function parseWriteoffQuantity(value: string | number): number | null {
  const text = String(value).trim().replace(',', '.')
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return null
  const number = Number(text)
  return Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER / 1000 ? number : null
}

export function writeoffQuantityStep(unit: string = 'шт'): number {
  return ['кг', 'г', 'л', 'мл', 'м', 'м2', 'м²', 'м3', 'м³', 'kg', 'g', 'l', 'ml', 'm'].includes(unit.trim().toLowerCase().replace(/[.]$/, '')) ? 0.001 : 1
}
