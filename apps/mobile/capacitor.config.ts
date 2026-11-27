import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Форсаж для Android та iOS (27.11.2026, слово власника: «на Vercel довго завантажується і погано працює сканер з камери»).
 * Дані — із сервера програми, як у вебі. Сканер — рідний сканер телефона (ML Kit), а не браузерний.
 *
 * 27.11.2026, слово власника: «автооновлення — з сервера». Екрани застосунок бере з сервера програми (та сама адреса,
 * що й веб): кожне злиття в main оновлює екрани на телефоні при наступному відкритті, без нового APK. Новий APK
 * потрібен лише при зміні самої оболонки (нові модулі телефона, дозволи). Файли з хешем у назві телефон кешує.
 * Без звʼязку (27.11.2026, слово власника «і без інтернету через Wi-Fi») відкривається копія екранів, вбудована
 * в застосунок: вхід «Через Wi-Fi» — і робота прямо з головним ПК (apps/web/src/lib/phoneLan).
 */
export const SCREENS_URL = 'https://forsage-pos-crm-new-web.vercel.app'

const config: CapacitorConfig = {
  appId: 'ua.forsage.crm',
  appName: 'Форсаж',
  webDir: '../web/dist-mobile',
  // Без інтернету — запасна копія екранів із самого застосунку (один файл, scripts/inline-offline-app.cjs):
  // вхід «Через Wi-Fi» і робота прямо з головним ПК.
  server: { url: SCREENS_URL, errorPath: 'index.html' },
  android: { allowMixedContent: false },
  ios: { contentInset: 'automatic' },
}

export default config
