/**
 * KuCoin user stream: read a MARKET order's venue fee over REST before its
 * FILLED report goes out.
 *
 * KuCoin's private order topics (`/spotMarket/tradeOrdersV2`,
 * `/contractMarket/tradeOrders`) carry no fee at all (spec 003 §3.2), so
 * every fill the stream reports reached `orders` without one and consumers
 * fell back to an estimate. The REST record does carry it:
 * - spot: the order detail (`GET /api/v1/orders/{id}`) has the order's
 *   summed `fee` / `feeCurrency` once it is done (cheapest read, weight 2);
 * - futures: the order detail has no fee field, the fills
 *   (`GET /api/v1/fills?orderId=`, futures host) have one per trade.
 *
 * Rules (same as the other venues):
 * - an unresolvable fee is OMITTED, never 0 — a lookup that fails, times
 *   out, sees the order still active, or sees fewer fills than the stream
 *   reported returns `{}` and the report goes out as before;
 * - the currency is taken as reported: a KCS-discounted account pays in KCS,
 *   which stays `feeAsset` for consumers to value;
 * - a net zero/negative fee (promo pair, maker rebate) is not a fee — omitted;
 * - bounded latency: a few attempts within `timeoutMs`, then give up;
 * - one lookup per order: KuCoin reports a market order FILLED more than once
 *   (the last `match` with remainSize 0, then `filled`/done), and main-app books
 *   the first FILLED, so every FILLED of an order waits on the same lookup.
 *
 * Pure apart from the injected fetchers so it is pinned by
 * `test/kucoinStreamFee.test.ts`.
 */

export type KucoinFeeFields = {
  feePaid?: string
  feeAsset?: string
  feeBreakdown?: { asset: string; amount: string }[]
}

/** The order-detail fields used here (spot `KucoinOrder`). */
export type KucoinRestOrder = {
  id?: string
  isActive?: boolean
  dealSize?: string | number
  fee?: string | number
  feeCurrency?: string
}

/** The fill fields used here (spot and futures `/api/v1/fills` items). */
export type KucoinRestFill = {
  orderId?: string
  tradeId?: string
  size?: string | number
  fee?: string | number
  feeCurrency?: string
}

export type KucoinRestFills = { totalNum?: number; items?: KucoinRestFill[] }

const round = (n: number): number => +n.toPrecision(12)

/** Per-currency amounts → report fields; zero/negative legs dropped. */
export const kucoinFeeFieldsFromLegs = (
  fees: Record<string, number>,
): KucoinFeeFields => {
  const legs = Object.entries(fees)
    .map(([asset, amount]) => [asset, round(amount)] as const)
    .filter(([, amount]) => amount > 0)
  if (legs.length === 0) {
    return {}
  }
  if (legs.length === 1) {
    return { feePaid: `${legs[0][1]}`, feeAsset: legs[0][0] }
  }
  return {
    feeBreakdown: legs.map(([asset, amount]) => ({
      asset,
      amount: `${amount}`,
    })),
  }
}

