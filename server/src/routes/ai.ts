import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  getAiConfig, saveAiConfig, testKey, runChat, recognizeSupplyInvoicePhoto, applyAction, getUsageSummary,
  AI_MODELS,
} from '../services/aiService.js'
import { downloadProcessingUpload, removeProcessingUploads } from '../services/processingUploadService.js'

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

const chatSchema = z.object({
  message: z.string().min(1).max(20000),
  history: z.array(z.object({
    role: z.enum(['user', 'model']),
    text: z.string(),
  })).max(40).optional(),
  file_text: z.string().max(1_000_000).optional(),
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
  ])).max(4).optional(),
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
router.post('/chat', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  const storagePaths: string[] = []
  try {
    const parsed = chatSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
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
    const out = await runChat(req.user!.tenant_id, req.user!.id, {
      message: parsed.data.message,
      history: parsed.data.history,
      fileText: parsed.data.file_text,
      images: images.length > 0 ? images : undefined,
    })
    res.json({ data: out })
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

export default router
