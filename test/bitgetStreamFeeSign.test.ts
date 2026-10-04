/**
 * Spec: specs/016.bitget-stream-fee-sign.md.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Bitget states a charge as a NEGATIVE `feeDetail[].fee`. main-app reads
 * `feePaid`/`feeBreakdown` as a cost and treats anything `<= 0` as "not
 * observed", so a signed charge forwarded unchanged is dropped there and the
 * order falls back to an estimated fee. These tests are RED while the Bitget
 * mappers forward the venue's sign unchanged.
 *
 * The last two tests run the mapper's output through main-app's own fee
 * processing (`streamFeeFields` → `observedFeeSplit` / `observedFeeLegs`).
 * main-app is not a dependency of this repo, so they load it from a sibling
 * checkout — `MAIN_APP_CORE`, else `../../main-app/core` — and are skipped
 * when neither exists.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'

const connector = () => new UserConnector(true) as any

const classicOrder = (feeDetail: { feeCoin: string; fee: string }[]) => [
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
    feeDetail,
    enterPointSource: '',
  },
]

const utaOrder = (feeDetail: { feeCoin: string; fee: string }[]) => ({
  category: 'spot',
  symbol: 'BTCUSDT',
  orderId: '111',
  clientOid: 'c1',
  price: '',
  qty: '0.01',
  amount: '500',
  orderType: 'market',
  side: 'buy',
  cumExecQty: '0.01',
  cumExecValue: '500',
  avgPrice: '50000',
  orderStatus: 'filled',
  feeDetail,
  createdTime: '1000',
  updatedTime: '2000',
})

test('§1.1 classic: a negative Bitget charge is forwarded as its cost', () => {
  const [r] = connector().prepareBitgetOrderMsg(
    classicOrder([{ feeCoin: 'USDT', fee: '-0.05' }]),
  )
  assert.equal(r.feePaid, '0.05')
  assert.equal(r.feeAsset, 'USDT')
  assert.deepEqual(r.feeBreakdown, [{ asset: 'USDT', amount: '0.05' }])
})

test('§1.1 classic: every leg of a multi-leg charge is a cost', () => {
  const [r] = connector().prepareBitgetOrderMsg(
    classicOrder([
      { feeCoin: 'BGB', fee: '-0.001' },
      { feeCoin: 'USDT', fee: '-0.03' },
    ]),
  )
  assert.deepEqual(r.feeBreakdown, [
    { asset: 'BGB', amount: '0.001' },
    { asset: 'USDT', amount: '0.03' },
  ])
  // Leg choice unchanged (§1.3): the quote leg still wins.
  assert.equal(r.feePaid, '0.03')
  assert.equal(r.feeAsset, 'USDT')
})

test('§1.1 unified account: a negative charge is forwarded as its cost', () => {
  const [r] = connector().prepareBitgetUtaOrderMsg(
    [utaOrder([{ feeCoin: 'USDT', fee: '-0.05' }])],
    ExchangeEnum.bitget,
  )
  assert.equal(r.feePaid, '0.05')
  assert.deepEqual(r.feeBreakdown, [{ asset: 'USDT', amount: '0.05' }])
})

test('§1.3 a non-negative Bitget fee is forwarded byte-for-byte', () => {
  const uc = connector()
  const [classic] = uc.prepareBitgetOrderMsg(
    classicOrder([{ feeCoin: 'USDT', fee: '0.0332526' }]),
  )
  assert.equal(classic.feePaid, '0.0332526')
  assert.deepEqual(classic.feeBreakdown, [
    { asset: 'USDT', amount: '0.0332526' },
  ])
  const [uta] = uc.prepareBitgetUtaOrderMsg(
    [utaOrder([{ feeCoin: 'USDT', fee: '0' }])],
    ExchangeEnum.bitget,
  )
  assert.equal(uta.feePaid, '0')
  const [none] = uc.prepareBitgetOrderMsg(classicOrder([]))
  assert.equal(none.feePaid, undefined)
  assert.deepEqual(none.feeBreakdown, [])
})

const mainAppCore = [
  process.env.MAIN_APP_CORE,
  path.resolve(__dirname, '../../../main-app/core'),
].find((p) => p && fs.existsSync(path.join(p, 'src/bot/orderFee.ts')))
const skip = mainAppCore ? false : 'main-app core checkout not found'

const throughMainApp = async (report: any) => {
  const { streamFeeFields, observedFeeSplit } = await import(
    path.join(mainAppCore as string, 'src/bot/orderFee.ts')
  )
  const { observedFeeLegs } = await import(
    path.join(mainAppCore as string, 'src/bot/feeLedger.ts')
  )
  const order = {
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    ...streamFeeFields(report),
  }
  return {
    split: observedFeeSplit(order),
    legs: observedFeeLegs(order),
  }
}

test(
  '§3 main-app books a USDT stream fee as a quote cost',
  { skip },
  async () => {
    const [r] = connector().prepareBitgetOrderMsg(
      classicOrder([{ feeCoin: 'USDT', fee: '-0.05' }]),
    )
    const { split, legs } = await throughMainApp(r)
    assert.deepEqual(split, { base: 0, quote: 0.05 })
    assert.deepEqual(legs, [{ asset: 'USDT', amount: 0.05 }])
  },
)

test('§3 main-app ledgers a BGB stream fee as one leg', { skip }, async () => {
  const [r] = connector().prepareBitgetOrderMsg(
    classicOrder([{ feeCoin: 'BGB', fee: '-0.0012' }]),
  )
  const { split, legs } = await throughMainApp(r)
  // Off-pair, so the split still falls back to the estimate — as a
  // REST-sourced BGB fee already does — but the ledger now records it.
  assert.equal(split, null)
  assert.deepEqual(legs, [{ asset: 'BGB', amount: 0.0012 }])
})
