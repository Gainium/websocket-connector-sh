/**
 * Hyperliquid two-channel fill join: park-and-retry.
 *
 * HL splits order data across two WS channels:
 *   - `orderUpdates` — order status transitions (NEW / open / filled / …),
 *      but NO reliable execution price for the fill.
 *   - `userFills`   — the real per-fill `px`/`sz` (buffered by cloid in
 *      `hyperliquidExpirableMap`).
 *
 * The connector emits execution reports from `orderUpdates` and, historically,
 * **hard-dropped a FILLED update whose fills weren't buffered yet**
 * (`if (isFilled && !get) return false`). The drop was DELIBERATE: emitting a
 * FILLED without the buffered fills books it at `limitPx` instead of the real
 * average price (an earlier bug Maksym fixed by dropping). But any lost / late /
 * expired / reconnect-snapshot `userFills` message then means the FILLED event
 * is NEVER relayed to main-app ⇒ the order stays NEW ⇒ the deal silently
 * freezes. This was the verified root cause of the ongoing HL missed fills.
 *
 * The fix keeps price accuracy while closing the hole: instead of dropping a
 * FILLED-without-fills update, we PARK it in a bounded, TTL'd map and give the
 * fills a grace window to arrive. Resolution order (first that yields fills wins):
 *   1. buffer  — fills arrive on `userFills` during the grace window (the common
 *                case; resolved immediately via {@link notifyFillArrived}).
 *   2. REST    — grace expires with no buffered fill ⇒ a REST order lookup
 *                fetches the real fills, RETRIED with exponential backoff so a
 *                transient balancer/exchange error doesn't cost us the real
 *                price. The buffer is re-checked before every attempt, so fills
 *                landing mid-backoff still win.
 *   3. limitPx — only once EVERY REST attempt is spent ⇒ emit at `limitPx` as a
 *                LAST resort (a slightly-off average beats a permanently frozen
 *                deal), logged loudly.
 *
 * The parked entry stays in the map for the whole ladder, including the REST
 * backoff, so {@link HyperliquidFillParkResolver.has} keeps reporting `true` and
 * reconnect-snapshot fills for that cloid are still buffered ({@link
 * ingestUserFills} gates snapshots on being parked). It is removed from the map
 * at its single emit.
 *
 * This module is intentionally generic over the order / fill / event types and
 * takes all of its side-effects (buffer access, REST lookup, event build, emit,
 * log, timers) as injected dependencies, so the resolution state machine is unit
 * testable without the surrounding `UserConnector`.
 */

import { CommonOrder } from '../../type'
import { ExchangeEnum } from './common'

/** Context handed to the REST fallback for a parked, filled order. */
export interface ParkContext {
  /** Client order id (map key). */
  cloid: string
  /** User-stream room id the resolved event must be emitted to. */
  roomId: string
  /** Hyperliquid numeric order id. */
  oid: number
  /** EVM address whose fills we look up (the HL "user"). */
  user: string
  /** `statusTimestamp` of the FILLED update (ms epoch) — REST lookback anchor. */
  statusTimestamp: number
  key: string
  exchange: ExchangeEnum
}

/** Everything needed to park a filled order until its fills are known. */
export interface ParkInput<TOrder> extends ParkContext {
  /** The raw orderUpdates entry, replayed into `buildEvent` on resolution. */
  order: TOrder
}

interface ParkEntry<TOrder> extends ParkInput<TOrder> {
  timer: ReturnType<typeof setTimeout> | null
  resolving: boolean
}

export type ParkTrigger = 'buffer' | 'grace' | 'fill-arrived' | 'overflow'

/** REST attempts (including the first) before falling back to limitPx. */
const DEFAULT_REST_RETRIES = 3
/** Base backoff between REST attempts; doubles each attempt. */
const DEFAULT_REST_RETRY_DELAY_MS = 1000

