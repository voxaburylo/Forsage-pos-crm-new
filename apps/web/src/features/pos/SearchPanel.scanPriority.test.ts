import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./SearchPanel.tsx', import.meta.url), 'utf8')

describe('POS barcode source priority', () => {
  it('uses current server data before IndexedDB in the online web cashier', () => {
    const scanner = source.slice(
      source.indexOf('async function handleBarcodeScan'),
      source.indexOf('async function fetchAnalogs'),
    )
    const desktopLookup = scanner.indexOf('catalog.findByBarcode')
    const offlineBranch = scanner.indexOf('if (desktopRuntime || !serverReachable)')
    const indexedDbLookup = scanner.indexOf('findProductByScanOffline', offlineBranch)
    const serverLookup = scanner.indexOf('/api/v1/search/barcode/')

    expect(desktopLookup).toBeGreaterThanOrEqual(0)
    expect(desktopLookup).toBeLessThan(offlineBranch)
    expect(indexedDbLookup).toBeGreaterThan(offlineBranch)
    expect(indexedDbLookup).toBeLessThan(serverLookup)
    expect(scanner.slice(0, offlineBranch)).not.toContain('findProductByScanOffline')
  })

  it('checks the indexed local product before the exact local customer card', () => {
    const scanner = source.slice(
      source.indexOf('async function handleBarcodeScan'),
      source.indexOf('async function fetchAnalogs'),
    )
    const productLookup = scanner.indexOf('catalog.findByBarcode')
    const customerLookup = scanner.indexOf('findCustomerByBarcode')

    expect(productLookup).toBeGreaterThanOrEqual(0)
    expect(customerLookup).toBeGreaterThan(productLookup)
    expect(scanner).not.toContain('listCustomers({ search: normalizedCode')
  })

  it('never falls back to a stale cached product after an online lookup error', () => {
    const scanner = source.slice(
      source.indexOf('async function handleBarcodeScan'),
      source.indexOf('async function fetchAnalogs'),
    )
    const onlineLookup = scanner.indexOf('/api/v1/search/barcode/')
    const onlineCatch = scanner.indexOf('} catch {', onlineLookup)
    const catchBlock = scanner.slice(onlineCatch)

    expect(catchBlock).toContain('Не вдалося перевірити актуальний товар')
    expect(catchBlock).not.toContain('searchProductsOffline')
    expect(catchBlock).not.toContain('findProductByScanOffline')
  })
})