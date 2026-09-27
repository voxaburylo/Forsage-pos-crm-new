export function parseReturnQuantity(value: string | number): number | null {
  const raw = String(value).trim().replace(',', '.')
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) return null
  const quantity = Number(raw)
  return Number.isFinite(quantity) && quantity <= Number.MAX_SAFE_INTEGER / 1000 ? quantity : null
}
