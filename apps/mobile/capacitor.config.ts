import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Форсаж для Android та iOS (27.11.2026, слово власника: «на Vercel довго завантажується і погано працює сканер з камери»).
 * Екрани — ті самі, що у вебі (apps/web), зібрані всередину застосунку: відкриваються одразу, без завантаження з мережі.
 * Дані — із сервера програми, як у вебі. Сканер — рідний сканер телефона (ML Kit), а не браузерний.
 */
const config: CapacitorConfig = {
  appId: 'ua.forsage.crm',
  appName: 'Форсаж',
  webDir: '../web/dist-mobile',
  android: { allowMixedContent: false },
  ios: { contentInset: 'automatic' },
}

export default config
