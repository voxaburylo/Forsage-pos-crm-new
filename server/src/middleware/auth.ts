import type { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { AppError } from './errorHandler.js'

/**
 * MVP_TENANT_ID — фіксований ідентифікатор єдиного магазину в режимі MVP.
 *
 * Призначення:
 *   - Усі дані (товари, продажі, клієнти) прив'язані до tenant_id.
 *   - У межах одного магазину поле в JWT user_metadata.tenant_id може бути відсутнім —
 *     тоді цей константний fallback гарантує, що дані не «загубляться».
 *
 * РИЗИК БЕЗПЕКИ:
 *   Якщо в системі з'явиться другий магазин, цей fallback створює загрозу
 *   витоку даних: користувач без tenant_id у JWT отримає доступ до даних магазину #1.
 *
 * Умови видалення fallback (перед запуском мультитенантності):
 *   1. Усі активні користувачі мають tenant_id у user_metadata
 *      (перевірити: SELECT id FROM auth.users WHERE raw_user_meta_data->>'tenant_id' IS NULL).
 *   2. Seed/міграційні скрипти автоматично присвоюють tenant_id новим користувачам.
 *   3. Тут — замість fallback кидати AppError('NO_TENANT', 403).
 *
 * План мультитенантності — див. [[project_forsage_crm]] в auto-memory або ARCHITECT_PLAN.md.
 */
const MVP_TENANT_ID = '00000000-0000-0000-0000-000000000001'

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError('UNAUTHORIZED', 'Необхідна авторизація', 401))
  }

  const token = authHeader.slice(7)

  // Використовуємо єдиний shared admin клієнт (не створюємо новий для кожного запиту)
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data.user) {
    return next(new AppError('UNAUTHORIZED', 'Недійсний токен', 401))
  }

  const meta = data.user.user_metadata ?? {}

  // Перевіряємо чи користувач активний
  if (meta.is_active === false) {
    return next(new AppError('FORBIDDEN', 'Акаунт заблоковано', 403))
  }

  req.user = {
    id:        data.user.id,
    email:     data.user.email ?? '',
    role:      (meta.role as string) ?? 'cashier',
    tenant_id: (meta.tenant_id as string) ?? MVP_TENANT_ID,
  }

  next()
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('UNAUTHORIZED', 'Необхідна авторизація', 401))
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError('FORBIDDEN', 'Недостатньо прав доступу', 403))
    }
    next()
  }
}
