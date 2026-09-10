import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Table } from '@/components/ui/Table'
import { readFileSync } from 'node:fs'

const styles = readFileSync(new URL('./analyticsLayout.css', import.meta.url), 'utf8')

describe('analytics responsive layout', () => {
  it('keeps a label with every generic report cell without changing values', () => {
    const html = renderToStaticMarkup(<Table
      columns={[
        { key: 'name', header: 'Товар', render: (row: { id: string; name: string }) => row.name },
        { key: 'sum', header: 'Сума', render: () => <strong>1 234,56 грн</strong> },
      ]}
      data={[{ id: '1', name: 'Довгий артикул AUTO-12345678901234567890' }]}
      keyFn={(row) => row.id}
    />)
    expect(html).toContain('data-label="Товар"')
    expect(html).toContain('data-label="Сума"')
    expect(html).toContain('AUTO-12345678901234567890')
    expect(html).toContain('<strong>1 234,56 грн</strong>')
    expect(html).toContain('<thead')
  })

  it('keeps empty reports readable', () => {
    const html = renderToStaticMarkup(<Table
      columns={[{ key: 'id', header: 'Товар', render: (row: { id: string }) => row.id }]}
      data={[]} keyFn={(row) => row.id}
    />)
    expect(html).toContain('Нічого не знайдено')
    expect(html).not.toContain('data-label')
  })

  it('scopes mobile stacking and safe bottom space to analytics', () => {
    expect(styles).toContain('@media (max-width: 767px)')
    expect(styles).toContain('.analytics-content table td')
    expect(styles).toContain('content: attr(data-label)')
    expect(styles).toContain('calc(2rem + env(safe-area-inset-bottom, 0px))')
    expect(styles).toContain('.analytics-content .analytics-operation-history { max-height: none; overflow: visible; }')
  })
})
