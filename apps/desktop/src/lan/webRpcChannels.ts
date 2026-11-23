import { isLanProxyChannel } from './localNetwork'

/**
 * 22.11.2026: які дії головний ПК виконує на запит вебу. Ті самі, що й для ПК менеджера (isLanProxyChannel),
 * мінус усе, що стосується лише цього комп'ютера чи грошей у шухляді: вхід, вікно, друк, фіскалізація,
 * копії бази, мережа. Сервер має такий самий список (webRpcChannelAllowed) — перевірка з двох боків.
 */
const WEB_DENIED_PREFIXES = [
  'desktop:auth:', 'desktop:lan:', 'desktop:link:', 'desktop:print:', 'desktop:fiscal:', 'desktop:sync:', 'desktop:bootstrap:',
  'desktop:backup', 'desktop:problems:', 'desktop:web-rpc:', 'desktop:window:', 'desktop:get-runtime-info',
  'desktop:catalog:cleanup-', 'desktop:orders:offline-status', 'desktop:orders:discard-offline', 'desktop:orders:retry-offline',
  'desktop:diagnostic',
  // Автор зміни передається аргументом — з вебу це можна було б підробити; ця дія лише для команд сервера.
  'desktop:staff:apply-remote-secret',
]
/**
 * 23.11.2026: гроші в касі — лише на самій касі (план вебу 22.11.2026). Екрани вебу цих дій не показують,
 * а тут другий замок: головний ПК і сервер відхиляють їх, навіть якщо запит склали вручну.
 * Скасування замовлення сюди не входить: воно гроші не видає (оплата лише зараховується на рахунок клієнта).
 */
export const WEB_MONEY_CHANNELS: readonly string[] = [
  'desktop:pos:checkout', 'desktop:pos:create-return', 'desktop:pos:refund-core-deposit', 'desktop:pos:create-cash-operation',
  'desktop:pos:open-shift', 'desktop:pos:close-shift', 'desktop:pos:remote-close-shift', 'desktop:pos:reconcile',
  'desktop:pos:pay-debt', 'desktop:pos:add-customer-deposit', 'desktop:pos:payout-customer-deposit',
  'desktop:pos:suspend-sale', 'desktop:pos:resume-sale', 'desktop:pos:confirm-resume-sale', 'desktop:pos:discard-suspended-sale',
  'desktop:orders:add-payment', 'desktop:orders:complete',
  'desktop:staff:create-salary', 'desktop:staff:delete-salary', 'desktop:staff:daily-payout', 'desktop:staff:tire-cash-handover',
]
export function webRpcChannelAllowed(channel: string): boolean {
  return /^desktop:[a-z0-9:-]{1,120}$/.test(channel) && isLanProxyChannel(channel)
    && !WEB_DENIED_PREFIXES.some(prefix => channel.startsWith(prefix)) && !WEB_MONEY_CHANNELS.includes(channel)
}
