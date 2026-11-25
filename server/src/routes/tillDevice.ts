import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { authenticateTillDevice, parseDeviceAuthorization, registerTillDevice } from '../services/tillDeviceService.js'
import { tillBeat } from '../services/tillLinkService.js'
import { claimRpc, finishRpc, rpcResultSchema } from '../services/tillRpcService.js'
import { exportServerOnlyData } from '../services/serverDataExport.js'
import { devicePushSchema, pushFromMainPc } from '../services/tillDevicePush.js'
import { saveStatusReport } from '../services/systemStatusService.js'
import { storeProcessingUpload } from '../services/processingUploadService.js'
import { assistantActor, DEVICE_AI_DENIED } from '../services/tillAssistantActor.js'
import { siteAdminRouter } from './site.js'
import { supplierApiRouter, supplierOffersRouter } from './supplierApi.js'
import { callSiteGateway } from '../services/siteGatewayService.js'
import { linkedOfferPhotos } from '../services/supplierApiService.js'
import aiRouter from './ai.js'
import vinRouter from './vin.js'

/**
 * Зв'язок головного ПК власним ключем (див. tillDeviceService): програма забирає запити вебу й тоді,
 * коли в ній ніхто не увійшов. Ті самі дії, що й /till-link/beat та /till-rpc/claim|result, але пристрій
 * упізнається за ключем, а не за сесією працівника. Усі адреси — лише з програми на касі
 * (заголовок каси перевіряє localFirstWriteGuard).
 */
export const tillDeviceRouter = Router()

// Власник чи адміністратор, увійшовши на головному ПК, видає ПК ключ зв'язку (повторно — заміняє старий).
tillDeviceRouter.post('/register', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await registerTillDevice(req.user!.tenant_id, req.user!.id, String(req.body?.device_id ?? '')) })
  } catch (err) { next(err) }
})

interface DeviceRequest extends Request { tillDevice?: { tenant_id: string; device_id: string; created_by: string | null } }

async function requireTillDevice(req: DeviceRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const credentials = parseDeviceAuthorization(req.get('authorization'))
    const device = credentials ? await authenticateTillDevice(credentials.deviceId, credentials.token) : null
    if (!device) throw new AppError('TILL_DEVICE_UNAUTHORIZED', 'Ключ зв\'язку каси не прийнято', 401)
    req.tillDevice = device
    next()
  } catch (err) { next(err) }
}

tillDeviceRouter.post('/beat', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    // 23.11.2026 (план T2): раз на кілька хвилин каса додає відомості про себе для екрана «Стан системи».
    // Окремо й без права зупинити зв'язок: це довідка для власника.
    if (req.body?.status) void saveStatusReport(req.tillDevice!.tenant_id, req.body.status).catch(() => undefined)
    res.json({ data: await tillBeat(req.tillDevice!.tenant_id, req.tillDevice!.device_id, req.body?.outbox) })
  } catch (err) { next(err) }
})

tillDeviceRouter.post('/rpc/claim', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try { res.json({ data: await claimRpc(req.tillDevice!.tenant_id, req.tillDevice!.device_id) }) } catch (err) { next(err) }
})

tillDeviceRouter.post('/rpc/:id/result', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try {
    const parsed = rpcResultSchema.safeParse(req.body?.outcome)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректна відповідь каси', 422)
    res.json({ data: await finishRpc(req.tillDevice!.tenant_id, req.tillDevice!.device_id, String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
})

// 23.11.2026: зміни каси приходять ключем самого головного ПК — і коли в програмі касир, і коли вона працює у фоні.
// Раніше відправку робило лише вікно програми сесією того, хто увійшов: правка власника з вебу застрягала («Недостатньо прав»).
tillDeviceRouter.post('/sync/push', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const parsed = devicePushSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректний пакет синхронізації', 400)
    res.json({ data: await pushFromMainPc(req.tillDevice!, parsed.data) })
  } catch (err) { next(err) }
})

// Дані, що живуть лише в хмарі: головний ПК раз на добу забирає їх у власну базу (без ключів і паролів служб).
tillDeviceRouter.post('/server-data', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await exportServerOnlyData(req.tillDevice!.tenant_id) })
  } catch (err) { next(err) }
})

