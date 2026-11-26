import { Router } from 'express'
import { getNbuRate } from '../services/nbuRateService.js'
import { catalogReviewSchema, reviewCatalog } from '../services/catalogAgentService.js'
import { duplicateReviewSchema, reviewCatalogDuplicates } from '../services/catalogDuplicateReviewService.js'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  getAiConfig, saveAiConfig, testKey, runChat, recognizeSupplyInvoicePhoto, applyAction, getUsageSummary,
  AI_MODELS,
} from '../services/aiService.js'
import { downloadProcessingUpload, removeProcessingUploads } from '../services/processingUploadService.js'
import { findProductPhotos, productPhotoRequestSchema } from '../services/aiProductPhotoService.js'
import { isAiRequestId, readAiReply, saveAiReply } from '../services/aiReplyStore.js'
import { addAiRule, deleteAiRule, listAiRules, parseMemoryCommand, runMemoryCommand, AI_RULE_MAX_CHARS } from '../services/aiMemoryService.js'
import { appendReplyToChat, readChat, writeChat } from '../services/aiChatStore.js'
import { applyOfferItems, changeJobStatus, createJob, createJobSchema, getJob, listJobItems, listJobs, markProductItems, setItemsState } from '../services/aiJobService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/ai/status — чи налаштовано, модель, витрати за місяць
router.get('/status', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const cfg = await getAiConfig(req.user!.tenant_id)
    const usage = await getUsageSummary(req.user!.tenant_id)
    res.json({ data: { enabled: cfg.enabled, model: cfg.model, has_key: cfg.hasKey, usage } })
  } catch (err) { next(err) }
})

// GET /api/v1/ai/usage — лічильник вартості
router.get('/usage', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try { res.json({ data: await getUsageSummary(req.user!.tenant_id) }) } catch (err) { next(err) }
})

const configSchema = z.object({
  api_key: z.string().max(300).optional().nullable(),
  model: z.enum(AI_MODELS).optional(),
  enabled: z.boolean().optional(),
})

// POST /api/v1/ai/config — зберегти ключ / модель / увімкнення (тільки власник/адмін)
// GET /api/v1/ai/nbu-rate?currency=USD — офіційний курс НБУ на сьогодні для накладних у валюті
router.get('/nbu-rate', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try { res.json({ data: await getNbuRate(String(req.query.currency ?? 'USD')) }) } catch (err) { next(err) }
})

router.post('/config', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = configSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await saveAiConfig(req.user!.tenant_id, {
      apiKey: parsed.data.api_key,
      model: parsed.data.model,
      enabled: parsed.data.enabled,
    })
    res.json({ data: result })
  } catch (err) { next(err) }
})

// POST /api/v1/ai/test — перевірити звʼязок (використовує збережений або переданий ключ)
router.post('/test', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const bodyKey = typeof req.body?.api_key === 'string' && req.body.api_key.trim() ? req.body.api_key.trim() : null
    const cfg = await getAiConfig(req.user!.tenant_id)
    const key = bodyKey ?? cfg.apiKey
    if (!key) throw new AppError('AI_NOT_CONFIGURED', 'Немає ключа для перевірки', 400)
    const model = (typeof req.body?.model === 'string' && req.body.model) || cfg.model
    res.json({ data: await testKey(key, model) })
  } catch (err) { next(err) }
})

router.post('/catalog-duplicates-review', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const input = duplicateReviewSchema.safeParse(req.body)
    if (!input.success) throw new AppError('VALIDATION_ERROR', 'Некоректні групи порівняння товарів', 422)
    res.json({ data: await reviewCatalogDuplicates(req.user!.tenant_id, req.user!.id, input.data) })
  } catch (error) { next(error) }
})

router.post('/catalog-review', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const input = catalogReviewSchema.safeParse(req.body)
    if (!input.success) throw new AppError('VALIDATION_ERROR', 'Некоректний пакет перевірки каталогу', 422)
    res.json({ data: await reviewCatalog(req.user!.tenant_id, req.user!.id, input.data) })
  } catch (error) { next(error) }
})

