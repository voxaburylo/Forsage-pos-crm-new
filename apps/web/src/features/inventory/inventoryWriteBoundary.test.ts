import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./ActiveSession.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('ActiveSession.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions = new Map<string, ts.FunctionDeclaration>()
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node)
  ts.forEachChild(node, visit)
}
visit(tree)

describe('all manual inventory writes participate in completion', () => {
  it('journals hardware scans before queueing and blocks completion with pending recovery', () => {
    const queue = functions.get('queueInventoryScan')!.getText(tree)
    expect(queue).toContain('inventoryApi.prepareScan(')
    expect(queue.indexOf('inventoryApi.prepareScan(')).toBeLessThan(queue.indexOf('scanQueue.current.push('))
    expect(functions.get('drainInventoryScanQueue')!.getText(tree)).toContain('pending.sessionId === id')
    const complete = functions.get('completeSession')!.getText(tree)
    expect(complete).toContain('inventoryApi.pendingScans(id).length')
    expect(complete.indexOf('inventoryApi.pendingScans(id).length')).toBeLessThan(complete.indexOf('await inventoryApi.complete'))
  })
  it('persists a retry ID before calling the atomic creation API', () => {
    const handler = functions.get('createProductFromInventory')!.getText(tree)
    expect(handler).toContain('draft.operation_id || crypto.randomUUID()')
    expect(handler).toContain('saveInventoryLocalDraft(')
    expect(handler.indexOf('saveInventoryLocalDraft(')).toBeLessThan(handler.indexOf('await inventoryApi.createProduct('))
    expect(handler).not.toContain('productApi.create(')
    expect(handler).not.toContain('inventoryApi.count(')
  })
  it.each(['savePrice', 'addProduct', 'setItemQty', 'removeItem', 'setItemRetail', 'setItemPurchase',
    'updateItemProduct', 'applyRowMarkup', 'applyMassPrice', 'saveCount', 'createProductFromInventory', 'applyIssuePrice'])(
    '%s tracks the whole write operation', name => {
      const handler = functions.get(name)!
      const outerTry = handler.body!.statements.find(ts.isTryStatement)!
      expect(outerTry.tryBlock.statements[0].getText(tree)).toMatch(/^await trackRowWrite\(/)
    },
  )
  it('checks failures before applying stock and flushes the active input', () => {
    const complete = functions.get('completeSession')!.getText(tree)
    expect(complete.indexOf('flushingInputRef.current = true')).toBeLessThan(complete.indexOf('activeElement.blur()'))
    expect(complete.indexOf('writeFailuresRef.current !== writeFailuresBefore')).toBeLessThan(complete.indexOf('await inventoryApi.complete'))
    expect(complete).toContain('inputGuardRef.current.hasErrors(id)')
    expect(complete.indexOf('inputGuardRef.current.hasErrors(id)')).toBeLessThan(complete.indexOf('await inventoryApi.complete'))
    const tracker = functions.get('trackRowWrite')!.getText(tree)
    expect(tracker).toContain('writeFailuresRef.current += 1')
    expect(tracker).toContain('await writeQueueRef.current.run(work)')
    expect(tracker).toContain('pendingRowWritesRef.current === 0 && refreshAfterWritesRef.current')
  })
  it('does not erase an observed mismatch before the new price is saved', () => {
    const count = functions.get('saveCount')!.getText(tree)
    expect(count).toContain("price_checked: priceStatus === 'match'")
    expect(count).toContain('observed_retail_price: observedKopecks')
    expect(count).not.toContain('observed_retail_price: willApplyPrice ? null')
  })
  it('does not discard edits by comparing with an outdated rendered value', () => {
    for (const [name, stale] of [
      ['setItemQty', 'qty === item.counted_stock'],
      ['setItemRetail', 'retail === product.retail_price'],
      ['setItemPurchase', 'purchase === (product.purchase_price'],
      ['updateItemProduct', 'sku === product.sku'],
      ['updateItemProduct', 'name === product.name'],
    ]) expect(functions.get(name)!.getText(tree)).not.toContain(stale)
  })
})
