import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { BuildInfoSummary } from './BuildInfoSummary'
it('shows an explicit build ID and handles older EXEs without inventing one', () => {
  expect(renderToStaticMarkup(<BuildInfoSummary build={null} />)).toContain('недоступний')
  const html = renderToStaticMarkup(<BuildInfoSummary build={{version:'0.1.0',releaseId:'20260923T120000-123456789abc',builtAt:'2026-09-23T12:00:00Z',contentHash:'a'.repeat(64),sourceCommit:null,sourceDirty:null}} />)
  expect(html).toContain('20260923T120000-123456789abc')
  expect(html).toContain('23.09.2026')
})
