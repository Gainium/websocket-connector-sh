/**
 * WhiteBit `candles_update` / `trades_update` parsing.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The column order WhiteBit pushes candles in is
 * `[time, open, close, high, low, volume_stock, volume_money, market]` —
 * open and close BEFORE high and low, the opposite of the o/h/l/c order every
 * other venue in this repo sends. A parser copied from another exchange
 * silently swaps close↔high and produces candles that still look plausible
 * (they only break when high < close), so the mapping is pinned here.
 *
 * The two channels also disagree about time units: candles carry integer
 * seconds, trades a float number of seconds. Both must land as epoch ms.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWhitebitCandleUpdate,
  parseWhitebitTradesUpdate,
  toWhitebitIntervalSeconds,
  whitebitExchangeForMarket,
  whitebitSideToOrderSide,
} from '../src/utils/whitebit'
import { ExchangeEnum } from '../src/utils/common'

test('candles_update maps open/close/high/low by index, not by o-h-l-c habit', () => {
  const params = [
    1700000100, // time, integer seconds
    '35000.1', // open
    '35400.9', // close
    '35500.5', // high
    '34900.2', // low
    '12.5', // volume_stock
    '441000.75', // volume_money
    'BTC_USDT',
  ]
  const [candle] = parseWhitebitCandleUpdate(params)
  assert.ok(candle, 'a documented candles_update row must parse')
  assert.equal(candle.market, 'BTC_USDT')
  assert.equal(candle.open, '35000.1')
  assert.equal(candle.close, '35400.9')
  assert.equal(candle.high, '35500.5')
  assert.equal(candle.low, '34900.2')
  assert.equal(candle.volume, '12.5')
  // Integer seconds → epoch ms.
  assert.equal(candle.start, 1700000100000)
  // The invariant a swapped mapping breaks.
  assert.ok(+candle.high >= +candle.close && +candle.high >= +candle.open)
  assert.ok(+candle.low <= +candle.close && +candle.low <= +candle.open)
})

test('a batched candles_update (array of rows) is not dropped', () => {
  const rows = [
    [1700000100, '1', '2', '3', '0.5', '10', '20', 'ETH_USDT'],
    [1700001000, '2', '4', '5', '1.5', '11', '21', 'ETH_USDT'],
  ]
  const candles = parseWhitebitCandleUpdate(rows)
  assert.equal(candles.length, 2)
  assert.deepEqual(
    candles.map((c) => [c.open, c.close, c.high, c.low]),
    [
      ['1', '2', '3', '0.5'],
      ['2', '4', '5', '1.5'],
    ],
  )
})

test('a malformed candles_update row yields nothing rather than a bad candle', () => {
  assert.deepEqual(parseWhitebitCandleUpdate([1, 2, 3]), [])
  assert.deepEqual(parseWhitebitCandleUpdate(null), [])
  assert.deepEqual(parseWhitebitCandleUpdate({}), [])
})

test('trades_update time is float SECONDS and converts to ms', () => {
  const parsed = parseWhitebitTradesUpdate([
    'BTC_USDT',
    [
      {
        id: 1,
        time: 1700000100.5,
        price: '35000.1',
        amount: '0.01',
        type: 'buy',
      },
      {
        id: 2,
        time: 1700000101.25,
        price: '35001.2',
        amount: '0.02',
        type: 'sell',
      },
    ],
  ])
  assert.ok(parsed)
  assert.equal(parsed.market, 'BTC_USDT')
  assert.equal(parsed.trades.length, 2)
  assert.equal(parsed.trades[0].time, 1700000100500)
  assert.equal(parsed.trades[1].time, 1700000101250)
  assert.equal(parsed.trades[0].side, 'buy')
  assert.equal(parsed.trades[1].side, 'sell')
})

test('the perp suffix picks the usdm variant, everything else is spot', () => {
  assert.equal(whitebitExchangeForMarket('BTC_PERP'), ExchangeEnum.whitebitUsdm)
  assert.equal(whitebitExchangeForMarket('BTC_USDT'), ExchangeEnum.whitebit)
})

test('interval strings map to WhiteBit integer seconds', () => {
  assert.equal(toWhitebitIntervalSeconds('15m'), 900)
  assert.equal(toWhitebitIntervalSeconds('1h'), 3600)
  assert.equal(toWhitebitIntervalSeconds('1d'), 86400)
  assert.equal(toWhitebitIntervalSeconds('1w'), 604800)
  // Bare-minutes form, the way a candle room can arrive.
  assert.equal(toWhitebitIntervalSeconds('240'), 14400)
  // Unsupported → null, so the caller skips instead of sending a value the
  // venue rejects on every reconnect.
  assert.equal(toWhitebitIntervalSeconds('7m'), null)
  assert.equal(toWhitebitIntervalSeconds(''), null)
})

test('numeric order side: 1 is SELL and 2 is BUY', () => {
  // Deliberately the opposite polarity to Kraken Futures' `direction`.
  assert.equal(whitebitSideToOrderSide(1), 'SELL')
  assert.equal(whitebitSideToOrderSide(2), 'BUY')
  assert.equal(whitebitSideToOrderSide('1'), 'SELL')
})