/**
 * 24.11.2026 (власник: «прибери пароль у ШІ-помічнику»): помічник на головному ПК працює ключем самого ПК.
 * Працівник входить на касі локальним паролем чи PIN — серверної сесії в нього немає, і помічник просив ще один
 * пароль. Тепер каса, яка вже перевірила працівника, передає запит помічника своїм ключем і називає його роль.
 * Дії на сервері записуються на користувача, що видав ключ ПК (власник). Ключ ШІ та його перевірка сюди не входять:
 * їх змінює лише власник зі своїм входом.
 */
// Хто діє й що закрито — services/tillAssistantActor.ts.

function actAsTillStaff(req: DeviceRequest, _res: Response, next: NextFunction): void {
  try {
    req.tillDeviceActor = assistantActor(req.tillDevice!, req.get('x-forsage-staff-role'))
    next()
  } catch (err) { next(err) }
}

tillDeviceRouter.post('/assistant-upload', requireTillDevice, actAsTillStaff, async (req: DeviceRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const purpose = req.body?.purpose === 'vin' ? 'vin' : req.body?.purpose === 'ai' ? 'ai' : null
    const encoded = typeof req.body?.data_base64 === 'string' ? req.body.data_base64 : ''
    if (!purpose || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new AppError('VALIDATION_ERROR', 'Некоректне вкладення', 422)
    res.json({ data: await storeProcessingUpload({ userId: req.tillDeviceActor!.id, purpose, mimeType: String(req.body?.mime_type ?? '').toLowerCase(), buffer: Buffer.from(encoded, 'base64') }) })
  } catch (err) { next(err) }
})

tillDeviceRouter.use('/ai', requireTillDevice, actAsTillStaff, (req, _res, next) => {
  if (DEVICE_AI_DENIED.has(req.path)) return next(new AppError('FORBIDDEN', 'Ключ ШІ змінює лише власник зі своїм входом', 403))
  next()
}, aiRouter)
tillDeviceRouter.use('/vin', requireTillDevice, actAsTillStaff, vinRouter)
// 24.11.2026 (доповнення 3): фото, які сайт знайшов сам. Забирає їх головний ПК своїм ключем — раз на годину й кнопкою;
// працівник для цього не потрібен. Сервер лише передає список від шлюзу сайту, у базу нічого не пише.
tillDeviceRouter.get('/site-photos', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since).toISOString() : undefined
    res.json({ data: await callSiteGateway('photos.auto_list', { ...(since ? { since } : {}), limit: 200 }) })
  } catch (err) { next(err) }
})
// 24.11.2026: фото постачальника (Омега) для НАШИХ карток, що збіглися з його товарами. Головний ПК ставить їх у картки без фото.
tillDeviceRouter.get('/supplier-photos', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since).toISOString() : null
    res.json({ data: await linkedOfferPhotos(req.tillDevice!.tenant_id, since) })
  } catch (err) { next(err) }
})
// 25.11.2026: кроси й OE-номери постачальника для НАШИХ карток — головний ПК пише їх у крос-номери карток (джерело «omega»).
tillDeviceRouter.get('/supplier-crosses', requireTillDevice, async (req: DeviceRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since).toISOString() : null
    const { linkedOfferCrossNumbers } = await import('../services/supplierCrosses.js')
    res.json({ data: await linkedOfferCrossNumbers(req.tillDevice!.tenant_id, since) })
  } catch (err) { next(err) }
})
// 24.11.2026: розділ «Сайт» на головному ПК — тим самим ключем; пускає лише власника (requireRole у самому розділі).
tillDeviceRouter.use('/site-admin', requireTillDevice, actAsTillStaff, siteAdminRouter)
// 24.11.2026: товари постачальників під замовлення — на головному ПК тим самим ключем.
tillDeviceRouter.use('/supplier-offers', requireTillDevice, actAsTillStaff, supplierOffersRouter)
tillDeviceRouter.use('/supplier-api', requireTillDevice, actAsTillStaff, supplierApiRouter)
