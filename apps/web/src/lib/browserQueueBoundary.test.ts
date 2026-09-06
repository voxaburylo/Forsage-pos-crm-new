import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * На касі дві черги співіснували роками: справжня в SQLite і браузерна в
 * IndexedDB. Основний офлайн-шлях у десктопі був закритий, а аварійний — ні:
 * якщо локальний продаж падав, чек ішов у браузерну чергу, звідки його ніхто
 * не читає, і навіть лічильник «N у черзі» на касі його не показував би, бо
 * той у десктопі теж вимкнений. Чек зникав тихо.
 */
describe('межа між двома чергами', () => {
  const originalWindow = (globalThis as any).window

  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = originalWindow
  })

  function pretendDesktop(): void {
    (globalThis as any).window = { forsageDesktop: {} }
  }

  it('не дає покласти чек у браузерну чергу, коли працює каса', async () => {
    pretendDesktop()
    const { enqueueSale } = await import('./offlineDB')

    await expect(enqueueSale({ offline_id: 'x' } as any)).rejects.toThrow(/недоступна на касі/)
  })

  it('така сама межа стоїть на всіх входах у чергу продажів', async () => {
    pretendDesktop()
    const offlineDB = await import('./offlineDB') as Record<string, any>

    for (const name of [
      'commitLocalSale',
      'completePendingSaleSync',
      'markPendingSaleFailed',
      'removePendingSale',
    ]) {
      await expect(offlineDB[name]({} as any, {} as any, 'scope')).rejects.toThrow(/недоступна на касі/)
    }
  })

  it('у браузері черга працює як працювала — межа спрацьовує лише на касі', async () => {
    // Без window.forsageDesktop це звичайна веб-версія: перевірка мовчить, і
    // виклик іде далі, у IndexedDB (якої в тестовому середовищі немає, тому
    // помилка буде вже інша — головне, що не наша).
    const { enqueueSale } = await import('./offlineDB')

    await expect(enqueueSale({ offline_id: 'x' } as any)).rejects.not.toThrow(/недоступна на касі/)
  })

  it('каса не має аварійного шляху «зберегти чек у браузер»', () => {
    const source = readFileSync(new URL('../features/pos/POSPage.tsx', import.meta.url), 'utf8')
    const offlineSaleStart = source.indexOf('async function saveOfflineSale()')
    expect(offlineSaleStart).toBeGreaterThan(-1)

    // Перевірка на десктоп має стояти на самому початку функції — раніше за
    // будь-яку роботу з чеком, інакше сенсу в ній немає.
    const head = source.slice(offlineSaleStart, offlineSaleStart + 600)
    expect(head).toContain('if (desktopBridge())')
    expect(head).toContain('Натисніть «Оплатити» ще раз')
  })
})
