/**
 * «Що закінчується» (слово власника 24.11.2026): товари з низьким залишком, розкладені за постачальниками, —
 * щоб скласти лист замовлення, скопіювати його чи зберегти Excel і надіслати постачальнику.
 * Мінімальних залишків у картках ніхто не вів (на 24.11 — у жодної), тому «мало» рахуємо з продажів:
 * товар продавався за останні 90 днів, а залишку менше, ніж продано за 30 днів (або його немає взагалі).
 * Постачальник — той, від кого товар приходив востаннє. Рахує каса (apps/desktop/src/repositories/localPurchaseRepository.ts).
 */
export interface RestockRow {
  product_id: string; sku: string | null; name: string
  qty_on_hand: number; reorder_point: number; sold_30: number; sold_90: number
  purchase_price: number; suggest_qty: number
  supplier_id: string | null; supplier_name: string | null; last_received_at: string | null
}
export interface RestockGroup { key: string; supplier_id: string | null; title: string; rows: RestockRow[]; total: number }

export const NO_SUPPLIER = 'Постачальник невідомий (товар ще не приходив накладною)'
const qty = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))

/** Групи за постачальником (за абеткою, «невідомий» — у кінці); у групі — спершу те, чого немає зовсім і що продається швидше. */
export function groupRestock(rows: readonly RestockRow[]): RestockGroup[] {
  const groups = new Map<string, RestockGroup>()
  for (const row of rows) {
    const key = row.supplier_id ?? ''
    const group = groups.get(key) ?? { key: key || 'none', supplier_id: row.supplier_id, title: row.supplier_name?.trim() || NO_SUPPLIER, rows: [], total: 0 }
    group.rows.push(row); group.total += Math.round(row.suggest_qty * row.purchase_price)
    groups.set(key, group)
  }
  for (const group of groups.values()) group.rows.sort((a, b) => Number(a.qty_on_hand > 0) - Number(b.qty_on_hand > 0) || b.sold_30 - a.sold_30 || a.name.localeCompare(b.name, 'uk'))
  return [...groups.values()].sort((a, b) => (a.supplier_id ? 0 : 1) - (b.supplier_id ? 0 : 1) || a.title.localeCompare(b.title, 'uk'))
}

/** Лист замовлення текстом (месенджер, пошта): артикул — назва × кількість. Цін і залишків у ньому немає. */
export function restockText(group: Pick<RestockGroup, 'rows'>, picked: ReadonlyMap<string, number>, shopName = 'Форсаж'): string {
  const lines = group.rows.filter(row => (picked.get(row.product_id) ?? 0) > 0)
    .map((row, index) => `${index + 1}. ${row.sku ? row.sku + ' — ' : ''}${row.name} × ${qty(picked.get(row.product_id)!)}`)
  return lines.length ? [`Замовлення від ${shopName}:`, ...lines].join('\n') : ''
}

/** Рядки для Excel: те саме, що в листі, окремими стовпцями. Закупівельних цін постачальнику не шлемо. */
export function restockSheetRows(group: Pick<RestockGroup, 'rows'>, picked: ReadonlyMap<string, number>): Array<Record<string, string | number>> {
  return group.rows.filter(row => (picked.get(row.product_id) ?? 0) > 0)
    .map((row, index) => ({ '№': index + 1, 'Артикул': row.sku ?? '', 'Назва': row.name, 'Кількість': picked.get(row.product_id)! }))
}

/** Назва файла: «Замовлення-Vitol-2026-11-24.xlsx», без знаків, які не можна в іменах файлів. */
export function restockFileName(title: string, now = new Date()): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'постачальник'
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `Замовлення-${safe}-${day}.xlsx`
}

/** Початковий вибір: усе запропоноване, у запропонованій кількості. */
export function initialPick(rows: readonly RestockRow[]): Map<string, number> {
  return new Map(rows.map(row => [row.product_id, row.suggest_qty]))
}

/** Кількість із поля: ціле чи дробове ≥ 0; порожнє або сміття — 0 (рядок не йде в лист). */
export function readPickQty(text: string): number {
  const value = Number(text.trim().replace(',', '.'))
  return Number.isFinite(value) && value > 0 && value <= 100_000 ? Math.round(value * 1000) / 1000 : 0
}
