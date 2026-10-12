import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { assertLocalDataAuthority } from '../src/security/localDataAuthority'

// Parse and execute only the isolated callback, never import/start Electron main.
const mainText = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const main = ts.createSourceFile('main.ts', mainText, ts.ScriptTarget.Latest, true)
const channel = 'desktop:staff:resolve-operation'
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit) }
  visit(root); return result
}

it('uses the ordinary guarded IPC registration with trusted session actor and tenant, ignoring extra renderer arguments', () => {
  const calls = find(main, node => ts.isCallExpression(node) && node.expression.getText(main) === 'handleDesktopIpc'
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) as ts.CallExpression[]
  expect(calls).toHaveLength(1)
  const callback = calls[0].arguments[1]
  expect(ts.isArrowFunction(callback)).toBe(true)
  const js = ts.transpileModule('const handler = ' + callback.getText(main), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const resolveOperation = vi.fn(() => ({ status: 'not_committed' }))
  const requireDesktopSession = vi.fn(() => ({ id: 'trusted-owner', tenant_id: 'trusted-tenant' }))
  const handler = new Function('requireLocalStaff', 'requireDesktopSession', js + '; return handler')(
    () => ({ resolveOperation }), requireDesktopSession)
  expect(handler({}, 'daily-salary', 'operation', 'attacker', 'foreign-tenant')).toEqual({ status: 'not_committed' })
  expect(resolveOperation).toHaveBeenCalledExactlyOnceWith('daily-salary', 'operation', 'trusted-owner', 'trusted-tenant')
  expect(requireDesktopSession).toHaveBeenCalledTimes(1)
})

it('keeps owner/admin-only policy and main-PC LAN authority for resolution', () => {
  for (const role of ['owner', 'admin']) expect(isDesktopChannelAllowed(channel, role)).toBe(true)
  for (const role of ['manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker', 'unknown', '']) {
    expect(isDesktopChannelAllowed(channel, role)).toBe(false)
  }
  expect(isLanProxyChannel(channel)).toBe(true)
  expect(() => assertLocalDataAuthority(channel)).not.toThrow()
  const executor = find(main, node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeDesktopCommand')[0]
  const executorText = executor.getText(main)
  for (const guard of ['assertLocalDataAuthority(channel)', 'activeSession(requireLocalDatabase(), session)',
    'isDesktopChannelAllowed(channel, session.role)', 'validateTenantArguments(argument, session.tenant_id)']) {
    expect(executorText.indexOf(guard)).toBeGreaterThan(-1)
    expect(executorText.indexOf(guard)).toBeLessThan(executorText.indexOf('listener(event, ...args)'))
  }
})

it('preload forwards only kind and identity and the web bridge marks legacy support optional', () => {
  const preload = readFileSync(new URL('../src/preload.ts', import.meta.url), 'utf8')
  expect(preload).toContain("resolveOperation: (kind: 'salary' | 'daily-salary', operationId: string) => ipcRenderer.invoke('desktop:staff:resolve-operation', kind, operationId)")
  const bridge = readFileSync(new URL('../../web/src/lib/desktopBridge.ts', import.meta.url), 'utf8')
  expect(bridge).toContain("resolveOperation?: (kind: 'salary' | 'daily-salary', operationId: string) => Promise<{ status: 'committed'; result: any } | { status: 'not_committed' }>")
})
