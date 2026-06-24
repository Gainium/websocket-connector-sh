import RedisClient from './redis'
import Rabbit from './rabbit'
import logger from './logger'
import { IdMute, IdMutex } from './mutex'
import { ExchangeEnum } from './common'

/**
 * Hyperliquid user-stream balancer.
 *
 * Architecture:
 *   - The main user-stream service runs in `balancer` mode (default).
 *     It owns the existing `usersStreamAction` rabbit queue and routes
 *     non-HL events to its local handlers as before. HL open/close
 *     events are forwarded to one of the configured worker servers.
 *   - Each worker runs the same binary in `worker` mode and listens on
 *     `usersStream:worker:<id>`. Workers behave like the existing
 *     user-stream service: they hold the WS connections.
 *   - Hyperliquid caps simultaneous WS connections at 10 per IP, so each
 *     worker handles up to 10 unique HL users; with N workers we get
 *     N × 10 capacity.
 *
 * State (Redis-backed so the balancer is essentially stateless on
 * restart):
 *   `userStream:assignment:<uuid>`   → JSON `{ workerId, openPayload }`
 *   `userStream:worker:<id>:boot`    → bootEpoch (set on worker start)
 *   `userStream:worker:<id>:hb`      → heartbeat (TTL = 3 × heartbeat)
 *   `userStream:lastBoot:<id>`       → balancer-side last-seen bootEpoch
 *
 * Reconciliation runs every `heartbeat` seconds:
 *   - missing `hb` ⇒ worker dead ⇒ rebalance its users to other workers
 *   - `boot` changed since last seen ⇒ worker restarted ⇒ re-send opens
 *     so the worker re-establishes the WS subscriptions
 *
 * Idempotency: `openStreamCallback` already increments `subscribersMap`
 * for repeat opens, so re-sends after a worker restart are harmless.
 */

const HL_EXCHANGES = new Set<ExchangeEnum>([
  ExchangeEnum.hyperliquid,
  ExchangeEnum.hyperliquidLinear,
])
export const isHyperliquidExchange = (e: ExchangeEnum | undefined): boolean =>
  e ? HL_EXCHANGES.has(e) : false

const ASSIGN_PREFIX = 'userStream:assignment:'
const WORKER_BOOT_KEY = (id: string) => `userStream:worker:${id}:boot`
const WORKER_HB_KEY = (id: string) => `userStream:worker:${id}:hb`
const WORKER_CAP_KEY = (id: string) => `userStream:worker:${id}:cap`
const WORKER_USERS_KEY = (id: string) => `userStream:worker:${id}:users`
const LAST_BOOT_KEY = (id: string) => `userStream:lastBoot:${id}`
export const workerQueueName = (id: string) => `usersStream:worker:${id}`

/** Worker's reply to an `open stream` RPC from the balancer. */
export type WorkerOpenResponse = {
  accepted: boolean
  /** Populated on accepted=false. 'cap' = worker is at the 10-cap.
   *  'error' = an exception was raised processing the open. */
  reason?: 'cap' | 'error'
  workerId?: string
  message?: string
}

type Assignment = {
  workerId: string
  /** Original open-stream message. `null` for ghost assignments
   *  created from worker-reported user lists when the balancer doesn't
   *  have the original payload (e.g. lost across a balancer crash).
   *  Ghost assignments can route close events but can't be `resendTo`'d. */
  openPayload: unknown | null
}

type RoutedEvent =
  | {
      event: 'open stream'
      data: { api: { provider: ExchangeEnum } }
      uuid: string
    }
  | { event: 'close stream'; uuid: string }

// Global mutex used by both `routeOpen` and `routeClose`. The whole
// reason the mutex exists is to keep the in-memory `assignments` map
// consistent under concurrent routing decisions: two simultaneous
// `routeOpen` calls would otherwise both call `leastLoadedAlive`
// before either had a chance to update load via `assignments.set`,
// and would converge on the same worker. Hyperliquid bursts arrive
// concurrently, so we need a single-key mutex (not per-uuid) to
// serialise all routing decisions through `assignments`.
const routeMutex = new IdMutex()

class HyperliquidBalancer {
  private static _instance: HyperliquidBalancer | null = null
  static getInstance(): HyperliquidBalancer {
    if (!HyperliquidBalancer._instance) {
      HyperliquidBalancer._instance = new HyperliquidBalancer()
    }
    return HyperliquidBalancer._instance
  }

