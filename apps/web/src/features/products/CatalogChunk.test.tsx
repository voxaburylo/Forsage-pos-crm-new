import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CatalogChunk, catalogChunks } from './CatalogChunk'

describe('catalogue page window', () => {
  it('keeps every product in order, including the final incomplete chunk', () => {
    const items = Array.from({ length: 14307 }, (_, i) => i)
    const chunks = catalogChunks(items)
    expect(chunks.flat()).toEqual(items)
    expect(chunks.every(chunk => chunk.length <= 25)).toBe(true)
    expect(chunks.at(-1)).toHaveLength(7)
    expect(catalogChunks([])).toEqual([])
  })
  it('renders valid table sections and a usable non-observer fallback', () => {
    const html = renderToStaticMarkup(<table><CatalogChunk table>{() => <tr><td>Товар</td></tr>}</CatalogChunk></table>)
    expect(html).toContain('<tbody')
    expect(html).toContain('<tr><td>Товар</td></tr>')
    expect(html).not.toContain('<div')
  })
})
