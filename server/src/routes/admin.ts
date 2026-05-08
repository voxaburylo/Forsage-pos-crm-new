import { Router } from 'express'
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
    res.status(201).json({ data: await adminService.createUser(parsed.data) })
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
  try { await adminService.deactivateUser(String(req.params.id)); res.status(204).send() } catch (err) { next(err) }
})

// Categories
router.get('/categories', requireRole('owner', 'admin'), async (_req, res, next) => {
  try { res.json({ data: await adminService.listCategories() }) } catch (err) { next(err) }
})

router.post('/categories', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = categorySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані категорії', 422, parsed.error.flatten())
    res.status(201).json({ data: await adminService.createCategory(parsed.data) })
  } catch (err) { next(err) }
})

router.put('/categories/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = categorySchema.partial().safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.json({ data: await adminService.updateCategory(String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
})

router.delete('/categories/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try { await adminService.deleteCategory(String(req.params.id)); res.status(204).send() } catch (err) { next(err) }
})

// Brands
router.get('/brands', requireRole('owner', 'admin'), async (_req, res, next) => {
  try { res.json({ data: await adminService.listBrands() }) } catch (err) { next(err) }
})

router.post('/brands', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = brandSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані бренду', 422, parsed.error.flatten())
    res.status(201).json({ data: await adminService.createBrand(parsed.data) })
  } catch (err) { next(err) }
})

router.put('/brands/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = brandSchema.partial().safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.json({ data: await adminService.updateBrand(String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
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
