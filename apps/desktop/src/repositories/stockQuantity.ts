/**
 * Stock documents use thousandths (the same precision as returns/write-offs).
 * Calculate in integer thousandths, then store the canonical decimal in SQLite.
 * Tiny IEEE-754 tails are accepted; real fourth decimals are never rounded away.
 * This does not scan or rewrite existing data.
 */
const SCALE = 1000
const FLOAT_TOLERANCE = 0.000001

export function stockUnits(value: unknown, message = 'Некоректна кількість: вкажіть число до 3 знаків після коми'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message)
  const scaled = value * SCALE
  const units = Math.round(scaled)
  if (!Number.isSafeInteger(units) || Math.abs(scaled - units) > FLOAT_TOLERANCE) throw new Error(message)
  return units === 0 ? 0 : units
}

export function stockQuantity(value: unknown, message?: string): number {
  return stockUnits(value, message) / SCALE
}

export function addStockQuantity(left: number, right: number): number {
  const sum = stockUnits(left) + stockUnits(right)
  if (!Number.isSafeInteger(sum)) throw new Error('Надто велика кількість товару')
  return sum / SCALE
}

export function subtractStockQuantity(left: number, right: number): number {
  return addStockQuantity(left, -right)
}
