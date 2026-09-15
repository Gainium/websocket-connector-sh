/**
 * Bitget Reality stock token (rAAPL) candles on the price connector.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Bitget accepts a v2 `candle*` subscription for a Reality token and never
 * pushes on it (checked live on RAAPLUSDT: ticker and trade push, candle1m/5m/
 * 1H/1D stay silent), while the v3 `kline` topic pushes 1m/5m/15m/1H/4H/1D.
 * v3's 1D bucket starts at 16:00 UTC, so only the UTC-aligned intervals are
 * streamed. Nothing here opens a socket: the connector methods run against a
 * fake `this`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import BitgetConnector from '../src/price/bitget'
import { ExchangeEnum } from '../src/utils/common'
import {
  bitgetRealityKlineInterval,
  setBitgetRealitySymbols,
} from '../src/utils/bitgetReality'

const proto = BitgetConnector.prototype as any

function fake() {
  const subscribed: unknown[] = []
  const published: { trade: any; exchange: ExchangeEnum }[] = []
  const self: any = {
    realityChannels: new Map<string, string>(),
    mainData: {},
    base: {},
    bitgetClientCandleReality: [
      {
        client: { subscribe: (t: unknown) => subscribed.push(t) },
        subs: 0,
        id: 0,
      },
    ],
    cbWsTrade: (trade: any, exchange: ExchangeEnum) =>
      published.push({ trade, exchange }),
    timer: new Map(),
    inQueueCandles: new Map(),
  }
  self.subscribeBitgetRealityCandle =
    proto.subscribeBitgetRealityCandle.bind(self)
  self.bitgetRealityCandleCb = proto.bitgetRealityCandleCb.bind(self)
  return { self, subscribed, published }
}

test('only UTC-aligned v3 intervals are streamed for Reality tokens', () => {
  assert.deepEqual(
    [
      'candle1m',
      'candle5m',
      'candle15m',
      'candle30m',
      'candle1H',
      'candle4H',
      'candle1Dutc',
      'candle1Wutc',
      '2h',
    ].map(bitgetRealityKlineInterval),
    ['1m', '5m', '15m', undefined, '1H', '4H', undefined, undefined, undefined],
  )
})

test('a Reality subscription goes to v3 kline, once per symbol+interval', () => {
  const { self, subscribed } = fake()
  self.subscribeBitgetRealityCandle('RAAPLUSDT', 'candle1H')
  self.subscribeBitgetRealityCandle('RAAPLUSDT', 'candle1H')
  self.subscribeBitgetRealityCandle('RAAPLUSDT', 'candle1Dutc')
  assert.deepEqual(subscribed, [
    { instType: 'spot', topic: 'kline', symbol: 'RAAPLUSDT', interval: '1H' },
  ])
  assert.equal(self.realityChannels.get('RAAPLUSDT|1H'), 'candle1H')
})

test('a v3 kline update is published on the v2 channel name main-app subscribed', () => {
  const { self, published } = fake()
  self.subscribeBitgetRealityCandle('RAAPLUSDT', 'candle1m')
  self.bitgetRealityCandleCb({
    action: 'update',
    arg: {
      instType: 'spot',
      topic: 'kline',
      symbol: 'RAAPLUSDT',
      interval: '1m',
    },
    data: [
      {
        start: '1789451760000',
        open: '331.5',
        close: '331.6',
        high: '331.7',
        low: '331.4',
        volume: '12',
        turnover: '3979.2',
      },
    ],
    ts: 1789451774293,
  })
  assert.equal(published.length, 1)
  assert.equal(published[0].exchange, ExchangeEnum.bitget)
  assert.deepEqual(published[0].trade.k, {
    o: '331.5',
    h: '331.7',
    l: '331.4',
    c: '331.6',
    v: '3979.2',
    i: 'candle1m',
    t: 1789451760000,
  })
  // unknown symbol/interval and snapshots are ignored
  self.bitgetRealityCandleCb({
    action: 'snapshot',
    arg: { topic: 'kline', symbol: 'RAAPLUSDT', interval: '1m' },
    data: [{}],
  })
  self.bitgetRealityCandleCb({
    action: 'update',
    arg: { topic: 'kline', symbol: 'BTCUSDT', interval: '1m' },
    data: [{}],
  })
  assert.equal(published.length, 1)
})

test('spot candle requests route Reality symbols to v3 and the rest to v2', async () => {
  setBitgetRealitySymbols(['RAAPLUSDT'])
  const { self } = fake()
  const reality: string[] = []
  self.subscribeBitgetRealityCandle = (s: string, i: string) =>
    reality.push(`${s}:${i}`)
  await proto.connectBitgetCandleStreams.call(
    self,
    'RAAPLUSDT',
    'candle1m',
    'spot',
  )
  await proto.connectBitgetCandleStreams.call(
    self,
    'BTCUSDT',
    'candle1m',
    'spot',
  )
  assert.deepEqual(reality, ['RAAPLUSDT:candle1m'])
  assert.deepEqual(
    [...self.inQueueCandles.get('spot').keys()],
    ['BTCUSDT-candle1m-spot'],
  )
  clearTimeout(self.timer.get('spot'))
})
