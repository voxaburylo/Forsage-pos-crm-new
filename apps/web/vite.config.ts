import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

const isDesktopBuild = process.env.FORSAGE_DESKTOP_BUILD === '1'
// 27.11.2026: збірка для застосунку на телефоні (apps/mobile): екрани лежать усередині застосунку, service worker не потрібен.
const isMobileBuild = process.env.VITE_MOBILE_BUILD === '1'

export default defineConfig({
  base: isDesktopBuild ? './' : '/',
  // 27.11.2026: застосунок на телефоні бере екрани з сервера, а без інтернету Capacitor віддає з самого застосунку лише
  // ОДНУ сторінку (errorPath). Тому запасна копія екранів — один файл: увесь код і стилі всередині index.html
  // (apps/mobile/scripts/inline-offline-app.cjs вбудовує їх після збірки).
  ...(isMobileBuild ? { build: { cssCodeSplit: false, assetsInlineLimit: 100_000_000, rollupOptions: { output: { inlineDynamicImports: true } } } } : {}),
  // 22.11.2026 (прохання власника): номер збірки видно вгорі екрана — щоб бачити, чи оновився ПК менеджера чи веб.
  define: {
    __WEB_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    __WEB_COMMIT__: JSON.stringify(String(process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7)),
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(!isDesktopBuild && !isMobileBuild ? [VitePWA({
      // Новий service worker активується одразу, інакше відкрита вкладка каси
      // безкінечно утримує старі модулі (зокрема друк етикеток). Поточну
      // сторінку це не перезавантажує: оновлення з'явиться при наступному reload.
      registerType: 'autoUpdate',
      selfDestroying: true,
      // 21.11.2026 (план швидкості вебу): registerSW.js реєстрував цей самознищувальний sw.js при КОЖНОМУ
      // відкритті, а він одразу перезавантажував сторінку — веб вантажився двічі. Реєстрацію вимкнено;
      // sw.js лишається лише для старих браузерів, де його вже зареєстровано: один раз прибере себе.
      injectRegister: false,
      includeAssets: ['*.svg'],
      manifest: {
        name: 'Forsage CRM',
        short_name: 'Forsage',
        description: 'CRM/ERP система для магазину автозапчастин Форсаж',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        shortcuts: [
          {
            name: 'Відкрити касу',
            short_name: 'Каса',
            description: 'Відкрити POS-касу Форсаж',
            url: '/pos',
            icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
          },
        ],
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        skipWaiting: true,
        clientsClaim: true,
      },
    })] : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