export interface HyperliquidFillParkOptions<TOrder, TFill, TEvent> {
  /** Max time to wait for fills before falling back to REST. */
  graceMs: number
  /** Hard cap on simultaneously-parked orders; oldest is force-resolved on overflow. */
  maxSize: number
  /** Read the fills currently buffered for a cloid (the `userFills` buffer). */
  getBufferedFills: (cloid: string) => TFill[] | undefined
  /** Drop the buffered fills for a cloid once consumed. */
  clearBufferedFills: (cloid: string) => void
  /** REST fallback: fetch the real fills for a filled order (`null` if none/unavailable). */
  restLookup: (ctx: ParkContext) => Promise<CommonOrder | null>
  /**
   * REST attempts (including the first) before falling back to limitPx.
   * Defaults to {@link DEFAULT_REST_RETRIES}; values below 1 are clamped to 1.
   */
  restRetries?: number
  /**
   * Base backoff between REST attempts, doubled each attempt. Defaults to
   * {@link DEFAULT_REST_RETRY_DELAY_MS}; `0` retries immediately (tests).
   */
  restRetryDelayMs?: number
  /** Build the execution-report event from an order + resolved fills (empty ⇒ limitPx). */
  buildEvent: (order: TOrder, fills: TFill[]) => TEvent
  /** Build the execution-report event from an order + resolved commonOrder. */
  buildEventFromCommonOrder: (order: TOrder, commonOrder: CommonOrder) => TEvent
  /** Relay a resolved event to the user-stream. */
  emit: (roomId: string, event: TEvent) => void
  /** Structured logging (msg, isError). */
  log: (msg: string, isError?: boolean) => void
  /** Injectable timer (tests). Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** Injectable timer clear (tests). Defaults to `clearTimeout`. */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export class HyperliquidFillParkResolver<TOrder, TFill, TEvent> {
  private readonly map = new Map<string, ParkEntry<TOrder>>()
  private readonly setTimer: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void

  constructor(
    private readonly opts: HyperliquidFillParkOptions<TOrder, TFill, TEvent>,
  ) {
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        // Don't keep the process alive purely for a pending park timer.
        if (typeof t.unref === 'function') t.unref()
        return t
      })
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))
  }

  /** Is there a filled order currently parked on this cloid? */
  has(cloid: string): boolean {
    return this.map.has(cloid)
  }

  /** Number of currently-parked orders (metrics/tests). */
  get size(): number {
    return this.map.size
  }

  /**
   * Park a FILLED order update whose fills aren't buffered yet. Starts the
   * grace timer; the order is resolved by the first of {@link notifyFillArrived}
   * (fills landed), the grace timer (REST fallback), or an overflow eviction.
   */
  park(input: ParkInput<TOrder>): void {
    const { cloid } = input
    const existing = this.map.get(cloid)
    if (existing) {
      // A newer FILLED snapshot for the same cloid — refresh the order we'll
      // replay, but keep the running grace timer so we don't extend forever.
      existing.order = input.order
      return
    }
    if (this.map.size >= this.opts.maxSize) {
      // Bound memory: resolve the oldest parked order now (its buffer→REST→
      // limitPx path is unchanged and safe to run early). Entries already
      // mid-resolution can't be force-resolved again — they clear themselves
      // once their REST retries drain — so evict the oldest one not yet started.
      let oldest: string | undefined
      for (const [candidate, entry] of this.map) {
        if (!entry.resolving) {
          oldest = candidate
          break
        }
      }
      if (oldest !== undefined) {
        this.opts.log(
          `[hl-park] size cap ${this.opts.maxSize} reached; force-resolving oldest cloid ${oldest}`,
          true,
        )
        void this.resolve(oldest, 'overflow')
      } else {
        // Every parked order is draining its REST retries; parking over the cap
        // is bounded by (arrival rate × retry window) and self-corrects.
        this.opts.log(
          `[hl-park] size cap ${this.opts.maxSize} reached but every parked order is mid-resolution; parking ${cloid} over cap`,
          true,
        )
      }
    }
    const timer = this.setTimer(
      () => void this.resolve(cloid, 'grace'),
      this.opts.graceMs,
    )
    this.map.set(cloid, { ...input, timer, resolving: false })
  }

  /**
   * Signal that fills have landed for a cloid (called after appending to the
   * buffer). If that cloid is parked, resolve it immediately with the real
   * fills instead of waiting out the grace window.
   */
  notifyFillArrived(cloid: string): void {
    if (this.map.has(cloid)) {
      void this.resolve(cloid, 'fill-arrived')
    }
  }

  /** Clear all timers and parked entries (tests / shutdown). */
  clear(): void {
    for (const entry of this.map.values()) {
      if (entry.timer !== null) this.clearTimer(entry.timer)
    }
    this.map.clear()
  }

  private async resolve(cloid: string, trigger: ParkTrigger): Promise<void> {
    const entry = this.map.get(cloid)
    if (!entry || entry.resolving) return
    // Flag synchronously (before any await) so concurrent resolve() calls for
    // the same cloid — grace timer vs. fill-arrived vs. overflow — only run the
    // ladder once. The entry stays in the map until `finish()` so it remains
    // visible to `has()`/`ingestUserFills` across the REST backoff.
    entry.resolving = true
    if (entry.timer !== null) {
      this.clearTimer(entry.timer)
      entry.timer = null
    }

    // 1. Buffer: fills arrived (live or reconnect snapshot) while parked.
    if (this.emitFromBuffer(entry, trigger)) return

    // 2. REST fallback, retried with exponential backoff so a transient
    //    balancer/exchange error doesn't cost us the real fill price.
    const attempts = Math.max(1, this.opts.restRetries ?? DEFAULT_REST_RETRIES)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Fills may have landed while we were backing off — always prefer them.
      if (attempt > 1 && this.emitFromBuffer(entry, trigger)) return
      try {
        const order = await this.opts.restLookup({
          cloid,
          roomId: entry.roomId,
          oid: entry.oid,
          user: entry.user,
          statusTimestamp: entry.statusTimestamp,
          exchange: entry.exchange,
          key: entry.key,
        })
        if (order) {
          this.finish(entry)
          this.opts.emit(
            entry.roomId,
            this.opts.buildEventFromCommonOrder(entry.order, order),
          )
          this.opts.log(
            `[hl-park] resolved cloid ${cloid} via REST after ${trigger} (attempt ${attempt}/${attempts}, ${order.status} status)`,
          )
          return
        }
        this.opts.log(
          `[hl-park] REST returned no order for cloid ${cloid} (oid ${entry.oid}) after ${trigger} (attempt ${attempt}/${attempts})`,
          true,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : `${err}`
        this.opts.log(
          `[hl-park] REST lookup failed for cloid ${cloid} (oid ${entry.oid}) (attempt ${attempt}/${attempts}): ${msg}`,
          true,
        )
      }
      if (attempt < attempts) await this.backoff(attempt)
    }

    // 3. Last resort, only now that every REST attempt is spent: emit at
    //    limitPx (empty fills ⇒ buildEvent prices at limitPx). A slightly-off
    //    average beats a permanently frozen deal.
    if (this.emitFromBuffer(entry, trigger)) return
    this.finish(entry)
    this.opts.emit(entry.roomId, this.opts.buildEvent(entry.order, []))
    this.opts.log(
      `[hl-park] cloid ${cloid} (oid ${entry.oid}) unresolved after ${attempts} REST attempt(s) via ${trigger}; emitting at limitPx (LAST RESORT)`,
      true,
    )
  }

  /**
   * Emit from the fill buffer if it holds anything for this entry. Returns
   * `true` when it emitted (the caller must then stop — one emit per park).
   */
  private emitFromBuffer(
    entry: ParkEntry<TOrder>,
    trigger: ParkTrigger,
  ): boolean {
    const buffered = this.opts.getBufferedFills(entry.cloid)
    if (!buffered || !buffered.length) return false
    this.opts.clearBufferedFills(entry.cloid)
    this.finish(entry)
    this.opts.emit(entry.roomId, this.opts.buildEvent(entry.order, buffered))
    this.opts.log(
      `[hl-park] resolved cloid ${entry.cloid} from buffer via ${trigger} (${buffered.length} fills)`,
    )
    return true
  }

  /** Drop a parked entry from the map, immediately before its single emit. */
  private finish(entry: ParkEntry<TOrder>): void {
    if (entry.timer !== null) {
      this.clearTimer(entry.timer)
      entry.timer = null
    }
    this.map.delete(entry.cloid)
  }

  /** Exponential backoff between REST attempts, via the injectable timer. */
  private backoff(attempt: number): Promise<void> {
    const base = this.opts.restRetryDelayMs ?? DEFAULT_REST_RETRY_DELAY_MS
    const ms = base * 2 ** (attempt - 1)
    if (ms <= 0) return Promise.resolve()
    return new Promise((res) => {
      this.setTimer(() => res(), ms)
    })
  }
}

