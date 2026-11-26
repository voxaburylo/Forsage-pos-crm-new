import { Router, type NextFunction, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import * as adminService from '../services/adminService.js'
import { siteGatewayAction } from '../services/siteGatewayService.js'
import {
  createSiteOrder, issueSiteKey, readSiteAccessIds, saveSiteAccessIds, siteAccessSchema, siteSectionAllowed, listSiteAdminCategories, listSiteOrders, readSiteAdmin, revokeSiteKey, saveSiteAdmin, siteAccess, siteAdminUpdateSchema,
  siteCategories, siteInfo, siteOrderStatus, siteProductById, siteProducts, siteSupplierOffers, type SiteAccess,
} from '../services/siteService.js'
import { listCatalogCategories } from '../services/siteCatalogCategories.js'
import { bulkSupplierOffers, catalogQuerySchema, getSupplierOffer, listSiteCatalog, offerBulkSchema, offerPatchSchema, patchSupplierOffer } from '../services/siteCatalogService.js'

/**
 * Розділ «Сайт» у програмі (рішення власника 24.11.2026): лише власник. Тут він вмикає сайт, видає ключ,
 * вирішує, що сайт бачить, і дивиться замовлення, що прийшли.
 */
export const siteAdminRouter = Router()
siteAdminRouter.use(requireAuth)

/**
 * Розділ відкритий власнику й тим, кому він дав доступ. На головному ПК запит іде ключем ПК: каса, яка вже перевірила
 * працівника, називає його в заголовку (заголовку віримо лише тоді, коли ключ ПК перевірено сервером).
 */
async function requireSiteSection(req: Request, _res: Response, next: NextFunction) {
  try {
    const staffId = req.tillDeviceActor ? req.get('x-forsage-staff-id') : null
    if (!(await siteSectionAllowed(req.user!, staffId))) throw new AppError('FORBIDDEN', 'Розділ «Сайт» відкриває власник. Попросіть його дати вам доступ.', 403)
    next()
  } catch (err) { next(err) }
}
const ownerOnly = requireRole('owner')

/** Чи можна цьому працівнику в розділ: меню питає раз, щоб показати чи сховати пункт «Сайт». */
siteAdminRouter.get('/me', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const staffId = req.tillDeviceActor ? req.get('x-forsage-staff-id') : null
    res.json({ data: { allowed: await siteSectionAllowed(req.user!, staffId), owner: req.user!.role === 'owner' } })
  } catch (err) { next(err) }
})
siteAdminRouter.get('/access', ownerOnly, async (req, res, next) => {
  try {
    const [users, ids] = await Promise.all([adminService.listUsers(req.user!.tenant_id, false), readSiteAccessIds(req.user!.tenant_id)])
    res.json({ data: { user_ids: ids, users: (users as Array<{ id: string; full_name?: string | null; role?: string }>).filter(user => user.role !== 'owner')
      .map(user => ({ id: user.id, full_name: user.full_name ?? '', role: user.role ?? '' })) } })
  } catch (err) { next(err) }
})
siteAdminRouter.put('/access', ownerOnly, async (req, res, next) => {
  try {
    const parsed = siteAccessSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректний список працівників', 422)
    res.json({ data: { user_ids: await saveSiteAccessIds(req.user!.tenant_id, req.user!.id, parsed.data.user_ids) } })
  } catch (err) { next(err) }
})

siteAdminRouter.get('/', ownerOnly, async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await readSiteAdmin(req.user!.tenant_id) }) } catch (err) { next(err) }
})
siteAdminRouter.put('/', ownerOnly, async (req, res, next) => {
  try {
    const parsed = siteAdminUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Перевірте налаштування сайту: ' + (parsed.error.issues[0]?.path.join('.') || 'невідоме поле'), 422)
    res.json({ data: await saveSiteAdmin(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})
siteAdminRouter.post('/key', ownerOnly, async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await issueSiteKey(req.user!.tenant_id, req.user!.id) }) } catch (err) { next(err) }
})
siteAdminRouter.delete('/key', ownerOnly, async (req, res, next) => {
  try { res.json({ data: await revokeSiteKey(req.user!.tenant_id, req.user!.id) }) } catch (err) { next(err) }
})
// Шлюз сайту forsage-tires.com: кожна дія розділу «Сайт» іде сюди, а сервер додає ключ сайту й пише журнал.
siteAdminRouter.post('/gateway', requireSiteSection, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    // У журнал аудиту — той, хто справді натиснув (на головному ПК його називає каса).
    const staffId = req.tillDeviceActor ? req.get('x-forsage-staff-id') : null
    const actor = staffId && /^[0-9a-f-]{36}$/i.test(staffId) ? { ...req.user!, id: staffId } : req.user!
    res.json({ data: await siteGatewayAction(actor, req.body?.action, req.body?.params) })
  } catch (err) { next(err) }
})
siteAdminRouter.get('/categories', requireSiteSection, async (req, res, next) => {
  try { res.json({ data: await listSiteAdminCategories(req.user!.tenant_id) }) } catch (err) { next(err) }
})

// 26.11.2026: «Сайт → Усі товари» — наші й постачальників в одному списку (див. services/siteCatalogService.ts).
siteAdminRouter.get('/catalog', requireSiteSection, async (req, res, next) => {
  try {
    const parsed = catalogQuerySchema.safeParse(req.query)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректний запит списку товарів', 422)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await listSiteCatalog(req.user!.tenant_id, req.user!.role, parsed.data) })
  } catch (err) { next(err) }
})
// 26.11.2026: дерево категорій із кількістю товарів — ліва колонка «Сайт → Товари».
siteAdminRouter.get('/catalog/categories', requireSiteSection, async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await listCatalogCategories(req.user!.tenant_id) }) } catch (err) { next(err) }
})
siteAdminRouter.get('/catalog/offers/:key', requireSiteSection, async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await getSupplierOffer(req.user!.tenant_id, req.user!.role, String(req.params.key)) }) } catch (err) { next(err) }
})
siteAdminRouter.patch('/catalog/offers/:key', requireSiteSection, async (req, res, next) => {
  try {
    const parsed = offerPatchSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Некоректні дані', 422)
    await patchSupplierOffer(req.user!.tenant_id, String(req.params.key), parsed.data)
    res.json({ data: await getSupplierOffer(req.user!.tenant_id, req.user!.role, String(req.params.key)) })
  } catch (err) { next(err) }
})
siteAdminRouter.post('/catalog/offers/bulk', requireSiteSection, async (req, res, next) => {
  try {
    const parsed = offerBulkSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректні дані', 422)
    res.json({ data: await bulkSupplierOffers(req.user!.tenant_id, parsed.data) })
  } catch (err) { next(err) }
})
siteAdminRouter.get('/orders', ownerOnly, async (req, res, next) => {
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
// 26.11.2026: товари під замовлення від постачальників (Омега, GPL) — з фото, без закупки й назви постачальника.
siteRouter.get('/supplier-offers', async (req: SiteRequest, res, next) => {
  try { res.json({ data: await siteSupplierOffers(req.site!, req.query) }) } catch (err) { next(err) }
})
siteRouter.post('/orders', async (req: SiteRequest, res, next) => {
  try { res.status(201).json({ data: await createSiteOrder(req.site!, req.body) }) } catch (err) { next(err) }
})
siteRouter.get('/orders/:externalId', async (req: SiteRequest, res, next) => {
  try { res.json({ data: await siteOrderStatus(req.site!, String(req.params.externalId)) }) } catch (err) { next(err) }
})
