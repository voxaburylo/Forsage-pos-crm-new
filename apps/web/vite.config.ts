import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

const isDesktopBuild = process.env.FORSAGE_DESKTOP_BUILD === '1'

export default defineConfig({
  base: isDesktopBuild ? './' : '/',
  plugins: [
    react(),
    tailwindcss(),
    ...(!isDesktopBuild ? [VitePWA({
      // Новий service worker активується одразу, інакше відкрита вкладка каси
      // безкінечно утримує старі модулі (зокрема друк етикеток). Поточну
      // сторінку це не перезавантажує: оновлення з'явиться при наступному reload.
      registerType: 'autoUpdate',
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
