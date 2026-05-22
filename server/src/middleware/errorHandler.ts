import type { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'

export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        status: err.status,
        ...(err.details ? { details: err.details } : {}),
      },
    })
    return
  }

  // Визначаємо тип помилки для кращої діагностики
  const errMsg = err instanceof Error ? err.message : String(err)

  // Supabase / мережева недоступність
  const isNetworkErr = errMsg.includes('fetch failed') || errMsg.includes('ENOTFOUND')
    || errMsg.includes('ECONNREFUSED') || errMsg.includes('network')
  if (isNetworkErr) {
    logger.error({ error: errMsg }, 'Supabase / DB недоступний')
    res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'База даних недоступна. Перевірте статус Supabase проекту.', status: 503 },
    })
    return
  }

  logger.error(err, 'Unhandled error')
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Внутрішня помилка сервера',
      status: 500,
    },
  })
}
