import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Inspect wiring without importing main: importing it would start the desktop,
// its database, background services and Electron lifecycle.
const main = ts.createSourceFile('main.ts',
  readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const printer = ts.createPrinter({ removeComments: true })
const text = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, main)

function nodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node): void => {
    if (guard(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function one<T>(values: T[]): T {
  expect(values).toHaveLength(1)
  return values[0]!
}

function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, ts.isCallExpression).filter(node => text(node.expression) === name)
}

function declaration(name: string): ts.FunctionDeclaration {
  return one(nodes(main, ts.isFunctionDeclaration).filter(node => node.name?.text === name))
}

describe('fiscal orchestration production wiring', () => {
  it('imports the two implementations from the side-effect-free production module', () => {
    const imported = one(nodes(main, ts.isImportDeclaration).filter(node =>
      ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === './fiscal/fiscalOrchestration'))
    expect(imported.importClause?.isTypeOnly).toBe(false)
    const bindings = imported.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) throw new Error('Named fiscal imports are required')
    expect(bindings.elements.map(item => ({ local: item.name.text,
      imported: item.propertyName?.text ?? item.name.text, typeOnly: item.isTypeOnly })))
      .toEqual([
        { local: 'fiscalizeSale', imported: 'fiscalizeSale', typeOnly: false },
        { local: 'processFiscalReturn', imported: 'processFiscalReturn', typeOnly: false },
      ])
  })

  it.each([
    ['desktop:fiscal:fiscalize-sale', 'fiscalizeSale', 'request'],
    ['desktop:fiscal:fiscalize-return', 'processFiscalReturn', 'request'],
    ['desktop:fiscal:resume-return', 'processFiscalReturn',
      'requireLocalPos().getFiscalReturnRequest(operationId, scope)'],
  ])('delegates %s through the ordinary IPC boundary with lazy Cashalot access', (channel, target, request) => {
    const registration = one(calls(main, 'handleDesktopIpc').filter(call => {
      const first = call.arguments[0]
      return first && ts.isStringLiteral(first) && first.text === channel
    }))
    const handler = registration.arguments[1]
    if (!handler || !ts.isArrowFunction(handler) || !ts.isCallExpression(handler.body)) {
      throw new Error('Fiscal IPC must delegate directly, not duplicate orchestration')
    }
    expect(text(handler.body.expression)).toBe(target)
    expect(handler.body.arguments.map(text)).toEqual(['requireLocalPos()', 'requireCashalot', request])
  })

  it('does not leave a second inline fiscal state machine in main', () => {
    const orchestrationMethods = new Set(['prepareFiscalSaleIntent', 'prepareFiscalReturnIntent',
      'startFiscalSaleIntent', 'markFiscalSaleIntentFiscalized', 'markFiscalSaleIntentUnknown'])
    const inline = nodes(main, ts.isCallExpression).filter(call =>
      ts.isPropertyAccessExpression(call.expression) && orchestrationMethods.has(call.expression.name.text))
    expect(inline).toEqual([])
    expect(nodes(main, ts.isFunctionDeclaration).filter(node =>
      node.name?.text === 'fiscalizeSale' || node.name?.text === 'processFiscalReturn')).toEqual([])
  })

  it('keeps authenticated execution and promise routing around the extracted handlers', () => {
    const ipc = declaration('handleDesktopIpc')
    const route = one(calls(ipc, 'executeDesktopCommand'))
    expect(route.arguments.map(text)).toEqual(['channel', 'listener', 'event', 'args', 'session'])
    expect(one(calls(ipc, 'requireDesktopSession')).getStart(main)).toBeLessThan(route.getStart(main))
    expect(calls(ipc, 'listener')).toEqual([])

    const executor = declaration('executeDesktopCommand')
    const listener = one(calls(executor, 'listener'))
    expect(listener.arguments.map(text)).toEqual(['event', '...args'])
    const invoke = listener.parent
    if (!ts.isArrowFunction(invoke) || invoke.body !== listener) throw new Error('Listener must be deferred')
    const then = invoke.parent
    if (!ts.isCallExpression(then)) throw new Error('Listener must run through Promise.then')
    expect(text(then.expression)).toBe('Promise.resolve().then')
    expect(then.arguments).toHaveLength(1)
    for (const guard of ['assertLocalDataAuthority', 'activeSession', 'isDesktopChannelAllowed',
      'validateTenantArguments']) {
      expect(one(calls(executor, guard)).getStart(main)).toBeLessThan(listener.getStart(main))
    }
    const roleGuard = one(nodes(executor, ts.isIfStatement).filter(node =>
      calls(node.expression, 'isDesktopChannelAllowed').length === 1))
    expect(text(roleGuard.expression)).toBe('!isDesktopChannelAllowed(channel, session.role)')
    expect(nodes(roleGuard.thenStatement, ts.isThrowStatement)).toHaveLength(1)
    expect(one(calls(executor, 'desktopSessionContext.run')).arguments.map(text)).toEqual(['session', 'run'])
  })
})
