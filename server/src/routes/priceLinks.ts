import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createPriceLink, createPriceLinkSchema, listPriceLinks, readPublicPriceList, revokePriceLink } from '../services/priceListLinkService.js'

/** Керування посиланнями на прайс: створює й вимикає працівник у програмі на касі. */
export const priceLinksRouter = Router()
priceLinksRouter.use(requireAuth)

priceLinksRouter.get('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try { res.json({ data: await listPriceLinks(req.user!.tenant_id) }) } catch (err) { next(err) }
})

priceLinksRouter.post('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = createPriceLinkSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Виберіть від 1 до 500 товарів, назву прайсу і знижку до 50%', 422)
    res.status(201).json({ data: await createPriceLink(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})

priceLinksRouter.delete('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try { res.json({ data: await revokePriceLink(req.user!.tenant_id, String(req.params.id)) }) } catch (err) { next(err) }
})

/** Публічний прайс для клієнта: без входу, лише читання, з окремим обмеженням частоти. */
export const publicPriceRouter = Router()
publicPriceRouter.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Забагато запитів', status: 429 } },
}))

publicPriceRouter.get('/price-list/:token', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Robots-Tag', 'noindex')
    res.json({ data: await readPublicPriceList(String(req.params.token)) })
  } catch (err) { next(err) }
})
