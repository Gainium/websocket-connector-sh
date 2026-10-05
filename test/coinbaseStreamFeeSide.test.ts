/**
 * Spec: specs/018.coinbase-stream-fee-side.md.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Coinbase's user channel reports `total_fees` with no currency field.
 * Forwarded as a bare `feePaid`, main-app cannot tell which side of the pair
 * it was charged on, so the order falls back to an estimated fee — zero for
 * an account with "Ignore exchange fees" on.
 *
 * The main-app test loads main-app's own fee processing from a sibling
 * checkout — `MAIN_APP_CORE`, else `../../main-app/core` — and is skipped
 * when neither exists, as in okxStreamFeeSign.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import UserConnector from '../src/userStream'

const connector = () => new UserConnector(true) as any

/** A filled ZRX-USDC TP sell, with the fee prod stored for it. */
const zrxSell = {
  order_id: 'o1',
  client_order_id: 'D-TP-c1',
  product_id: 'ZRX-USDC',
  order_side: 'SELL',
  order_type: 'Limit',
  creation_time: '2026-10-05T01:00:00.000Z',
  avg_price: '0.128672',
  cumulative_quantity: '786.50899',
  leaves_quantity: '0',
  status: 'FILLED',
  total_fees: '0.060721010856768',
}

const emit = (order: Record<string, unknown>) =>
  connector().prepareCoinbaseOrderMsg({
    sequence_num: 1,
    timestamp: '2026-10-05T02:16:00.615Z',
    events: [{ orders: [order] }],
  })

test('§1.1 a Coinbase stream fee is stated as charged in quote', () => {
  const [r] = emit(zrxSell)
  assert.equal(r.feePaid, '0.060721010856768')
  assert.equal(r.feeSide, 'quote')
  assert.equal(r.feeAsset, undefined)
})

const mainAppCore = [
  process.env.MAIN_APP_CORE,
  path.resolve(__dirname, '../../../main-app/core'),
].find((p) => p && fs.existsSync(path.join(p, 'src/bot/orderFee.ts')))
const skip = mainAppCore ? false : 'main-app core checkout not found'

test(
  '§3 main-app books a Coinbase stream fee as a quote cost',
  { skip },
  async () => {
    const { streamFeeFields, observedFeeSplit } = await import(
      path.join(mainAppCore as string, 'src/bot/orderFee.ts')
    )
    const { observedFeeLegs } = await import(
      path.join(mainAppCore as string, 'src/bot/feeLedger.ts')
    )
    const [r] = emit(zrxSell)
    const order = {
      baseAsset: 'ZRX',
      quoteAsset: 'USDC',
      ...streamFeeFields(r),
    }
    assert.deepEqual(observedFeeSplit(order), {
      base: 0,
      quote: 0.060721010856768,
    })
    assert.deepEqual(observedFeeLegs(order), [
      { asset: 'USDC', amount: 0.060721010856768 },
    ])
  },
)
