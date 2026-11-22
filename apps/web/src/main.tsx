import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installLocalDiagnostics } from './lib/localDiagnostics'
import { applyLiteMode } from './lib/liteMode'
import { installDialogFocusRepair } from './lib/dialogFocusRepair'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
