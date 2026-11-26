/**
 * Кнопки-відбори над списком «Товари» (винесено з catalogRepository.ts 26.11.2026 за правилом ділити великі файли).
 *  - negative — пішли в мінус (вирівняти ревізією);
 *  - no_price — роздрібна ціна 0 грн;
 *  - in_stock — 26.11.2026 (власник: «у товарах — які в наявності, теж такий відбір»): залишок більше нуля.
 */
export type CatalogStockFilter = 'negative' | 'no_price' | 'in_stock' | ''

export function catalogStockFilterClause(filter: CatalogStockFilter | undefined): string | null {
  if (filter === 'negative') return 'p.qty_on_hand < 0'
  if (filter === 'no_price') return 'p.retail_price = 0'
  if (filter === 'in_stock') return 'p.qty_on_hand > 0'
  return null
}
