/**
 * Bybit `wallet` push → OutboundAccountPosition on a unified account.
 * Spec: `specs/024.bybit-unified-stream-free-ignores-account-available.md`.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The venue checks a new order against the account's `totalAvailableBalance`,
 * which nets out open positions' unrealized loss. The push mapping streamed
 * `walletBalance - margin` instead, which does not.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'

const connector = () => new UserConnector(true) as any

const coin = (over: Record<string, unknown> = {}) => ({
  coin: 'USDT',
  equity: '8500',
  usdValue: '8500',
  walletBalance: '10000',
  availableToWithdraw: '',
  availableToBorrow: '',
  borrowAmount: '0',
  accruedInterest: '0',
  totalOrderIM: '0',
  totalPositionIM: '7000',
  totalPositionMM: '100',
  unrealisedPnl: '-1500',
  cumRealisedPnl: '0',
  bonus: '0',
  collateralSwitch: true,
  marginCollateral: true,
  locked: '0',
  free: '',
  ...over,
})

const msg = (coins: any[], over: Record<string, unknown> = {}) => ({
  id: '1',
  topic: 'wallet',
  creationTime: '1700000000000',
  data: [
    {
      accountType: 'UNIFIED',
      totalAvailableBalance: '1500',
      coin: coins,
      ...over,
    },
  ],
})

const row = (m: any, asset = 'USDT') =>
  connector()
    .prepareBybitOutboundAccountInfo(m, 'linear')
    .balances.find((b: any) => b.asset === asset)

test('§1.1 losing positions: free is totalAvailableBalance', () => {
  assert.equal(+row(msg([coin()])).free, 1500)
})

test('§1.1 empty per-coin margin fields: free is still the venue figure', () => {
  const b = row(
    msg([coin({ totalPositionIM: '', totalOrderIM: '' })], {
      totalAvailableBalance: '200',
    }),
  )
  assert.equal(+b.free, 200)
})

test('§1.2 free + locked stays the wallet balance', () => {
  const b = row(msg([coin()]))
  assert.equal(+b.free + +b.locked, 10000)
})

test('§1.3 a venue figure above wallet - margin never raises free', () => {
  const b = row(msg([coin()], { totalAvailableBalance: '9000' }))
  assert.equal(+b.free, 3000)
  assert.equal(+b.locked, 7000)
})

test('§1.3 a negative venue figure clamps free to 0', () => {
  assert.equal(+row(msg([coin()], { totalAvailableBalance: '-5' })).free, 0)
})

test('§1.4 missing figure: free unchanged', () => {
  assert.equal(+row(msg([coin()], { totalAvailableBalance: '' })).free, 3000)
})

test('§1.4 non-stable coin: free unchanged', () => {
  const btc = coin({
    coin: 'BTC',
    walletBalance: '1',
    equity: '1',
    usdValue: '90000',
    totalPositionIM: '0',
  })
  assert.equal(+row(msg([btc]), 'BTC').free, 1)
})

test('§1.4 classic CONTRACT account: free unchanged', () => {
  const m = msg([{ ...coin(), collateralSwitch: undefined }], {
    accountType: 'CONTRACT',
  })
  assert.equal(+row(m).free, 3000)
})