  // Use the dedicated set/get client; the shared `redis` instance is
  // reserved for pub/sub and will throw on regular commands once it's
  // entered subscriber mode somewhere else in the process.
  private redisSet = RedisClient.getInstance()
  private rabbit = new Rabbit()
  /** uuid → assignment. In-memory mirror of `userStream:assignment:*`. */
  private assignments = new Map<string, Assignment>()
  /** workerId → last-seen bootEpoch. Tracks restart detection. */
  private workerBoot = new Map<string, string>()
  private workerCapMap = new Map<string, number>()
  private selectionCounter = new Map<string, number>()
  private rpcTimeoutMs = +(
    process.env.USER_STREAM_HL_RPC_TIMEOUT_MS ?? 5 * 60 * 1000
  )
  private watchdog: NodeJS.Timeout | null = null
  private initPromise: Promise<void> | null = null

  private workers: string[] = (process.env.USER_STREAM_HL_WORKERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  private defaultWorkerCap = +(process.env.USER_STREAM_HL_WORKER_CAP ?? '10')
  private heartbeatSec = +(process.env.USER_STREAM_HL_HEARTBEAT_SEC ?? '30')

  /** True when at least one worker is configured — i.e. balancer should
   *  forward HL events instead of handling them locally. */
  enabled(): boolean {
    return this.workers.length > 0
  }

  /** Snapshot of assignments + caps + watcher start. Idempotent and
   *  promise-cached: callers (incl. `route()`) `await init()` to be sure
   *  caps/assignments are loaded before any routing decision. Never
   *  rejects, so a route() awaiting it can't be turned into a self-open. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    if (!this.enabled()) return
    try {
      await this.loadAssignments()
      await this.loadLastBoots()
      // Load published per-worker caps up front. Without this, capFor()
      // falls back to defaultWorkerCap until the first watchdog tick (up to
      // heartbeatSec later), so a multi-IP worker (e.g. 6 IPs → cap 60)
      // looks capped at the default 10 right after boot and the balancer
      // drops every HL open past 10.
      await this.loadWorkerCaps()
      const capStr = this.workers.map((w) => `${w}=${this.capFor(w)}`).join(',')
      logger.info(
        `Hyperliquid balancer init: ${this.assignments.size} active assignments across ${this.workers.length} workers [${capStr}]`,
      )
    } catch (e) {
      logger.error(`Hyperliquid balancer init load failed: ${e}`)
    }
    this.startWatchdog()
  }

  /** Load per-worker effective caps (IPs × per-IP cap) published to Redis
   *  by each worker. Called at boot from `init()`; `tick()` keeps the same
   *  map fresh thereafter. */
  private async loadWorkerCaps(): Promise<void> {
    for (const id of this.workers) {
      const capRaw = await this.redisSet.get(WORKER_CAP_KEY(id))
      const cap = capRaw ? +capRaw : NaN
      if (Number.isFinite(cap) && cap > 0) this.workerCapMap.set(id, cap)
    }
  }

  /** Returns true if this uuid has been routed to a worker (i.e. it's
   *  HL and should NOT be processed locally). */
  has(uuid: string): boolean {
    return this.assignments.has(uuid)
  }

  // Both `routeOpen` and `routeClose` mutate `this.assignments`, which
  // is also the source of truth for `leastLoadedAlive`'s load counts.
  // Without a mutex, two concurrent `routeOpen` calls both compute a
  // stale load=0 view and pick the same worker. Hyperliquid open bursts
  // come in simultaneously from the bot, so this matters in practice.
  // Using a single global key serialises all routing decisions —
  // routing is cheap (an in-memory map update + one rabbit send + one
  // redis set), so the throughput hit is negligible.
  @IdMute(routeMutex, () => 'route')
  async routeOpen(
    uuid: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.enabled()) return false
    const tried = new Set<string>()
    let lastReason: string | undefined
    while (tried.size < this.workers.length) {
      let target: string | null = null
      // Prefer the existing assignment if it's alive and not yet tried.
      if (tried.size === 0) {
        const existingTarget = this.assignments.get(uuid)?.workerId
        if (
          existingTarget &&
          !tried.has(existingTarget) &&
          (await this.alive(existingTarget))
        ) {
          target = existingTarget
        }
      }
      if (!target) target = await this.leastLoadedAlive(tried)
      if (!target) break

      const assignment: Assignment = { workerId: target, openPayload: payload }
      // Provisionally update the in-memory load so concurrent (sub-tick)
      // reads through `loadByWorker()` see this user; the mutex already
      // serialises us, but this keeps state coherent if we yield.
      this.assignments.set(uuid, assignment)

      const result = await this.rabbit.sendWithCallback<
        Record<string, unknown>,
        WorkerOpenResponse
      >(workerQueueName(target), payload, this.rpcTimeoutMs)

      if (result?.response?.accepted) {
        await this.redisSet.set(
          `${ASSIGN_PREFIX}${uuid}`,
          JSON.stringify(assignment),
        )
        const load = this.loadByWorker().get(target) ?? 0
        const retryNote = tried.size
          ? ` (after retries through ${[...tried].join(',')})`
          : ''
        logger.info(
          `Hyperliquid routed open ${uuid} → ${target} (load ${load}/${this.capFor(target)})${retryNote}`,
        )
        return true
      }

      // Rejected — undo the provisional assignment, record the worker
      // as tried, retry the loop.
      this.assignments.delete(uuid)
      tried.add(target)
      lastReason = result?.response?.reason ?? 'unknown'
      logger.warn(
        `Hyperliquid worker ${target} rejected ${uuid} (reason=${lastReason}${result?.response?.message ? `, ${result?.response?.message}` : ''}); will retry`,
      )
    }

    logger.error(
      `Hyperliquid balancer: open ${uuid} dropped${
        tried.size
          ? ` after every worker rejected (${[...tried].join(',')}, lastReason=${lastReason})`
          : ` — no healthy worker available`
      }`,
    )
    return false
  }

