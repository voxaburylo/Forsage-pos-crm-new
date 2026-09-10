import type { LocalDatabase } from '../db/localDatabase'
export interface HistoryOptions { offset?: number; limit?: number; from?: string; to?: string }
export function customerHistory(db: LocalDatabase, tenant: string, customer: string, kind: string, options: HistoryOptions = {}) {
  if (kind !== 'sales' && kind !== 'deposit') throw new Error('Невідомий вид історії')
  const offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 50)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Некоректна сторінка історії')
  const where = ['tenant_id=?', 'customer_id=?', 'deleted_at IS NULL']
  const params: any[] = [tenant, customer]
  const field = kind === 'sales' ? 'completed_at' : 'created_at'
  for (const [value, operator] of [[options.from, '>='],[options.to,'<=']] as const) {
    if (value) {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Некоректна дата')
      where.push(field + operator + '?'); params.push(value)
    }
  }
  if (options.from && options.to && options.from > options.to) throw new Error('Некоректний період')
  const table = kind === 'sales' ? 'sales' : 'customer_deposit_transactions'
  const columns = kind === 'sales' ? 'id,sale_number,total,payment_method,status,completed_at' : 'id,amount,balance_after,method,order_id,sale_id,shift_id,notes,created_at'
  const rows=db.prepare(`SELECT ${columns} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${field} DESC,id DESC LIMIT ? OFFSET ?`).all(...params,limit+1,offset)
  return {data: rows.slice(0,limit),has_more:rows.length>limit}
}
