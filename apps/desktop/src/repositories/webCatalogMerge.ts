import type { LocalDatabase } from '../db/localDatabase'
import { cleanupCartBlockers } from '../security/catalogCleanupSafety'
import { CatalogCleanupRepository } from './catalogCleanupRepository'

/**
 * 26.11.2026, власник (скрин з телефона): помічник у вебі запропонував обʼєднати дублі, а на «Застосувати» каса
 * відповіла «Ця дія доступна лише на самій касі». Звичайне очищення номенклатури вимагає, щоб у вікні каси був сам
 * власник; з вебу він працює з телефона, а у вікні каси — касир. Тут — той самий механізм обʼєднання з тими самими
 * перевірками, але для власника/адміністратора, що прийшов через веб:
 *  — відкриті чеки й кошик каси читаються з вікна головного ПК; вікно не відкрите — відмова (не видно, що в чеках);
 *  — сервер уже приймав обʼєднання з цієї каси (передане «product.catalog_cleanup»), інакше — відмова;
 *  — перед записом — копія бази; одночасно лише одне обʼєднання (той самий замок, що й у касі);
 *  — запис у журнал — від імені того, хто натиснув у вебі.
 */
export const WEB_MERGE_CHANNELS = { preview: 'desktop:catalog:cleanup-preview', apply: 'desktop:catalog:cleanup-apply' } as const
export const WEB_MERGE_NO_WINDOW = 'Відкрийте вікно програми на головному ПК: без нього не видно відкритих чеків, і обʼєднувати небезпечно.'
export const WEB_MERGE_SERVER_UNPROVEN = 'Сервер ще не приймав обʼєднання з цієї каси — спершу обʼєднайте одну пару на самій касі («Очищення номенклатури»).'

export interface WebMergeHost {
  db: LocalDatabase
  readOpenReceipts: () => Promise<unknown | null>
  backup: () => Promise<unknown>
  busy: () => boolean
  lock: (on: boolean) => void
}
export interface WebMergeSession { id: string; tenant_id: string; role: string }

export function isWebMergeChannel(channel: unknown): channel is typeof WEB_MERGE_CHANNELS[keyof typeof WEB_MERGE_CHANNELS] {
  return channel === WEB_MERGE_CHANNELS.preview || channel === WEB_MERGE_CHANNELS.apply
}

export async function runWebCatalogMerge(host: WebMergeHost, session: WebMergeSession, channel: string, input: unknown): Promise<unknown> {
  if (!['owner', 'admin'].includes(session.role)) throw new Error('Обʼєднання карток доступне власнику та адміністратору')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некоректний запит обʼєднання')
  const { db } = host
  if (!db.prepare("SELECT 1 FROM sync_outbox WHERE tenant_id=? AND operation_type='product.catalog_cleanup' AND status='synced' LIMIT 1").get(session.tenant_id))
    throw new Error(WEB_MERGE_SERVER_UNPROVEN)
  const request = { ...(input as Record<string, unknown>), tenant_id: session.tenant_id }
  const repositoryWith = (receipts: unknown) => new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: ids => cleanupCartBlockers(receipts, ids) })

  if (channel === WEB_MERGE_CHANNELS.preview) {
    const receipts = await host.readOpenReceipts()
    if (receipts === null) throw new Error(WEB_MERGE_NO_WINDOW)
    return repositoryWith(receipts).preview(request as never)
  }
  if (host.busy()) throw new Error('Попереднє обʼєднання ще виконується. Дочекайтеся результату.')
  host.lock(true)
  try {
    const backupPath = await host.backup()
    // Чеки читаємо після копії, і далі до кінця запису — жодного очікування (синхронна транзакція бази).
    const receipts = await host.readOpenReceipts()
    if (receipts === null) throw new Error(WEB_MERGE_NO_WINDOW)
    return { ...repositoryWith(receipts).apply(request as never, session.id) as object, backupPath }
  } finally { host.lock(false) }
}
