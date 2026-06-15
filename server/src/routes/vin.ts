import { Router } from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { getSettings } from '../services/adminService.js'

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
  try {
    const { image, mimeType } = req.body ?? {}
    if (!image) throw new AppError('NO_IMAGE', 'Не передано зображення', 400)
    const model = gemini()
    if (!model) throw new AppError('OCR_NOT_AVAILABLE', 'Розпізнавання недоступне (не налаштовано GEMINI_API_KEY)', 503)

    const base64 = String(image).replace(/^data:[^;]+;base64,/, '')
    const prompt = 'Ти — експерт з автомобілів. На фото — VIN-код або документ на авто. Знайди 17-символьний VIN. Поверни ТІЛЬКИ сам VIN великими літерами без пробілів і розділювачів. Якщо VIN не видно — поверни NONE.'
    const result = await model.generateContent([
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
      { text: prompt },
    ])
    const raw = (result?.response?.text?.() ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    const vin = raw === 'NONE' || raw.length < 11 ? null : raw.slice(0, 17)
    if (!vin) throw new AppError('VIN_NOT_FOUND', 'VIN не розпізнано на фото. Спробуйте чіткіше фото.', 422)
    res.json({ data: { vin } })
  } catch (err) { next(err) }
})

export default router
