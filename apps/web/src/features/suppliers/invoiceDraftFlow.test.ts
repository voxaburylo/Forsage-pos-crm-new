import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
const form = readFileSync(new URL('./InvoiceFormPage.tsx', import.meta.url), 'utf8')
it('stores a stable receiving identity before the atomic IPC can lose its reply', () => {
  const submit = form.slice(form.indexOf('async function handleSubmit'))
  expect(submit.indexOf('commitInvoiceId: invoiceId')).toBeGreaterThanOrEqual(0)
  expect(submit.indexOf('persistSupplyInvoiceDraft')).toBeLessThan(submit.indexOf('await supplierApi.commitReceiving'))
  expect(submit.indexOf('await supplierApi.commitReceiving')).toBeLessThan(submit.indexOf('clearSupplyInvoiceDraft'))
})
it('never automatically clones an already posted invoice during recovery', () => {
  expect(form).not.toMatch(/navigate\([^\n]+new\?clone=/)
  expect(form).toContain('setVersionConflict(invoice)')
  expect(form).toContain('onOpen={() => navigate(\'/suppliers/invoices/\' + versionConflict.id)}')
})
it('keeps a manually selected category when revalidating the same product', () => {
  expect(form).toContain('category_id: item.product_id === product.id ? item.category_id ?? null : product.category_id ?? item.category_id ?? null')
  expect(form.match(/<option value="__create_category__">/g)).toHaveLength(3)
})
it('clears the draft only after cancellation has succeeded', () => {
  const cancel = form.slice(form.indexOf('async function cancelInvoiceForm()'))
  expect(cancel.indexOf('await cancelStoredInvoiceDraft')).toBeGreaterThanOrEqual(0)
  expect(cancel.indexOf('await cancelStoredInvoiceDraft')).toBeLessThan(cancel.indexOf('clearSupplyInvoiceDraft'))
})
