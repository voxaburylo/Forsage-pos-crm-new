import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CatalogChunk, catalogChunks, useDesktopCatalogLayout } from '../../src/features/products/CatalogChunk'

const products = Array.from({ length: 1000 }, (_, index) => ({ id: index, name: 'Товар ' + index + ' довга назва '.repeat(index % 6) }))
function Fixture() {
  const desktop = useDesktopCatalogLayout()
  const [selected, setSelected] = useState(new Set<number>())
  const rows = (chunk: typeof products) => chunk.map(p => {
    const content = <><input type="checkbox" checked={selected.has(p.id)} onChange={() => setSelected(prev => {
      const next = new Set(prev)
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
      return next
    })} aria-label={'Обрати ' + p.id} />{p.name}</>
    return desktop
      ? <tr key={p.id} data-product={p.id}><td style={{ padding: 12, width: 280 }}>{content}</td><td>25 шт</td><td>199 грн</td></tr>
      : <div key={p.id} data-product={p.id} style={{ padding: 12, borderBottom: '1px solid #ccc' }}>{content}<p>25 шт · 199 грн</p></div>
  })
  return <><p>Обрано: {selected.size}</p><main id="app-main-scroll" style={{ height: 500, overflow: 'auto' }}>
    {desktop ? <table style={{ width: 600, borderCollapse: 'collapse' }}>{catalogChunks(products).map(chunk =>
      <CatalogChunk table key={chunk[0].id}>{() => rows(chunk)}</CatalogChunk>)}</table>
    : <div>{catalogChunks(products).map(chunk => <CatalogChunk key={chunk[0].id}>{() => rows(chunk)}</CatalogChunk>)}</div>}
  </main></>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
