import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// VitePWA активує новий service worker автоматично. Одразу перезавантажуємо
// сторінку після зміни контролера, щоб відкрита вкладка не продовжувала
// працювати зі старим JS і застарілою адресою API. Прапорець захищає від циклу.
if ('serviceWorker' in navigator) {
  let reloadingForUpdate = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return
    reloadingForUpdate = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
