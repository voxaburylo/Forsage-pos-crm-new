import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const salesRouteSource = readFileSync(new URL('../../routes/sales.ts', import.meta.url), 'utf8')
const saleApiSource = readFileSync(
  new URL('../../../../apps/web/src/features/pos/saleApi.ts', import.meta.url),
  'utf8',
)
const suspendModalSource = readFileSync(
  new URL('../../../../apps/web/src/features/pos/SuspendModal.tsx', import.meta.url),
  'utf8',
)

const suspendStart = salesRouteSource.indexOf("router.post('/suspend'")
const suspendEnd = salesRouteSource.indexOf("router.post('/calculate-price'", suspendStart)
const suspendBlock = salesRouteSource.slice(suspendStart, suspendEnd)

describe('suspended sale transaction safety', () => {
  it('commits the suspended receipt, all items and idempotency response atomically', () => {
    expect(suspendBlock).toContain('runTransaction(async (client) =>')
    expect(suspendBlock).toContain('INSERT INTO idempotency_keys')
    expect(suspendBlock).toContain("VALUES ($1, $2, 'processing'")
    expect(suspendBlock).toContain('INSERT INTO sales')
    expect(suspendBlock).toContain('client_operation_id, client_payload_hash')
    expect(suspendBlock).toContain('INSERT INTO sale_items')
    expect(suspendBlock).toContain("SET status = 'completed', response = $3::jsonb")
    expect(suspendBlock).not.toContain(".from('sales')")
    expect(suspendBlock).not.toContain(".from('sale_items')")
  })

  it('validates tenant ownership before inserting the suspended receipt', () => {
    expect(suspendBlock).toContain('FROM shifts')
    expect(suspendBlock).toContain('AND tenant_id = $2')
    expect(suspendBlock).toContain('AND cashier_id = $3')
    expect(suspendBlock).toContain('FROM customers')
    expect(suspendBlock).toContain('FROM products')
    expect(suspendBlock).toContain('AND deleted_at IS NULL')
  })

  it('touches the parent only after inserting every item', () => {
    const itemInsert = suspendBlock.indexOf('INSERT INTO sale_items')
    const finalTouch = suspendBlock.indexOf('SET updated_at = clock_timestamp()', itemInsert)
    expect(itemInsert).toBeGreaterThan(0)
    expect(finalTouch).toBeGreaterThan(itemInsert)
  })

  it('reuses one browser operation key across a timeout retry', () => {
    expect(saleApiSource).toContain("{ 'X-Idempotency-Key': idempotencyKey }")
    expect(suspendModalSource).toContain('const operationKeyRef = useRef<string | null>(null)')
    expect(suspendModalSource).toContain('operationKeyRef.current ?? crypto.randomUUID()')
    expect(suspendModalSource).toContain('`suspend:${operationKey}`')
  })
})
