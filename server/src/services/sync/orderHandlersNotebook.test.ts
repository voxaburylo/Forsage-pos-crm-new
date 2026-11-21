import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 22.11.2026: замовлення з блокнота. Гроші нового замовлення сервер завжди бере нульовими — це й робить «архів при створенні» безпечним. */
describe('notebook orders in sync', () => {
  const source = readFileSync(new URL('./orderHandlers.ts', import.meta.url), 'utf8')
  const upsert = source.slice(source.indexOf('export async function applyOrderUpsert'), source.indexOf('export async function applyOrderDeleted'))
  const remove = source.slice(source.indexOf('export async function applyOrderDeleted'))

  it('accepts an archived order only when it is being created, never as an edit of an existing one', () => {
    expect(upsert).toContain("const notebookArchive = !existing && requestedStatus === 'archived'")
    expect(upsert).toContain("if (existing && ['completed', 'canceled', 'archived'].includes(String(existing.status))) return")
    // New orders never carry money from the payload.
    expect(upsert).toContain('Number(existing?.prepayment ?? 0),')
    expect(upsert).toContain('Number(existing?.total_paid ?? 0),')
  })

  it('deletes a notebook order only without money, receipt or handed-over lines', () => {
    expect(remove).toContain("operation.payload?.from_notebook === true")
    expect(remove).toContain("item_status IN ('handed', 'returned')")
    const guard = remove.slice(remove.indexOf("if (!(['lead', 'quoted', 'new']"), remove.indexOf('SYNC_ORDER_DELETE_FORBIDDEN'))
    for (const check of ['row.prepayment', 'row.total_paid', 'row.payment_count', 'row.ledger_paid', 'row.sale_id']) expect(guard).toContain(check)
  })
})
