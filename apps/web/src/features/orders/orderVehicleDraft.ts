export type OrderVehicleInfo = { make?: string; model?: string; year?: number; vin?: string }

// Inline editing stays a draft until the order is saved or a garage vehicle is added.
// This keeps Cancel meaningful and saves manual corrections, not the earlier OCR snapshot.
export function orderVehicleFromDraft(draft: { brand: string; model: string; year: string; vin: string }): OrderVehicleInfo | null {
  const make = draft.brand.trim(), model = draft.model.trim(), vin = draft.vin.trim().toUpperCase()
  const yearText = draft.year.trim()
  if (!make && !model && !vin && !yearText) return null
  const year = yearText ? Number(yearText) : undefined
  if (year !== undefined && (!/^\d{4}$/.test(yearText) || !Number.isInteger(year) || year < 1886 || year > 2100)) {
    throw new Error('Перевірте рік випуску автомобіля — введіть чотири цифри або залиште поле порожнім')
  }
  return { make: make || undefined, model: model || undefined, vin: vin || undefined, year }
}