  @IdMute(routeMutex, () => 'route')
  async routeClose(uuid: string, payload: unknown): Promise<boolean> {
    if (!this.enabled()) return false
    const a = this.assignments.get(uuid)
    if (!a) return false
    await this.rabbit.send(workerQueueName(a.workerId), payload)
    this.assignments.delete(uuid)
    await this.redisSet.del(`${ASSIGN_PREFIX}${uuid}`)
    return true
  }

  /** Snapshot of current load per worker computed from the in-memory
   *  assignments map. Used both for routing decisions and for logging. */
  private loadByWorker(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const id of this.workers) counts.set(id, 0)
    for (const a of this.assignments.values()) {
      counts.set(a.workerId, (counts.get(a.workerId) ?? 0) + 1)
    }
    return counts
  }

  /** Re-routes any event that mentions a known HL uuid. Used by the
   *  balancer's main rabbit handler to decide locally-vs-forward. */
  async route(msg: RoutedEvent): Promise<boolean> {
    if (!this.enabled()) return false
    // Ensure caps + existing assignments are loaded before routing. The
    // rabbit consumer starts before the constructor's fire-and-forget
    // init() finishes, so without this the first ~second of opens route
    // against an empty assignment map and the default cap.
    await this.init()
    if (msg.event === 'open stream') {
      if (!isHyperliquidExchange(msg.data?.api?.provider)) return false
      // Always claim HL opens once the balancer is enabled — even when
      // routing fails (no worker yet / all at cap). The balancer must never
      // open HL locally: it shares the host with the worker(s) and never
      // raises its own cap, so a self-open would double-bind IPs and break.
      // A failed route is logged in routeOpen and left for main-app to retry.
      // Swallow throws too: if routeOpen rejects, the caller's `.catch`
      // would turn route() into `false` and the balancer would self-open.
      await this.routeOpen(msg.uuid, msg).catch((e) =>
        logger.error(`Hyperliquid routeOpen error for ${msg.uuid}: ${e}`),
      )
      return true
    }
    // close stream: if we have an assignment, forward; otherwise
    // it's a non-HL user, fall through to local.
    if (!this.has(msg.uuid)) return false
    return this.routeClose(msg.uuid, msg)
  }

  // ---------------------------------------------------------------- //
  // Watchdog                                                         //
  // ---------------------------------------------------------------- //

  private startWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = setInterval(() => {
      this.tick().catch((e) =>
        logger.error(`Hyperliquid balancer tick error: ${e}`),
      )
    }, this.heartbeatSec * 1000)
  }

  private async tick(): Promise<void> {
    const states: string[] = []
    for (const id of this.workers) {
      const boot = await this.redisSet.get(WORKER_BOOT_KEY(id))
      const hb = await this.redisSet.get(WORKER_HB_KEY(id))
      const capRaw = await this.redisSet.get(WORKER_CAP_KEY(id))
      const cap = capRaw ? +capRaw : NaN
      if (Number.isFinite(cap) && cap > 0) this.workerCapMap.set(id, cap)
      const prev = this.workerBoot.get(id)
      const counts = this.loadByWorker()
      const load = counts.get(id) ?? 0
      if (!hb) {
        states.push(`${id}=dead(load=${load}/${this.capFor(id)})`)
        // No heartbeat — worker is dead (or never started). If we
        // previously saw it alive we have users to redistribute.
        if (prev) {
          logger.warn(`Hyperliquid worker ${id} dead — rebalancing its users`)
          await this.rebalanceFrom(id)
          this.workerBoot.delete(id)
          await this.redisSet.del(LAST_BOOT_KEY(id))
        }
        continue
      }
      if (!boot) {
        states.push(`${id}=hb-no-boot(load=${load}/${this.capFor(id)})`)
        continue // unusual, skip until next tick
      }
      if (!prev) {
        // First time we see this worker — record the boot epoch but do
        // NOT re-send. The worker may already hold its users from a
        // previous balancer instance. Subsequent restart detection
        // works only when we have an established baseline.
        this.workerBoot.set(id, boot)
        await this.redisSet.set(LAST_BOOT_KEY(id), boot)
        states.push(`${id}=alive-new(load=${load}/${this.capFor(id)})`)
        await this.reconcileWorkerAssignments(id)
        continue
      }
      if (boot !== prev) {
        logger.warn(
          `Hyperliquid worker ${id} restarted (boot ${prev} → ${boot}) — re-sending opens`,
        )
        await this.resendTo(id)
        this.workerBoot.set(id, boot)
        await this.redisSet.set(LAST_BOOT_KEY(id), boot)
        states.push(`${id}=restarted(load=${load}/${this.capFor(id)})`)
        await this.reconcileWorkerAssignments(id)
        continue
      }
      // Healthy path: reconcile any drift between what the balancer
      // thinks the worker is holding vs what the worker actually
      // reports. Lost close events, partial crashes etc. silently
      // inflate the in-memory load count over time; reconciliation
      // catches it. Recompute load after reconciliation for the log.
      await this.reconcileWorkerAssignments(id)
      const recountedLoad = this.loadByWorker().get(id) ?? 0
      states.push(`${id}=alive(load=${recountedLoad}/${this.capFor(id)})`)
    }
    logger.info(`Hyperliquid balancer tick: ${states.join(' ')}`)
  }

  /**
   * Compare the balancer's in-memory assignments for `workerId` against
   * the worker's self-reported `userStream:worker:<id>:users` list.
   *
   * Actions taken:
   *   - Balancer-side assignment whose uuid isn't in the worker's
   *     report → drop it. Worker has lost / never had it; the load
   *     count was inflated.
   *   - Worker reports a uuid the balancer has no assignment for →
   *     create a ghost assignment (workerId set, openPayload `null`).
   *     This lets future close events route correctly. The ghost is
   *     in-memory only — not persisted — so it disappears on balancer
   *     restart and is rebuilt from the next worker report. We can't
   *     `resendTo` a ghost (no payload), but the worker already holds
   *     the user so there's nothing to resend anyway.
   *
   * Silently no-ops if the worker hasn't yet published its user list
   * (e.g. very first tick after a fresh boot).
   */
  private async reconcileWorkerAssignments(workerId: string): Promise<void> {
    const raw = await this.redisSet.get(WORKER_USERS_KEY(workerId))
    if (!raw) return
    let reported: string[]
    try {
      reported = JSON.parse(raw) as string[]
      if (!Array.isArray(reported)) return
    } catch {
      return
    }
    const actual = new Set(reported)
    let dropped = 0
    let ghosted = 0
    for (const [uuid, a] of this.assignments) {
      if (a.workerId !== workerId) continue
      if (actual.has(uuid)) continue
      this.assignments.delete(uuid)
      await this.redisSet.del(`${ASSIGN_PREFIX}${uuid}`)
      dropped++
    }
    for (const uuid of actual) {
      if (this.assignments.has(uuid)) continue
      this.assignments.set(uuid, { workerId, openPayload: null })
      ghosted++
    }
    if (dropped || ghosted) {
      logger.info(
        `Hyperliquid reconcile ${workerId}: dropped=${dropped} ghosted=${ghosted}`,
      )
    }
  }

  private async rebalanceFrom(deadId: string): Promise<void> {
    let moved = 0
    let orphaned = 0
    let droppedGhosts = 0
    for (const [uuid, a] of this.assignments) {
      if (a.workerId !== deadId) continue
      if (a.openPayload === null) {
        // Ghost — we don't have the open payload to re-publish.
        // The user was on the dead worker; without the original
        // payload there's nothing we can hand to a new worker. Drop
        // it and rely on the bot republishing.
        this.assignments.delete(uuid)
        droppedGhosts++
        continue
      }
      const newId = await this.leastLoadedAlive(deadId)
      if (!newId) {
        orphaned++
        continue
      }
      a.workerId = newId
      this.assignments.set(uuid, a)
      await this.redisSet.set(`${ASSIGN_PREFIX}${uuid}`, JSON.stringify(a))
      await this.rabbit.send(workerQueueName(newId), a.openPayload)
      moved++
    }
    logger.info(
      `Hyperliquid rebalance from ${deadId}: moved=${moved}, orphaned=${orphaned}, droppedGhosts=${droppedGhosts}`,
    )
  }

  private async resendTo(restartedId: string): Promise<void> {
    let count = 0
    let skippedGhosts = 0
    for (const [, a] of this.assignments) {
      if (a.workerId !== restartedId) continue
      if (a.openPayload === null) {
        // Ghost assignment built from a worker's user-list report;
        // we don't have the original payload to replay. The next bot
        // republish for this user will recreate the real assignment.
        skippedGhosts++
        continue
      }
      await this.rabbit.send(workerQueueName(restartedId), a.openPayload)
      count++
    }
    if (count || skippedGhosts) {
      logger.info(
        `Hyperliquid re-sent ${count} opens to ${restartedId}${skippedGhosts ? ` (${skippedGhosts} ghosts skipped)` : ''}`,
      )
    }
  }

  // ---------------------------------------------------------------- //
  // Worker selection                                                 //
  // ---------------------------------------------------------------- //

  /** Worker's effective HL cap. Falls back to `defaultWorkerCap` when
   *  the worker hasn't yet published its `:cap` key (cold start, or
   *  legacy worker that doesn't publish). */
  private capFor(workerId: string): number {
    return this.workerCapMap.get(workerId) ?? this.defaultWorkerCap
  }

  /**
   * Pick the alive worker with the lowest load/cap ratio.
   */
  private async leastLoadedAlive(
    exclude?: string | Set<string>,
  ): Promise<string | null> {
    const excludeSet =
      exclude instanceof Set
        ? exclude
        : exclude
          ? new Set([exclude])
          : new Set<string>()
    const counts = this.loadByWorker()
    let bestRatio = Infinity
    for (const id of this.workers) {
      if (excludeSet.has(id)) continue
      if (!(await this.alive(id))) continue
      const load = counts.get(id) ?? 0
      const cap = this.capFor(id)
      if (load >= cap) continue
      const ratio = load / cap
      if (ratio < bestRatio) bestRatio = ratio
    }
    if (!Number.isFinite(bestRatio)) return null
    const EPS = 1e-9
    let best: string | null = null
    let bestCounter = Infinity
    for (const id of this.workers) {
      if (excludeSet.has(id)) continue
      if (!(await this.alive(id))) continue
      const load = counts.get(id) ?? 0
      const cap = this.capFor(id)
      if (load >= cap) continue
      if (Math.abs(load / cap - bestRatio) > EPS) continue
      const counter = this.selectionCounter.get(id) ?? 0
      if (counter < bestCounter) {
        bestCounter = counter
        best = id
      }
    }
    if (best) {
      this.selectionCounter.set(
        best,
        (this.selectionCounter.get(best) ?? 0) + 1,
      )
    }
    return best
  }

  private async alive(id: string): Promise<boolean> {
    const hb = await this.redisSet.get(WORKER_HB_KEY(id))
    return Boolean(hb)
  }

  // ---------------------------------------------------------------- //
  // Boot-time hydration                                              //
  // ---------------------------------------------------------------- //

  private async loadAssignments(): Promise<void> {
    let cursor = '0'
    do {
      const reply = await this.redisSet.scan(cursor, {
        MATCH: `${ASSIGN_PREFIX}*`,
        COUNT: 200,
      })
      cursor = `${reply.cursor}`
      if (reply.keys.length === 0) continue
      const vals = await this.redisSet.mGet(reply.keys)
      reply.keys.forEach((k: string, i: number) => {
        const uuid = k.slice(ASSIGN_PREFIX.length)
        const raw = vals[i]
        if (!raw) return
        try {
          this.assignments.set(uuid, JSON.parse(raw) as Assignment)
        } catch (e) {
          logger.error(
            `Hyperliquid balancer: could not parse assignment ${uuid}: ${e}`,
          )
        }
      })
    } while (cursor !== '0')
  }

  private async loadLastBoots(): Promise<void> {
    for (const id of this.workers) {
      const prev = await this.redisSet.get(LAST_BOOT_KEY(id))
      if (prev) this.workerBoot.set(id, prev)
    }
  }
}

export default HyperliquidBalancer
