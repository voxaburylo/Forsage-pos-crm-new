import { businessDateKey } from '@/lib/businessDate'

export type WriteoffSummary = {
  month: string; count: number; total_cost: number;
  writeoffs: Array<{ id: string; reason: string; created_at: string; total_cost: number;
    items: Array<{ id: string; cost_kopecks: number }> }>
}
const invalid = (): never => { throw Error('Звіт списань неповний або неузгоджений. Оновіть дані та перевірте копію документів.') }
const money = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function parseWriteoffSummary(value: unknown, month: string): WriteoffSummary {
  const report = value as WriteoffSummary
  if (!report || report.month !== month || !Array.isArray(report.writeoffs) || !money(report.count)
    || report.count !== report.writeoffs.length || !money(report.total_cost)) invalid()
  const ids = new Set<string>(), lineIds = new Set<string>()
  let total = 0
  for (const doc of report.writeoffs) {
    if (!doc || typeof doc.id !== 'string' || !doc.id.trim() || ids.has(doc.id)
      || !['damage','expiry','loss','audit','other'].includes(doc.reason)
      || typeof doc.created_at !== 'string' || businessDateKey(doc.created_at).slice(0,7) !== month
      || !money(doc.total_cost) || !Array.isArray(doc.items) || !doc.items.length) invalid()
    ids.add(doc.id)
    let cost = 0
    for (const item of doc.items) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || lineIds.has(item.id) || !money(item.cost_kopecks)) invalid()
      lineIds.add(item.id); cost += item.cost_kopecks
      if (!money(cost)) invalid()
    }
    if (cost !== doc.total_cost) invalid()
    total += cost
    if (!money(total)) invalid()
  }
  if (total !== report.total_cost) invalid()
  return report
}
export function writeoffReportDate(timestamp: string) {
  return businessDateKey(timestamp).split('-').reverse().join('.')
}