const chatSchema = z.object({
  message: z.string().min(1).max(20000),
  history: z.array(z.object({
    role: z.enum(['user', 'model']),
    text: z.string(),
  })).max(40).optional(),
  file_text: z.string().max(1_000_000).optional(),
  // 24.11.2026: номер запиту від екрана — за ним готову відповідь можна забрати, якщо зʼєднання обірвалось.
  request_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
  // Новий веб-клієнт передає приватний шлях Supabase Storage, старі клієнти — base64.
  images: z.array(z.union([
    z.object({
      mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
      storage_path: z.string().min(1).max(300),
    }),
    z.object({
      mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
      data_base64: z.string().min(1).max(6_000_000),
    }),
    // PDF накладної передається напряму (тимчасове сховище приймає лише фото й таблиці).
    z.object({
      mime_type: z.literal('application/pdf'),
      data_base64: z.string().min(1).max(5_500_000),
    }),
  ])).max(4).optional(),
  // 26.11.2026: у який спільний чат дописати відповідь, якщо екран закрили до її приходу (лише звичайне питання, без файлів).
  chat_kind: z.enum(['assistant', 'invoice']).optional(),
})
const supplyInvoicePhotoSchema = z.object({
  message: z.string().max(20000).optional(),
  images: chatSchema.shape.images.unwrap().min(1),
})

router.post('/supply-invoice-photo', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  const storagePaths: string[] = []
  try {
    const parsed = supplyInvoicePhotoSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані фото накладної', 422, parsed.error.flatten())
    const images = []
    for (const image of parsed.data.images) {
      if ('data_base64' in image) {
        images.push(image)
        continue
      }
      storagePaths.push(image.storage_path)
      const uploaded = await downloadProcessingUpload({
        path: image.storage_path,
        userId: req.user!.id,
        purpose: 'ai',
        maxBytes: 6 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      })
      images.push({
        mime_type: uploaded.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
        data_base64: uploaded.buffer.toString('base64'),
      })
    }
    const out = await recognizeSupplyInvoicePhoto(req.user!.tenant_id, req.user!.id, {
      message: parsed.data.message,
      images,
    })
    res.json({ data: out })
  } catch (err) { next(err) }
  finally {
    await removeProcessingUploads(storagePaths, req.user!.id).catch(() => {})
  }
})

// POST /api/v1/ai/chat — діалог із «директором»
// Фото товарів з інтернету: лише пропозиції з точним артикулом на сторінці; зберігає програма після вибору власника.
router.post('/product-photos', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = productPhotoRequestSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Виберіть від 1 до 8 товарів', 422, parsed.error.flatten())
    res.json({ data: await findProductPhotos(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})

// Пам'ять помічника: правила власника (без міграції — JSON у приватному сховищі файлів).
router.get('/memory', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try { res.json({ data: await listAiRules(req.user!.tenant_id) }) } catch (err) { next(err) }
})
router.post('/memory', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().min(3).max(AI_RULE_MAX_CHARS) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', `Правило: від 3 до ${AI_RULE_MAX_CHARS} символів`, 422)
    res.json({ data: (await addAiRule(req.user!.tenant_id, req.user!.id, parsed.data.text)).rules })
  } catch (err) { next(err) }
})
router.delete('/memory/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try { res.json({ data: (await deleteAiRule(req.user!.tenant_id, String(req.params.id))).rules }) } catch (err) { next(err) }
})

// GET /api/v1/ai/chat-result/:id — готова відповідь помічника, якщо зʼєднання обірвалось (24.11.2026).
// { data: null } — відповіді ще немає; читає лише той, хто питав.
router.get('/chat-result/:id', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const id = String(req.params.id)
    if (!isAiRequestId(id)) throw new AppError('VALIDATION_ERROR', 'Невірний номер запиту', 422)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await readAiReply(req.user!.tenant_id, req.user!.id, id) })
  } catch (err) { next(err) }
})

