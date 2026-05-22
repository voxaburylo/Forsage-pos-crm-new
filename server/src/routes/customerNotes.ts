import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createNoteSchema, updateNoteSchema } from '../validators/customerNoteSchema.js'
import * as noteService from '../services/customerNoteService.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)

// GET /api/v1/customers/:customerId/notes
router.get('/', async (req, res, next) => {
  try {
    const customerId = String((req.params as Record<string, string>)['customerId'])
    const data = await noteService.listNotes(customerId)
    res.json({ data })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/:customerId/notes
router.post('/', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const customerId = String((req.params as Record<string, string>)['customerId'])
    const parsed = createNoteSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const data = await noteService.createNote(customerId, req.user!.id, parsed.data)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// PATCH /api/v1/customers/:customerId/notes/:noteId
router.patch('/:noteId', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const customerId = String((req.params as Record<string, string>)['customerId'])
    const noteId     = String((req.params as Record<string, string>)['noteId'])
    const parsed = updateNoteSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const data = await noteService.updateNote(noteId, customerId, parsed.data)
    res.json({ data })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customers/:customerId/notes/:noteId
router.delete('/:noteId', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const customerId = String((req.params as Record<string, string>)['customerId'])
    const noteId     = String((req.params as Record<string, string>)['noteId'])
    await noteService.deleteNote(noteId, customerId)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
