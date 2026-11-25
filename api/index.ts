import app from '../server/src/index.js'

// Сумісний Express API для наявних адрес `/api/v1/...`.
// Бізнес-логіка залишається у server/src; це лише вхід для Vercel.
export default app
// 25.11.2026 (власник: «сервер платний, оплатив Pro», «подними»): помічнику до ~13 хв на відповідь (межа Pro — 800 с).
export const maxDuration = 800
