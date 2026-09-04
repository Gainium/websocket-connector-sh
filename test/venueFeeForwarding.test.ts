/**
 * Spec: specs/003.forward-venue-fee-for-all-exchanges.md §1.2/§2.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Bybit/OKX/Bitget/Coinbase/Hyperliquid all carry a fee field on their raw
 * private-stream payload today — verified against the already-declared raw
 * types in `src/userStream.ts` and the `coinbase-advanced-node` /
 * `@nktkas/hyperliquid` SDK type declarations — but none of the five
 * `prepare*OrderMsg()` normalizers reads it, so it never reaches the
 * `ExecutionReport` this repo publishes to Redis. Each test below builds a
 * payload shaped like the venue's real (typed) fields and asserts the fee
 * survives into the outgoing report. They are RED today for exactly that
 * reason — the normalizer under test does not reference the fee field at
 * all — not for a shape/parsing mismatch.
 *
 * Kraken spot is now included too — spec §3.1 — using the message shape
 * from Kraken's own official v2 `executions` channel docs (the "Execution"
 * example verbatim, extended to a second trade event to pin the
 * accumulation choice). This is stronger evidence than the field-name
 * inference the other venues rely on, but it is still not a message this
 * account's own traffic has produced — see spec §3.1 items 2-3 for what
 * remains to confirm before shipping. Kraken futures is still absent
 * (spec §3.1a): separate channel, no docs supplied for it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'

const connector = () => new UserConnector(true) as any

test('Bybit: cumExecFee/feeCurrency reach the outgoing report', () => {
  const uc = connector()
  const msg = {
    creationTime: '1',
    data: [
      {
        createType: 'CreateByUser',
        symbol: 'BTCUSDT',
        orderId: 'o1',
        side: 'Buy',
        orderType: 'Limit',
        cancelType: '',
        price: '50000',
        qty: '0.01',
        orderIv: '',
        timeInForce: 'GTC',
        orderStatus: 'Filled',
        orderLinkId: 'c1',
        lastPriceOnCreated: '50000',
        reduceOnly: false,
        leavesQty: '0',
        leavesValue: '0',
        cumExecQty: '0.01',
        cumExecValue: '500',
        avgPrice: '50000',
        blockTradeId: '',
        positionIdx: 0,
        cumExecFee: '0.275',
        createdTime: '1000',
        updatedTime: '2000',
        rejectReason: '',
        stopOrderType: '',
        tpslMode: '',
        triggerPrice: '',
        takeProfit: '',
        stopLoss: '',
        tpTriggerBy: '',
        slTriggerBy: '',
        tpLimitPrice: '',
        slLimitPrice: '',
        triggerDirection: 0,
        triggerBy: '',
        closeOnTrigger: false,
        category: 'linear',
        placeType: '',
        smpType: '',
        smpGroup: 0,
        smpOrderId: '',
        feeCurrency: 'USDT',
      },
    ],
  }
  const [report] = uc.prepareBybitOrderMsg(msg, 'linear')
  assert.equal((report as any).feePaid, '0.275')
  assert.equal((report as any).feeAsset, 'USDT')
})

test('OKX: the order-level fee/feeCcy (not the per-fill fillFee/fillFeeCcy) reaches the outgoing report', () => {
  const uc = connector()
  const msg = [
    {
      instId: 'BTC-USDT',
      instType: 'SPOT',
      cTime: '1000',
      uTime: '2000',
      clOrdId: 'c1',
      ordId: 'o1',
      state: 'filled',
      ordType: 'limit',
      avgPx: '50000',
      px: '50000',
      sz: '0.01',
      accFillSz: '0.01',
      side: 'buy',
      category: 'normal',
      // Order-level running total — the field this spec asks for.
      fee: '-0.05',
      feeCcy: 'USDT',
      // Latest-fill-only — must NOT be what gets forwarded.
      fillFee: '-0.02',
      fillFeeCcy: 'USDT',
    },
  ]
  const [report] = uc.prepareOkxOrderMsg(msg, 'SPOT')
  assert.equal((report as any).feePaid, '-0.05')
  assert.equal((report as any).feeAsset, 'USDT')
})

test('Bitget: feeDetail (cumulative, multi-leg) reaches the outgoing report as feeBreakdown', () => {
  const uc = connector()
  const msg = [
    {
      instId: 'BTCUSDT',
      orderId: 'o1',
      clientOid: 'c1',
      size: '0.01',
      newSize: '0.01',
      notional: '500',
      orderType: 'limit',
      force: 'gtc',
      side: 'buy',
      fillPrice: '50000',
      tradeId: 't1',
      baseVolume: '0.01',
      fillTime: '2000',
      // Single-leg, per-fill — must NOT be what gets forwarded.
      fillFee: '-0.00001',
      fillFeeCoin: 'BTC',
      tradeScope: 'taker',
      accBaseVolume: '0.01',
      priceAvg: '50000',
      price: '50000',
      status: 'filled',
      cTime: '1000',
      uTime: '2000',
      stpMode: '',
      // Cumulative, multi-leg — the field this spec asks for.
      feeDetail: [{ feeCoin: 'USDT', fee: '-0.05' }],
      enterPointSource: '',
    },
  ]
  const [report] = uc.prepareBitgetOrderMsg(msg)
  assert.deepEqual((report as any).feeBreakdown, [
    { asset: 'USDT', amount: '-0.05' },
  ])
})

test('Coinbase: total_fees reaches the outgoing report', () => {
  const uc = connector()
  const order = {
    order_id: 'o1',
    client_order_id: 'c1',
    product_id: 'BTC-USDC',
    order_side: 'BUY',
    order_type: 'Limit',
    creation_time: '2026-08-25T00:43:56.428Z',
    avg_price: '50000',
    cumulative_quantity: '0.01',
    leaves_quantity: '0',
    status: 'FILLED',
    total_fees: '0.05',
  }
  const [report] = uc.prepareCoinbaseOrderMsg({
    sequence_num: 1,
    timestamp: '2026-08-25T08:14:22.349Z',
    events: [{ orders: [order] }],
  })
  assert.equal((report as any).feePaid, '0.05')
})

test('Hyperliquid: per-fill fee/feeToken are summed across fills into the outgoing report', () => {
  const uc = connector()
  const order = {
    order: {
      oid: 1,
      origSz: '0.02',
      sz: '0',
      limitPx: '50000',
    },
    status: 'filled',
    statusTimestamp: 2000,
  }
  const fills = [
    { sz: '0.01', px: '50000', fee: '0.5', feeToken: 'USDC', tid: 1 },
    { sz: '0.01', px: '50000', fee: '0.5', feeToken: 'USDC', tid: 2 },
  ]
  const report = uc.buildHyperliquidExecutionReport(order, fills)
  assert.equal((report as any).feePaid, '1')
  assert.equal((report as any).feeAsset, 'USDC')
})

// Kraken's own v2 `executions` docs example, verbatim (order OK4GJX-KSTLS-7DZZO5,
// BTC/USD, a 0.005 sell partial fill), extended with a second trade event for
// the same order to pin the plan's two resolved-but-unverified choices:
// `fees[]` is accumulated per order (conservative — spec §2.1/§3.1 — until a
// live payload confirms whether it's already cumulative), `fee_usd_equiv` is
// forwarded as-is, never summed (documented as already a running total).
const krakenExecution = (over: Record<string, unknown>) => ({
  order_id: 'OK4GJX-KSTLS-7DZZO5',
  order_userref: 3,
  exec_type: 'trade',
  symbol: 'BTC/USD',
  side: 'sell',
  order_type: 'limit',
  timestamp: '2023-09-22T10:33:05.709993Z',
  order_status: 'partially_filled',
  avg_price: 26599.9,
  ...over,
})

const krakenConnector = () => {
  const uc = new UserConnector(true) as any
  uc.getKrakenMaps = async () => ({
    wsnameToNormalized: new Map([['BTC/USD', 'BTCUSD']]),
  })
  return uc
}

test('Kraken spot: fees[] accumulated per order, fee_usd_equiv passed through unaccumulated', async () => {
  const uc = krakenConnector()
  const emit = (data: unknown) =>
    uc.prepareKrakenOrderMsg(
      { channel: 'executions', type: 'update', data: [data] },
      'executions',
      ExchangeEnum.kraken,
    )

  const [first] = await emit(
    krakenExecution({
      exec_id: 'TGBB7L-HT5LX-J3BZ4A',
      trade_id: 62887576,
      last_qty: 0.005,
      last_price: 26599.9,
      cost: 132.9995,
      cum_qty: 0.005,
      cum_cost: 132.9995,
      fee_usd_equiv: 0.3458,
      fees: [{ asset: 'USD', qty: 0.3458 }],
    }),
  )
  assert.equal((first as any).feePaid, '0.3458')
  assert.equal((first as any).feeAsset, 'USD')
  assert.equal((first as any).feePaidUsd, '0.3458')

  // A second fill on the SAME order: fees[] is this fill's own slice (0.35,
  // not yet summed by Kraken per spec §2.1's conservative reading) but
  // fee_usd_equiv is Kraken's own new running total (0.70, deliberately NOT
  // 0.3458 + 0.70 — chosen unequal to the sum so the assertion can't pass by
  // accident on either the "sum everything" or "forward everything raw" bug).
  const [second] = await emit(
    krakenExecution({
      exec_id: 'TGBB7L-HT5LX-J3BZ4B',
      trade_id: 62887577,
      last_qty: 0.005,
      last_price: 26600.1,
      cost: 133.0005,
      cum_qty: 0.01,
      cum_cost: 265.9,
      order_status: 'filled',
      fee_usd_equiv: 0.7,
      fees: [{ asset: 'USD', qty: 0.35 }],
    }),
  )
  assert.equal((second as any).feePaid, '0.6958')
  assert.equal((second as any).feeAsset, 'USD')
  assert.equal((second as any).feePaidUsd, '0.7')
})
