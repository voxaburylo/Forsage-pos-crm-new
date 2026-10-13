import type { SaleItem } from '@/types/sale'

export function saleLineLabel(line: Pick<SaleItem, 'product' | 'description' | 'sku'>): string {
  return line.product?.name?.trim() || line.description?.trim() || line.product?.sku?.trim() || line.sku?.trim() || 'Назва недоступна в історичному записі'
}
