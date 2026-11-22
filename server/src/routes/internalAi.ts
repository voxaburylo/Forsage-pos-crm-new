import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { AppError } from '../middleware/errorHandler.js'
import { runAiCrossNumberEnrichment } from '../services/aiCrossNumberEnrichmentService.js'
import { pool } from '../db/pg.js'
import { runOwnerAlerts } from '../services/ownerAlertService.js'
import { runDailyDigestTick } from '../services/dailyDigestService.js'
import { runSelfCheckIfDue } from '../services/selfCheckService.js'

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

/**
 * Ключ планувальника бази (pg_cron): створюється самою базою в міграції й ніколи її не покидає,
 * окрім заголовка цього запиту. Так для тривог не потрібна жодна ручна настройка секретів.
 */
async function hasValidJobKey(key: string | undefined, name: string): Promise<boolean> {
  if (!key || key.length < 32 || key.length > 200) return false
  const { rows } = await pool.query('SELECT key FROM internal_job_keys WHERE name = $1', [name])
  const expected = rows[0]?.key ? Buffer.from(String(rows[0].key)) : null
  const actual = Buffer.from(key)
  return Boolean(expected) && expected!.length === actual.length && timingSafeEqual(expected!, actual)
}

// Тривоги власнику й вечірній звіт: раз на кілька хвилин (етап 11, 22.11.2026).
router.get('/owner-alerts', async (req, res, next) => {
  try {
    const allowed = hasValidCronSecret(req.get('authorization')) || await hasValidJobKey(req.get('x-forsage-job-key'), 'owner-alerts')
    if (!allowed) throw new AppError('UNAUTHORIZED', 'Невірний ключ фонового завдання', 401)
    res.setHeader('Cache-Control', 'no-store')
    const alerts = await runOwnerAlerts()
    await runDailyDigestTick()
    res.json({ data: alerts })
  } catch (error) {
    next(error)
  }
})

// Самоперевірка сервера: планувальник бази стукає кожні 10 хв, прохід іде після публікації та раз на три години.
router.get('/self-check', async (req, res, next) => {
  try {
    const allowed = hasValidCronSecret(req.get('authorization')) || await hasValidJobKey(req.get('x-forsage-job-key'), 'self-check')
    if (!allowed) throw new AppError('UNAUTHORIZED', 'Невірний ключ фонового завдання', 401)
    res.setHeader('Cache-Control', 'no-store')
    const outcome = await runSelfCheckIfDue(req.app)
    res.json({ data: { ran: outcome.ran, results: outcome.results?.map(result => ({ checked: result.checked, failures: result.failures.length, slow: result.slow.length, ms: result.ms })) } })
  } catch (error) {
    next(error)
  }
})

export default router
