/**
 * Kraken Futures `open_orders` feed → ExecutionReport fill fields.
 *
 * On this feed an order's `qty` is the quantity STILL OPEN, not the quantity
 * originally placed; `filled` is the cumulative amount executed. Kraken's docs
 * only say "the quantity of the order", and the previous mapping read it as the
 * total: `filled >= qty ? FILLED : PARTIALLY_FILLED`. A 16-lot order with 11
 * filled therefore arrived as `{qty: 5, filled: 11}` → `11 >= 5` → **FILLED at
 * 11** — observed live (2026-08-22, Kraken XRP-USD): the engine saw a "full"
 * fill 5 short of what it placed, sent a market remainder for the 5, and the
 * original order then filled to 16 on its own. The venue held 21, the deal
 * booked 11, and the extra 5 sat on the exchange with no take-profit and no
 * stop-loss. 40 such duplicate remainders in two weeks across 26 accounts.
 *
 * The `fills` feed was fixed the same way on 2026-08-07 (cumulative totals,
 * FILLED only at `remaining_order_qty === 0`); this is the other half.
 *
 * Pure so the arithmetic is pinned by `krakenOpenOrders.spec.ts`.
 */

export type KrakenOpenOrderLike = {
  /** Quantity still open on the book (NOT the original size). */
  qty?: number | string | null
  /** Cumulative executed quantity. */
  filled?: number | string | null
}

export type KrakenOpenOrderFill = {
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED'
  /** Original order size = filled + remaining. */
  total: number
  /** Cumulative executed quantity. */
  filled: number
  /** Quantity still open. */
  remaining: number
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(`${v ?? ''}`)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Status and quantities for an `open_orders` order update. FILLED only when
 * nothing remains open; the reported quantity is the ORIGINAL size so
 * `executedQty < origQty` means what the engine thinks it means.
 */
export const krakenOpenOrderFill = (
  order: KrakenOpenOrderLike,
): KrakenOpenOrderFill => {
  const remaining = num(order.qty)
  const filled = num(order.filled)
  const status =
    filled > 0 && remaining === 0
      ? 'FILLED'
      : filled > 0
        ? 'PARTIALLY_FILLED'
        : 'NEW'
  return { status, total: filled + remaining, filled, remaining }
}

/**
 * `open_orders` removes an order with `is_cancel: true` for cancellation AND for
 * a full fill (`reason: 'full_fill'`). The fill itself arrives on the `fills`
 * feed with the real quantity and price; emitting CANCELED here would mark a
 * filled order dead. Only a full fill is a fill — `partial_fill` keeps the order
 * open and never carries `is_cancel`.
 */
export const krakenOpenOrdersRemovalIsFill = (
  reason: string | null | undefined,
): boolean => `${reason ?? ''}`.toLowerCase() === 'full_fill'

/**
 * Is this Kraken Futures `fills` feed entry a forced close of the account's
 * own position, not an order it placed?
 *
 * Kraken tags every fill with `fill_type`. A liquidation comes in chunks, each
 * under its own venue order id and with no `cli_ord_id`: the account history
 * shows them as `PartialLiquidation` / `Liquidation`. Before this, every
 * Kraken futures fill went out as `liquidation: false`, so main-app dropped
 * the chunks as orders it did not know. The deal kept tracking a position the
 * venue had already closed, and booked none of the liquidation loss.
 *
 * `unwindBankrupt` / `unwindCounterparty` are the venue force-closing the
 * account's position too (bankruptcy unwind and auto-deleveraging), which is
 * what the `liquidation` flag means on Binance (`autoclose-`) as well.
 * `assignor` / `assignee` are NOT included: they are the takeover side, where
 * this account receives or hands over a position under a transfer.
 */
export const isKrakenLiquidationFill = (fill: {
  fill_type?: unknown
  fillType?: unknown
}): boolean => {
  const type = `${fill?.fill_type ?? fill?.fillType ?? ''}`.toLowerCase()
  return (
    type.includes('liquidation') ||
    type === 'unwindbankrupt' ||
    type === 'unwindcounterparty'
  )
}
