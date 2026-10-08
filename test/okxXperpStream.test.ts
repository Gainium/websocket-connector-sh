/**
 * OKX Europe X-Perps are listed under instType FUTURES, not SWAP. The user
 * stream subscribed to (and kept) SWAP order updates only, so no X-Perp fill
 * ever arrived over the stream; each was booked late by the REST sweep.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector, { okxOrderInstTypes } from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'

const connector = () => new UserConnector(true) as any

const order = (instId: string, instType: string) => ({
  instId,
  instType,
  cTime: '1000',
  uTime: '2000',
  clOrdId: 'c1',
  ordId: 'o1',
  state: 'filled',
  ordType: 'limit',
  avgPx: '25',
  px: '25',
  sz: '3',
  accFillSz: '3',
  side: 'buy',
  category: 'normal',
  fee: '-0.01',
  feeCcy: 'USD',
})

test('a linear connection subscribes to SWAP and FUTURES orders', () => {
  assert.deepEqual(okxOrderInstTypes(ExchangeEnum.okxLinear), [
    'SWAP',
    'FUTURES',
  ])
  assert.deepEqual(okxOrderInstTypes(ExchangeEnum.okx), ['SPOT'])
  assert.deepEqual(okxOrderInstTypes(ExchangeEnum.okxInverse), ['SWAP'])
})

test('an X-Perp fill is forwarded under its pair id', () => {
  const [r] = connector().prepareOkxOrderMsg(
    [order('SOXL-USD_UM_XPERP-310523', 'FUTURES')],
    okxOrderInstTypes(ExchangeEnum.okxLinear),
  )
  assert.equal(r.symbol, 'SOXL-USD_UM_XPERP')
  assert.equal(r.orderStatus, 'FILLED')
  assert.equal(r.newClientOrderId, 'c1')
})

test('a global swap fill is unchanged', () => {
  const [r] = connector().prepareOkxOrderMsg(
    [order('BTC-USDT-SWAP', 'SWAP')],
    okxOrderInstTypes(ExchangeEnum.okxLinear),
  )
  assert.equal(r.symbol, 'BTC-USDT')
})

test('an instType the connection did not subscribe to is still dropped', () => {
  const out = connector().prepareOkxOrderMsg(
    [order('BTC-USDT', 'SPOT')],
    okxOrderInstTypes(ExchangeEnum.okxLinear),
  )
  assert.equal(out.length, 0)
})
