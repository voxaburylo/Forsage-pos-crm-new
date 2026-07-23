import { describe, expect, it, vi } from 'vitest'
import { canDeleteCatalog, performCatalogDelete } from './catalogDeletePermissions'

describe('catalog delete permissions', () => {
  it.each(['manager', 'storekeeper', 'cashier', 'sto_viewer', undefined])(
    'does not offer delete to %s',
    (role) => expect(canDeleteCatalog(role)).toBe(false),
  )

  it.each(['owner', 'admin'])('offers delete to %s', (role) => {
    expect(canDeleteCatalog(role)).toBe(true)
  })

  it.each(['manager', 'storekeeper'])('does not invoke local delete for %s', async (role) => {
    const localDelete = vi.fn(async () => ({ ok: true }))
    await expect(performCatalogDelete(role, localDelete)).rejects.toThrow('лише власник або адміністратор')
    expect(localDelete).not.toHaveBeenCalled()
  })

  it('invokes delete for owner', async () => {
    const localDelete = vi.fn(async () => ({ ok: true }))
    await expect(performCatalogDelete('owner', localDelete)).resolves.toEqual({ ok: true })
    expect(localDelete).toHaveBeenCalledOnce()
  })
})
