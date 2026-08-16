import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { supabaseAdmin } from '../db/supabaseAdmin.js'
import { AppError } from './errorHandler.js'
import { logger } from '../lib/logger.js'
import { acquireTenantMutationGuard, getTenantSyncGeneration } from '../services/syncGeneration.js'

interface SupabaseJwtPayload {
  sub: string
  email?: string
  iat?: number
  app_metadata?: {
    is_active?: boolean
    can_login?: boolean
    role?: string
    tenant_id?: string
  }
}

type AuthUserPayload = {
  id: string
  email: string
  role: string
  tenant_id?: string
  is_active?: boolean
  can_login?: boolean
  issued_at?: number
}

function requestPath(req: Request): string {
  const path = req.originalUrl.split('?', 1)[0]
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function isMutation(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

function usesOwnGenerationGuard(req: Request): boolean {
  const path = requestPath(req)
  return req.method === 'POST' && (path === '/api/v1/sync/push' || path === '/api/v1/sales')
}

function isResetRequest(req: Request): boolean {
  return req.method === 'POST' && requestPath(req) === '/api/v1/admin/reset-all-data'
}

async function loadRemoteUser(token: string): Promise<AuthUserPayload | null> {
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data.user) return null
  const meta = data.user.app_metadata ?? {}
  return {
    id: data.user.id,
    email: data.user.email ?? '',
    role: (meta.role as string) ?? 'cashier',
    tenant_id: meta.tenant_id as string | undefined,
    is_active: meta.is_active as boolean | undefined,
    can_login: meta.can_login as boolean | undefined,
  }
}

function tokenPredatesReset(issuedAt: number | undefined, resetAt: string | null): boolean {
  if (!resetAt) return false
  if (!Number.isFinite(issuedAt)) return true
  return Number(issuedAt) * 1000 <= Date.parse(resetAt)
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError('UNAUTHORIZED', 'Необхідна авторизація', 401))
  }

  const token = authHeader.slice(7)
  let userPayload: AuthUserPayload | null = null
  let locallyVerified = false

  const jwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET
  const tokenHeader = jwt.decode(token, { complete: true })?.header
  const usesSharedSecret = tokenHeader?.alg?.startsWith('HS') ?? false
  if (jwtSecret && usesSharedSecret) {
    try {
      const issuer = `${String(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')}/auth/v1`
      const decoded = jwt.verify(token, jwtSecret, {
        algorithms: ['HS256', 'HS384', 'HS512'],
        audience: 'authenticated',
        issuer,
      }) as SupabaseJwtPayload
      const trustedMeta = decoded.app_metadata
      if (trustedMeta?.tenant_id) {
        locallyVerified = true
        userPayload = {
          id: decoded.sub,
          email: decoded.email ?? '',
          role: trustedMeta.role ?? 'cashier',
          tenant_id: trustedMeta.tenant_id,
          is_active: trustedMeta.is_active,
          can_login: trustedMeta.can_login,
          issued_at: decoded.iat,
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Local JWT verification failed, falling back to Supabase API')
    }
  }

  if (!userPayload) {
    userPayload = await loadRemoteUser(token)
    if (!userPayload) return next(new AppError('UNAUTHORIZED', 'Недійсний токен', 401))
  }

  let tenantId = userPayload.tenant_id
  if (!tenantId) {
    return next(new AppError('FORBIDDEN', 'Не вказано ідентифікатор магазину (tenant_id)', 403))
  }

  // Після повного скидання локально перевірений старий JWT недостатній: Auth
  // перечитується примусово, тому видалений або заблокований працівник не може
  // продовжити роботу до завершення строку токена.
  if (locallyVerified) {
    try {
      const state = await getTenantSyncGeneration(tenantId)
      if (tokenPredatesReset(userPayload.issued_at, state.resetAt)) {
        const originalTenantId = tenantId
        const currentUser = await loadRemoteUser(token)
        if (!currentUser) return next(new AppError('UNAUTHORIZED', 'Сеанс завершено після скидання даних', 401))
        if (currentUser.tenant_id !== originalTenantId) {
          return next(new AppError('FORBIDDEN', 'Акаунт більше не належить цьому магазину', 403))
        }
        userPayload = currentUser
        tenantId = originalTenantId
      }
    } catch (error) {
      return next(error)
    }
  }

  if (userPayload.is_active === false) {
    return next(new AppError('FORBIDDEN', 'Акаунт заблоковано', 403))
  }
  if (userPayload.role === 'tire_worker' || userPayload.can_login === false) {
    return next(new AppError('FORBIDDEN', 'Цей працівник не має доступу до програми', 403))
  }

  req.user = {
    id: userPayload.id,
    email: userPayload.email,
    role: userPayload.role,
    tenant_id: tenantId,
  }

  if (isMutation(req.method) && !isResetRequest(req) && !usesOwnGenerationGuard(req)) {
    try {
      const releaseGuard = await acquireTenantMutationGuard(tenantId)
      let released = false
      const release = () => {
        if (released) return
        released = true
        void releaseGuard().catch((error) => logger.error({ error }, 'Failed to release tenant write guard'))
      }
      res.once('finish', release)
      res.once('close', release)
    } catch (error) {
      return next(error)
    }
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
