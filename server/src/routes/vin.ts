import { Router } from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { getSettings } from '../services/adminService.js'

import { downloadProcessingUpload, removeProcessingUploads } from '../services/processingUploadService.js'
const router = Router()
router.use(requireAuth)

// Gemini для розпізнавання VIN з фото (ліниво ініціалізуємо)
let geminiModel: any = null
function gemini() {
  const key = process.env.GEMINI_API_KEY
  if (!geminiModel && key) {
    geminiModel = new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.5-flash' })
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


type VehicleOcrData = {
  document_type: 'vin' | 'registration_certificate' | 'other'
  vin: string | null
  make: string | null
  model: string | null
  year: number | null
  registration_number: string | null
}

function cleanOcrText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, maxLength) : null
}

function parseVehicleOcr(raw: string): VehicleOcrData {
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    const vinMatch = raw.toUpperCase().match(/[A-HJ-NPR-Z0-9]{17}/)
    parsed = { vin: vinMatch?.[0] ?? null }
  }

  const vinCandidate = String(parsed.vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const vin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vinCandidate) ? vinCandidate : null
  const numericYear = Number(parsed.year)
  const maxYear = new Date().getFullYear() + 1
  const year = Number.isInteger(numericYear) && numericYear >= 1900 && numericYear <= maxYear ? numericYear : null
  const documentType = parsed.document_type === 'registration_certificate'
    ? 'registration_certificate'
    : parsed.document_type === 'vin' ? 'vin' : 'other'

  return {
    document_type: documentType,
    vin,
    make: cleanOcrText(parsed.make, 100),
    model: cleanOcrText(parsed.model, 150),
    year,
    registration_number: cleanOcrText(parsed.registration_number, 30)?.toUpperCase() ?? null,
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

// POST /api/v1/vin/ocr — розпізнавання VIN з фото (base64) через Gemini
router.post('/ocr', async (req, res, next) => {
  const storagePath = typeof req.body?.storage_path === 'string' ? req.body.storage_path : null
  try {
    const { image, mimeType } = req.body ?? {}
    if (!image && !storagePath) throw new AppError('NO_IMAGE', 'Не передано зображення', 400)
    const model = gemini()
    if (!model) throw new AppError('OCR_NOT_AVAILABLE', 'Розпізнавання недоступне (не налаштовано GEMINI_API_KEY)', 503)

    let base64: string
    let resolvedMimeType = mimeType || 'image/jpeg'
    if (storagePath) {
      const uploaded = await downloadProcessingUpload({
        path: storagePath,
        userId: req.user!.id,
        purpose: 'vin',
        maxBytes: 6 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      })
      base64 = uploaded.buffer.toString('base64')
      resolvedMimeType = uploaded.mimeType
    } else {
      base64 = String(image).replace(/^data:[^;]+;base64,/, '')
    }
    const prompt = `Ти розпізнаєш дані автомобіля з фото VIN-коду або свідоцтва про реєстрацію (техпаспорта).
Поверни ТІЛЬКИ валідний JSON без markdown:
{"document_type":"vin|registration_certificate|other","vin":null,"make":null,"model":null,"year":null,"registration_number":null}
Правила:
- використовуй лише чітко видимі на фото дані, нічого не вигадуй;
- VIN має рівно 17 символів A-H, J-N, P, R-Z та 0-9, без I, O, Q;
- make — марка/виробник, model — модель, year — чотиризначний рік випуску;
- registration_number — державний номер автомобіля;
- для невідомого або нерозбірливого поля повертай null.`
    const result = await model.generateContent([
      { inlineData: { mimeType: resolvedMimeType, data: base64 } },
      { text: prompt },
    ])
    const raw = result?.response?.text?.() ?? ''
    const vehicle = parseVehicleOcr(raw)
    if (!vehicle.vin && !vehicle.make && !vehicle.model && !vehicle.year) {
      throw new AppError('VEHICLE_NOT_FOUND', 'Не вдалося розпізнати VIN або дані автомобіля. Спробуйте чіткіше фото.', 422)
    }
    res.json({ data: vehicle })
  } catch (err) { next(err) }
  finally {
    if (storagePath) await removeProcessingUploads([storagePath], req.user!.id).catch(() => {})
  }
})

export default router
