import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { AppError } from '../middleware/errorHandler.js'
import { runAiCrossNumberEnrichment } from '../services/aiCrossNumberEnrichmentService.js'
import { pool } from '../db/pg.js'
import { runOwnerAlerts } from '../services/ownerAlertService.js'
import { runDailyDigestTick } from '../services/dailyDigestService.js'
import { runSelfCheckIfDue } from '../services/selfCheckService.js'
import { runSupplierSync } from '../services/supplierApiService.js'
import { dbBusy } from '../services/dbLoad.js'

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

// 24.11.2026: прайси постачальників з API (Омега). Планувальник бази стукає кожні 5 хв; одна порція — до 8 сторінок.
router.get('/supplier-sync', async (req, res, next) => {
  try {
    const allowed = hasValidCronSecret(req.get('authorization')) || await hasValidJobKey(req.get('x-forsage-job-key'), 'supplier-sync')
    if (!allowed) throw new AppError('UNAUTHORIZED', 'Невірний ключ фонового завдання', 401)
    res.setHeader('Cache-Control', 'no-store')
    // 27.11.2026: база зайнята — прайси почекають наступних 5 хвилин (вони не термінові, а база потрібна касі й сайту).
    if (await dbBusy()) { res.json({ data: { skipped: 'db_busy' } }); return }
    res.json({ data: await runSupplierSync() })
  } catch (error) {
    next(error)
  }
})

// 26.11.2026: фонові задачі помічника (порядок у назвах, переклад). Планувальник бази стукає щохвилини;
// одне пробудження працює до ~50 с, кілька пачок одночасно. Немає задач — відповідь одразу.
router.get('/ai-jobs', async (req, res, next) => {
  try {
    const allowed = hasValidCronSecret(req.get('authorization')) || await hasValidJobKey(req.get('x-forsage-job-key'), 'ai-jobs')
    if (!allowed) throw new AppError('UNAUTHORIZED', 'Невірний ключ фонового завдання', 401)
    res.setHeader('Cache-Control', 'no-store')
    const { runAiJobsStep } = await import('../services/aiJobService.js')
    // 26.11.2026: той самий будильник веде й масову роботу над текстами товарів для сайту (окрема помилка одну одній не заважає).
    // 27.11.2026: масові тексти й розкладка по категоріях — лише коли база не зайнята; замовлення сайту й задачі з чату йдуть завжди.
    const busy = await dbBusy()
    const skipped = { skipped: 'db_busy' as const }
    const [names, texts, sorting, orders, photos] = await Promise.allSettled([runAiJobsStep(),
      busy ? Promise.resolve(skipped) : import('../services/siteTextJobService.js').then(module => module.runSiteTextStep()),
      busy ? Promise.resolve(skipped) : import('../services/supplierCategorySort.js').then(module => module.runCategorySortStep()),
      // 27.11.2026: замовлення із сайту — у програму, щохвилини.
      import('../services/siteOrderPull.js').then(module => module.runSiteOrderPullStep()),
      // 27.11.2026: масовий «Пошук фото з ШІ» — теж лише коли база не зайнята.
      busy ? Promise.resolve(skipped) : import('../services/photoAi/photoQueue.js').then(module => module.runPhotoAiStep())])
    if (names.status === 'rejected' && texts.status === 'rejected') throw names.reason
    res.json({ data: { ...(names.status === 'fulfilled' ? names.value : { error: true }), site_texts: texts.status === 'fulfilled' ? texts.value : { error: true },
      category_sort: sorting.status === 'fulfilled' ? sorting.value : { error: true }, site_orders: orders.status === 'fulfilled' ? orders.value : { error: true },
      photo_ai: photos.status === 'fulfilled' ? photos.value : { error: true } } })
  } catch (error) {
    next(error)
  }
})

export default router
