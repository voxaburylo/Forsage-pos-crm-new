import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), authority: vi.fn(), config: vi.fn(), usage: vi.fn(),
  search: vi.fn(), extract: vi.fn(), cache: vi.fn(), writes: [] as any[],
}))
vi.mock('../../db/supabase.js', () => ({ db: { rpc: mock.rpc, from: mock.from } }))
vi.mock('../sync/balanceMirror.js', () => ({ requiresSignedBalances: mock.authority }))
vi.mock('../aiService.js', () => ({ getAiConfig: mock.config, recordAiUsage: mock.usage }))
vi.mock('../productService.js', () => ({ clearProductSearchCache: mock.cache, catalogCodesFromName: () => ['WA6333'] }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@google/genai', () => ({ GoogleGenAI: class {
  interactions = { create: mock.search }
  models = { generateContent: mock.extract }
} }))
import { runAiCrossNumberEnrichment } from '../aiCrossNumberEnrichmentService.js'

const product = { tenant_id: 'test-tenant', product_id: 'test-product', source_fingerprint: 'saved-fingerprint',
  sku: 'AUTO-test', name: 'Фільтр WA6333', oem_number: null, supplier_article: null, brand_name: 'WIX' }
const businessWrites = () => mock.writes.filter(row => row.table !== 'product_cross_enrichment_state')

beforeEach(() => {
  vi.clearAllMocks(); mock.writes = []
  mock.authority.mockReset().mockResolvedValue(false)
  mock.config.mockResolvedValue({ enabled: true, apiKey: 'synthetic-key', model: 'synthetic-model' })
  mock.rpc.mockImplementation(async name => ({ data: name === 'claim_product_cross_enrichment' ? [product] : true, error: null }))
  mock.from.mockImplementation(table => {
    let write: any
    const chain: any = {
      update(data: unknown) { write = { table, data, filters: [] }; mock.writes.push(write); return chain },
      upsert(data: unknown) { write = { table, data, filters: [] }; mock.writes.push(write); return chain },
      eq(key: string, value: unknown) { write.filters.push([key, value]); return chain },
      select() { return chain },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: [{ id: 'saved-cross' }], error: null }).then(resolve) },
    }
    return chain
  })
  mock.search.mockResolvedValue({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Synthetic evidence',
    annotations: [{ type: 'url_citation', url: 'https://manufacturer.example/catalog', title: 'Manufacturer' }] }] }] })
  mock.extract.mockResolvedValue({ text: JSON.stringify({ products: [{ product_id: product.product_id,
    primary_catalog_number: 'WA6333', primary_confidence: 1, primary_evidence_index: 0,
    cross_numbers: [{ number: 'C1212', brand: 'Synthetic', number_type: 'cross', evidence_index: 0, confidence: 1 }] }] }) })
})

describe('background AI respects local catalog authority', () => {
  it('does not call the paid provider or write catalog fields for a local-primary store', async () => {
    mock.authority.mockResolvedValue(true)
    expect(await runAiCrossNumberEnrichment()).toMatchObject({ claimed: 1, added: 0, sku_updated: 0, failed: 0 })
    expect(mock.config).not.toHaveBeenCalled()
    expect(mock.search).not.toHaveBeenCalled(); expect(mock.extract).not.toHaveBeenCalled(); expect(mock.usage).not.toHaveBeenCalled()
    expect(businessWrites()).toEqual([])
    expect(mock.rpc.mock.calls.map(call => call[0])).toEqual(['claim_product_cross_enrichment'])
    expect(mock.writes).toHaveLength(1)
    expect(mock.writes[0]).toMatchObject({ table: 'product_cross_enrichment_state', data: {
      status: 'no_match', locked_at: null, locked_by: null,
    }, filters: [['tenant_id', product.tenant_id], ['product_id', product.product_id], ['source_fingerprint', product.source_fingerprint]] })
  })

  it('fails closed when authority cannot be checked, without provider or catalog calls', async () => {
    mock.authority.mockRejectedValue(new Error('unavailable'))
    await expect(runAiCrossNumberEnrichment()).rejects.toThrow()
    expect(mock.config).not.toHaveBeenCalled(); expect(mock.search).not.toHaveBeenCalled()
    expect(businessWrites()).toEqual([])
    expect(mock.rpc.mock.calls.map(call => call[0])).toEqual(['claim_product_cross_enrichment'])
  })

  it('rechecks before saving when the store becomes local-primary during the provider request', async () => {
    mock.authority.mockResolvedValueOnce(false).mockResolvedValue(true)
    expect(await runAiCrossNumberEnrichment()).toMatchObject({ added: 0, sku_updated: 0 })
    expect(mock.search).toHaveBeenCalledOnce()
    expect(businessWrites()).toEqual([])
    expect(mock.rpc.mock.calls.map(call => call[0])).toEqual(['claim_product_cross_enrichment'])
  })

  it('preserves enrichment for a cloud-managed catalog without a registered local primary', async () => {
    expect(await runAiCrossNumberEnrichment()).toMatchObject({ claimed: 1, processed: 1, added: 1, sku_updated: 1, failed: 0 })
    expect(mock.search).toHaveBeenCalledOnce(); expect(mock.extract).toHaveBeenCalledOnce()
    expect(businessWrites()).toHaveLength(1)
    expect(mock.rpc.mock.calls.map(call => call[0])).toEqual(['claim_product_cross_enrichment', 'set_product_sku_from_ai'])
    expect(mock.cache).toHaveBeenCalledOnce()
  })

  it('does not save provider output when the final authority check fails', async () => {
    mock.authority.mockResolvedValueOnce(false).mockRejectedValue(new Error('authority check unavailable'))
    expect(await runAiCrossNumberEnrichment()).toMatchObject({ added: 0, sku_updated: 0, failed: 1 })
    expect(mock.search).toHaveBeenCalledOnce()
    expect(businessWrites()).toEqual([])
    expect(mock.rpc.mock.calls.map(call => call[0])).toEqual(['claim_product_cross_enrichment'])
  })

  it('releases every claimed protected card without enabling AI for any of them', async () => {
    mock.rpc.mockResolvedValue({ data: [product, { ...product, product_id: 'second-product' }], error: null })
    mock.authority.mockResolvedValue(true)
    expect(await runAiCrossNumberEnrichment()).toMatchObject({ claimed: 2, processed: 0, added: 0, sku_updated: 0, failed: 0 })
    expect(mock.writes).toHaveLength(2)
    expect(mock.config).not.toHaveBeenCalled(); expect(businessWrites()).toEqual([])
    expect(mock.writes.map(write => write.filters.find(([field]: string[]) => field === 'product_id')?.[1]))
      .toEqual([product.product_id, 'second-product'])
  })

  it('has no additional calls when the queue is empty', async () => {
    mock.rpc.mockResolvedValue({ data: [], error: null })
    expect(await runAiCrossNumberEnrichment()).toEqual({ claimed: 0, processed: 0, added: 0, sku_updated: 0, failed: 0 })
    expect(mock.authority).not.toHaveBeenCalled(); expect(mock.config).not.toHaveBeenCalled()
    expect(mock.writes).toEqual([])
  })
})
