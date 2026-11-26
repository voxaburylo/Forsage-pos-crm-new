import type { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'
import { safeUnhandledErrorInfo } from '../lib/safeErrorInfo.js'
import { keepAlive } from '../lib/keepAlive.js'

/**
 * 23.11.2026 (план T3): неочікувана помилка сервера записується ще й у базу (адреса без параметрів і номерів,
 * технічний текст без особистих даних). Модуль бази підвантажується лише тут і лише коли помилка сталася:
 * запис ніколи не затримує відповідь і сам помилкою не стає.
 * 26.11.2026 (аудит): запис ішов «навздогін» відповіді, а Vercel після відповіді функцію зупиняє — у журнал не потрапило
 * нічого. Тепер платформа чекає на запис (keepAlive); і відмова з кодом 5xx, яку сервер віддав сам (AppError), теж записується.
 */
function rememberError(req: Request, status: number, code: string, err: unknown): void {
  keepAlive(import('../services/systemStatusService.js').then(service => service.recordServerError({
    tenantId: (req as Request & { user?: { tenant_id?: string } }).user?.tenant_id ?? null, source: 'request',
    route: service.safeRoute(req.method, req.originalUrl ?? req.url), status, code: String((err as { code?: unknown })?.code ?? code),
    message: err instanceof Error ? err.message : String(err),
  })))
}

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
  req: Request,
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
    // Свідома відмова 4xx (немає прав, не знайдено, перевірка) — не помилка сервера. 5xx — помилка: у журнал.
    if (err.status >= 500) rememberError(req, err.status, err.code, err)
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
  rememberError(req, 500, 'INTERNAL_ERROR', err)
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Внутрішня помилка сервера',
      status: 500,
    },
  })
}
