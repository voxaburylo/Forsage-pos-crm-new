/**
 * У браузерній версії API працює на тому самому домені. Desktop renderer
 * відкривається через file://, тому для нього потрібна повна HTTPS-адреса.
 * Старий Render-сервіс виведено з експлуатації; навіть застарілий env не
 * повинен знову зупинити локальну синхронізацію.
 */
const DESKTOP_API_URL = 'https://forsage-pos-crm-new-web.vercel.app'
const configuredApiUrl = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/$/, '')

function isRetiredApiUrl(value: string): boolean {
  if (!value) return false
  try {
    return new URL(value).hostname.endsWith('.onrender.com')
  } catch {
    return true
  }
}

const activeConfiguredUrl = isRetiredApiUrl(configuredApiUrl) ? '' : configuredApiUrl
// 27.11.2026: застосунок на телефоні відкривається з власної адреси (https://localhost), тож теж потребує повної адреси сервера.
export const API_BASE_URL = activeConfiguredUrl || (import.meta.env.BASE_URL === './' || import.meta.env.VITE_MOBILE_BUILD === '1' ? DESKTOP_API_URL : '')
