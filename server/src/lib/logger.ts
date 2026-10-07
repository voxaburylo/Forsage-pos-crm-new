import pino from 'pino'
import { privateLogOptions, protectLoggerChildren } from './logSafety.js'

export const logger = protectLoggerChildren(pino({
  ...privateLogOptions,
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'phone', 'email', 'password', 'pin', 'token', 'access_token', 'refresh_token',
      'authorization', 'req.headers.authorization', 'payload.phone', 'payload.text',
      '*.password', '*.pin', '*.token', '*.access_token', '*.refresh_token',
    ],
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
}))
