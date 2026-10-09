import type { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'
import { safeUnhandledErrorInfo } from '../lib/safeErrorInfo.js'

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
  // A failed stream is not a successful partial JSON response. Never append an
  // error envelope or try to replace headers after bytes have already been sent.
  if (res.headersSent || res.destroyed) {
    logger.error(safeUnhandledErrorInfo(err), 'Response interrupted')
    if (!res.destroyed) res.destroy()
    return
  }
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

  const diagnostic = safeUnhandledErrorInfo(err)

  if (diagnostic.category === 'network') {
    logger.error(diagnostic, 'Supabase / DB недоступний')
    res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'База даних недоступна. Перевірте статус Supabase проекту.', status: 503 },
    })
    return
  }

  logger.error(diagnostic, 'Unhandled error')
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Внутрішня помилка сервера',
      status: 500,
    },
  })
}
