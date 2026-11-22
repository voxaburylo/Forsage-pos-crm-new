import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'

// 22.11.2026, рішення власника «веб повний, але тільки через головний ПК».
it('the main PC runs web requests like manager-PC requests, without session, printing, fiscal or backups', () => {
  for (const channel of ['desktop:supply:post-invoice', 'desktop:inventory:count', 'desktop:staff:set-pin', 'desktop:catalog:save-product'])
    expect(webRpcChannelAllowed(channel)).toBe(true)
  for (const channel of ['desktop:auth:login-pin', 'desktop:lan:update', 'desktop:print:receipt', 'desktop:fiscal:sale', 'desktop:backup:restore',
    'desktop:backup-now', 'desktop:problems:list', 'desktop:web-rpc:execute', 'desktop:catalog:cleanup-merge', 'desktop:sync:push'])
    expect(webRpcChannelAllowed(channel)).toBe(false)
})

it('a web request runs with the web employee rights through the manager-PC path, only on the main PC', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const handler = main.slice(main.indexOf("handleDesktopIpc('desktop:web-rpc:execute'"), main.indexOf('// Етап 9: швидка зміна касира за PIN.'))
  expect(handler).toContain("getStatus().mode === 'client'")
  expect(handler).toContain('webRpcChannelAllowed(channel)')
  expect(handler).toContain('resolveLanSession(userId)')
  expect(handler).toContain('executeLanCommand(channel')
})
