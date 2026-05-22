import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

const dateRegex = /^\d{4}-\d{2}-\d{2}$/

// GET /api/v1/analytics/dashboard?startDate=&endDate=
router.get('/dashboard', async (req, res, next) => {
  try {
    const now = new Date()
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
    const defaultEnd = now.toISOString().split('T')[0]

    const schema = z.object({
      startDate: z.string().regex(dateRegex).default(defaultStart),
      endDate:   z.string().regex(dateRegex).default(defaultEnd),
    })
    const q = schema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірний формат дати', 400)

    const { startDate, endDate } = q.data
    const dateFrom = startDate + 'T00:00:00.000Z'
    const dateTo   = endDate   + 'T23:59:59.999Z'

    // 1. Продажі за період (завершені)
    const { data: sales } = await db
      .from('sales')
      .select('id, total, completed_at')
      .eq('status', 'completed')
      .gte('completed_at', dateFrom)
      .lte('completed_at', dateTo)

    const saleIds = (sales ?? []).map((s) => s.id)
    const totalRevenue = (sales ?? []).reduce((s, x) => s + x.total, 0)
    const totalReceipts = (sales ?? []).length
    const averageReceipt = totalReceipts > 0 ? Math.round(totalRevenue / totalReceipts) : 0

    // 2. Собівартість (purchase_price * qty) з sale_items
    let cogs = 0
    if (saleIds.length > 0) {
      const { data: items } = await db
        .from('sale_items')
        .select('qty, unit_price, product:products!inner(purchase_price)')
        .in('sale_id', saleIds)

      for (const item of items ?? []) {
        const product = item.product as unknown as { purchase_price: number } | undefined
        const purchasePrice = product?.purchase_price ?? 0
        cogs += purchasePrice * item.qty
      }
    }

    const grossProfit = totalRevenue - cogs

    // 3. Дані по днях для графіка
    const { data: dailySales } = await db
      .from('sales')
      .select('total, completed_at')
      .eq('status', 'completed')
      .gte('completed_at', dateFrom)
      .lte('completed_at', dateTo)
      .order('completed_at', { ascending: true })

    // Групуємо по днях
    const dailyMap = new Map<string, { revenue: number; count: number }>()
    for (const s of dailySales ?? []) {
      const date = s.completed_at.split('T')[0]
      const existing = dailyMap.get(date) ?? { revenue: 0, count: 0 }
      existing.revenue += s.total
      existing.count++
      dailyMap.set(date, existing)
    }

    // Будуємо масив для всіх днів періоду
    const daily: Array<{ date: string; revenue: number; profit: number }> = []
    const start = new Date(startDate)
    const end = new Date(endDate)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0]
      const dayData = dailyMap.get(dateStr)
      daily.push({
        date: dateStr,
        revenue: dayData?.revenue ?? 0,
        profit: 0, // спрощено — без собівартості по днях
      })
    }

    // 4. Витрати (cash_operations type='out' з категорією)
    const { data: expenses } = await db
      .from('cash_operations')
      .select('amount')
      .eq('type', 'out')
      .not('expense_category_id', 'is', null)
      .gte('created_at', dateFrom)
      .lte('created_at', dateTo)

    const totalExpenses = (expenses ?? []).reduce((s, x) => s + x.amount, 0)
    const netProfit = grossProfit - totalExpenses

    res.json({
      data: {
        total_revenue:   totalRevenue,
        cogs,
        gross_profit:    grossProfit,
        total_expenses:  totalExpenses,
        net_profit:      netProfit,
        total_receipts:  totalReceipts,
        average_receipt: averageReceipt,
        daily,
      },
    })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/abc — ABC-аналіз товарів
router.get('/abc', async (req, res, next) => {
  try {
    // Період: за замовчуванням 90 днів
    const days = Math.max(1, parseInt(String(req.query.days ?? '90'), 10))
    const since = new Date(Date.now() - days * 86400000).toISOString()

    // 1. Отримуємо ID завершених продажів за період
    const { data: completedSales } = await db
      .from('sales')
      .select('id')
      .eq('status', 'completed')
      .gte('completed_at', since)
    const completedSaleIds = (completedSales ?? []).map((s) => s.id)

    // Отримуємо позиції тільки якщо є продажі
    const { data: items } = completedSaleIds.length > 0
      ? await db
          .from('sale_items')
          .select('product_id, qty, unit_price, product:products!inner(id, sku, name, qty_on_hand, purchase_price)')
          .in('sale_id', completedSaleIds)
      : { data: [] }

    // Згуртовуємо по product_id
    const profitMap = new Map<string, { sku: string; name: string; currentStock: number; soldQty: number; profit: number }>()
    for (const item of items ?? []) {
      const p = item.product as unknown as { id: string; sku: string; name: string; qty_on_hand: number; purchase_price: number }
      if (!p) continue
      const existing = profitMap.get(item.product_id) ?? {
        sku: p.sku, name: p.name, currentStock: p.qty_on_hand,
        soldQty: 0, profit: 0,
      }
      existing.soldQty += item.qty
      existing.profit += (item.unit_price - (p.purchase_price ?? 0)) * item.qty
      profitMap.set(item.product_id, existing)
    }

    // 2. Товари, що не продавались — отримуємо окремо
    const soldIds = [...profitMap.keys()]
    const { data: allProducts } = await db
      .from('products')
      .select('id, sku, name, qty_on_hand')
      .is('deleted_at', null)
      .eq('is_active', true)

    for (const prod of allProducts ?? []) {
      if (!soldIds.includes(prod.id)) {
        profitMap.set(prod.id, {
          sku: prod.sku, name: prod.name,
          currentStock: prod.qty_on_hand, soldQty: 0, profit: 0,
        })
      }
    }

    // Сортуємо за прибутком (спадання)
    const sorted = [...profitMap.entries()]
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.profit - a.profit)

    const totalProfit = sorted.reduce((s, x) => s + Math.max(0, x.profit), 0)
    if (totalProfit === 0) {
      return res.json({ data: sorted.map((x) => ({ ...x, abc_class: 'Z', cumulative_pct: 0 })) })
    }

    // ABC класифікація
    let cumulative = 0
    const result = sorted.map((item) => {
      const pct = totalProfit > 0 ? (Math.max(0, item.profit) / totalProfit) * 100 : 0
      cumulative += pct
      let abcClass: string
      if (item.soldQty === 0) {
        abcClass = 'Z'
      } else if (cumulative <= 80) {
        abcClass = 'A'
      } else if (cumulative <= 95) {
        abcClass = 'B'
      } else {
        abcClass = 'C'
      }
      return {
        ...item,
        profit: item.profit,
        abc_class: abcClass,
        cumulative_pct: Math.round(cumulative * 100) / 100,
      }
    })

    res.json({ data: result })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/staff-kpi — KPI персоналу
router.get('/staff-kpi', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const now = new Date()
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
    const defaultEnd = now.toISOString().split('T')[0]
    const dateRegex2 = /^\d{4}-\d{2}-\d{2}$/
    const startDate = typeof req.query.startDate === 'string' && dateRegex2.test(req.query.startDate) ? req.query.startDate : defaultStart
    const endDate = typeof req.query.endDate === 'string' && dateRegex2.test(req.query.endDate) ? req.query.endDate : defaultEnd
    const dateFrom = startDate + 'T00:00:00.000Z'
    const dateTo   = endDate   + 'T23:59:59.999Z'

    // Отримуємо продажі + продавців
    const { data: sales } = await db
      .from('sales')
      .select('id, manager_id, total, discount, subtotal')
      .eq('status', 'completed')
      .gte('completed_at', dateFrom)
      .lte('completed_at', dateTo)

    // Групуємо по manager_id
    const kpiMap = new Map<string, { name: string; revenue: number; count: number; discountTotal: number }>()

    for (const s of sales ?? []) {
      const mgrId = s.manager_id ?? 'unknown'
      const existing = kpiMap.get(mgrId) ?? { name: mgrId === 'unknown' ? 'Невідомо' : mgrId, revenue: 0, count: 0, discountTotal: 0 }
      existing.revenue += s.total
      existing.count++
      existing.discountTotal += s.discount
      kpiMap.set(mgrId, existing)
    }

    // Отримуємо повернення по чеках
    const saleIds = (sales ?? []).map((s) => s.id)
    let returnsCount = 0
    let returnsAmount = 0
    if (saleIds.length > 0) {
      const { data: returns } = await db
        .from('returns')
        .select('refund_kopecks')
        .in('sale_id', saleIds)
      returnsCount = returns?.length ?? 0
      returnsAmount = (returns ?? []).reduce((s, r) => s + (r.refund_kopecks ?? 0), 0)
    }

    // Пробуємо отримати імена з users
    const result = await Promise.all([...kpiMap.entries()].map(async ([mgrId, data]) => {
      let name = data.name
      if (mgrId !== 'unknown') {
        try {
          const { supabaseAdmin } = await import('../db/supabaseAdmin.js')
          const { data: user } = await supabaseAdmin.auth.admin.getUserById(mgrId)
          if (user.user?.user_metadata?.full_name) {
            name = user.user.user_metadata.full_name as string
          }
        } catch {}
      }
      const avg = data.count > 0 ? Math.round(data.revenue / data.count) : 0
      const discountPct = data.revenue > 0 ? Math.round((data.discountTotal / data.revenue) * 100) : 0
      return {
        manager_id: mgrId,
        manager_name: name,
        total_revenue: data.revenue,
        receipt_count: data.count,
        average_receipt: avg,
        total_discounts: data.discountTotal,
        discount_pct: discountPct,
        returns_count: returnsCount,
        returns_amount: returnsAmount,
      }
    }))

    res.json({ data: result.sort((a, b) => b.total_revenue - a.total_revenue) })
  } catch (err) { next(err) }
})

// GET /api/v1/analytics/staff-profitability?startDate=&endDate=
router.get('/staff-profitability', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const now = new Date()
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
    const defaultEnd = now.toISOString().split('T')[0]
    const schema = z.object({
      startDate: z.string().regex(dateRegex).default(defaultStart),
      endDate:   z.string().regex(dateRegex).default(defaultEnd),
    })
    const q = schema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірний формат дати', 400)

    const { startDate, endDate } = q.data
    const dateFrom = startDate + 'T00:00:00.000Z'
    const dateTo   = endDate   + 'T23:59:59.999Z'
    const tenantId = req.user!.tenant_id

    // 1. Отримуємо завершені POS продажі за період
    const { data: sales, error: salesErr } = await db
      .from('sales')
      .select('id, total, manager_id')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .gte('completed_at', dateFrom)
      .lte('completed_at', dateTo)

    if (salesErr) throw new AppError('DB_ERROR', salesErr.message, 500)

    // 2. Отримуємо позиції чеків для розрахунку собівартості (cogs)
    const saleIds = (sales ?? []).map((s) => s.id)
    let saleItemsMap: Record<string, { qty: number; purchase_price: number }[]> = {}
    if (saleIds.length > 0) {
      const { data: saleItems, error: itemsErr } = await db
        .from('sale_items')
        .select('sale_id, qty, product:products!inner(purchase_price)')
        .in('sale_id', saleIds)

      if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

      for (const item of saleItems ?? []) {
        const product = item.product as unknown as { purchase_price: number } | undefined
        const purchasePrice = product?.purchase_price ?? 0
        if (!saleItemsMap[item.sale_id]) {
          saleItemsMap[item.sale_id] = []
        }
        saleItemsMap[item.sale_id].push({ qty: Number(item.qty), purchase_price: purchasePrice })
      }
    }

    // 3. Отримуємо завершені замовлення клієнтів за період
    const { data: orders, error: ordersErr } = await db
      .from('customer_orders')
      .select('id, total_amount, manager_id')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .gte('created_at', dateFrom)
      .lte('created_at', dateTo)

    if (ordersErr) throw new AppError('DB_ERROR', ordersErr.message, 500)

    // 4. Отримуємо товари замовлень для розрахунку собівартості та виручки замовлень
    const orderIds = (orders ?? []).map((o) => o.id)
    let orderItemsMap: Record<string, { qty: number; buy_price: number; sell_price: number }[]> = {}
    if (orderIds.length > 0) {
      const { data: orderItems, error: orderItemsErr } = await db
        .from('customer_order_items')
        .select('order_id, qty, buy_price, sell_price, item_status')
        .in('order_id', orderIds)
        .neq('item_status', 'canceled')

      if (orderItemsErr) throw new AppError('DB_ERROR', orderItemsErr.message, 500)

      for (const item of orderItems ?? []) {
        if (!orderItemsMap[item.order_id]) {
          orderItemsMap[item.order_id] = []
        }
        orderItemsMap[item.order_id].push({
          qty: Number(item.qty),
          buy_price: Number(item.buy_price),
          sell_price: Number(item.sell_price)
        })
      }
    }

    // 5. Отримуємо виплати заробітної плати та премій
    const { data: payments, error: paymentsErr } = await db
      .from('salary_payments')
      .select('employee_id, employee_name, amount, type')
      .eq('tenant_id', tenantId)
      .gte('created_at', dateFrom)
      .lte('created_at', dateTo)

    if (paymentsErr) throw new AppError('DB_ERROR', paymentsErr.message, 500)

    // 6. Отримуємо список користувачів для відображення імен
    let usersList: any[] = []
    try {
      const adminService = await import('../services/adminService.js')
      usersList = await adminService.listUsers()
    } catch (uErr: any) {
      // Ігноруємо помилку, використаємо ім'я за замовчуванням
    }
    const userNamesMap = new Map<string, string>()
    for (const u of usersList) {
      userNamesMap.set(u.id, u.full_name || u.email)
    }

    // 7. Агрегуємо дані прибутковості по менеджерах
    const profitabilityMap: Record<string, {
      manager_id: string
      manager_name: string
      sales_revenue: number
      sales_cogs: number
      orders_revenue: number
      orders_cogs: number
      total_revenue: number
      total_cogs: number
      gross_profit: number
      salary_cost: number
      bonus_cost: number
      advance_cost: number
      penalty_cost: number
      total_payouts: number
      net_profit: number
    }> = {}

    const getOrCreateManager = (id: string, fallbackName?: string) => {
      if (!profitabilityMap[id]) {
        const name = userNamesMap.get(id) || fallbackName || 'Невідомий співробітник'
        profitabilityMap[id] = {
          manager_id: id,
          manager_name: name,
          sales_revenue: 0,
          sales_cogs: 0,
          orders_revenue: 0,
          orders_cogs: 0,
          total_revenue: 0,
          total_cogs: 0,
          gross_profit: 0,
          salary_cost: 0,
          bonus_cost: 0,
          advance_cost: 0,
          penalty_cost: 0,
          total_payouts: 0,
          net_profit: 0
        }
      }
      return profitabilityMap[id]
    }

    // Обробляємо POS продажі
    for (const s of sales ?? []) {
      const managerId = s.manager_id ?? 'unknown'
      const mData = getOrCreateManager(managerId)
      mData.sales_revenue += s.total

      const items = saleItemsMap[s.id] ?? []
      for (const item of items) {
        mData.sales_cogs += item.purchase_price * item.qty
      }
    }

    // Обробляємо замовлення клієнтів
    for (const o of orders ?? []) {
      const managerId = o.manager_id ?? 'unknown'
      const mData = getOrCreateManager(managerId)
      
      const items = orderItemsMap[o.id] ?? []
      let calculatedOrderRevenue = 0
      let calculatedOrderCogs = 0
      for (const item of items) {
        calculatedOrderRevenue += item.sell_price * item.qty
        calculatedOrderCogs += item.buy_price * item.qty
      }

      // Якщо деталей замовлення немає (хоча має бути), беремо загальну суму
      if (items.length === 0) {
        mData.orders_revenue += o.total_amount
      } else {
        mData.orders_revenue += calculatedOrderRevenue
        mData.orders_cogs += calculatedOrderCogs
      }
    }

    // Обробляємо витрати на ЗП
    for (const p of payments ?? []) {
      const empId = p.employee_id
      const mData = getOrCreateManager(empId, p.employee_name)
      const amt = p.amount

      if (p.type === 'salary') {
        mData.salary_cost += amt
      } else if (p.type === 'bonus') {
        mData.bonus_cost += amt
      } else if (p.type === 'advance') {
        mData.advance_cost += amt
      } else if (p.type === 'penalty') {
        mData.penalty_cost += amt
      }
    }

    // Підраховуємо фінальні метрики
    for (const id in profitabilityMap) {
      const mData = profitabilityMap[id]
      mData.total_revenue = mData.sales_revenue + mData.orders_revenue
      mData.total_cogs = mData.sales_cogs + mData.orders_cogs
      mData.gross_profit = mData.total_revenue - mData.total_cogs
      mData.total_payouts = mData.salary_cost + mData.bonus_cost + mData.advance_cost - mData.penalty_cost
      mData.net_profit = mData.gross_profit - mData.total_payouts
    }

    const data = Object.values(profitabilityMap).sort((a, b) => b.net_profit - a.net_profit)
    res.json({ data })
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
