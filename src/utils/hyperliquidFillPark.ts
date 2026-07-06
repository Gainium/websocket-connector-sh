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
 *   2. REST    — grace expires with no buffered fill ⇒ ONE `userFillsByTime`
 *                lookup fetches the real fills.
 *   3. limitPx — REST also fails/empty ⇒ emit at `limitPx` as a LAST resort
 *                (a slightly-off average beats a permanently frozen deal), logged
 *                loudly.
 *
 * This module is intentionally generic over the order / fill / event types and
 * takes all of its side-effects (buffer access, REST lookup, event build, emit,
 * log, timers) as injected dependencies, so the resolution state machine is unit
 * testable without the surrounding `UserConnector`.
 */

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
}

/** Everything needed to park a filled order until its fills are known. */
export interface ParkInput<TOrder> extends ParkContext {
  /** The raw orderUpdates entry, replayed into `buildEvent` on resolution. */
  order: TOrder
}

interface ParkEntry<TOrder> extends ParkInput<TOrder> {
  timer: ReturnType<typeof setTimeout>
  resolving: boolean
}

export type ParkTrigger = 'buffer' | 'grace' | 'fill-arrived' | 'overflow'

export interface HyperliquidFillParkOptions<TOrder, TFill, TEvent> {
  /** Max time to wait for fills before falling back to REST. */
  graceMs: number
  /** Hard cap on simultaneously-parked orders; oldest is force-resolved on overflow. */
  maxSize: number
  /** Read the fills currently buffered for a cloid (the `userFills` buffer). */
  getBufferedFills: (cloid: string) => TFill[] | undefined
  /** Drop the buffered fills for a cloid once consumed. */
  clearBufferedFills: (cloid: string) => void
  /** REST fallback: fetch the real fills for a filled order (`[]` if none/unavailable). */
  restLookup: (ctx: ParkContext) => Promise<TFill[]>
  /** Build the execution-report event from an order + resolved fills (empty ⇒ limitPx). */
  buildEvent: (order: TOrder, fills: TFill[]) => TEvent
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
      // limitPx path is unchanged and safe to run early).
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        this.opts.log(
          `[hl-park] size cap ${this.opts.maxSize} reached; force-resolving oldest cloid ${oldest}`,
          true,
        )
        void this.resolve(oldest, 'overflow')
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
      this.clearTimer(entry.timer)
    }
    this.map.clear()
  }

  private async resolve(cloid: string, trigger: ParkTrigger): Promise<void> {
    const entry = this.map.get(cloid)
    if (!entry || entry.resolving) return
    // Delete synchronously (before any await) so concurrent resolve() calls
    // for the same cloid — grace timer vs. fill-arrived vs. overflow — can
    // only emit once.
    entry.resolving = true
    this.clearTimer(entry.timer)
    this.map.delete(cloid)

    // 1. Buffer: fills arrived (live or reconnect snapshot) while parked.
    const buffered = this.opts.getBufferedFills(cloid)
    if (buffered && buffered.length) {
      this.opts.clearBufferedFills(cloid)
      this.opts.emit(entry.roomId, this.opts.buildEvent(entry.order, buffered))
      this.opts.log(
        `[hl-park] resolved cloid ${cloid} from buffer via ${trigger} (${buffered.length} fills)`,
      )
      return
    }

    // 2. REST fallback: one lookup for the real fills.
    try {
      const fills = await this.opts.restLookup({
        cloid,
        roomId: entry.roomId,
        oid: entry.oid,
        user: entry.user,
        statusTimestamp: entry.statusTimestamp,
      })
      if (fills && fills.length) {
        this.opts.emit(entry.roomId, this.opts.buildEvent(entry.order, fills))
        this.opts.log(
          `[hl-park] resolved cloid ${cloid} via REST after ${trigger} (${fills.length} fills)`,
        )
        return
      }
      this.opts.log(
        `[hl-park] REST returned no fills for cloid ${cloid} (oid ${entry.oid}) after ${trigger}; emitting at limitPx (LAST RESORT)`,
        true,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : `${err}`
      this.opts.log(
        `[hl-park] REST lookup failed for cloid ${cloid} (oid ${entry.oid}): ${msg}; emitting at limitPx (LAST RESORT)`,
        true,
      )
    }

    // 3. Last resort: emit at limitPx (empty fills ⇒ buildEvent uses limitPx).
    this.opts.emit(entry.roomId, this.opts.buildEvent(entry.order, []))
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
