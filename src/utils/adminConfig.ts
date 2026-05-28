import type { createClient } from 'redis'
import RedisClient from './redis'
import logger from './logger'

// Self-hosted admin-config sync. Gated entirely by ADMIN_CONFIG_ENABLED:
// in cloud builds (flag absent) every export is a hard no-op — no Redis
// subscriber opened, no timers scheduled, no log lines emitted. Cloud
// behavior is byte-identical to today.
//
// Mirrors exchange-connector-sh/src/utils/adminConfig.ts and app-sh/src/
// utils/adminConfig.ts (same Redis contract, same flag).
//
// Specific to this repo: an `onChange(prev, next)` callback lets callers
// (priceConnector, userStream) diff old vs new and spawn/terminate
// workers + drop in-flight WS subscriptions accordingly.

const ENABLED =
  process.env.ADMIN_CONFIG_ENABLED === 'true' ||
  process.env.ADMIN_CONFIG_ENABLED === '1'

const KEY = 'gainium:admin:enabled_exchanges'
const CHANNEL = 'gainium:admin:config'
const REFRESH_MS = Number(process.env.ADMIN_CONFIG_REFRESH_MS ?? '10000')

let cache: Set<string> | null = null
let initialized = false
let started = false

type RedisClientLike = ReturnType<typeof createClient>

export function isAdminConfigEnabled(): boolean {
  return ENABLED
}

/**
 * Synchronous check used everywhere we route per-exchange. Always returns
 * true in cloud builds AND before the first refresh completes so we don't
 * spuriously reject in-flight work during boot.
 */
export function isExchangeEnabled(exchange: string): boolean {
  if (!ENABLED) return true
  if (!initialized || cache === null) return true
  return cache.has(exchange)
}

/**
 * Snapshot of the current enabled set. `null` means key absent ⇒ all
 * enabled. Used by callers that need to compute a diff (e.g. the
 * websocket worker map) on a delayed render path.
 */
export function getEnabledSnapshot(): Set<string> | null {
  if (!ENABLED) return null
  return cache ? new Set(cache) : null
}

function parseRaw(raw: string | null | undefined): Set<string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return null
  }
}

function setEquals(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export type AdminConfigChangeListener = (
  prev: Set<string> | null,
  next: Set<string> | null,
) => void | Promise<void>

const listeners = new Set<AdminConfigChangeListener>()

/**
 * Subscribe to enabled-set changes. The callback is invoked AFTER cache
 * updates so synchronous calls to isExchangeEnabled inside the callback
 * already see the new state. Returns an unsubscribe function.
 */
export function onAdminConfigChange(cb: AdminConfigChangeListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * One-shot bootstrap. Idempotent: calling twice is a no-op. Reads the
 * current key, subscribes to gainium:admin:config pubsub, and starts a
 * 10s periodic refresh. Failures are logged but never thrown — boot
 * shouldn't abort if Redis is briefly unreachable.
 */
export async function startAdminConfigSync(): Promise<void> {
  if (!ENABLED || started) return
  started = true

  const redis = RedisClient.getInstance() as RedisClientLike

  const refresh = async () => {
    try {
      const raw = await redis.get(KEY)
      const next = parseRaw(raw)
      const prev = cache
      cache = next
      initialized = true
      if (!setEquals(prev, next)) {
        logger.info(
          `admin-config changed: ${
            next ? Array.from(next).sort().join(',') : '(all)'
          }`,
        )
        for (const cb of listeners) {
          try {
            await cb(prev, next)
          } catch (err) {
            logger.error(`admin-config onChange threw: ${err}`)
          }
        }
      }
    } catch (err) {
      logger.warn(`admin-config refresh failed: ${err}`)
    }
  }

  await refresh()

  // Pubsub subscriber. node-redis v4 requires a dedicated client for
  // subscription mode — duplicate the existing connection so we share
  // socket options + reconnect strategy.
  try {
    const sub = redis.duplicate()
    sub.on('error', (err) => logger.error(`admin-config sub error: ${err}`))
    await sub.connect()
    await sub.subscribe(CHANNEL, () => {
      void refresh()
    })
  } catch (err) {
    logger.warn(`admin-config subscribe failed: ${err}`)
  }

  // Safety net for dropped pubsub messages (Redis restart, transient
  // network drop). Idempotent — only fires listeners when the set
  // actually changed.
  setInterval(() => {
    void refresh()
  }, REFRESH_MS).unref()
}
