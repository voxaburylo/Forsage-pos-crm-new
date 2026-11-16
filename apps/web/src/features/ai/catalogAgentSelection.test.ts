import { describe, expect, it } from 'vitest'
import { agentPayloadChunks, agentSelection, type CatalogIssue } from './catalogAgentModel'

const issue = (id: string, product: string, changes: Record<string, unknown> = {}, extra: Partial<CatalogIssue> = {}): CatalogIssue =>
  ({ id, product_id: product, fingerprint: 'f-' + product, name: 'Товар ' + product, sku: 'S-' + product, kind: 'price', reason: '', changes, ...extra })

describe('catalog assistant selection', () => {
  it('lets the owner tick any finding; only proposals go to «apply», all products go to bulk edit', () => {
    const issues = [
      issue('a:price', 'a', { retail_price: 1500 }),
      issue('b:category', 'b'),
      issue('b:price', 'b'),
      issue('c:dup', 'c', {}, { primary_id: 'd', primary_fingerprint: 'f-d', blocked: 'Є залишок' }),
    ]
    const selection = agentSelection(issues, new Set(issues.map(row => row.id)))
    expect(selection.rows).toHaveLength(4)
    expect(selection.proposals.map(row => row.id)).toEqual(['a:price'])
    expect(selection.productIds).toEqual(['a', 'b', 'c'])
  })

  it('applies more than 100 proposals in parts, keeping a duplicate apart from an edit of its main card', () => {
    const many = Array.from({ length: 230 }, (_, i) => issue('p' + i, 'p' + i, { retail_price: 1000 + i }))
    const chunks = agentPayloadChunks(many)
    expect(chunks.map(chunk => chunk.length)).toEqual([100, 100, 30])
    const mixed = agentPayloadChunks([
      issue('x:price', 'x', { retail_price: 1000 }),
      issue('y:dup', 'y', {}, { primary_id: 'x', primary_fingerprint: 'f-x' }),
    ])
    expect(mixed).toHaveLength(2)
  })
})
