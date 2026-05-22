import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { db } from '../db/supabase.js'
import { TaskQueue } from '../services/taskQueue.js'

const router = Router()
router.use(requireAuth)

const ALLOWED = ['owner', 'admin'] as const

// 1. Завантаження файлу прайс-листа
router.post('/upload', requireRole(...ALLOWED), async (req, res, next) => {
  try {
    const supplierId = req.query.supplier_id as string || null
    const updateRetail = req.query.update_retail === 'true'
    const mode = (req.query.mode as 'replace' | 'add') || 'replace'
    
    // Декодуємо ім'я файлу з заголовків
    let filename = req.headers['x-filename'] as string || 'import.csv'
    filename = decodeURIComponent(filename)

    // Створюємо папку temp, якщо вона відсутня
    const tempDir = join(process.cwd(), 'temp')
    await fs.mkdir(tempDir, { recursive: true })

    const tempFilename = `${randomUUID()}.csv`
    const tempPath = join(tempDir, tempFilename)

    const writeStream = createWriteStream(tempPath)
    req.pipe(writeStream)

    writeStream.on('error', (err) => {
      next(err)
    })

    writeStream.on('finish', async () => {
      try {
        // Створюємо запис у таблиці supplier_price_imports
        const { data: importRecord, error: dbErr } = await db
          .from('supplier_price_imports')
          .insert({
            supplier_id: supplierId,
            filename,
            status: 'pending',
            total_rows: 0,
            processed_rows: 0,
            errors_log: [],
          })
          .select('id')
          .single()

        if (dbErr || !importRecord) {
          throw new AppError('DB_ERROR', 'Помилка створення запису імпорту: ' + dbErr?.message, 500)
        }

        // Ставимо задачу в чергу sys_background_jobs
        const job = await TaskQueue.enqueue('import_supplier_price', {
          importId: importRecord.id,
          tempPath,
          supplierId,
          updateRetail,
          mode,
        })

        res.status(201).json({
          success: true,
          importId: importRecord.id,
          jobId: job.id,
        })
      } catch (err) {
        // Очищаємо темповий файл при помилці
        try {
          await fs.unlink(tempPath)
        } catch {}
        next(err)
      }
    })
  } catch (err) {
    next(err)
  }
})

// 2. Список імпортів
router.get('/', requireRole(...ALLOWED), async (_req, res, next) => {
  try {
    const { data, error } = await db
      .from('supplier_price_imports')
      .select('*, suppliers(id, name)')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (err) {
    next(err)
  }
})

// 3. Статус конкретного імпорту
router.get('/status/:id', requireRole(...ALLOWED), async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('supplier_price_imports')
      .select('*, suppliers(id, name)')
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    if (!data) throw new AppError('NOT_FOUND', 'Імпорт не знайдено', 404)
    res.json({ data })
  } catch (err) {
    next(err)
  }
})

export default router
