import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { AppError } from './errorHandler.js'
import { logger } from '../lib/logger.js'

interface SupabaseJwtPayload {
  sub: string
  email?: string
  app_metadata?: {
    is_active?: boolean
    role?: string
    tenant_id?: string
  }
}

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
  let userPayload: { id: string; email: string; role: string; tenant_id?: string; is_active?: boolean } | null = null

  // 1. Спроба локальної валідації JWT підпису для прискорення запитів на 150-300мс
  const jwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET
  const tokenHeader = jwt.decode(token, { complete: true })?.header
  const usesSharedSecret = tokenHeader?.alg?.startsWith('HS') ?? false
  if (jwtSecret && usesSharedSecret) {
    try {
      const decoded = jwt.verify(token, jwtSecret) as SupabaseJwtPayload
      const trustedMeta = decoded.app_metadata
      if (trustedMeta?.tenant_id) {
        userPayload = {
          id: decoded.sub,
          email: decoded.email ?? '',
          role: trustedMeta.role ?? 'cashier',
          tenant_id: trustedMeta.tenant_id,
          is_active: trustedMeta.is_active,
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Local JWT verification failed, falling back to Supabase API')
    }
  }

  // 2. Фолбек на мережевий запит до Supabase Auth API, якщо секрет не задано або локальна валідація не пройшла
  if (!userPayload) {
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data.user) {
      return next(new AppError('UNAUTHORIZED', 'Недійсний токен', 401))
    }
    const meta = data.user.app_metadata ?? {}
    userPayload = {
      id: data.user.id,
      email: data.user.email ?? '',
      role: (meta.role as string) ?? 'cashier',
      tenant_id: meta.tenant_id as string | undefined,
      is_active: meta.is_active as boolean | undefined,
    }
  }

  if (userPayload.is_active === false) {
    return next(new AppError('FORBIDDEN', 'Акаунт заблоковано', 403))
  }

  const tenantId = userPayload.tenant_id
  if (!tenantId) {
    return next(new AppError('FORBIDDEN', 'Не вказано ідентифікатор магазину (tenant_id)', 403))
  }

  req.user = {
    id:        userPayload.id,
    email:     userPayload.email,
    role:      userPayload.role,
    tenant_id: tenantId,
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
