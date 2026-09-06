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
    const tracker = functions.get('trackRowWrite')!.getText(tree)
    expect(tracker).toContain('writeFailuresRef.current += 1')
    expect(tracker).toContain('pendingRowWritesRef.current === 0 && refreshAfterWritesRef.current')
  })
  it('does not erase an observed mismatch before the new price is saved', () => {
    const count = functions.get('saveCount')!.getText(tree)
    expect(count).toContain("price_checked: priceStatus === 'match'")
    expect(count).toContain('observed_retail_price: observedKopecks')
    expect(count).not.toContain('observed_retail_price: willApplyPrice ? null')
  })
})