const asset = (v: unknown): string => `${v ?? ''}`.trim().toUpperCase()
const amountOf = (v: unknown): number | undefined => {
  if (v === undefined || v === null || `${v}`.trim() === '') {
    return undefined
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Spot order detail → fee. `null` = not settled yet (still active), worth
 * another attempt; `{}` = settled but no usable fee.
 */
export const kucoinSpotOrderFee = (
  order: KucoinRestOrder | null | undefined,
): KucoinFeeFields | null => {
  if (!order) {
    return null
  }
  if (order.isActive) {
    return null
  }
  const amount = amountOf(order.fee)
  const ccy = asset(order.feeCurrency)
  if (amount === undefined || !ccy) {
    return {}
  }
  return kucoinFeeFieldsFromLegs({ [ccy]: amount })
}

/**
 * Futures fills → fee. `null` = the fills seen do not yet add up to what the
 * stream reported executed (or there are more pages), worth another attempt.
 * `{}` = complete but a fill had no usable fee.
 */
export const kucoinFillsFee = (
  orderId: string,
  res: KucoinRestFills | null | undefined,
  executedQty: number,
): KucoinFeeFields | null => {
  if (!res) {
    return null
  }
  const items = (res.items ?? []).filter(
    (f) => !f.orderId || `${f.orderId}` === orderId,
  )
  if (!items.length) {
    return null
  }
  if ((res.totalNum ?? items.length) > (res.items ?? []).length) {
    // More pages than were read: the fee would be partial.
    return {}
  }
  const seen = new Set<string>()
  let qty = 0
  const fees: Record<string, number> = {}
  for (const f of items) {
    const key = f.tradeId ? `${f.tradeId}` : undefined
    if (key && seen.has(key)) {
      continue
    }
    if (key) {
      seen.add(key)
    }
    qty += Number(f.size) || 0
    const amount = amountOf(f.fee)
    const ccy = asset(f.feeCurrency)
    if (amount === undefined || !ccy) {
      return {}
    }
    fees[ccy] = (fees[ccy] ?? 0) + amount
  }
  if (
    Number.isFinite(executedQty) &&
    executedQty > 0 &&
    round(qty) + 1e-12 < round(executedQty) * (1 - 1e-9)
  ) {
    return null
  }
  return kucoinFeeFieldsFromLegs(fees)
}

export type KucoinFeeSettlerOpts = {
  futures: boolean
  /** Spot: order detail. Return `null` on any failure. */
  getSpotOrder: (orderId: string) => Promise<KucoinRestOrder | null>
  /** Futures: fills of the order. Return `null` on any failure. */
  getFuturesFills: (orderId: string) => Promise<KucoinRestFills | null>
  /** Waits before each attempt (ms); the venue needs a moment to settle. */
  attemptDelaysMs?: number[]
  /** Hard cap on the whole lookup, ms. */
  timeoutMs?: number
  /** How long a resolved fee is kept for a repeat FILLED of the order. */
  cacheMs?: number
  log?: (msg: string) => void
  sleep?: (ms: number) => Promise<void>
}

export const KUCOIN_FEE_ATTEMPT_DELAYS_MS = [400, 800, 1200]
export const KUCOIN_FEE_TIMEOUT_MS = 3000
const KUCOIN_FEE_CACHE_MS = 60_000

/**
 * Returns `settle(orderId, executedQty)` → the fee fields to spread onto the
 * FILLED report (`{}` when unresolved). Never rejects.
 */
export const createKucoinFeeSettler = (opts: KucoinFeeSettlerOpts) => {
  const delays = opts.attemptDelaysMs ?? KUCOIN_FEE_ATTEMPT_DELAYS_MS
  const timeoutMs = opts.timeoutMs ?? KUCOIN_FEE_TIMEOUT_MS
  const cacheMs = opts.cacheMs ?? KUCOIN_FEE_CACHE_MS
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const inFlight = new Map<string, Promise<KucoinFeeFields>>()

  const lookup = async (
    orderId: string,
    executedQty: number,
    deadline: { expired: boolean },
  ): Promise<KucoinFeeFields> => {
    for (const wait of delays) {
      await sleep(wait)
      if (deadline.expired) {
        return {}
      }
      const fee = opts.futures
        ? kucoinFillsFee(
            orderId,
            await opts.getFuturesFills(orderId),
            executedQty,
          )
        : kucoinSpotOrderFee(await opts.getSpotOrder(orderId))
      if (fee) {
        return fee
      }
    }
    return {}
  }

  return (orderId: string, executedQty: number): Promise<KucoinFeeFields> => {
    const cached = inFlight.get(orderId)
    if (cached) {
      return cached
    }
    const deadline = { expired: false }
    let timer: NodeJS.Timeout | undefined
    const p = Promise.race([
      lookup(orderId, executedQty, deadline),
      new Promise<KucoinFeeFields>((resolve) => {
        timer = setTimeout(() => {
          deadline.expired = true
          resolve({})
        }, timeoutMs)
      }),
    ])
      .catch((e) => {
        opts.log?.(
          `KuCoin fee lookup for ${orderId} failed: ${
            e instanceof Error ? e.message : `${e}`
          }`,
        )
        return {} as KucoinFeeFields
      })
      .then((fee) => {
        clearTimeout(timer)
        if (!fee.feePaid && !fee.feeBreakdown) {
          opts.log?.(
            `KuCoin fee for ${orderId} unresolved; reporting the fill without a fee`,
          )
        }
        const t = setTimeout(() => inFlight.delete(orderId), cacheMs)
        t.unref?.()
        return fee
      })
    inFlight.set(orderId, p)
    return p
  }
}
