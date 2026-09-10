/**
 * Kraken spot v2 `executions` → ExecutionReport status + symbol (spec 007).
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Every payload below is a REAL production message, verbatim from the
 * user-stream log (2026-09-10), in the order the venue delivered it.
 *
 * Two defects, one code path (spec 007 §1.2):
 *  (a) the branch read `order.status`; Kraken v2 sends `order_status`, so
 *      every spot execution was emitted as NEW — a no-op for fills in
 *      `app-sh` — and the fill was only recovered later by the REST sweep;
 *  (b) the terminal `filled`/`canceled` summaries carry no `symbol`, so the
 *      report that books the fill priced it through a missed
 *      `getExchangeInfo('')` and got MathHelper.round's 2-decimal default.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'

/** Grid order on SOL/USDC — a market buy. Arrival order preserved. */
const SOL_NEW = {
  timestamp: '2026-09-10T21:32:35.921979Z',
  order_status: 'new',
  exec_type: 'new',
  cl_ord_id: 'GRID-BO-DVe742G3Eq',
  order_id: 'OJUFYI-6DJSE-BNXAKJ',
}
const SOL_TRADE = {
  order_id: 'OJUFYI-6DJSE-BNXAKJ',
  cl_ord_id: 'GRID-BO-DVe742G3Eq',
  exec_id: 'TNPY35-6GCT5-MINCYT',
  exec_type: 'trade',
  trade_id: 1725702,
  symbol: 'SOL/USDC',
  side: 'buy',
  last_qty: 1.80406743,
  last_price: 99.95,
  liquidity_ind: 't',
  cost: 180.31654,
  order_type: 'market',
  timestamp: '2026-09-10T21:32:35.921979Z',
  order_status: 'partially_filled',
  cum_qty: 1.80406743,
  cum_cost: 180.31654,
  avg_price: 99.95,
  fee_usd_equiv: 0,
  fees: [{ asset: 'USDC', qty: 0.685203 }],
}
const SOL_FILLED = {
  timestamp: '2026-09-10T21:32:35.921979Z',
  order_status: 'filled',
  exec_type: 'filled',
  cum_qty: 1.80406743,
  cum_cost: 180.31654,
  fee_usd_equiv: 0,
  avg_price: 99.95,
  cl_ord_id: 'GRID-BO-DVe742G3Eq',
  order_id: 'OJUFYI-6DJSE-BNXAKJ',
}

/** Combo-bot grid order on SN51/USD — placed, rested, then cancelled. */
const SN51_PENDING_NEW = {
  order_id: 'O3M3V4-5FY2F-55AQNT',
  symbol: 'SN51/USD',
  order_qty: 1.75351,
  cum_cost: 0,
  time_in_force: 'GTC',
  exec_type: 'pending_new',
  side: 'buy',
  order_type: 'limit',
  cl_ord_id: 'CMB-GR-bGLyTuIQNle',
  limit_price_type: 'static',
  limit_price: 23.384,
  stop_price: 0,
  order_status: 'pending_new',
  fee_usd_equiv: 0,
  fee_ccy_pref: 'fciq',
  timestamp: '2026-09-10T22:24:50.850096Z',
}
const SN51_CANCELED = {
  timestamp: '2026-09-10T22:51:18.435685Z',
  order_status: 'canceled',
  exec_type: 'canceled',
  cum_qty: 0,
  cum_cost: 0,
  fee_usd_equiv: 0,
  avg_price: 0,
  cl_ord_id: 'CMB-GR-bGLyTuIQNle',
  cancel_reason: 'User requested',
  reason: 'User requested',
  order_id: 'O3M3V4-5FY2F-55AQNT',
}

const krakenConnector = () => {
  const uc = new UserConnector(true) as any
  uc.getKrakenMaps = async () => ({
    wsnameToNormalized: new Map([
      ['SOL/USDC', 'SOLUSDC'],
      ['SN51/USD', 'SN51USD'],
    ]),
  })
  return uc
}

/** Feed one venue frame, exactly as the `executions` channel delivers it. */
const emit = (uc: any, ...data: unknown[]) =>
  uc.prepareKrakenOrderMsg(
    { channel: 'executions', type: 'update', data },
    'executions',
    ExchangeEnum.kraken,
  )

