import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { logger } from './lib/logger.js'
import { errorHandler } from './middleware/errorHandler.js'
import authRouter from './routes/auth.js'
import productsRouter from './routes/products.js'
import customersRouter from './routes/customers.js'
import shiftsRouter from './routes/shifts.js'
import salesRouter from './routes/sales.js'
import returnsRouter from './routes/returns.js'
import reportsRouter from './routes/reports.js'
import adminRouter, { settingsRouter } from './routes/admin.js'
import suppliersRouter from './routes/suppliers.js'
import importRouter from './routes/import.js'
import writeoffsRouter from './routes/writeoffs.js'
import auditRouter from './routes/audit.js'
import loyaltyRouter from './routes/loyalty.js'
import pricingRouter from './routes/pricing.js'
import cashOperationsRouter from './routes/cashOperations.js'
import telegramRouter from './routes/telegram.js'
import customerCarsRouter from './routes/customerCars.js'
import chatsRouter from './routes/chats.js'
import channelsRouter from './routes/channels.js'
import inventoryRouter from './routes/inventory.js'
import analyticsRouter from './routes/analytics.js'
import expenseCategoriesRouter from './routes/expenseCategories.js'
import barcodeSearchRouter from './routes/barcodeSearch.js'
import waitlistRouter from './routes/waitlist.js'
import customerOrdersRouter from './routes/customerOrders.js'
import customerGroupsRouter from './routes/customerGroups.js'
import salaryRouter from './routes/salary.js'
import internalConsumptionsRouter from './routes/internalConsumptions.js'
import { startBot, stopBot, processOcrPhoto } from './services/telegramBot.js'
import { initMessengers, stopMessengers } from './services/messengers/MessengerService.js'
import { processOrderDeadlines } from './services/orderReminders.js'
import { JobWorker } from './workers/jobWorker.js'
import reservesRouter from './routes/reserves.js'
import pickingRouter from './routes/picking.js'
import commissionRouter from './routes/commission.js'
import supplierImportsRouter from './routes/supplierImports.js'
import stockIntegrityRouter from './routes/stockIntegrity.js'
import warehouseMovementsRouter from './routes/warehouseMovements.js'
import notificationsRouter from './routes/notifications.js'
import printRouter from './routes/print.js'
import autoPurchaseRouter from './routes/autoPurchase.js'
import { processImport } from './services/supplierImportService.js'
import { ReserveService } from './services/reserveService.js'
import { StockValidatorService } from './services/stockValidatorService.js'
import { TaskQueue } from './services/taskQueue.js'
import { closeStaleShifts } from './services/shiftService.js'
import { JOB_PRIORITY } from './services/taskQueue.js'
import { db } from './db/supabase.js'

const app = express()
const PORT = process.env.PORT ?? 3001

const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim())

app.use(cors({
  origin: corsOrigins,
  credentials: true,
}))

app.use(express.json())

// Глобальний rate limit: 300 запитів/хв (на IP)
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Забагато запитів', status: 429 } },
}))

// Rate limit для login: max 10 попыток/час (по ТЗ раздел 8.3)
const loginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_LOGIN_ATTEMPTS', message: 'Забагато спроб входу. Спробуйте через годину.', status: 429 } },
})

app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Rate limit на login — підключаємо ДО роутера
app.use('/api/v1/auth/login', loginLimiter)

// Роуты
app.use('/api/v1/auth', authRouter)
app.use('/api/v1/products', productsRouter)
app.use('/api/v1/customers', customersRouter)
app.use('/api/v1/shifts', shiftsRouter)
app.use('/api/v1/sales', salesRouter)
app.use('/api/v1/returns', returnsRouter)
app.use('/api/v1/reports', reportsRouter)
app.use('/api/v1/admin', adminRouter)
app.use('/api/v1/settings', settingsRouter)
app.use('/api/v1/suppliers', suppliersRouter)
app.use('/api/v1/import', importRouter)
app.use('/api/v1/writeoffs', writeoffsRouter)
app.use('/api/v1/audit', auditRouter)
app.use('/api/v1/loyalty', loyaltyRouter)
app.use('/api/v1/pricing', pricingRouter)
app.use('/api/v1/cash-operations', cashOperationsRouter)
app.use('/api/v1/telegram', telegramRouter)
app.use('/api/v1/customer-cars', customerCarsRouter)
app.use('/api/v1/chats', chatsRouter)
app.use('/api/v1/channels', channelsRouter)
app.use('/api/v1/inventory', inventoryRouter)
app.use('/api/v1/analytics', analyticsRouter)
app.use('/api/v1/expense-categories', expenseCategoriesRouter)
app.use('/api/v1/search', barcodeSearchRouter)
app.use('/api/v1/waitlist', waitlistRouter)
app.use('/api/v1/customer-orders', customerOrdersRouter)
app.use('/api/v1/reserves', reservesRouter)
app.use('/api/v1/picking', pickingRouter)
app.use('/api/v1/commission', commissionRouter)
app.use('/api/v1/supplier-imports', supplierImportsRouter)
app.use('/api/v1/admin/stock-integrity', stockIntegrityRouter)
app.use('/api/v1/warehouse/movements', warehouseMovementsRouter)
app.use('/api/v1/notifications', notificationsRouter)
app.use('/api/v1/print', printRouter)
app.use('/api/v1/auto-purchase', autoPurchaseRouter)

