/**
 * Escalates a feed that stays dead to a fresh worker thread.
 *
 * A watchdog stall (see `CommonConnector.watchdogFn`) throws inside the price
 * worker, and `service.ts` answers by rebuilding the connector in the same
 * thread. That covers short blips, but a rebuild inherits everything the
 * thread holds (module-level mutexes, sockets of earlier connectors), so a
 * feed it cannot revive stays dead until the process restarts. After
 * `STALL_EXIT_THRESHOLD` stalls of the same feed with no data in between, the
 * worker exits and the parent's `initWorker` starts a fresh one.
 */

export const STALL_EXIT_THRESHOLD = 3

export type StallKind = 'price' | 'candle'

const STALL_PATTERN =
  /(Trades on exchange )?(?:exceed connect time|not received new data for) \d+s \| (\S+)/

/** The feed a watchdog stall error names, or null for any other error. */
export const stallOf = (
  message?: string | null,
): { exchange: string; kind: StallKind } | null => {
  const m = `${message ?? ''}`.match(STALL_PATTERN)
  return m ? { exchange: m[2], kind: m[1] ? 'candle' : 'price' } : null
}

export class StallCounter {
  private stalls: Map<string, number> = new Map()

  constructor(private threshold = STALL_EXIT_THRESHOLD) {}

  /** Real data arrived: the feed is alive, forget its stalls. */
  noteData(exchange: string, kind: StallKind) {
    this.stalls.delete(`${kind}|${exchange}`)
  }

  /** Count a stall; true once the feed reached the threshold. */
  noteStall(exchange: string, kind: StallKind) {
    const key = `${kind}|${exchange}`
    const count = (this.stalls.get(key) ?? 0) + 1
    this.stalls.set(key, count)
    return count >= this.threshold
  }
}

/** One per worker thread: it has to outlive the connectors it restarts. */
export const stallCounter = new StallCounter()
