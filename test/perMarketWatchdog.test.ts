/**
 * The price watchdog judges each market of a connector on its own.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Every connector used to give all its markets one shared liveness record
 * (`mainData[market] = this.base`), so data on spot refreshed USDM too and a
 * dead market was hidden by a live sibling. Nothing here opens a socket: the
 * watchdog runs against a fake `this`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import CommonConnector from '../src/price/common'
import { stallOf } from '../src/price/stallEscalation'
import { ExchangeEnum } from '../src/utils/common'

const proto = CommonConnector.prototype as any
const baseGetter = Object.getOwnPropertyDescriptor(proto, 'base')!.get!

function fake(role: 'ticker' | 'candle' = 'ticker') {
  const handled: string[] = []
  const self: any = {
    mainData: {},
    timeout: 50_000,
    tradeTimeout: 75_000,
    connectTime: 50_000,
    isCandle: role === 'candle',
    isAll: false,
    maxTargetedRestarts: 2,
    targetedRestarts: new Map(),
    redis: { publish: () => undefined },
    handleStall: (e: string, kind: string) => {
      handled.push(`${kind}|${e}`)
      return false
    },
  }
  Object.defineProperty(self, 'base', { get: baseGetter })
  for (const m of [
    'watchdogFn',
    'checkClientStalls',
    'reportStall',
    'escalateOrHandle',
    'isFeedAlive',
    'getPriceTimeout',
    'getTradeTimeout',
  ]) {
    self[m] = proto[m].bind(self)
  }
  return { self, handled }
}

const run = (self: any) => {
  try {
    self.watchdogFn()
    return null
  } catch (e) {
    return stallOf((e as Error).message)
  }
}

test('each market gets its own liveness record', () => {
  const { self } = fake()
  self.mainData[ExchangeEnum.bitget] = self.base
  self.mainData[ExchangeEnum.bitgetUsdm] = self.base
  assert.notEqual(
    self.mainData[ExchangeEnum.bitget],
    self.mainData[ExchangeEnum.bitgetUsdm],
  )
})

test('one market quiet for less than its own window is not flagged', () => {
  const { self } = fake()
  const now = Date.now()
  self.mainData[ExchangeEnum.bybit] = { ...self.base, lastData: now - 1_000 }
  self.mainData[ExchangeEnum.bybitCoinm] = {
    ...self.base,
    lastData: now - 120_000,
  }
  assert.equal(run(self), null)
})

test('every market quiet past the shared timeout is still a stall', () => {
  const { self } = fake()
  const now = Date.now()
  self.mainData[ExchangeEnum.okx] = { ...self.base, lastData: now - 60_000 }
  self.mainData[ExchangeEnum.okxLinear] = {
    ...self.base,
    lastData: now - 70_000,
  }
  assert.deepEqual(run(self), { exchange: ExchangeEnum.okx, kind: 'price' })
})

test('a dead market is caught while its sibling is live', () => {
  const { self } = fake()
  const now = Date.now()
  self.mainData[ExchangeEnum.bitget] = { ...self.base, lastData: now - 1_000 }
  self.mainData[ExchangeEnum.bitgetUsdm] = {
    ...self.base,
    lastData: now - 200_000,
  }
  assert.deepEqual(run(self), {
    exchange: ExchangeEnum.bitgetUsdm,
    kind: 'price',
  })
})

test('a market that never delivered (disabled) does not trip while a sibling delivers', () => {
  const { self } = fake()
  const now = Date.now()
  self.mainData[ExchangeEnum.bitget] = { ...self.base, lastData: now - 1_000 }
  self.mainData[ExchangeEnum.bitgetCoinm] = {
    ...self.base,
    connectTime: now - 600_000,
  }
  assert.equal(run(self), null)
})

test('nothing delivered on any market past the connect time is still a connect stall', () => {
  const { self } = fake()
  const now = Date.now()
  self.mainData[ExchangeEnum.bybit] = {
    ...self.base,
    connectTime: now - 60_000,
  }
  self.mainData[ExchangeEnum.bybitUsdm] = { ...self.base }
  assert.deepEqual(run(self), { exchange: ExchangeEnum.bybit, kind: 'price' })
})

test('candles stay judged across markets: one market without candles is not dead', () => {
  const { self } = fake('candle')
  const now = Date.now()
  self.mainData[ExchangeEnum.okx] = { ...self.base, lastDataTrade: 0 }
  self.mainData[ExchangeEnum.okxLinear] = {
    ...self.base,
    lastDataTrade: now - 1_000,
  }
  self.mainData[ExchangeEnum.okxInverse] = {
    ...self.base,
    lastDataTrade: now - 600_000,
  }
  assert.equal(run(self), null)
  self.mainData[ExchangeEnum.okxLinear].lastDataTrade = now - 100_000
  assert.deepEqual(run(self), {
    exchange: ExchangeEnum.okxLinear,
    kind: 'candle',
  })
})

test("a sibling's data no longer resets a dead market's restart budget", () => {
  const { self, handled } = fake()
  self.handleStall = (e: string, kind: string) => {
    handled.push(`${kind}|${e}`)
    return true
  }
  const now = Date.now()
  self.mainData[ExchangeEnum.hyperliquid] = { ...self.base, lastData: now }
  self.mainData[ExchangeEnum.hyperliquidLinear] = {
    ...self.base,
    lastData: now - 200_000,
  }
  const kill = () =>
    (self.mainData[ExchangeEnum.hyperliquidLinear].lastData =
      Date.now() - 200_000)
  assert.equal(run(self), null)
  kill()
  self.targetedRestarts.delete(ExchangeEnum.hyperliquid) // sibling data
  assert.equal(run(self), null)
  kill()
  assert.deepEqual(run(self), {
    exchange: ExchangeEnum.hyperliquidLinear,
    kind: 'price',
  })
  assert.deepEqual(handled, [
    'price|hyperliquidLinear',
    'price|hyperliquidLinear',
  ])
})
