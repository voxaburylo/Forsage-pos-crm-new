// Kept identical in server/lib and desktop/lib; parity is covered by tests.
export const INCOMPLETE_WRITEOFF_REPORT = 'Звіт списань містить неповні або неузгоджені дані. Перевірте акти та серверну копію.'
const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
export function writeoffMonth(now = new Date()): string { return formatter.format(now).slice(0, 7) }
export function writeoffMonthRange(month: string) {
  if (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) || month > '9998-12')
    throw new Error('Некоректний місяць звіту списань')
  const [year, m] = month.split('-').map(Number)
  const midnight = (local: number) => {
    let guess = local
    for (let attempt = 0; attempt < 4; attempt++) {
      const p = Object.fromEntries(parts.formatToParts(new Date(guess)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
      const correction = local - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
      guess += correction
      if (Math.abs(correction) < 1000) break
    }
    return new Date(guess).toISOString()
  }
  return { from: midnight(Date.UTC(year, m - 1, 1)), toExclusive: midnight(Date.UTC(year, m, 1)) }
}
type Document = { id: string; reason: string; created_at: string }
type Line = { id: string; writeoff_id: string; product_id: string; known_product_id: string | null;
  qty: number; cost_kopecks: number; deleted: boolean; tenant_matches: boolean }
export type WriteoffSnapshot = { documents: Document[]; lines: Line[] }
function invalid(): never { throw new Error(INCOMPLETE_WRITEOFF_REPORT) }
function sum(a: number, b: number) {
  const n = a + b
  if (!Number.isSafeInteger(n)) invalid()
  return n
}
export function aggregateWriteoffs(snapshot: WriteoffSnapshot, month: string) {
  const range = writeoffMonthRange(month)
  if (!snapshot || !Array.isArray(snapshot.documents) || !Array.isArray(snapshot.lines)) invalid()
  const documents = new Map<string, Document>(), lines = new Set<string>()
  const grouped = new Map<string, Array<{ id: string; cost_kopecks: number }>>()
  const products = new Map<string, Set<string>>()
  for (const doc of snapshot.documents) {
    if (!doc || typeof doc.id !== 'string' || !doc.id.trim() || documents.has(doc.id)
      || !['damage','expiry','loss','audit','other'].includes(doc.reason)
      || typeof doc.created_at !== 'string' || !Number.isFinite(Date.parse(doc.created_at))
      || Date.parse(doc.created_at) < Date.parse(range.from) || Date.parse(doc.created_at) >= Date.parse(range.toExclusive)) invalid()
    documents.set(doc.id, doc); grouped.set(doc.id, []); products.set(doc.id, new Set())
  }
  for (const line of snapshot.lines) {
    if (!line || typeof line.id !== 'string' || !line.id.trim() || lines.has(line.id)
      || !documents.has(line.writeoff_id) || line.deleted !== false || line.tenant_matches !== true
      || typeof line.product_id !== 'string' || !line.product_id || line.known_product_id !== line.product_id
      || typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0
      || !Number.isSafeInteger(Math.round(line.qty * 1000)) || Math.abs(line.qty * 1000 - Math.round(line.qty * 1000)) > .00001
      || typeof line.cost_kopecks !== 'number' || !Number.isSafeInteger(line.cost_kopecks) || line.cost_kopecks < 0
      || products.get(line.writeoff_id)!.has(line.product_id)) invalid()
    lines.add(line.id); products.get(line.writeoff_id)!.add(line.product_id)
    grouped.get(line.writeoff_id)!.push({ id: line.id, cost_kopecks: line.cost_kopecks })
  }
  const writeoffs = [...documents.values()].map(doc => {
    const items = grouped.get(doc.id)!
    if (!items.length) invalid()
    return { ...doc, created_at: new Date(doc.created_at).toISOString(), items,
      total_cost: items.reduce((total, item) => sum(total, item.cost_kopecks), 0) }
  }).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
  return { month, count: writeoffs.length, total_cost: writeoffs.reduce((total, doc) => sum(total, doc.total_cost), 0), writeoffs }
}
