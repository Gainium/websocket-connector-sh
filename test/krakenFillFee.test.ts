/**
 * Kraken futures `fills` feed → the order's venue fee.
 *
 * Each fill carries that fill's `fee_paid` / `fee_currency` (verbatim prod
 * shape below, 2026-11-11T11:00:01Z, PF_XBTUSD: 0.0036993 USD on 0.0001 @
 * 73986 = 5 bp taker). The report carries the running total per currency,
 * deduped by fill_id like the quantity. A fill counted from REST (`/fills`
 * reports no fee) makes the total partial, so the fee is omitted rather
 * than under-reported.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'

const FILL = {
  instrument: 'PF_XBTUSD',
  time: 1794394801547,
  price: 73986,
  buy: true,
  qty: 0.0001,
  remaining_order_qty: 0.0001,
  order_id: 'a3330279-2a6f-4822-b2e5-c154d01f0026',
  cli_ord_id: 'CMB-BO-hcxCF08E88I6FR3Kfn6u8T0hMSq7',
  fill_id: 'eb8a5ada-96e2-4c47-8cd8-dc1b48a87767',
  fill_type: 'taker',
  fee_paid: 0.0036993,
  fee_currency: 'USD',
  taker_order_type: 'market',
  order_type: 'market',
  realized_pnl: 0,
  seq: 100,
}

function connector() {
  const uc = new UserConnector(true) as any
  uc.getKrakenMaps = async () => ({
    wsnameToNormalized: new Map([['PF_XBTUSD', 'BTC-USD']]),
  })
  return uc
}

const forOrder = (id: string, over: Record<string, unknown>) => ({
  ...FILL,
  ...over,
  order_id: `${id}-${FILL.order_id}`,
  fill_id: `${id}-${over.fill_id ?? FILL.fill_id}`,
})

const emit = (uc: any, fills: unknown[], settle?: unknown) =>
  uc.prepareKrakenOrderMsg({ fills }, 'fills', ExchangeEnum.krakenUsdm, settle)

test('fees accumulate per order and dedupe by fill_id', async () => {
  const uc = connector()
  const [a] = await emit(uc, [forOrder('acc', {})])
  assert.equal(a.orderStatus, 'PARTIALLY_FILLED')
  assert.equal(a.feePaid, '0.0036993')
  assert.equal(a.feeAsset, 'USD')

  // redelivery of the same fill changes nothing
  const [dup] = await emit(uc, [forOrder('acc', {})])
  assert.equal(dup.feePaid, '0.0036993')

  const [b] = await emit(uc, [
    forOrder('acc', {
      fill_id: 'second',
      remaining_order_qty: 0,
      fee_paid: 0.0036994,
      price: 73988,
    }),
  ])
  assert.equal(b.orderStatus, 'FILLED')
  assert.equal(b.feePaid, '0.0073987')
  assert.equal(b.feeAsset, 'USD')
})

test('a fill recovered from REST (no fee) drops the fee rather than under-report it', async () => {
  const uc = connector()
  const id = 'rest'
  const settle = async () => [
    {
      fill_id: 'from-rest',
      order_id: `${id}-${FILL.order_id}`,
      size: 0.0001,
      price: 73990,
    },
  ]
  const [r] = await emit(uc, [forOrder(id, { remaining_order_qty: 0 })], settle)
  assert.equal(r.orderStatus, 'FILLED')
  assert.equal(+r.totalTradeQuantity, 0.0002)
  assert.equal('feePaid' in r, false)
  assert.equal('feeAsset' in r, false)
})

test('a fill without fee_paid makes the fee absent, never zero', async () => {
  const uc = connector()
  const { fee_paid, ...noFee } = FILL
  void fee_paid
  const [r] = await emit(uc, [
    { ...noFee, order_id: 'nofee', fill_id: 'nofee-1' },
  ])
  assert.equal('feePaid' in r, false)
})
