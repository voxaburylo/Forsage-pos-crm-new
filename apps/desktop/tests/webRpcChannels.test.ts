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
  // 22.11.2026: одну й ту саму перевірку проходить запит і з вікна програми (сесія працівника),
  // і з головного процесу, який тримає зв'язок ключем самого ПК (екран входу).
  expect(main).toContain("handleDesktopIpc('desktop:web-rpc:execute', (_event, userId: string, channel: string, args: unknown[]) => executeWebRequest(userId, channel, args))")
  expect(main).toContain('execute: executeWebRequest,')
  const executor = main.slice(main.indexOf('async function executeWebRequest('), main.indexOf('let tillDeviceLinkError'))
  expect(executor).toContain('if (!isMainTill())')
  expect(executor).toContain('webRpcChannelAllowed(channel)')
  expect(executor).toContain('resolveLanSession(userId)')
  expect(executor).toContain("session.role === 'cashier'")
  expect(executor).toContain('executeLanCommand(channel')
  const mainTill = main.slice(main.indexOf('function isMainTill()'), main.indexOf('async function executeWebRequest('))
  expect(mainTill).toContain("getStatus().mode !== 'client'")
  expect(mainTill).toContain('hasLanIdentity(')
})

// 23.11.2026: «гроші в касі — лише на касі» стереже не лише відсутність кнопок у вебі, а й канал: головний ПК і сервер
// відхиляють грошові дії з вебу, навіть складені вручну. Списки на обох боках — однакові.
it('money at the till never runs from the web, on both sides of the link', async () => {
  const { WEB_MONEY_CHANNELS } = await import('../src/lan/webRpcChannels')
  for (const channel of WEB_MONEY_CHANNELS) expect(webRpcChannelAllowed(channel), channel).toBe(false)
  for (const channel of ['desktop:pos:checkout', 'desktop:pos:create-return', 'desktop:pos:create-cash-operation', 'desktop:pos:pay-debt',
    'desktop:orders:add-payment', 'desktop:orders:complete', 'desktop:staff:create-salary', 'desktop:staff:daily-payout'])
    expect(WEB_MONEY_CHANNELS).toContain(channel)
  // Робота з товаром і документами через веб лишається.
  for (const channel of ['desktop:supply:create-invoice', 'desktop:supply:post-invoice', 'desktop:inventory:complete', 'desktop:orders:save',
    'desktop:orders:cancel', 'desktop:catalog:change-cross-numbers', 'desktop:pos:get-sale', 'desktop:pos:list-sales'])
    expect(webRpcChannelAllowed(channel), channel).toBe(true)
  const server = readFileSync(new URL('../../../server/src/services/tillRpcService.ts', import.meta.url), 'utf8')
  const desktop = readFileSync(new URL('../src/lan/webRpcChannels.ts', import.meta.url), 'utf8')
  const list = (source: string) => source.slice(source.indexOf('export const WEB_MONEY_CHANNELS'), source.indexOf(']', source.indexOf('export const WEB_MONEY_CHANNELS')))
  expect(list(server)).toBe(list(desktop))
  expect(server).toContain('&& !WEB_MONEY_CHANNELS.includes(channel)')
})
