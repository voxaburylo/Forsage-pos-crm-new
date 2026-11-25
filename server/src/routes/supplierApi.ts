import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  connectionSchema, listConnections, removeConnection, requestSyncNow, saveConnection, saveWarehouse, searchOffers, warehouseSchema,
} from '../services/supplierApiService.js'

/** Налаштування → «API-ключі»: лише власник. Ключ постачальника назовні не віддається. */
export const supplierApiRouter = Router()
supplierApiRouter.use(requireAuth, requireRole('owner'))
supplierApiRouter.get('/', async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await listConnections(req.user!.tenant_id) }) } catch (err) { next(err) }
})
supplierApiRouter.put('/', async (req, res, next) => {
  try {
    const parsed = connectionSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Перевірте ключ: лише латинські літери й цифри, 8–200 знаків', 422)
    res.json({ data: await saveConnection(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})
supplierApiRouter.delete('/:id', async (req, res, next) => {
  try { res.json({ data: await removeConnection(req.user!.tenant_id, String(req.params.id)) }) } catch (err) { next(err) }
})
supplierApiRouter.post('/:id/sync', async (req, res, next) => {
  try { res.json({ data: await requestSyncNow(req.user!.tenant_id, String(req.params.id)) }) } catch (err) { next(err) }
})
supplierApiRouter.put('/warehouses/:id', async (req, res, next) => {
  try {
    const parsed = warehouseSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Днів до відправки: від 0 до 60', 422)
    res.json({ data: await saveWarehouse(req.user!.tenant_id, String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
})

/** Пошук товару постачальника за артикулом — для бланка замовлення. Закупку бачать власник, адмін і менеджер. */
/** 25.11.2026: аналоги за артикулом з крос-номерів постачальника (Омега). Закупку бачать власник, адмін і менеджер. */
async function crossesHandler(req: any, res: any, next: any) {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : ''
    const { searchCrosses } = await import('../services/supplierCrosses.js')
    res.json({ data: await searchCrosses(req.user!.tenant_id, q, ['owner', 'admin', 'manager'].includes(req.user!.role)) })
  } catch (err) { next(err) }
}
export const supplierOffersRouter = Router()
supplierOffersRouter.use(requireAuth, requireRole('owner', 'admin', 'manager', 'cashier'))
supplierOffersRouter.get('/crosses', crossesHandler)
/** 25.11.2026: опис товару постачальника (OE-номери, застосовність, характеристики) за артикулом. */
supplierOffersRouter.get('/details', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : ''
    const { searchDetails } = await import('../services/supplierDetails.js')
    res.json({ data: await searchDetails(req.user!.tenant_id, q) })
  } catch (err) { next(err) }
})
supplierOffersRouter.get('/search', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : ''
    res.json({ data: await searchOffers(req.user!.tenant_id, q, ['owner', 'admin', 'manager'].includes(req.user!.role)) })
  } catch (err) { next(err) }
})
