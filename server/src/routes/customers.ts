import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import {
  createCustomerSchema, updateCustomerSchema,
  customerListSchema, payDebtSchema, quickCreateSchema,
} from '../validators/customerSchema.js'
import * as customerService from '../services/customerService.js'
import notesRouter from './customerNotes.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/customers — список з пошуком
router.get('/', async (req, res, next) => {
  try {
    const q = customerListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await customerService.listCustomers(q.data, req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/customers/:id — картка клієнта
router.get('/:id', async (req, res, next) => {
  try {
    const customer = await customerService.getCustomer(String(req.params.id), req.user!.tenant_id)
    res.json({ data: customer })
  } catch (err) { next(err) }
})

// GET /api/v1/customers/:id/sales — історія покупок
router.get('/:id/sales', async (req, res, next) => {
  try {
    const sales = await customerService.getCustomerSales(String(req.params.id), req.user!.tenant_id)
    res.json({ data: sales })
  } catch (err) { next(err) }
})

// GET /api/v1/customers/:id/debts — продажі в борг (историяч долгов)
router.get('/:id/debts', async (req, res, next) => {
  try {
    const debts = await customerService.getCustomerDebts(String(req.params.id), req.user!.tenant_id)
    res.json({ data: debts })
  } catch (err) { next(err) }
})

// POST /api/v1/customers — створити клієнта
router.post('/', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = createCustomerSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані клієнта', 422, parsed.error.flatten())
    const result = await customerService.createCustomer(parsed.data, req.user!.tenant_id)
    res.status(result.reused ? 200 : 201).json({
      data: result.customer,
      meta: { reused: result.reused, vehicle_added: result.vehicleAdded },
    })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/quick — швидке створення з POS (тільки телефон + ім'я)
router.post('/quick', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = quickCreateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Введіть телефон та ім\'я', 422, parsed.error.flatten())
    const result = await customerService.createCustomer({ ...parsed.data, tags: [], card_barcode: null }, req.user!.tenant_id)
    res.status(result.reused ? 200 : 201).json({
      data: result.customer,
      meta: { reused: result.reused, vehicle_added: result.vehicleAdded },
    })
  } catch (err) { next(err) }
})

// PUT /api/v1/customers/:id — оновити клієнта
router.put('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = updateCustomerSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані клієнта', 422, parsed.error.flatten())
    const customer = await customerService.updateCustomer(String(req.params.id), parsed.data, req.user!.tenant_id)
    res.json({ data: customer })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/:id/pay-debt — погасити борг
router.post('/:id/pay-debt', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = payDebtSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Вкажіть коректну суму', 422, parsed.error.flatten())
    const customer = await customerService.payDebt(String(req.params.id), parsed.data, req.user!.tenant_id)

    // Cash operation для готівки
    if (parsed.data.method === 'cash' && parsed.data.shift_id) {
      await db.from('cash_operations').insert({
        tenant_id: req.user!.tenant_id, shift_id: parsed.data.shift_id,
        type: 'in', amount: parsed.data.amount,
        created_by: req.user!.id,
        note: `Оплата боргу: ${customer.full_name ?? customer.phone}`,
      })
    }

    // Audit log
    await db.from('audit_log').insert({
      tenant_id: req.user!.tenant_id, user_id: req.user!.id,
      action: 'DEBT_PAYMENT', entity_type: 'customers', entity_id: customer.id,
      details: { amount: parsed.data.amount, method: parsed.data.method, debt_after: customer.debt_balance },
    })

    res.json({ data: customer })
  } catch (err) { next(err) }
})

// ── Рахунок клієнта (передплата) ─────────────────────────────────────────────
// Гроші вносяться ТІЛЬКИ на касі; з рахунку оплачуються замовлення.

// GET /api/v1/customers/:id/deposit — баланс + останні операції
router.get('/:id/deposit', async (req, res, next) => {
  try {
    const customer = await customerService.getCustomer(String(req.params.id), req.user!.tenant_id)
    const { data: transactions } = await db
      .from('customer_deposit_transactions')
      .select('id, amount, balance_after, method, order_id, sale_id, notes, created_at')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(50)
    res.json({ data: { balance: (customer as any).deposit_balance ?? 0, transactions: transactions ?? [] } })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/:id/deposit — поповнити рахунок (каса)
router.post('/:id/deposit', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = z.object({
      amount:   z.number().int().min(1).max(100_000_000_00),
      method:   z.enum(['cash', 'card', 'transfer']),
      shift_id: z.string().uuid().optional().nullable(),
      notes:    z.string().max(500).optional().nullable(),
    }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Вкажіть коректну суму', 422, parsed.error.flatten())

    const customer = await customerService.getCustomer(String(req.params.id), req.user!.tenant_id)
    const { data: newBalance, error } = await db.rpc('customer_deposit_change', {
      p_tenant_id:   req.user!.tenant_id,
      p_customer_id: customer.id,
      p_amount:      parsed.data.amount,
      p_method:      parsed.data.method,
      p_shift_id:    parsed.data.shift_id ?? null,
      p_notes:       parsed.data.notes ?? 'Поповнення рахунку на касі',
      p_created_by:  req.user!.id,
    })
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Готівка проходить через касу зміни — каса має зійтись при звірці
    if (parsed.data.method === 'cash' && parsed.data.shift_id) {
      await db.from('cash_operations').insert({
        tenant_id: req.user!.tenant_id, shift_id: parsed.data.shift_id,
        type: 'in', amount: parsed.data.amount,
        created_by: req.user!.id,
        note: `Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone}`,
      })
    }

    await db.from('audit_log').insert({
      tenant_id: req.user!.tenant_id, user_id: req.user!.id,
      action: 'DEPOSIT_TOPUP', entity_type: 'customers', entity_id: customer.id,
      details: { amount: parsed.data.amount, method: parsed.data.method, balance_after: newBalance },
    })

    res.json({ data: { balance: newBalance } })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/:id/bonuses — нарахувати/списати бонуси вручну
router.post('/:id/bonuses', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = z.object({
      amount: z.number().int(),  // копійки (+ нарахувати, - списати)
      description: z.string().max(500).optional().nullable(),
    }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const customer = await customerService.manualBonus(
      String(req.params.id), parsed.data.amount, parsed.data.description ?? null, req.user!.id, req.user!.tenant_id,
    )
    res.json({ data: customer })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customers/:id — soft delete
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await customerService.deleteCustomer(String(req.params.id), req.user!.tenant_id)
    res.status(204).send()
  } catch (err) { next(err) }
})

// Вкладені маршрути нотаток
router.use('/:customerId/notes', notesRouter)

// ===================== АВТОМОБІЛІ (Garage) =====================

// GET /api/v1/customers/:id/vehicles — список авто клієнта
router.get('/:id/vehicles', async (req, res, next) => {
  try {
    const vehicles = await customerService.listCustomerVehicles(String(req.params.id), req.user!.tenant_id)
    res.json({ data: vehicles })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/:id/vehicles — додати авто
router.post('/:id/vehicles', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = z.object({
      brand: z.string().min(1).max(100),
      model: z.string().min(1).max(100),
      year:  z.number().int().min(1900).max(2100).optional().nullable(),
      vin:   z.string().max(17).optional().nullable(),
      notes: z.string().max(2000).optional().nullable(),
    }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const vehicle = await customerService.createCustomerVehicle(
      String(req.params.id), parsed.data, req.user!.tenant_id,
    )
    res.status(201).json({ data: vehicle })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customers/:id/vehicles/:vehicleId — видалити авто
router.delete('/:id/vehicles/:vehicleId', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    await customerService.deleteCustomerVehicle(String(req.params.vehicleId), req.user!.tenant_id)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
