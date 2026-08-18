import { describe, expect, it } from 'vitest'
import {
  evidenceDomain,
  groundedSourceLabel,
  isPlaceholderSku,
  normalizedNameContains,
  safeCatalogNumber,
} from '../aiCrossNumberRules.js'

describe('AI cross-number safety rules', () => {
  it('normalizes real catalog numbers while rejecting barcodes and specifications', () => {
    expect(safeCatalogNumber('W 811/80')).toBe('W81180')
    expect(safeCatalogNumber('OC-90')).toBe('OC90')
    expect(safeCatalogNumber('4820039094001')).toBeNull()
    expect(safeCatalogNumber('5W-30')).toBeNull()
    expect(safeCatalogNumber('5 L')).toBeNull()
    expect(safeCatalogNumber('AUTO-12345')).toBeNull()
  })

  it('accepts direct catalog sources and blocks search, social and marketplace pages', () => {
    expect(evidenceDomain('https://catalog.mann-filter.com/product/W81180')).toBe('catalog.mann-filter.com')
    expect(evidenceDomain('https://www.mahle-aftermarket.com/catalog')).toBe('mahle-aftermarket.com')
    expect(evidenceDomain('https://google.com/search?q=W81180')).toBeNull()
    expect(evidenceDomain('https://prom.ua/item/123')).toBeNull()
    expect(evidenceDomain('javascript:alert(1)')).toBeNull()
    expect(groundedSourceLabel('MANN-FILTER Online Catalog', 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/test')).toBe('MANN-FILTER Online Catalog')
    expect(groundedSourceLabel('prom.ua marketplace', 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/test')).toBeNull()
  })

  it('changes only generated articles and requires the number to be present in the name', () => {
    expect(isPlaceholderSku('AUTO-ABC123')).toBe(true)
    expect(isPlaceholderSku('W81180')).toBe(false)
    expect(normalizedNameContains('Фільтр MANN W 811/80', 'W81180')).toBe(true)
    expect(normalizedNameContains('Олива 5W30 5L', 'W81180')).toBe(false)
  })
})
