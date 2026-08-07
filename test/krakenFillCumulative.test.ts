/**
 * Kraken futures `fills` feed → ExecutionReport cumulative-quantity contract.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Kraken's `fills` feed reports one fill at a time (`qty`, `price`,
 * `remaining_order_qty`), while `ExecutionReport.totalTradeQuantity` is the
 * CUMULATIVE executed quantity — main-app assigns it straight to
 * `order.executedQty`. The two payloads below are the real prod messages for
 * order D-TP-5VRYGIvnDOZ9OSNarX4yva67AtxKCv (bug #332): a 0.07 XAUT-USD
 * reduce-only close that filled 0.037 + 0.033. Emitting the per-fill qty made
 * the FILLED report say 0.033, so the deal kept a phantom 0.037 residual and
 * chased it with reduce-only orders Kraken rejects as `wouldNotReducePosition`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'

/** Real prod fills, verbatim from the user-stream log (2026-08-07T08:36:23Z). */
const FILL_1 = {
  instrument: 'PF_XAUTUSD',
  time: 1786091783778,
  price: 4282.5,
  buy: false,
  qty: 0.037,
  remaining_order_qty: 0.033,
  order_id: 'a271b0a1-7e88-49ad-9057-7047303410ba',
  cli_ord_id: 'D-TP-5VRYGIvnDOZ9OSNarX4yva67AtxKCv',
  fill_id: 'd59a4a5e-64d9-48fa-857c-addfb24e30e9',
  fill_type: 'taker',
  order_type: 'market',
  seq: 23,
}
const FILL_2 = {
  ...FILL_1,
  price: 4282.3,
  qty: 0.033,
  remaining_order_qty: 0,
  fill_id: '5aa4ed26-0d2a-4b02-9d10-457ac792875e',
  seq: 24,
}

/** testMode skips rabbit/redis; the symbol map is the only other dependency. */
function connector() {
  const uc = new UserConnector(true) as any
  uc.getKrakenMaps = async () => ({
    wsnameToNormalized: new Map([['PF_XAUTUSD', 'XAUT-USD']]),
  })
  return uc
}

const emit = (uc: any, fill: unknown) =>
  uc.prepareKrakenOrderMsg({ fills: [fill] }, 'fills', ExchangeEnum.krakenUsdm)

/**
 * The accumulator is module-level on purpose — in production ONE process sees
 * every fill of an order, and it must survive across `prepareKrakenOrderMsg`
 * calls. node:test runs these in that same process, so each test rebases the
 * order/fill ids onto its own namespace instead of sharing FILL_1's.
 */
const forOrder = (id: string, fill: typeof FILL_1) => ({
  ...fill,
  order_id: `${id}-${fill.order_id}`,
  fill_id: `${id}-${fill.fill_id}`,
})

test('a two-chunk fill reports cumulative executed quantity', async () => {
  const uc = connector()

  const [first] = await emit(uc, forOrder('two-chunk', FILL_1))
  assert.equal(first.orderStatus, 'PARTIALLY_FILLED')
  assert.equal(+first.totalTradeQuantity, 0.037)

  const [second] = await emit(uc, forOrder('two-chunk', FILL_2))
  assert.equal(second.orderStatus, 'FILLED')
  // The bug: this used to be 0.033 (the last chunk) instead of the full 0.07.
  assert.equal(+second.totalTradeQuantity, 0.07)
  // Cumulative notional (0.037 * 4282.5 + 0.033 * 4282.3), so main-app's
  // quote/base gives the real VWAP.
  assert.ok(Math.abs(+second.totalQuoteTradeQuantity - 299.7684) < 1e-6)
  assert.ok(
    Math.abs(
      +second.totalQuoteTradeQuantity / +second.totalTradeQuantity - 4282.406,
    ) < 1e-3,
  )
  // The report is self-consistent: filled + remaining == the order quantity.
  assert.equal(+second.quantity, 0.07)
})

test('a redelivered fill does not double-count', async () => {
  const uc = connector()

  await emit(uc, forOrder('redelivered', FILL_1))
  await emit(uc, forOrder('redelivered', FILL_1))
  const [second] = await emit(uc, forOrder('redelivered', FILL_2))

  assert.equal(+second.totalTradeQuantity, 0.07)
})

test('fills of different orders are accumulated independently', async () => {
  const uc = connector()
  await emit(uc, forOrder('independent-a', FILL_1))
  const [otherReport] = await emit(uc, forOrder('independent-b', FILL_1))
  const [second] = await emit(uc, forOrder('independent-a', FILL_2))

  assert.equal(+otherReport.totalTradeQuantity, 0.037)
  assert.equal(+second.totalTradeQuantity, 0.07)
})

test('a single-fill order is unchanged', async () => {
  const uc = connector()
  const [only] = await emit(uc, {
    ...forOrder('single', FILL_1),
    remaining_order_qty: 0,
  })

  assert.equal(only.orderStatus, 'FILLED')
  assert.equal(+only.totalTradeQuantity, 0.037)
  assert.ok(Math.abs(+only.totalQuoteTradeQuantity - 158.4525) < 1e-6)
  assert.equal(+only.quantity, 0.037)
})