test('spec 007 §5.1: order_status drives orderStatus (not the absent `status`)', async () => {
  const uc = krakenConnector()

  const [nw] = await emit(uc, SOL_NEW)
  assert.equal(nw.orderStatus, 'NEW')

  const [trade] = await emit(uc, SOL_TRADE)
  // Read from `order.status` this came back 'NEW' and no fill was ever booked.
  assert.equal(trade.orderStatus, 'PARTIALLY_FILLED')

  const [filled] = await emit(uc, SOL_FILLED)
  assert.equal(filled.orderStatus, 'FILLED')

  const uc2 = krakenConnector()
  const [pending] = await emit(uc2, SN51_PENDING_NEW)
  assert.equal(pending.orderStatus, 'NEW')

  const [canceled] = await emit(uc2, SN51_CANCELED)
  assert.equal(canceled.orderStatus, 'CANCELED')
})

test('spec 007 §5.2: a symbol-less terminal frame inherits the order symbol', async () => {
  const uc = krakenConnector()

  // Detail frames teach the symbol...
  const [trade] = await emit(uc, SOL_TRADE)
  assert.equal(trade.symbol, 'SOLUSDC')

  // ...so the terminal summary, which carries none, still knows it.
  const [filled] = await emit(uc, SOL_FILLED)
  assert.equal(filled.symbol, 'SOLUSDC')
  // The report that books the fill: symbol '' made app-sh miss
  // getExchangeInfo and round this price to 2dp.
  assert.equal(filled.orderStatus, 'FILLED')
  // Value, not runtime type: this branch has always passed Kraken's numeric
  // `cum_qty` straight through a field the interface types as string (spec
  // 007 §4.4). Pre-existing, out of scope, and harmless — the schema path is
  // mongoose `RequiredString` (casts on save) and every downstream read
  // coerces with `+`/`parseFloat`.
  assert.equal(Number(filled.totalTradeQuantity), 1.80406743)

  // Same via `pending_new` on an order that never traded, then cancelled
  // ~27 minutes later.
  const uc2 = krakenConnector()
  await emit(uc2, SN51_PENDING_NEW)
  const [canceled] = await emit(uc2, SN51_CANCELED)
  assert.equal(canceled.symbol, 'SN51USD')
  assert.equal(canceled.orderStatus, 'CANCELED')
})

test('spec 007 §5.3: a batched frame resolves regardless of order within it', async () => {
  const uc = krakenConnector()
  // Terminal summary FIRST, detail second — the inverted market-order burst.
  const [filled, trade] = await emit(uc, SOL_FILLED, SOL_TRADE)
  assert.equal(filled.symbol, 'SOLUSDC')
  assert.equal(trade.symbol, 'SOLUSDC')
})

test('spec 007 §5.2/§5.4: unknown order falls back to empty; first-hand symbol unchanged', async () => {
  const uc = krakenConnector()

  // Nothing ever seen for this order id — must not throw, must not borrow
  // another order's symbol.
  const [orphan] = await emit(uc, {
    ...SOL_FILLED,
    order_id: 'ONEVER-SEEN-BEFORE',
    cl_ord_id: 'GRID-BO-neverSeen',
  })
  assert.equal(orphan.symbol, '')
  assert.equal(orphan.orderStatus, 'FILLED')

  // An entry carrying its own symbol is normalized exactly as before.
  const [trade] = await emit(uc, SOL_TRADE)
  assert.equal(trade.symbol, 'SOLUSDC')

  // An unmapped wsname still passes through raw (pre-existing behaviour).
  const [unmapped] = await emit(uc, { ...SOL_TRADE, symbol: 'XYZ/USD' })
  assert.equal(unmapped.symbol, 'XYZ/USD')
})

test('spec 007 §5.5: spec 003 fee forwarding is unchanged', async () => {
  const uc = krakenConnector()
  const [trade] = await emit(uc, SOL_TRADE)
  assert.equal(trade.feePaid, '0.685203')
  assert.equal(trade.feeAsset, 'USDC')
  assert.equal(trade.feePaidUsd, '0')
})
