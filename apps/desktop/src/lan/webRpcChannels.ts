import { isLanProxyChannel } from './localNetwork'

/**
 * 22.11.2026: які дії головний ПК виконує на запит вебу. Ті самі, що й для ПК менеджера (isLanProxyChannel),
 * мінус усе, що стосується лише цього комп'ютера чи грошей у шухляді: вхід, вікно, друк, фіскалізація,
 * копії бази, мережа. Сервер має такий самий список (webRpcChannelAllowed) — перевірка з двох боків.
 */
const WEB_DENIED_PREFIXES = [
  'desktop:auth:', 'desktop:lan:', 'desktop:print:', 'desktop:fiscal:', 'desktop:sync:', 'desktop:bootstrap:',
  'desktop:backup', 'desktop:problems:', 'desktop:web-rpc:', 'desktop:window:', 'desktop:get-runtime-info',
  'desktop:catalog:cleanup-', 'desktop:orders:offline-status', 'desktop:orders:discard-offline', 'desktop:orders:retry-offline',
  'desktop:diagnostic',
]
export function webRpcChannelAllowed(channel: string): boolean {
  return /^desktop:[a-z0-9:-]{1,120}$/.test(channel) && isLanProxyChannel(channel)
    && !WEB_DENIED_PREFIXES.some(prefix => channel.startsWith(prefix))
}
