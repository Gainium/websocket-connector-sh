/**
 * Bitget classic futures `account` push → OutboundAccountPosition.
 * Spec: `specs/023.bitget-futures-stream-free-ignores-cross-unrealized-loss.md`.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * In cross mode the venue accepts a new order only up to its own
 * `maxOpenPosAvailable`, which subtracts the open cross positions' unrealized
 * loss. The push's `available` does not, and it was streamed as `free`, so a
 * bot with losing cross positions saw a balance the venue would not let it
 * spend. Payload shape: docs/contract/websocket/private/Account-Channel.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'

const connector = () => new UserConnector(true) as any

// wallet balance 10000 = equity 8500 - unrealizedPL (-1500);
// the venue lets the account open 800 more.
const LOSING_CROSS = {
  marginCoin: 'USDT',
  frozen: '0',
  available: '3000',
  maxOpenPosAvailable: '800',
  maxTransferOut: '800',
  equity: '8500',
  usdtEquity: '8500',
  crossedRiskRate: '0.1',
  unrealizedPL: '-1500',
}

const usdt = (msg: any) => msg.balances.find((b: any) => b.asset === 'USDT')

test('§1.1 losing cross positions: free is the venue maxOpenPosAvailable', () => {
  const b = usdt(
    connector().prepareBitgetFuturesOutboundAccountInfo(
      [LOSING_CROSS],
      1,
      'u',
      'USDT-FUTURES',
    ),
  )
  assert.equal(+b.free, 800)
})

test('§1.2 free + locked stays the wallet balance', () => {
  const b = usdt(
    connector().prepareBitgetFuturesOutboundAccountInfo(
      [LOSING_CROSS],
      1,
      'u',
      'USDT-FUTURES',
    ),
  )
  assert.equal(+b.free + +b.locked, 10000)
})

test('§1.3 a venue figure above available never raises free', () => {
  const b = usdt(
    connector().prepareBitgetFuturesOutboundAccountInfo(
      [{ ...LOSING_CROSS, maxOpenPosAvailable: '4500' }],
      1,
      'u',
      'USDT-FUTURES',
    ),
  )
  assert.equal(+b.free, 3000)
})

test('§1.4 missing venue figure: free is available, as before', () => {
  const { maxOpenPosAvailable: _, ...row } = LOSING_CROSS
  const b = usdt(
    connector().prepareBitgetFuturesOutboundAccountInfo(
      [row],
      1,
      'u',
      'USDT-FUTURES',
    ),
  )
  assert.equal(+b.free, 3000)
  assert.equal(+b.free + +b.locked, 10000)
})

test('§3 COIN-FUTURES pushes are not capped (out of scope)', () => {
  const b = connector().prepareBitgetFuturesOutboundAccountInfo(
    [
      {
        ...LOSING_CROSS,
        marginCoin: 'BTC',
        unrealizedPL: '0',
        equity: '10000',
      },
    ],
    1,
    'u',
    'COIN-FUTURES',
  ).balances[0]
  assert.equal(+b.free, 3000)
})
