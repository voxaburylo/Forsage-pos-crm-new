import Redis from 'ioredis'
import { logger } from './logger.js'

interface CacheEntry<V> {
  value: V
  expiresAt: number
}

export class SimpleCache<K, V> {
  private store = new Map<K, CacheEntry<V>>()
  private ttlMs: number
  private maxKeys: number
  private intervalId: NodeJS.Timeout | null = null
  private redisClient: Redis | null = null
  private namespace: string
  private isRedisHealthy = false

  constructor(ttlMs: number, maxKeys = 5000, namespace?: string) {
    this.ttlMs = ttlMs
    this.maxKeys = maxKeys
    this.namespace = namespace || `cache:${Math.random().toString(36).substring(2, 9)}`

    if (process.env.REDIS_URL) {
      try {
        this.redisClient = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        })
        this.redisClient.on('connect', () => {
          this.isRedisHealthy = true
          logger.info({ namespace: this.namespace }, 'Connected to Redis')
        })
        this.redisClient.on('error', (err) => {
          this.isRedisHealthy = false
          logger.warn({ err: err.message, namespace: this.namespace }, 'Redis connection error, falling back to in-memory')
        })
        this.redisClient.connect().catch(() => {
          this.isRedisHealthy = false
        })
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to initialize Redis client, falling back to in-memory')
      }
    }

    // Set interval for local memory cache cleaning
    this.intervalId = setInterval(() => this.sweepExpired(), 15 * 60 * 1000)
    if (this.intervalId && this.intervalId.unref) {
      this.intervalId.unref()
    }
  }

  private getRedisKey(key: K): string {
    return `${this.namespace}:${String(key)}`
  }

  async get(key: K): Promise<V | undefined> {
    if (this.redisClient && this.isRedisHealthy) {
      try {
        const raw = await this.redisClient.get(this.getRedisKey(key))
        if (raw) {
          return JSON.parse(raw) as V
        }
        return undefined
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Redis get error, falling back to in-memory')
      }
    }

    // In-memory fallback
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  async set(key: K, value: V): Promise<void> {
    if (this.redisClient && this.isRedisHealthy) {
      try {
        await this.redisClient.set(
          this.getRedisKey(key),
          JSON.stringify(value),
          'PX',
          this.ttlMs
        )
        return
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Redis set error, falling back to in-memory')
      }
    }

    // In-memory fallback
    if (this.store.size >= this.maxKeys && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
      }
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  async delete(key: K): Promise<void> {
    if (this.redisClient && this.isRedisHealthy) {
      try {
        await this.redisClient.del(this.getRedisKey(key))
        return
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Redis delete error, falling back to in-memory')
      }
    }
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    if (this.redisClient && this.isRedisHealthy) {
      try {
        const keys = await this.redisClient.keys(`${this.namespace}:*`)
        if (keys.length > 0) {
          await this.redisClient.del(...keys)
        }
        return
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Redis clear error, falling back to in-memory')
      }
    }
    this.store.clear()
  }

  async invalidateWhere(predicate: (key: K) => boolean): Promise<void> {
    if (this.redisClient && this.isRedisHealthy) {
      try {
        const keys = await this.redisClient.keys(`${this.namespace}:*`)
        const keysToDelete: string[] = []
        for (const k of keys) {
          const originalStr = k.substring(this.namespace.length + 1)
          if (predicate(originalStr as unknown as K)) {
            keysToDelete.push(k)
          }
        }
        if (keysToDelete.length > 0) {
          await this.redisClient.del(...keysToDelete)
        }
        return
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Redis invalidateWhere error, falling back to in-memory')
      }
    }

    for (const key of this.store.keys()) {
      if (predicate(key)) this.store.delete(key)
    }
  }

  destroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
    }
    if (this.redisClient) {
      this.redisClient.disconnect()
    }
  }

  private sweepExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key)
      }
    }
  }
}
