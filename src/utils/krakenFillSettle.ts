/**
 * Kraken Futures `fills` feed: settle an order's executed quantity on REST
 * before reporting it FILLED.
 *
 * The feed does not deliver an order's fills in execution order, and not
 * always promptly. Observed on prod: a 0.027 ETH close that executed as 0.012
 * then 0.015 (same millisecond) delivered the 0.015 — the chunk with
 * `remaining_order_qty: 0` — first, and the 0.012 seven seconds later. The
 * stream accumulator reported FILLED 0.015 on the first message; main-app
 * books a deal's close on the FIRST FILLED of its take-profit and treats any
 * later one as already processed, so the deal recorded 0.015 of 0.027 and the
 * late fill changed nothing.
 *
 * `remaining_order_qty === 0` marks the LAST fill by execution, not the last
 * by delivery, and the stream alone cannot tell "every earlier fill has
 * already arrived" from "some are still on their way": a reduce-only close
 * Kraken capped to a nearly flat shared position also arrives as one fill
 * with remaining 0, and that partial size is the true one. So the order's
 * fills are read from REST (`GET /fills`) and merged into the running total,
 * deduped by `fill_id`. Never inferred from the size placed.
 *
 * Pure so the merge is pinned by `test/krakenFillLateArrival.test.ts`.
 */

/** What the REST `/fills` endpoint returns per fill (the fields used here). */
export type KrakenRestFill = {
  fill_id: string
  order_id: string
  size: number | string
  price: number | string
}

export type KrakenFillTotals = {
  qty: number
  cost: number
  fillIds: Set<string>
  /**
   * `settling`: the fill that closed the order is out on its REST lookup, so
   * fills that land meanwhile are counted into the report it will send.
   * `reported`: the FILLED report has gone out.
   */
  settled?: 'settling' | 'reported'
}

/**
 * Add the REST fills of `orderId` that the stream has not delivered yet.
 * Returns how many were added; mutates `totals`.
 */
export const mergeKrakenRestFills = (
  totals: KrakenFillTotals,
  orderId: string,
  restFills: KrakenRestFill[],
): number => {
  let added = 0
  for (const f of restFills) {
    if (`${f.order_id}` !== orderId || !f.fill_id) {
      continue
    }
    const id = `${f.fill_id}`
    if (totals.fillIds.has(id)) {
      continue
    }
    const qty = +f.size || 0
    totals.fillIds.add(id)
    totals.qty += qty
    totals.cost += qty * (+f.price || 0)
    added++
  }
  return added
}

/**
 * A float sum of fill sizes, cleaned of binary noise (0.0001 + 0.0001 + 0.0002
 * + 0.0214 + 0.0087 is 0.030399999999999996). Twelve significant digits is far
 * beyond any Kraken contract step and far below the noise.
 */
export const krakenQty = (n: number): number => +n.toPrecision(12)
