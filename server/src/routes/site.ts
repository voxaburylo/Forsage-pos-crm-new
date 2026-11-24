import { Router, type NextFunction, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  createSiteOrder, issueSiteKey, listSiteAdminCategories, listSiteOrders, readSiteAdmin, revokeSiteKey, saveSiteAdmin, siteAccess, siteAdminUpdateSchema,
  siteCategories, siteInfo, siteOrderStatus, siteProductById, siteProducts, type SiteAccess,
} from '../services/siteService.js'

/**
 * Розділ «Сайт» у програмі (рішення власника 24.11.2026): лише власник. Тут він вмикає сайт, видає ключ,
 * вирішує, що сайт бачить, і дивиться замовлення, що прийшли.
 */
export const siteAdminRouter = Router()
siteAdminRouter.use(requireAuth, requireRole('owner'))

siteAdminRouter.get('/', async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await readSiteAdmin(req.user!.tenant_id) }) } catch (err) { next(err) }
})
siteAdminRouter.put('/', async (req, res, next) => {
  try {
    const parsed = siteAdminUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Перевірте налаштування сайту: ' + (parsed.error.issues[0]?.path.join('.') || 'невідоме поле'), 422)
    res.json({ data: await saveSiteAdmin(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})
siteAdminRouter.post('/key', async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await issueSiteKey(req.user!.tenant_id, req.user!.id) }) } catch (err) { next(err) }
})
siteAdminRouter.delete('/key', async (req, res, next) => {
  try { res.json({ data: await revokeSiteKey(req.user!.tenant_id, req.user!.id) }) } catch (err) { next(err) }
})
siteAdminRouter.get('/categories', async (req, res, next) => {
  try { res.json({ data: await listSiteAdminCategories(req.user!.tenant_id) }) } catch (err) { next(err) }
})
siteAdminRouter.get('/orders', async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await listSiteOrders(req.user!.tenant_id) }) } catch (err) { next(err) }
})

/**
 * Адреси для самого сайту. Вхід — ключ сайту в заголовку X-Site-Key (його видає власник у програмі).
 * Лише читання каталогу й передача замовлення; закупівельних цін, клієнтів і грошей тут немає.
 */
export const siteRouter = Router()
siteRouter.use(rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Забагато запитів', status: 429 } },
}))

type SiteRequest = Request & { site?: SiteAccess }
async function requireSite(req: SiteRequest, res: Response, next: NextFunction) {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Robots-Tag', 'noindex')
    req.site = await siteAccess(req.get('x-site-key'))
    next()
  } catch (err) { next(err) }
}
siteRouter.use(requireSite)

siteRouter.get('/info', async (req: SiteRequest, res, next) => {
  try { res.json({ data: await siteInfo(req.site!) }) } catch (err) { next(err) }
})
siteRouter.get('/categories', async (req: SiteRequest, res, next) => {
  try { res.json({ data: await siteCategories(req.site!) }) } catch (err) { next(err) }
})
siteRouter.get('/products', async (req: SiteRequest, res, next) => {
  try { res.json({ data: await siteProducts(req.site!, req.query) }) } catch (err) { next(err) }
})
siteRouter.get('/products/:id', async (req: SiteRequest, res, next) => {
  try { res.json({ data: await siteProductById(req.site!, String(req.params.id)) }) } catch (err) { next(err) }
})
siteRouter.post('/orders', async (req: SiteRequest, res, next) => {
  try { res.status(201).json({ data: await createSiteOrder(req.site!, req.body) }) } catch (err) { next(err) }
})
siteRouter.get('/orders/:externalId', async (req: SiteRequest, res, next) => {
  try { res.json({ data: await siteOrderStatus(req.site!, String(req.params.externalId)) }) } catch (err) { next(err) }
})