router.post('/chat', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  const storagePaths: string[] = []
  try {
    const parsed = chatSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    // «Запам'ятай: …», «Забудь правило 2», «Які правила?» — виконуються без запиту до ШІ (безкоштовно).
    const memory = !parsed.data.file_text && !(parsed.data.images ?? []).length ? parseMemoryCommand(parsed.data.message) : null
    if (memory) {
      const reply = await runMemoryCommand(req.user!.tenant_id, req.user!.id, req.user!.role, memory)
      const out = { reply, actions: [], usage: { prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 } }
      if (parsed.data.request_id) await saveAiReply(req.user!.tenant_id, req.user!.id, parsed.data.request_id, { data: out })
      res.json({ data: out })
      return
    }
    const images = []
    for (const image of parsed.data.images ?? []) {
      if ('data_base64' in image) {
        images.push(image)
        continue
      }
      storagePaths.push(image.storage_path)
      const uploaded = await downloadProcessingUpload({
        path: image.storage_path,
        userId: req.user!.id,
        purpose: 'ai',
        maxBytes: 6 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      })
      images.push({
        mime_type: uploaded.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
        data_base64: uploaded.buffer.toString('base64'),
      })
    }
    // 21.11.2026: клієнт може попросити хід роботи рядками NDJSON (X-AI-Progress: 1). Без заголовка — як раніше.
    const progress = req.get('x-ai-progress') === '1'
    const requestId = parsed.data.request_id
    if (progress) {
      res.status(200)
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders?.()
      res.write(JSON.stringify({ progress: { stage: 'start' } }) + '\n')
    }
    try {
      const out = await runChat(req.user!.tenant_id, req.user!.id, {
        message: parsed.data.message,
        history: parsed.data.history,
        fileText: parsed.data.file_text,
        images: images.length > 0 ? images : undefined,
        onProgress: progress ? event => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify({ progress: event }) + '\n') } : undefined,
        role: req.user!.role,
      })
      // Спершу зберегти, потім віддати: екран, що втратив зʼєднання (згорнутий браузер, інша вкладка), забере її сам.
      if (requestId) await saveAiReply(req.user!.tenant_id, req.user!.id, requestId, { data: out })
      if (requestId && parsed.data.chat_kind && !parsed.data.file_text && !(parsed.data.images ?? []).length) {
        await appendReplyToChat(req.user!.tenant_id, req.user!.id, parsed.data.chat_kind, requestId, parsed.data.message,
          { text: out.reply, actions: out.actions, cost: out.usage?.cost_usd ?? 0 }).catch(() => undefined)
      }
      if (progress) res.end(JSON.stringify({ data: out }) + '\n')
      else res.json({ data: out })
    } catch (error) {
      const appError = error instanceof AppError ? error : null
      const failure = {
        code: appError?.code ?? 'AI_UPSTREAM_UNAVAILABLE',
        message: appError?.message ?? 'ШІ тимчасово недоступний. Повторіть запит.',
        status: appError?.status ?? 503,
      }
      if (requestId) await saveAiReply(req.user!.tenant_id, req.user!.id, requestId, { error: failure })
      if (!progress) throw error
      res.end(JSON.stringify({ error: failure }) + '\n')
    }
  } catch (err) { next(err) }
  finally {
    await removeProcessingUploads(storagePaths, req.user!.id).catch(() => {})
  }
})

const optionalText = (max: number) => z.string().max(max).optional().nullable()
const optionalMoney = z.number().finite().min(0).max(100_000_000).optional()
const customerPayload = z.object({
  full_name: optionalText(200),
  phone: optionalText(30),
  email: optionalText(320),
  notes: optionalText(2000),
  vin: optionalText(50),
  car_make: optionalText(100),
  car_model: optionalText(100),
  car_year: z.number().int().min(1900).max(2100).optional().nullable(),
})
const productPayload = z.object({
  sku: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  description: optionalText(5000),
  retail_price_uah: optionalMoney,
  purchase_price_uah: optionalMoney,
  category_id: z.string().uuid().optional().nullable(),
  category_name: optionalText(200),
  brand_name: optionalText(200),
  oem_number: optionalText(100),
  barcode: optionalText(100),
  storage_bin: optionalText(100),
  qty_on_hand: z.number().finite().min(0).max(100_000_000).optional(),
})

const orderItemPayload = z.object({
  name: z.string().min(1).max(500),
  part_number: optionalText(100),
  qty: z.number().min(0.001).max(10000).optional(),
  sell_price_uah: optionalMoney.nullable(),
  buy_price_uah: optionalMoney.nullable(),
  arrived: z.boolean().optional(),
  note: optionalText(500),
})
const orderPayload = z.object({
  customer_name: optionalText(200),
  customer_phone: optionalText(40),
  car_make: optionalText(100),
  car_model: optionalText(100),
  car_year: z.number().int().min(1900).max(2100).optional().nullable(),
  vin: optionalText(50),
  plate: optionalText(20),
  comment: optionalText(2000),
  is_done: z.boolean().optional(),
  items: z.array(orderItemPayload).min(1).max(100),
  uncertain: z.array(z.string().max(100)).max(30).optional(),
})

const applySchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('create_order'), payload: orderPayload }),
  z.object({
    tool: z.literal('update_product'),
    payload: productPayload.partial().extend({ product_id: z.string().uuid() }),
  }),
  z.object({ tool: z.literal('create_product'), payload: productPayload }),
  z.object({ tool: z.literal('create_customer'), payload: customerPayload }),
  z.object({
    tool: z.literal('update_customer'),
    payload: customerPayload.partial().extend({ customer_id: z.string().uuid() }),
  }),
  z.object({
    tool: z.literal('create_category'),
    payload: z.object({ name: z.string().trim().min(1).max(200) }),
  }),
  z.object({
    tool: z.literal('create_customers_bulk'),
    payload: z.object({ customers: z.array(customerPayload).min(1).max(500) }),
  }),
  z.object({
    tool: z.literal('create_products_bulk'),
    payload: z.object({ products: z.array(productPayload).min(1).max(1500) }),
  }),
  z.object({
    tool: z.literal('create_categories_bulk'),
    payload: z.object({ names: z.array(z.string().trim().min(1).max(200)).min(1).max(500) }),
  }),
  z.object({
    tool: z.literal('update_products_bulk'),
    payload: z.object({
      updates: z.array(z.object({
        product_id: z.string().uuid(),
        new_name: z.string().trim().min(1).max(500).optional(),
        new_sku: optionalText(80),
        cleanup: z.boolean().optional(),
        category_name: optionalText(200),
      })).min(1).max(500),
    }),
  }),
  z.object({
    tool: z.literal('merge_products_bulk'),
    payload: z.object({
      merges: z.array(z.object({
        primary_product_id: z.string().uuid(),
        duplicate_product_id: z.string().uuid(),
      })).min(1).max(200),
    }),
  }),
])

