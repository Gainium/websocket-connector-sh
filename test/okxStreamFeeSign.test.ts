/**
 * Spec: specs/017.okx-stream-fee-sign.md.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * OKX states a charge as a NEGATIVE order-level `fee`. main-app reads
 * `feePaid` as a cost and treats anything `<= 0` as "not observed", so a
 * signed charge forwarded unchanged is dropped there and the order falls
 * back to an estimated fee.
 *
 * The main-app test loads main-app's own fee processing from a sibling
 * checkout — `MAIN_APP_CORE`, else `../../main-app/core` — and is skipped
 * when neither exists, as in bitgetStreamFeeSign.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import UserConnector from '../src/userStream'

const connector = () => new UserConnector(true) as any

const okxOrder = (fee: string, feeCcy = 'USDT') => [
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
    fee,
    feeCcy,
    fillFee: '-0.02',
    fillFeeCcy: feeCcy,
  },
]

test('§1.1 a negative OKX charge is forwarded as its cost', () => {
  const [r] = connector().prepareOkxOrderMsg(
    okxOrder('-0.04328943912', 'USDC'),
    'SPOT',
  )
  assert.equal(r.feePaid, '0.04328943912')
  assert.equal(r.feeAsset, 'USDC')
})

test('§1.3 a non-negative OKX fee is forwarded byte-for-byte', () => {
  const uc = connector()
  const [positive] = uc.prepareOkxOrderMsg(okxOrder('0.0123'), 'SPOT')
  assert.equal(positive.feePaid, '0.0123')
  const [zero] = uc.prepareOkxOrderMsg(okxOrder('0'), 'SPOT')
  assert.equal(zero.feePaid, '0')
})

const mainAppCore = [
  process.env.MAIN_APP_CORE,
  path.resolve(__dirname, '../../../main-app/core'),
].find((p) => p && fs.existsSync(path.join(p, 'src/bot/orderFee.ts')))
const skip = mainAppCore ? false : 'main-app core checkout not found'

test(
  '§3 main-app books an OKX USDT stream fee as a quote cost',
  { skip },
  async () => {
    const { streamFeeFields, observedFeeSplit } = await import(
      path.join(mainAppCore as string, 'src/bot/orderFee.ts')
    )
    const { observedFeeLegs } = await import(
      path.join(mainAppCore as string, 'src/bot/feeLedger.ts')
    )
    const [r] = connector().prepareOkxOrderMsg(okxOrder('-0.05'), 'SPOT')
    const order = { baseAsset: 'BTC', quoteAsset: 'USDT', ...streamFeeFields(r) }
    assert.deepEqual(observedFeeSplit(order), { base: 0, quote: 0.05 })
    assert.deepEqual(observedFeeLegs(order), [{ asset: 'USDT', amount: 0.05 }])
  },
)
