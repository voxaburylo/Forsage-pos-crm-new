import { AppError } from '../middleware/errorHandler.js'

/**
 * 24.11.2026 (власник: «прибери пароль у ШІ-помічнику»): помічник на головному ПК працює ключем самого ПК.
 * Працівник входить на касі локальним паролем чи PIN — серверної сесії в нього немає, і помічник просив ще один
 * пароль. Тепер каса, яка вже перевірила працівника, передає запит помічника своїм ключем і називає його роль.
 * Дії на сервері записуються на користувача, що видав ключ ПК (власник). Ключ ШІ та його перевірка сюди не входять:
 * їх змінює лише власник зі своїм входом.
 */
const ASSISTANT_ROLES = new Set(['owner', 'admin', 'manager', 'cashier'])
/** Адреси помічника (відносно /ai), закриті для ключа ПК. */
export const DEVICE_AI_DENIED = new Set(['/config', '/test'])

export function assistantActor(device: { tenant_id: string; created_by: string | null }, claimedRole: unknown): { id: string; email: string; role: string; tenant_id: string } {
  if (!device.created_by) throw new AppError('TILL_DEVICE_UNAUTHORIZED', 'Ключ звʼязку каси видано без автора. Увійдіть на касі власником — ключ оновиться.', 401)
  const role = String(claimedRole ?? '')
  if (!ASSISTANT_ROLES.has(role)) throw new AppError('FORBIDDEN', 'Помічник доступний власнику, адміністратору, менеджеру й касиру', 403)
  return { id: device.created_by, email: '', role, tenant_id: device.tenant_id }
}
