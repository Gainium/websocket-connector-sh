/**
 * Kraken spot candles on the price connector are stamped with the bar's
 * opening time.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The v2 `ohlc` channel carries both `interval_begin` (the bar's opening time)
 * and `timestamp`, which is the bar's closing time — one interval later
 * (checked live on BTC/USDT 1h: `interval_begin` 18:00Z, `timestamp` 19:00Z).
 * Every consumer keys a bar by its opening time, so the candle must carry
 * `interval_begin`. Nothing here opens a socket: the callback runs against a
 * fake `this`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import KrakenConnector from '../src/price/kraken'
import { ExchangeEnum } from '../src/utils/common'

const proto = KrakenConnector.prototype as any

function fake() {
  const published: { trade: any; exchange: ExchangeEnum }[] = []
  const self: any = {
    spotSymbolMaps: { wsnameToNormalized: new Map([['BTC/USDT', 'BTCUSDT']]) },
    usdmSymbolMaps: { wsnameToNormalized: new Map() },
    cbWsTrade: (trade: any, exchange: ExchangeEnum) =>
      published.push({ trade, exchange }),
  }
  const cb = proto.krakenCandleCb.call(self, ExchangeEnum.kraken)
  return { cb, published }
}

const frame = {
  symbol: 'BTC/USDT',
  open: 80838.3,
  high: 81324,
  low: 80696.9,
  close: 81018.3,
  trades: 893,
  volume: 12.08499828,
  vwap: 80943.6,
  interval_begin: '2026-10-28T18:00:00.000000000Z',
  interval: 60,
  timestamp: '2026-10-28T19:00:00.000000Z',
}

test('a spot ohlc bar is stamped with interval_begin, not its closing timestamp', () => {
  const { cb, published } = fake()
  cb({ channel: 'ohlc', type: 'update', data: [frame] })
  assert.equal(published.length, 1)
  assert.equal(published[0].trade.s, 'BTCUSDT')
  assert.equal(published[0].trade.k.t, Date.parse('2026-10-28T18:00:00.000Z'))
})

test('without interval_begin, the opening time is timestamp minus the interval', () => {
  const { cb, published } = fake()
  const { interval_begin: _omit, ...noBegin } = frame
  cb({ channel: 'ohlc', type: 'update', data: [noBegin] })
  assert.equal(published[0].trade.k.t, Date.parse('2026-10-28T18:00:00.000Z'))
})
