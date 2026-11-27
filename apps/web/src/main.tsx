import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installLocalDiagnostics } from './lib/localDiagnostics'
import { applyLiteMode } from './lib/liteMode'
import { installDialogFocusRepair } from './lib/dialogFocusRepair'
import { installScannerPrefixGuard } from './lib/scannerPrefixGuard'
import { hydratePhoneLan } from './lib/phoneLan/phoneLan'
import { restorePhoneLanSession } from './lib/phoneLan/phoneLanSession'
import { isNativeApp } from './lib/nativeScan'

// Першим: F7 сканера не має відкривати вікно браузера на жодному екрані (23.11.2026).
installScannerPrefixGuard()
installLocalDiagnostics()
applyLiteMode()
installDialogFocusRepair()

// 21.11.2026: service worker більше не реєструється (див. vite.config.ts) — він лише перезавантажував
// сторінку при кожному відкритті. Прибираємо стару реєстрацію тихо, без перезавантаження: index.html
// і так завжди свіжий (no-store), а файли з хешем у назві кешуються браузером.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations()
    .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
    .catch(() => { /* not critical */ })
}

// 27.11.2026: копія екранів у застосунку на телефоні (без інтернету) відкривається за адресою /index.html — для
// розділів програми це «сторінка не знайдена». Переходимо на «/» без перезавантаження.
if (window.location.pathname === '/index.html') window.history.replaceState(null, '', '/' + window.location.search + window.location.hash)

// 27.11.2026: застосунок на телефоні — доступ через Wi-Fi лежить у памʼяті телефона; копія без інтернету одразу входить ним
// (без пароля й сканування). У браузері й на касі hydratePhoneLan нічого не робить.
async function boot() {
  await Promise.race([hydratePhoneLan(), new Promise(resolve => setTimeout(resolve, 1500))])
  if (window.location.hostname === 'localhost' && isNativeApp()) restorePhoneLanSession()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
void boot()
