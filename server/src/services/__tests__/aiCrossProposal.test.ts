import { describe, expect, it } from 'vitest'
import { cleanCrossProposal } from '../aiCrossNumberRules.js'

describe('chat cross-number proposal', () => {
  it('keeps only real catalog numbers with a trustworthy source page', () => {
    const items = cleanCrossProposal([{
      product_id: 'p1',
      numbers: [
        { number: 'W 811/80', brand: 'MANN', source_url: 'https://www.mann-filter.com/ua/catalog/w811-80' },
        { number: 'W811/80', brand: 'MANN', source_url: 'https://other.example/w81180' },
        { number: 'OC 21', brand: 'Knecht', source_url: 'https://www.google.com/search?q=oc21' },
        { number: '5W30', source_url: 'https://shop.example/oil' },
        { number: '4820304490668', source_url: 'https://shop.example/barcode' },
        { number: 'SP-2211B', source_url: 'not a url' },
      ],
    }, { product_id: '', numbers: [{ number: 'X12345', source_url: 'https://a.example' }] }])
    expect(items).toEqual([{ product_id: 'p1', numbers: [{ number: 'W 811/80', brand: 'MANN', source: 'mann-filter.com' }] }])
  })
})
