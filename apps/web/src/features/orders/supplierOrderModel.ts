/**
 * 23.11.2026 (план C3, етап 10 плану замовлень): «Замовити в постачальника» — позиції відкритих замовлень,
 * які ще не замовлено, згруповані за постачальником: видно, що й у кого замовити сьогодні.
 */
export interface SupplierOrderLine {
  item_id: string
  order_id: string
  order_number: number
  name: string
  sku: string | null
  qty: number
  supplier_id: string | null
  supplier_name: string | null
  customer_name: string | null
  customer_phone: string | null
  created_at: string
}

export interface SupplierOrderGroup {
  key: string
  supplier_id: string | null
  title: string
  lines: SupplierOrderLine[]
}

export const NO_SUPPLIER_TITLE = 'Постачальника не вказано'

/** Групи за постачальником; «без постачальника» — в кінці. Усередині — черга замовлень, як прийшла з каси. */
export function groupSupplierLines(lines: readonly SupplierOrderLine[]): SupplierOrderGroup[] {
  const groups = new Map<string, SupplierOrderGroup>()
  for (const line of lines) {
    const key = line.supplier_id ?? ''
    const group = groups.get(key) ?? { key: key || 'none', supplier_id: line.supplier_id, title: line.supplier_name?.trim() || NO_SUPPLIER_TITLE, lines: [] }
    group.lines.push(line)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => (a.supplier_id ? 0 : 1) - (b.supplier_id ? 0 : 1) || a.title.localeCompare(b.title, 'uk'))
}

const quantity = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))

/**
 * Текст замовлення для постачальника (месенджер, пошта): артикул — назва × кількість.
 * Однакові позиції з різних замовлень складаються в один рядок. Імен і телефонів клієнтів тут немає.
 */
export function supplierOrderText(group: Pick<SupplierOrderGroup, 'lines'>, shopName = 'Форсаж'): string {
  const rows = new Map<string, { sku: string; name: string; qty: number }>()
  for (const line of group.lines) {
    const sku = (line.sku ?? '').trim()
    const key = sku ? 'sku:' + sku.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '') : 'name:' + line.name.trim().toLowerCase()
    const row = rows.get(key)
    if (row) row.qty += line.qty
    else rows.set(key, { sku, name: line.name.trim(), qty: line.qty })
  }
  const body = [...rows.values()].map((row, index) => `${index + 1}. ${row.sku ? row.sku + ' — ' : ''}${row.name} × ${quantity(row.qty)}`)
  return [`Замовлення від ${shopName}:`, ...body].join('\n')
}
