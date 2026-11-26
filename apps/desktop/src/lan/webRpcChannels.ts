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
 * 23.11.2026 було: «гроші в касі — лише на самій касі». РІШЕННЯ ВЛАСНИКА 27.11.2026: «роби повну версію — фіскалізація
 * в нас поки не працює»: продаж, повернення, рух коштів, зміни й оплата замовлень відкриті з вебу й застосунку на телефоні —
 * виконує їх головний ПК, тим самим кодом і з правами того самого працівника (касир — із «Працює через веб», менеджер —
 * із «Може продавати»). Закритими лишились лише виплати зарплати: їх із вебу не просили.
 * Список на сервері й на головному ПК — однаковий (стереже тест webRpcChannels).
 */
export const WEB_MONEY_CHANNELS: readonly string[] = [
  'desktop:staff:create-salary', 'desktop:staff:delete-salary', 'desktop:staff:daily-payout', 'desktop:staff:tire-cash-handover',
]
export function webRpcChannelAllowed(channel: string): boolean {
  return /^desktop:[a-z0-9:-]{1,120}$/.test(channel) && isLanProxyChannel(channel)
    && !WEB_DENIED_PREFIXES.some(prefix => channel.startsWith(prefix)) && !WEB_MONEY_CHANNELS.includes(channel)
}
