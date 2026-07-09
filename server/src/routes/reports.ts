import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { periodSchema } from '../validators/reportSchema.js'
import * as reportService from '../services/reportService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/reports/sales/today — продажі за сьогодні
router.get('/sales/today', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const data = await reportService.getSalesToday(req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/sales/period?from=&to= — продажі за період
router.get('/sales/period', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const q = periodSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const data = await reportService.getSalesPeriod(q.data, req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/products/top?from=&to= — TOP-10 товарів за період
router.get('/products/top', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const q = periodSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const data = await reportService.getTopProducts(q.data, req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/products/low-stock — товари з низьким залишком
router.get('/products/low-stock', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const data = await reportService.getLowStockProducts(req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/customers/debtors — клієнти з боргом
router.get('/customers/debtors', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const data = await reportService.getDebtors(req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/sales/weekly — виручка за 7 днів
router.get('/sales/weekly', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const data = await reportService.getWeeklySales(req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/writeoffs/summary — списання за поточний місяць
router.get('/writeoffs/summary', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const data = await reportService.getWriteoffsSummary(req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/shift/:id — звіт по зміні
router.get('/shift/:id', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const data = await reportService.getShiftReport(String(req.params.id), req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/sold-items?date=YYYY-MM-DD — продані товари за день
// (список для дозамовлення у постачальників; за замовч. сьогодні)
router.get('/sold-items', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const raw = String(req.query.date ?? '')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' })
    res.json({ data: await reportService.getSoldItems(date, req.user!.tenant_id), date })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/daily-control?date= — контрольні метрики дня для власника
// (повернення, знижки, недостачі каси, борги, мінусові залишки)
router.get('/daily-control', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { buildDailyControl } = await import('../services/dailyDigestService.js')
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' })
    res.json({ data: await buildDailyControl(req.user!.tenant_id, date) })
  } catch (err) { next(err) }
})

// POST /api/v1/reports/daily-control/send — надіслати звіт власнику в Telegram зараз
router.post('/daily-control/send', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { sendOwnerDigest } = await import('../services/dailyDigestService.js')
    const sent = await sendOwnerDigest(req.user!.tenant_id)
    res.json({ data: { sent } })
  } catch (err) { next(err) }
})

// GET /api/v1/reports/profit?from=&to= — P&L звіт (E-6: COGS)
router.get('/profit', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const from = String(req.query.from ?? new Date(new Date().setDate(1)).toISOString())
    const to   = String(req.query.to   ?? new Date().toISOString())
    const tenantId = req.user!.tenant_id
    const { data, error } = await (await import('../db/supabase.js')).db.rpc('report_profit', {
      p_tenant_id: tenantId,
      p_from: from,
      p_to: to,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (err) { next(err) }
})

export default router