// POST /api/v1/ai/apply-action — застосувати підтверджену пропозицію (тільки власник/адмін)
router.post('/apply-action', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = applySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const out = await applyAction(parsed.data, req.user!.id, req.user!.tenant_id)
    res.json({ data: out })
  } catch (err) { next(err) }
})

// ─── 26.11.2026: спільний чат помічника (той самий на телефоні й ПК) ─────────────────────────────────
const chatKind = (value: unknown) => value === 'invoice' ? 'invoice' as const : 'assistant' as const
router.get('/chat-state', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await readChat(req.user!.tenant_id, req.user!.id, chatKind(req.query.kind)) })
  } catch (err) { next(err) }
})
router.put('/chat-state', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    res.json({ data: await writeChat(req.user!.tenant_id, req.user!.id, chatKind(req.query.kind), req.body?.state) })
  } catch (err) { next(err) }
})

// 26.11.2026: підтверджена пачка змін товарів постачальників із чату (наша назва, категорія, «прибрати»).
router.post('/supplier-offers/apply', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const updates = z.object({ updates: z.array(z.record(z.unknown())).min(1).max(500) }).parse(req.body?.payload ?? {}).updates
    const { applySupplierOfferUpdates } = await import('../services/aiSupplierTools.js')
    res.json({ data: { result: await applySupplierOfferUpdates(req.user!.tenant_id, updates) } })
  } catch (err) { next(err) }
})

// ─── 26.11.2026: фонові задачі помічника (порядок у назвах, переклад) — власник і адміністратор ──────
const jobKeys = z.object({ keys: z.array(z.string().min(1).max(160)).min(1).max(5000) })
router.get('/jobs', requireRole('owner', 'admin'), async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await listJobs(req.user!.tenant_id) }) } catch (err) { next(err) }
})
router.post('/jobs', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = createJobSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані задачі', 422, parsed.error.flatten())
    res.json({ data: await createJob(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})
router.get('/jobs/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ data: await getJob(req.user!.tenant_id, z.string().uuid().parse(req.params.id)) }) } catch (err) { next(err) }
})
router.post('/jobs/:id/:action(start|pause|cancel)', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    res.json({ data: await changeJobStatus(req.user!.tenant_id, z.string().uuid().parse(req.params.id), req.params.action as 'start' | 'pause' | 'cancel') })
  } catch (err) { next(err) }
})
router.get('/jobs/:id/items', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await listJobItems(req.user!.tenant_id, z.string().uuid().parse(req.params.id), String(req.query.state ?? 'proposed'), Number(req.query.page) || 1, Number(req.query.per_page) || 100) })
  } catch (err) { next(err) }
})
router.post('/jobs/:id/items/:to(approve|reject)', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { keys } = jobKeys.parse(req.body)
    res.json({ data: { changed: await setItemsState(req.user!.tenant_id, z.string().uuid().parse(req.params.id), keys, req.params.to === 'approve' ? 'proposed' : 'rejected') } })
  } catch (err) { next(err) }
})
// Товари постачальника — записуються в хмарі сервером.
router.post('/jobs/:id/apply-offers', requireRole('owner', 'admin'), async (req, res, next) => {
  try { res.json({ data: { applied: await applyOfferItems(req.user!.tenant_id, z.string().uuid().parse(req.params.id)) } }) } catch (err) { next(err) }
})
// Наші товари — записує головний ПК; екран повідомляє серверу результат пачки.
router.post('/jobs/:id/applied', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const body = z.object({ applied: z.array(z.string().min(1).max(160)).max(5000), failed: z.array(z.object({ key: z.string().min(1).max(160), error: z.string().max(500) })).max(5000) }).parse(req.body)
    await markProductItems(req.user!.tenant_id, z.string().uuid().parse(req.params.id), body.applied, body.failed)
    res.json({ data: await getJob(req.user!.tenant_id, z.string().uuid().parse(req.params.id)) })
  } catch (err) { next(err) }
})

export default router
