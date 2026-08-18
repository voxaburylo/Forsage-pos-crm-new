import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { AppError } from '../middleware/errorHandler.js'
import { runAiCrossNumberEnrichment } from '../services/aiCrossNumberEnrichmentService.js'

const router = Router()

function hasValidCronSecret(authorization: string | undefined): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected || !authorization?.startsWith('Bearer ')) return false
  const actual = authorization.slice('Bearer '.length)
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length
    && timingSafeEqual(expectedBuffer, actualBuffer)
}

router.get('/ai-cross-enrichment', async (req, res, next) => {
  try {
    if (!process.env.CRON_SECRET) {
      throw new AppError('CRON_NOT_CONFIGURED', 'Фоновий пошук не налаштовано', 503)
    }
    if (!hasValidCronSecret(req.get('authorization'))) {
      throw new AppError('UNAUTHORIZED', 'Невірний ключ фонового завдання', 401)
    }

    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await runAiCrossNumberEnrichment() })
  } catch (error) {
    next(error)
  }
})

export default router
