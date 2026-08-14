import app from '../server/src/index.js'

// Сумісний Express API для наявних адрес `/api/v1/...`.
// Бізнес-логіка залишається у server/src; це лише вхід для Vercel.
export default app
export const maxDuration = 300
