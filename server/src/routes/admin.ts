import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  createUserSchema, updateUserSchema,
  categorySchema, brandSchema, settingsSchema,
} from '../validators/adminSchema.js'
import * as adminService from '../services/adminService.js'

// ===================== ADMIN ROUTER (/api/v1/admin) =====================
const router = Router()
router.use(requireAuth)

// Users
router.get('/users', requireRole('owner', 'admin'), async (_req, res, next) => {
  try { res.json({ data: await adminService.listUsers() }) } catch (err) { next(err) }
})

router.post('/users', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = createUserSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані користувача', 422, parsed.error.flatten())
    res.status(201).json({ data: await adminService.createUser(parsed.data, req.user!.tenant_id) })
  } catch (err) { next(err) }
})

router.put('/users/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.json({ data: await adminService.updateUser(String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
})

router.delete('/users/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try { await adminService.deleteUser(String(req.params.id)); res.status(204).send() } catch (err) { next(err) }
})

// PUT /api/v1/admin/users/:id/password — скидання пароля адміном
router.put('/users/:id/password', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({ password: z.string().min(6, 'Пароль мінімум 6 символів') })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    await adminService.resetPassword(String(req.params.id), parsed.data.password)
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// Categories — GET доступний усім авторизованим (для фільтрів у товарах)
router.get('/categories', async (req, res, next) => {
  try { res.json({ data: await adminService.listCategories(req.user!.tenant_id) }) } catch (err) { next(err) }
})

router.post('/categories', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = categorySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані категорії', 422, parsed.error.flatten())
    res.status(201).json({ data: await adminService.createCategory(parsed.data, req.user!.tenant_id) })
  } catch (err) { next(err) }
})

router.put('/categories/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = categorySchema.partial().safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.json({ data: await adminService.updateCategory(String(req.params.id), parsed.data, req.user!.tenant_id) })
  } catch (err) { next(err) }
})

router.delete('/categories/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try { await adminService.deleteCategory(String(req.params.id), req.user!.tenant_id); res.status(204).send() } catch (err) { next(err) }
})

// Повне очищення каталогу — товари (soft) + категорії (hard). Тільки власник.
// Потрібне підтвердження рядком "ВИДАЛИТИ ВСЕ" у тілі запиту.
router.post('/reset-catalog', requireRole('owner'), async (req, res, next) => {
  try {
    const schema = z.object({ confirmation: z.literal('ВИДАЛИТИ ВСЕ') })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('CONFIRMATION_REQUIRED', 'Введіть "ВИДАЛИТИ ВСЕ" для підтвердження', 400)
    }
    res.json({ data: await adminService.resetCatalog(req.user!.tenant_id) })
  } catch (err) { next(err) }
})

// Brands — GET доступний усім авторизованим
router.get('/brands', async (req, res, next) => {
  try { res.json({ data: await adminService.listBrands(req.user!.tenant_id) }) } catch (err) { next(err) }
})

router.post('/brands', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = brandSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані бренду', 422, parsed.error.flatten())
    res.status(201).json({ data: await adminService.createBrand(parsed.data, req.user!.tenant_id) })
  } catch (err) { next(err) }
})

router.put('/brands/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = brandSchema.partial().safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.json({ data: await adminService.updateBrand(String(req.params.id), parsed.data, req.user!.tenant_id) })
  } catch (err) { next(err) }
})

router.delete('/brands/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try { await adminService.deleteBrand(String(req.params.id), req.user!.tenant_id); res.status(204).send() } catch (err) { next(err) }
})

export default router

// ===================== SETTINGS ROUTER (/api/v1/settings) =====================
export const settingsRouter = Router()
settingsRouter.use(requireAuth)

settingsRouter.get('/', requireRole('owner', 'admin', 'manager'), async (_req, res, next) => {
  try { res.json({ data: await adminService.getSettings() }) } catch (err) { next(err) }
})

settingsRouter.put('/', requireRole('owner'), async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні налаштування', 422, parsed.error.flatten())
    res.json({ data: await adminService.updateSettings(parsed.data) })
  } catch (err) { next(err) }
})
