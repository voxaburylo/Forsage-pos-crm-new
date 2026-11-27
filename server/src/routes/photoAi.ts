import { Router } from 'express'
import { requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { pool } from '../db/pg.js'
import { keysSchema, keysState, readSettings, readUsage, saveKeys, saveSettings, settingsSchema } from '../services/photoAi/photoAiConfig.js'
import { appliedSchema, decide, decideSchema, listReview, listUnapplied, markApplied, saveChosen, saveSchema, searchForCard, searchSchema } from '../services/photoAi/photoFinds.js'
import { changeBatch, createBatch, createBatchSchema, eligibleIds, eligibleSchema, latestJob } from '../services/photoAi/photoQueue.js'

/**
 * «Пошук фото з ШІ» (27.11.2026): /api/v1/ai/photo-ai/…  Шукати й зберігати фото можуть власник і адміністратор;
 * ключі Serper.dev і Gemini вставляє лише власник. Вхід перевіряє батьківський маршрут /ai.
 */
export const photoAiRouter = Router()
const staff = requireRole('owner', 'admin')
/** Забрати готові фото й доповісти «поставлено» головний ПК може за будь-якого працівника: саму картку змінює каса за своїми правами. */
const anyStaff = requireRole('owner', 'admin', 'manager', 'cashier')
const bad = (message: string, details?: unknown) => new AppError('VALIDATION_ERROR', message, 422, details)

photoAiRouter.get('/status', staff, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const tenantId = req.user!.tenant_id
    const [keys, settings, usage, job, counts] = await Promise.all([keysState(tenantId), readSettings(tenantId), readUsage(tenantId), latestJob(tenantId),
      pool.query(`SELECT count(DISTINCT product_id) FILTER (WHERE state = 'pending')::int AS review, count(DISTINCT product_id) FILTER (WHERE state = 'approved')::int AS unapplied,
                         count(DISTINCT product_id) FILTER (WHERE state = 'applied')::int AS applied FROM photo_ai_finds WHERE tenant_id = $1`, [tenantId])])
    // Перевірка стиснення — лише на прохання (?check=1): вона вантажить бібліотеку картинок.
    const compressor = req.query.check === '1' ? await (await import('../services/photoAi/photoStore.js')).compressorWorks() : undefined
    res.json({ data: { keys, settings, usage, job, review: counts.rows[0]?.review ?? 0, unapplied: counts.rows[0]?.unapplied ?? 0, applied: counts.rows[0]?.applied ?? 0,
      ...(compressor === undefined ? {} : { compressor }), can_edit_keys: req.user!.role === 'owner' } })
  } catch (err) { next(err) }
})

photoAiRouter.post('/settings', staff, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Фото на товар — від 1 до 5, мінімальний розмір — від 200 до 2000 px', parsed.error.flatten())
    res.json({ data: await saveSettings(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})

photoAiRouter.post('/keys', requireRole('owner'), async (req, res, next) => {
  try {
    const parsed = keysSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Перевірте ключ: лише латинські літери, цифри, «-», «_» і «.»')
    res.json({ data: await saveKeys(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})

photoAiRouter.post('/search', staff, async (req, res, next) => {
  try {
    const parsed = searchSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Спершу збережіть картку товару з назвою')
    res.json({ data: await searchForCard(req.user!.tenant_id, parsed.data.product) })
  } catch (err) { next(err) }
})

photoAiRouter.post('/save', staff, async (req, res, next) => {
  try {
    const parsed = saveSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Відмітьте від 1 до 5 фото')
    res.json({ data: await saveChosen(req.user!.tenant_id, parsed.data.product, parsed.data.urls) })
  } catch (err) { next(err) }
})

photoAiRouter.post('/eligible', staff, async (req, res, next) => {
  try {
    const parsed = eligibleSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Список товарів некоректний')
    res.json({ data: { ids: await eligibleIds(req.user!.tenant_id, parsed.data.ids) } })
  } catch (err) { next(err) }
})

photoAiRouter.post('/jobs', staff, async (req, res, next) => {
  try {
    const parsed = createBatchSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Партія — від 1 до 50 товарів')
    res.json({ data: await createBatch(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})

photoAiRouter.post('/jobs/:id/:action', staff, async (req, res, next) => {
  try {
    const action = String(req.params.action)
    if (action !== 'stop' && action !== 'resume') throw bad('Невідома дія')
    res.json({ data: await changeBatch(req.user!.tenant_id, String(req.params.id), action) })
  } catch (err) { next(err) }
})

photoAiRouter.get('/review', staff, async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await listReview(req.user!.tenant_id) }) } catch (err) { next(err) }
})

photoAiRouter.post('/decide', staff, async (req, res, next) => {
  try {
    const parsed = decideSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Рішення некоректне')
    res.json({ data: await decide(req.user!.tenant_id, parsed.data) })
  } catch (err) { next(err) }
})

photoAiRouter.get('/unapplied', anyStaff, async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await listUnapplied(req.user!.tenant_id) }) } catch (err) { next(err) }
})

photoAiRouter.post('/applied', anyStaff, async (req, res, next) => {
  try {
    const parsed = appliedSchema.safeParse(req.body)
    if (!parsed.success) throw bad('Звіт некоректний')
    res.json({ data: await markApplied(req.user!.tenant_id, parsed.data) })
  } catch (err) { next(err) }
})
