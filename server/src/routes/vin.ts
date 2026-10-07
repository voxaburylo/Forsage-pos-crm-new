import { Router } from 'express'
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { getSettings } from '../services/adminService.js'
import { withAiDataBoundary } from '../services/aiPromptSafety.js'
import { aiResponseCompletionError, safeAiErrorInfo } from '../services/aiResponseSafety.js'
import { withAiExecutionBudget } from '../services/aiExecutionBudget.js'
import { VEHICLE_OCR_INSTRUCTION, vehicleOcrInput, inlineVehiclePhoto, parseVehicleOcr } from '../services/vehicleOcr.js'
import { logger } from '../lib/logger.js'

import { downloadProcessingUpload, removeProcessingUploads } from '../services/processingUploadService.js'
const router = Router()
router.use(requireAuth)

// Gemini для розпізнавання VIN з фото (ліниво ініціалізуємо)
let geminiModel: GenerativeModel | null = null
function gemini() {
  const key = process.env.GEMINI_API_KEY
  if (!geminiModel && key) {
    geminiModel = new GoogleGenerativeAI(key).getGenerativeModel({
      model: 'gemini-2.5-flash', systemInstruction: withAiDataBoundary(VEHICLE_OCR_INSTRUCTION),
      generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' },
    })
  }
  return geminiModel
}

// Best-effort витяг марки/моделі/року з різних форматів відповіді декодера
function findKey(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === key.toLowerCase() && obj[k]) return obj[k]
  }
  return undefined
}

function extractVehicle(data: any): { make: string; model: string; year: string } {
  // NHTSA-подібний формат: { Results: [{ Variable, Value }] }
  if (Array.isArray(data?.Results)) {
    const get = (name: string) => data.Results.find((x: any) => x.Variable === name)?.Value ?? ''
    return { make: get('Make') || '', model: get('Model') || '', year: get('Model Year') || '' }
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) { const v = findKey(data, k); if (v) return String(v) }
    return ''
  }
  return {
    make: pick('make', 'brand', 'manufacturer'),
    model: pick('model'),
    year: pick('year', 'modelYear', 'model_year'),
  }
}

// GET /api/v1/vin/decode?vin=XXXX — декодування VIN через зовнішній API,
// налаштований у shop_settings (vin_decoder_url / vin_decoder_api_key).
router.get('/decode', async (req, res, next) => {
  try {
    const vin = String(req.query.vin ?? '').trim().toUpperCase()
    if (vin.length < 11) throw new AppError('INVALID_VIN', 'Вкажіть коректний VIN (мінімум 11 символів)', 400)

    const settings = (await getSettings(req.user!.tenant_id)) as any
    const url = (settings.vin_decoder_url ?? '').trim()
    if (!url) {
      throw new AppError('VIN_DECODER_NOT_CONFIGURED', 'VIN-декодер не налаштовано. Додайте URL у Налаштуваннях.', 422)
    }
    const key = (settings.vin_decoder_api_key ?? '').trim()

    // VIN підставляємо у шаблон {vin} або додаємо в кінець URL
    const target = url.includes('{vin}') ? url.replace('{vin}', encodeURIComponent(vin)) : url + encodeURIComponent(vin)
    const resp = await fetch(target, {
      headers: key ? { Authorization: `Bearer ${key}`, 'X-API-Key': key } : {},
    })
    if (!resp.ok) throw new AppError('VIN_DECODER_ERROR', `Сервіс декодера повернув ${resp.status}`, 502)

    const data: any = await resp.json().catch(() => ({}))
    res.json({ data: { vin, ...extractVehicle(data) } })
  } catch (err) { next(err) }
})

// POST /api/v1/vin/ocr — private upload or bounded legacy base64, no database writes.
router.post('/ocr', async (req, res, next) => {
  let storagePath: string | null = null
  try {
    const parsed = vehicleOcrInput.safeParse(req.body)
    if (!parsed.success) throw new AppError('INVALID_OCR_IMAGE', 'Невірні дані фото. Передайте одне зображення JPG, PNG або WebP.', 422)
    const input = parsed.data
    const inline = 'image' in input ? inlineVehiclePhoto(input.image, input.mimeType) : null
    if ('storage_path' in input) storagePath = input.storage_path
    const vehicle = await withAiExecutionBudget(90_000, async budget => {
      const model = gemini()
      if (!model) throw new AppError('OCR_NOT_AVAILABLE', 'Розпізнавання недоступне (не налаштовано GEMINI_API_KEY)', 503)
      let photo = inline!
      if (storagePath) {
        const uploaded = await budget.run(() => downloadProcessingUpload({
          path: storagePath!, userId: req.user!.id, purpose: 'vin',
          maxBytes: 6 * 1024 * 1024,
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        }))
        photo = { data: uploaded.buffer.toString('base64'), mimeType: uploaded.mimeType }
      }
      const result = await budget.run(signal => model.generateContent([
        { inlineData: photo }, { text: 'Розпізнай лише дані автомобіля з цього фото.' },
      ], { timeout: 90_000, signal }))
      const incomplete = aiResponseCompletionError(result.response)
      if (incomplete) throw incomplete
      return parseVehicleOcr(result.response.text())
    })
    if (!vehicle.vin && !vehicle.make && !vehicle.model && !vehicle.year) {
      throw new AppError('VEHICLE_NOT_FOUND', 'Не вдалося розпізнати VIN або дані автомобіля. Спробуйте чіткіше фото.', 422)
    }
    res.json({ data: vehicle })
  } catch (err) {
    if (err instanceof AppError) next(err)
    else {
      logger.warn(safeAiErrorInfo(err), '[vin] photo recognition failed')
      next(new AppError('OCR_FAILED', 'Не вдалося отримати відповідь розпізнавання авто. Нічого не збережено; повторіть спробу.', 502))
    }
  } finally {
    if (storagePath) await removeProcessingUploads([storagePath], req.user!.id).catch(() => {})
  }
})

export default router