app.use('/api/v1/customer-groups', customerGroupsRouter)
app.use('/api/v1/salary', salaryRouter)
app.use('/api/v1/internal-consumptions', internalConsumptionsRouter)

// Централизованный error handler (всегда последний)
app.use(errorHandler)

const jobWorker = new JobWorker()
jobWorker.register('test_job', async (payload) => {
  logger.info({ payload }, 'Test job execution handler triggered')
  if (payload && payload.fail === true) {
    throw new Error('Simulated job failure for testing backoff')
  }
})
jobWorker.register('cleanup_expired_reserves', async (_payload, jobInfo) => {
  logger.info('Running cleanup_expired_reserves background job...')
  const released = await ReserveService.releaseExpiredReserves()
  logger.info({ releasedReservesCount: released }, 'Completed cleanup_expired_reserves job')
  await ReserveService.enqueueCleanupJob(jobInfo.tenantId)
})
jobWorker.register('import_supplier_price', async (payload, jobInfo) => {
  logger.info({ jobId: jobInfo.id, importId: payload.importId }, 'Starting background supplier price import')
  await processImport(jobInfo.id, payload)
  logger.info({ jobId: jobInfo.id, importId: payload.importId }, 'Completed background supplier price import')
})
jobWorker.register('ocr_photo', async (payload, jobInfo) => {
  logger.info({ jobId: jobInfo.id, chatId: payload.chatId }, 'Starting background OCR photo recognition')
  await processOcrPhoto(payload.fileId, payload.chatId, payload.username)
  logger.info({ jobId: jobInfo.id, chatId: payload.chatId }, 'Completed background OCR photo recognition')
})
jobWorker.register('validate_stock_integrity', async (_payload, jobInfo) => {
  logger.info('Running validate_stock_integrity background job...')
  const result = await StockValidatorService.runIntegrityCheck(jobInfo.tenantId)
  logger.info({ issuesCount: result.count }, 'Completed validate_stock_integrity job')
  await StockValidatorService.enqueueNextCheck(jobInfo.tenantId)
})
jobWorker.register('close_stale_shifts', async (_payload, _jobInfo) => {
  logger.info('Running close_stale_shifts background job...')
  const closed = await closeStaleShifts()
  logger.info({ closed }, 'Completed close_stale_shifts job')
  // Re-enqueue для наступного запуску через 6 год
  await TaskQueue.enqueue('close_stale_shifts', {}, {
    scheduledAt: new Date(Date.now() + 6 * 3600 * 1000),
    tenantId: '00000000-0000-0000-0000-000000000001',
    priority: JOB_PRIORITY.BACKGROUND,
  })
})

const server = app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`)
  // Спочатку initMessengers — створює канал у БД, потім startBot щоб не було race condition
  initMessengers().then(() => startBot()).catch(() => startBot())
  processOrderDeadlines()
  setInterval(() => processOrderDeadlines(), 6 * 3600 * 1000)
  
  // Start background job worker
  jobWorker.start()

  // Ensure initial cleanup job is enqueued
  ;(async () => {
    try {
      const { data: existing } = await db.from('sys_background_jobs')
        .select('id')
        .eq('job_type', 'cleanup_expired_reserves')
        .eq('status', 'pending')
        .limit(1)
        .maybeSingle()

      if (!existing) {
        await TaskQueue.enqueue('cleanup_expired_reserves', {}, {
          scheduledAt: new Date(),
          tenantId: '00000000-0000-0000-0000-000000000001',
          priority: JOB_PRIORITY.NORMAL,
        })
        logger.info('Enqueued initial cleanup_expired_reserves job')
      }

      const { data: existingIntegrity } = await db.from('sys_background_jobs')
        .select('id').eq('job_type', 'validate_stock_integrity').eq('status', 'pending').limit(1).maybeSingle()
      if (!existingIntegrity) {
        await TaskQueue.enqueue('validate_stock_integrity', {}, {
          scheduledAt: new Date(Date.now() + 60 * 1000),
          tenantId: '00000000-0000-0000-0000-000000000001',
          priority: JOB_PRIORITY.LOW,
        })
        logger.info('Enqueued initial validate_stock_integrity job')
      }

      const { data: existingStaleShift } = await db.from('sys_background_jobs')
        .select('id').eq('job_type', 'close_stale_shifts').eq('status', 'pending').limit(1).maybeSingle()
      if (!existingStaleShift) {
        await TaskQueue.enqueue('close_stale_shifts', {}, {
          scheduledAt: new Date(Date.now() + 5 * 60 * 1000),
          tenantId: '00000000-0000-0000-0000-000000000001',
          priority: JOB_PRIORITY.BACKGROUND,
        })
        logger.info('Enqueued initial close_stale_shifts job')
      }
    } catch (err: any) {
      logger.error({ error: err ? err.message : 'Unknown error' }, 'Failed to check or enqueue initial jobs')
    }
  })()
})

// Graceful shutdown
process.on('SIGTERM', () => { jobWorker.stop(); stopBot(); stopMessengers(); server.close() })
process.on('SIGINT',  () => { jobWorker.stop(); stopBot(); stopMessengers(); server.close() })

// Запобігти краш від непойманих помилок
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — зупиняємо сервер')
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandledRejection — зупиняємо сервер')
  process.exit(1)
})
