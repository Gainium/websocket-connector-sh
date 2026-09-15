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

/** One WS message carrying a whole batch, exactly as Kraken delivers it. */
const emitBatch = (uc: any, fills: unknown[]) =>
  uc.prepareKrakenOrderMsg({ fills }, 'fills', ExchangeEnum.krakenUsdm)

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

/**
 * Bug #769 (spec 009). A `fills` message can carry the WHOLE batch, delivered
 * NEWEST-FIRST. Order D-BO-lDG9nW4K2gWCFBHnoyMggTj5oIHmgc: a LIMIT BUY of
 * 0.0955 BTC-USD @78460 taker-filled in 4 chunks, all stamped 15:00:02.492Z.
 *
 * The array order below is reconstructed from the relay's OWN emitted
 * cumulative totals in the prod log (0.0139 / 0.0235 / 0.0551 / 0.0955):
 * emitted cumulative #k == 0.0955 - remaining_order_qty of fill #k, which is
 * self-consistent only for a strictly reverse-chronological batch. `time` is
 * identical across all four, so `seq` is what actually orders them.
 *
 * Mapping in array order emitted FILLED at 0.0139 — 6.9x short — and app-sh
 * treated that as final, sent a market buy for the 0.0816 "shortfall" Kraken
 * had already filled, and sized the TP from 0.0139. 0.1632 BTC ended up held
 * with no deal, no TP and no SL.
 */
const BTC_BATCH_NEWEST_FIRST = (() => {
  const base = {
    instrument: 'PF_XBTUSD',
    time: 1789045202492,
    price: 78460,
    buy: true,
    order_id: 'batch-a1b2c3',
    cli_ord_id: 'D-BO-lDG9nW4K2gWCFBHnoyMggTj5oIHmgc',
    fill_type: 'taker',
    order_type: 'limit',
  }
  return [
    { ...base, qty: 0.0139, remaining_order_qty: 0, fill_id: 'b-f4', seq: 4 },
    {
      ...base,
      qty: 0.0096,
      remaining_order_qty: 0.0139,
      fill_id: 'b-f3',
      seq: 3,
    },
    {
      ...base,
      qty: 0.0316,
      remaining_order_qty: 0.0235,
      fill_id: 'b-f2',
      seq: 2,
    },
    {
      ...base,
      qty: 0.0404,
      remaining_order_qty: 0.0551,
      fill_id: 'b-f1',
      seq: 1,
    },
  ]
})()

test('a multi-fill batch delivered newest-first reports FILLED last, at the full quantity', async () => {
  const uc = connector()
  uc.getKrakenMaps = async () => ({
    wsnameToNormalized: new Map([['PF_XBTUSD', 'BTC-USD']]),
  })

  const reports = await emitBatch(uc, BTC_BATCH_NEWEST_FIRST)
  assert.equal(reports.length, 4)

  // §1.1b — exactly one FILLED, and it is the LAST report emitted. The bug:
  // reports[0] was FILLED at 0.0139 and the rest were PARTIALLY_FILLED.
  assert.deepEqual(
    reports.map((r: any) => r.orderStatus),
    ['PARTIALLY_FILLED', 'PARTIALLY_FILLED', 'PARTIALLY_FILLED', 'FILLED'],
  )
  assert.ok(Math.abs(+reports[3].totalTradeQuantity - 0.0955) < 1e-9)

  // §1.1a — cumulative, non-decreasing, ending at the full size.
  const cumulative = reports.map((r: any) => +r.totalTradeQuantity)
  for (let i = 1; i < cumulative.length; i++) {
    assert.ok(
      cumulative[i] >= cumulative[i - 1],
      `cumulative went backwards: ${cumulative[i - 1]} -> ${cumulative[i]}`,
    )
  }

  // §1.1c — the order's original size, on EVERY report. The bug drifted this
  // to 0.1506 for an order of 0.0955.
  for (const r of reports) {
    assert.ok(
      Math.abs(+r.quantity - 0.0955) < 1e-9,
      `quantity should be the 0.0955 placed, got ${r.quantity}`,
    )
  }

  // Cumulative notional follows the same chronological order, so the VWAP main
  // -app derives from quote/base is the real one.
  assert.ok(
    Math.abs(+reports[3].totalQuoteTradeQuantity - 0.0955 * 78460) < 1e-6,
  )
})

test('a batch already in chronological order is mapped unchanged', async () => {
  const uc = connector()
  uc.getKrakenMaps = async () => ({
    wsnameToNormalized: new Map([['PF_XBTUSD', 'BTC-USD']]),
  })

  const chronological = [...BTC_BATCH_NEWEST_FIRST].reverse().map((f) => ({
    ...f,
    order_id: 'chrono-a1b2c3',
    fill_id: `c-${f.fill_id}`,
  }))

  const reports = await emitBatch(uc, chronological)
  assert.deepEqual(
    reports.map((r: any) => r.orderStatus),
    ['PARTIALLY_FILLED', 'PARTIALLY_FILLED', 'PARTIALLY_FILLED', 'FILLED'],
  )
  assert.ok(Math.abs(+reports[3].totalTradeQuantity - 0.0955) < 1e-9)
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
