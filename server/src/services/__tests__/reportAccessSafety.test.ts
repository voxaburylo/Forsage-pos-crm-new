import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const reportsRoute = readFileSync(new URL('../../routes/reports.ts', import.meta.url), 'utf8')
const aiRoute = readFileSync(new URL('../../routes/ai.ts', import.meta.url), 'utf8')

describe('operational report access', () => {
  it('allows cashiers and managers to read the sold-items reorder list', () => {
    const soldItemsRoute = reportsRoute.match(/router\.get\('\/sold-items'[\s\S]*?\n\}\)/)?.[0] ?? ''

    expect(soldItemsRoute).toContain("requireRole('owner', 'admin', 'manager', 'cashier', 'storekeeper')")
  })
  it('allows managers and cashiers to use AI while keeping its settings protected', () => {
    expect(aiRoute).toContain("router.get('/status', requireRole('owner', 'admin', 'manager', 'cashier')")
    expect(aiRoute).toContain("router.post('/chat', requireRole('owner', 'admin', 'manager', 'cashier')")
    expect(aiRoute).toContain("router.post('/config', requireRole('owner', 'admin')")
    expect(aiRoute).toContain("router.post('/apply-action', requireRole('owner', 'admin')")
  })
})
