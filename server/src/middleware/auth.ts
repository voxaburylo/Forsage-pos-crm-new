import type { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { AppError } from './errorHandler.js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
)

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

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    return next(new AppError('UNAUTHORIZED', 'Недійсний токен', 401))
  }

  req.user = {
    id: data.user.id,
    email: data.user.email ?? '',
    role: (data.user.user_metadata?.role as string) ?? 'cashier',
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
