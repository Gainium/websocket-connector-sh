/**
 * Regression coverage for spec 011 — the binanceUS candle stream is dialled on
 * the raw-stream path and 404s.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Nothing here opens a socket. `BinanceConnector` is built with
 * `Object.create` off its prototype (no constructor ⇒ no Redis/worker port),
 * its eight clients are replaced with recording fakes, and the real
 * `connectBinanceCandleStreams` is driven directly.
 *
 * The assertion is on the URL string the connector hands to `connectToWsUrl`:
 * the live venue answers 404 on `/ws/stream` and streams klines on `/stream`
 * (spec §1.3), so the string is the whole defect.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ExchangeEnum } from '../src/utils/common'
import logger from '../src/utils/logger'
import BinanceConnector from '../src/price/binance'

type AnyConnector = any

/** The eight clients the binance family worker owns, by field name. */
const CLIENT_FIELDS = [
  'binanceClient',
  'binanceClientUsdm',
  'binanceClientCoinm',
  'binanceClientUs',
  'binanceClientCandle',
  'binanceClientCandleUs',
  'binanceClientCandleUsdm',
  'binanceClientCandleCoinm',
] as const

type Fake = {
  field: string
  /** URLs passed to `connectToWsUrl`. */
  urls: string[]
  closed: number
  removeAllListeners: () => void
  closeAll: (x?: boolean) => void
  on: (ev: string, cb: unknown) => void
  connectToWsUrl: (url: string, key: string) => void
  getWsUrl: (key: string) => Promise<string>
}

function makeFake(field: string): Fake {
  const f: Fake = {
    field,
    urls: [],
    closed: 0,
    removeAllListeners: () => undefined,
    closeAll: () => {
      f.closed++
    },
    on: () => undefined,
    connectToWsUrl: (url: string) => {
      f.urls.push(url)
    },
    // Reproduces `binance@3.6.3` for a client constructed with
    // `settings.wsUrl = 'wss://stream.binance.us:9443/ws'`: the override is
    // returned and the SDK appends its own `/stream` suffix. Verified against
    // the real SDK in spec §1.2a.
    getWsUrl: async () => 'wss://stream.binance.us:9443/ws/stream',
  }
  return f
}

/**
 * A connector with every client faked and every gate set to "this worker
 * serves intl + US, tickers + candles".
 */
function buildConnector(): {
  c: AnyConnector
  fakes: Record<string, Fake>
  restore: () => void
} {
  const c: AnyConnector = Object.create(BinanceConnector.prototype)
  const fakes: Record<string, Fake> = {}
  for (const field of CLIENT_FIELDS) {
    fakes[field] = makeFake(field)
    c[field] = fakes[field]
  }
  c.isIntl = true
  c.isUs = true
  c.isCandle = false
  c.isAll = true
  c.wsReconnect = 3500
  c.mainData = {}
  c.binanceTimers = new Map()
  c.subscribedCandlesMap = new Map()

  const prevInfo = logger.info
  const prevError = logger.error
  logger.info = (() => undefined) as never
  logger.error = (() => undefined) as never
  return {
    c,
    fakes,
    restore: () => {
      logger.info = prevInfo
      logger.error = prevError
    },
  }
}

/**
 * Drive the real `connectBinanceCandleStreams` past its 5s debounce.
 * The first call only arms a timer (`execute` false) and returns, so the flag
 * is pre-seeded exactly as the timer callback would leave it.
 */
async function connectCandles(
  c: AnyConnector,
  exchange: ExchangeEnum,
  symbol: string,
  interval: string,
  us: boolean,
  futures?: 'coinm' | 'usdm',
) {
  c.subscribedCandlesMap.set(
    exchange,
    new Set([c.getCandleRoomName(symbol, exchange, interval)]),
  )
  c.binanceTimers.set(exchange, { timer: null, execute: true })
  await c.connectBinanceCandleStreams(us, futures)
}

test('spec 011 §2.1 — the binanceUS candle stream uses the combined /stream endpoint, not /ws/stream', async () => {
  const { c, fakes, restore } = buildConnector()
  try {
    await connectCandles(c, ExchangeEnum.binanceUS, 'BTCUSDT', '1m', true)

    const urls = fakes.binanceClientCandleUs.urls
    assert.equal(urls.length, 1, 'exactly one binanceUS candle socket opened')
    const url = urls[0]

    // The defect: `getWsUrl()` returns the `/ws` override plus the SDK's own
    // `/stream` suffix, and `?streams=` is then appended to that. The live
    // venue answers 404 (spec §1.3).
    assert.ok(
      !url.includes('/ws/stream'),
      `binanceUS candle URL must not use the raw-stream path; got ${url}`,
    )
    assert.ok(
      url.startsWith('wss://stream.binance.us:9443/stream?streams='),
      `binanceUS candle URL must be the combined-stream endpoint; got ${url}`,
    )
    assert.ok(
      url.endsWith('btcusdt@kline_1m'),
      `the multiplexed stream list must survive intact; got ${url}`,
    )
  } finally {
    restore()
  }
})

test('spec 011 §1.1a — every binance candle branch builds the same combined-stream shape', async () => {
  const cases: {
    exchange: ExchangeEnum
    field: string
    us: boolean
    futures?: 'coinm' | 'usdm'
    host: string
  }[] = [
    {
      exchange: ExchangeEnum.binance,
      field: 'binanceClientCandle',
      us: false,
      host: 'wss://stream.binance.com:9443/stream?streams=',
    },
    {
      exchange: ExchangeEnum.binanceCoinm,
      field: 'binanceClientCandleCoinm',
      us: false,
      futures: 'coinm',
      host: 'wss://dstream.binance.com/stream?streams=',
    },
    {
      exchange: ExchangeEnum.binanceUsdm,
      field: 'binanceClientCandleUsdm',
      us: false,
      futures: 'usdm',
      host: 'wss://fstream.binance.com/market/stream?streams=',
    },
    {
      exchange: ExchangeEnum.binanceUS,
      field: 'binanceClientCandleUs',
      us: true,
      host: 'wss://stream.binance.us:9443/stream?streams=',
    },
  ]

  for (const k of cases) {
    const { c, fakes, restore } = buildConnector()
    try {
      await connectCandles(c, k.exchange, 'ETHUSDT', '5m', k.us, k.futures)
      const urls = fakes[k.field].urls
      assert.equal(urls.length, 1, `${k.exchange}: one socket`)
      assert.equal(
        urls[0],
        `${k.host}ethusdt@kline_5m`,
        `${k.exchange}: combined-stream URL`,
      )
    } finally {
      restore()
    }
  }
})
