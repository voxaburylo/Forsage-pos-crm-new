import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { authenticateTillDevice, parseDeviceAuthorization, registerTillDevice } from '../services/tillDeviceService.js'
import { tillBeat } from '../services/tillLinkService.js'
import { claimRpc, finishRpc, rpcResultSchema } from '../services/tillRpcService.js'
import { exportServerOnlyData } from '../services/serverDataExport.js'
import { devicePushSchema, pushFromMainPc } from '../services/tillDevicePush.js'
import { saveStatusReport } from '../services/systemStatusService.js'

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
