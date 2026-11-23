import { z } from 'zod'
import { AppError } from '../middleware/errorHandler.js'
import { pushLocalOperations } from './syncService.js'

/**
 * 23.11.2026: зміни каси, надіслані ключем самого головного ПК (а не сесією того, хто увійшов у програму).
 *
 * Чому права «власника»: головний ПК — єдине джерело даних; право на кожну дію вже перевірила каса, коли її
 * виконувала (роль працівника на касі чи у вебі). Серверу лишається прийняти документ у копію. Інакше правка
 * власника з вебу чекала, доки власник сам увійде в програму на касі: бот «не прив'язувався», PIN не доходив.
 * Ключ ПК зберігається в захищеному сховищі Windows; видає його власник чи адміністратор.
 */
export const devicePushSchema = z.object({
  reset_generation: z.number().int().nonnegative().optional().default(0),
  operations: z.array(z.object({
    sequence: z.number().int().positive(),
    operation_id: z.string().min(1),
    tenant_id: z.string().uuid(),
    device_id: z.string().min(1),
    aggregate_type: z.string().min(1),
    aggregate_id: z.string().min(1),
    operation_type: z.string().min(1),
    payload: z.any(),
    created_at: z.string().datetime({ offset: true }),
  })).max(100),
})

export async function pushFromMainPc(
  device: { tenant_id: string; device_id: string; created_by: string | null },
  body: z.infer<typeof devicePushSchema>,
  push: typeof pushLocalOperations = pushLocalOperations,
) {
  // Ключ ПК несе лише документи цього ПК: чужий пристрій чи чужий магазин під ним не пройде.
  for (const operation of body.operations) {
    if (operation.device_id.toLowerCase() !== device.device_id.toLowerCase()) {
      throw new AppError('SYNC_DEVICE_MISMATCH', 'Документ належить іншому пристрою', 403)
    }
  }
  if (!device.created_by) throw new AppError('TILL_DEVICE_UNAUTHORIZED', 'Ключ звʼязку каси видано без автора. Увійдіть на касі власником — ключ оновиться.', 401)
  return push({
    tenantId: device.tenant_id,
    userId: device.created_by,
    role: 'owner',
    resetGeneration: body.reset_generation,
    operations: body.operations.map(operation => ({ ...operation, payload: operation.payload ?? {} })),
  })
}