/**
 * Ingest a `userFills` message into the buffer and wake any parked orders.
 *
 * - **Live** (non-snapshot) fills are always buffered — this covers the
 *   fills-before-orderUpdates ordering.
 * - **Snapshot** fills (replayed on reconnect) are applied ONLY for cloids that
 *   currently have a parked order waiting on them. Buffering every snapshot fill
 *   would re-pollute the buffer with already-processed fills — the reason
 *   snapshots were originally skipped entirely.
 *
 * After buffering, a parked cloid is woken via `notifyFillArrived` so it resolves
 * immediately with the real price rather than waiting out its grace window.
 */
export function ingestUserFills<TFill extends { cloid?: string }>(
  data: { isSnapshot?: boolean; fills: TFill[] },
  deps: {
    appendFill: (cloid: string, fill: TFill) => void
    isParked: (cloid: string) => boolean
    notifyFillArrived: (cloid: string) => void
  },
): void {
  const snapshot = !!data.isSnapshot
  for (const fill of data.fills) {
    const cloid = fill.cloid ? `${fill.cloid}` : ''
    if (!cloid) continue
    if (snapshot && !deps.isParked(cloid)) continue
    deps.appendFill(cloid, fill)
    if (deps.isParked(cloid)) deps.notifyFillArrived(cloid)
  }
}
