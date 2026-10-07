import { Router } from 'express'

import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { getDashboard } from '../services/dashboardService.js'
import { getAbcAnalytics } from '../services/abcAnalyticsService.js'
import { getStaffAnalytics } from '../services/staffAnalyticsService.js'

const router = Router()
router.use(requireAuth)



// GET /api/v1/analytics/dashboard?startDate=&endDate=
router.get('/dashboard', async (req, res, next) => {
  try {
    res.json({ data: await getDashboard(req.query, req.user!.tenant_id, req.user!.role) })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/abc — ABC-аналіз товарів (маржа → лише власник/адмін)
router.get('/abc', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    res.json({ data: await getAbcAnalytics(req.query, req.user!.tenant_id) })
  } catch (err) { next(err) }
})

// Existing staff reports share a tenant-scoped, read-only accounting snapshot.
router.get('/staff-kpi', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    res.json({ data: await getStaffAnalytics(req.query, req.user!.tenant_id, 'kpi') })
  } catch (err) { next(err) }
})
router.get('/staff-profitability', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    res.json({ data: await getStaffAnalytics(req.query, req.user!.tenant_id, 'profitability') })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/kpi/calculate?user_id=&period=YYYY-MM
router.get('/kpi/calculate', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      user_id: z.string().uuid(),
      period: z.string().regex(/^\d{4}-\d{2}$/),
    })
    const q = schema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())

    const tenantId = req.user!.tenant_id
    const { data, error } = await db.rpc('calculate_kpi', {
      p_tenant_id: tenantId,
      p_user_id: q.data.user_id,
      p_period: q.data.period,
    })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/forecast?months=3 — прогноз виручки (лінійна екстраполяція)
router.get('/forecast', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const months = Math.min(parseInt(String(req.query.months ?? '3'), 10) || 3, 12)
    const tenantId = req.user!.tenant_id

    // Беремо останні 6 місяців щоденних даних
    const from = new Date(); from.setMonth(from.getMonth() - 6)
    const { data: sales } = await db
      .from('sales')
      .select('total, completed_at')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .gte('completed_at', from.toISOString())

    // Групуємо по місяцях
    const byMonth: Record<string, number> = {}
    for (const s of sales ?? []) {
      const key = s.completed_at?.slice(0, 7) ?? ''
      if (key) byMonth[key] = (byMonth[key] ?? 0) + s.total
    }

    const entries = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b))
    const n = entries.length
    if (n < 2) { res.json({ data: [] }); return }

    // Проста лінійна регресія по індексах
    const xs = entries.map((_, i) => i)
    const ys = entries.map(([, v]) => v)
    const xMean = xs.reduce((a, b) => a + b, 0) / n
    const yMean = ys.reduce((a, b) => a + b, 0) / n
    const slope = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0) /
                  xs.reduce((s, x) => s + (x - xMean) ** 2, 0)
    const intercept = yMean - slope * xMean

    const lastMonth = entries[n - 1][0]
    const [ly, lm] = lastMonth.split('-').map(Number)
    const forecast = Array.from({ length: months }, (_, i) => {
      const idx = n + i
      const d = new Date(ly, lm - 1 + i + 1, 1)
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      return { month, projected: Math.max(0, Math.round(intercept + slope * idx)) }
    })

    res.json({ data: forecast, trend: slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat' })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/anomalies — незвичайні паттерни
router.get('/anomalies', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const tenantId = req.user!.tenant_id
    const anomalies: Array<{ type: string; message: string; severity: 'warning' | 'critical' }> = []

    // Продажі за сьогодні vs середня за 7 днів
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const week = new Date(); week.setDate(week.getDate() - 7)

    const { data: todaySales } = await db.from('sales')
      .select('total').eq('tenant_id', tenantId).eq('status', 'completed')
      .gte('completed_at', today.toISOString())
    const { data: weekSales } = await db.from('sales')
      .select('total').eq('tenant_id', tenantId).eq('status', 'completed')
      .gte('completed_at', week.toISOString()).lt('completed_at', today.toISOString())

    const todayRev = (todaySales ?? []).reduce((s, x) => s + x.total, 0)
    const weekAvg  = (weekSales ?? []).reduce((s, x) => s + x.total, 0) / 7

    if (weekAvg > 0 && todayRev < weekAvg * 0.3 && new Date().getHours() > 15) {
      anomalies.push({ type: 'low_sales', message: `Сьогоднішні продажі (${Math.round(todayRev / 100)} ₴) значно нижче середнього (${Math.round(weekAvg / 100)} ₴/день)`, severity: 'warning' })
    }

    // Товари з від'ємними залишками
    const { data: negStock } = await db.from('products')
      .select('name').eq('tenant_id', tenantId).lt('qty_on_hand', 0).is('deleted_at', null).limit(5)
    if ((negStock ?? []).length > 0) {
      anomalies.push({ type: 'negative_stock', message: `${negStock!.length} товарів з від'ємним залишком`, severity: 'critical' })
    }

    // Замовлення без руху > 7 днів
    const staleDate = new Date(); staleDate.setDate(staleDate.getDate() - 7)
    const { count: staleCount } = await db.from('customer_orders')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('status', ['new', 'in_progress'])
      .lt('updated_at', staleDate.toISOString())
    if ((staleCount ?? 0) > 0) {
      anomalies.push({ type: 'stale_orders', message: `${staleCount} замовлень без руху > 7 днів`, severity: 'warning' })
    }

    res.json({ data: anomalies })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/kpi/targets?user_id=&period=YYYY-MM
router.get('/kpi/targets', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const tenantId = req.user!.tenant_id
    let query = db.from('staff_kpi_targets')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('period', { ascending: false })

    if (req.query.user_id) query = query.eq('user_id', req.query.user_id as string)
    if (req.query.period) query = query.eq('period', req.query.period as string)

    const { data, error } = await query
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/analytics/kpi/targets — створити/оновити KPI-цілі
router.post('/kpi/targets', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      user_id: z.string().uuid(),
      period: z.string().regex(/^\d{4}-\d{2}$/),
      targets: z.array(z.object({
        metric_type: z.enum(['sales_revenue', 'sales_count', 'orders_count', 'avg_check']),
        target_value: z.number().min(0),
      })),
    })
    const body = schema.safeParse(req.body)
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 400, body.error.flatten())

    const tenantId = req.user!.tenant_id
    const rows = body.data.targets.map(t => ({
      tenant_id: tenantId,
      user_id: body.data.user_id,
      period: body.data.period,
      metric_type: t.metric_type,
      target_value: t.target_value,
    }))

    const { data, error } = await db
      .from('staff_kpi_targets')
      .upsert(rows, { onConflict: 'tenant_id,user_id,period,metric_type' })
      .select()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

export default router
