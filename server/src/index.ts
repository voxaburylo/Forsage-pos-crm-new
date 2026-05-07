import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { logger } from './lib/logger.js'
import { errorHandler } from './middleware/errorHandler.js'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  credentials: true,
}))

app.use(express.json())

// Глобальный rate limit: 100 запросов/мин
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Забагато запитів', status: 429 } },
}))

// Rate limit для login: max 10 попыток/час (по ТЗ раздел 8.3)
const loginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_LOGIN_ATTEMPTS', message: 'Забагато спроб входу. Спробуйте через годину.', status: 429 } },
})

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Login rate limiter на /api/auth/login (роуты будут добавляться в Фазе 1)
app.use('/api/auth/login', loginLimiter)

// Централизованный error handler (всегда последний)
app.use(errorHandler)

app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`)
})
