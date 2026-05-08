import type { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { AppError } from './errorHandler.js'

// MVP: один магазин — фіксований tenant_id
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
