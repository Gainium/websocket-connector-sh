/**
 * Regression coverage for spec 014 — Binance candle sockets are dialled through
 * the SDK's private `connectToWsUrl()`, which never registers them, so
 * `closeAll()` closes nothing and every re-dial leaks a live stream.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Nothing here opens a socket. `BinanceConnector` is built with `Object.create`
 * off its prototype (no constructor ⇒ no Redis/worker port) and its eight
 * clients are replaced with fakes whose `connectToWsUrl` returns a fake socket
 * — the same shape the real SDK returns, minus the network. The assertions are
 * on what happens to those sockets, which is the whole defect.
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

/**
 * Stands in for the raw `ws` socket `connectToWsUrl` returns. Records what the
 * connector does to it: the SDK wires `onopen`/`onmessage`/`onerror`/`onclose`
 * on every socket it builds, so "were those detached before close" is
 * observable here exactly as it is on the real thing (spec §3.3d).
 */
type FakeSocket = {
  url: string
  readyState: number
  closeCalls: number
  onopen: unknown
  onmessage: unknown
  onerror: unknown
  onclose: unknown
  listeners: Record<string, ((...a: unknown[]) => void)[]>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  emit: (ev: string) => void
  close: () => void
}

function makeSocket(url: string): FakeSocket {
  const ws: FakeSocket = {
    url,
    readyState: 1,
    closeCalls: 0,
    onopen: () => undefined,
    onmessage: () => undefined,
    onerror: () => undefined,
    onclose: () => undefined,
    listeners: {},
    on: (ev, cb) => {
      ws.listeners[ev] = [...(ws.listeners[ev] ?? []), cb]
    },
    emit: (ev) => {
      ;(ws.listeners[ev] ?? []).forEach((cb) => cb())
    },
    close: () => {
      ws.closeCalls++
      ws.readyState = 2
    },
  }
  return ws
}

type Fake = {
  field: string
  /** Sockets handed back by `connectToWsUrl`, in dial order. */
  sockets: FakeSocket[]
  /** `closeAll()` calls — the SDK-side teardown, which must still happen. */
  closed: number
  removeAllListeners: () => void
  closeAll: (x?: boolean) => void
  on: (ev: string, cb: unknown) => void
  connectToWsUrl: (url: string, key: string) => FakeSocket
  getWsUrl: (key: string) => Promise<string>
}

function makeFake(field: string): Fake {
  const f: Fake = {
    field,
    sockets: [],
    closed: 0,
    removeAllListeners: () => undefined,
    closeAll: () => {
      f.closed++
    },
    on: () => undefined,
    // Reproduces `binance@3.6.3`: the socket is built and returned, and
    // NOTHING registers it in the SDK's wsStore (spec §2.2). `closeAll()`
    // therefore cannot reach it — which is why `f.closeAll` deliberately does
    // not touch `f.sockets`.
    connectToWsUrl: (url: string) => {
      const ws = makeSocket(url)
      f.sockets.push(ws)
      return ws
    },
    getWsUrl: async () => 'wss://stream.binance.us:9443/ws/stream',
  }
  return f
}

function buildConnector(): {
  c: AnyConnector
  fakes: Record<string, Fake>
  logged: string[]
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

  const logged: string[] = []
  const prevInfo = logger.info
  const prevError = logger.error
  logger.info = ((m: string) => {
    logged.push(`${m}`)
  }) as never
  logger.error = ((m: string) => {
    logged.push(`${m}`)
  }) as never
  return {
    c,
    fakes,
    logged,
    restore: () => {
      logger.info = prevInfo
      logger.error = prevError
    },
  }
}

/**
 * Drive the real `connectBinanceCandleStreams` past its 5s debounce, with
 * `count` subscribed streams (200 per chunk ⇒ one socket per chunk).
 */
async function connectCandles(
  c: AnyConnector,
  exchange: ExchangeEnum,
  count: number,
  us: boolean,
  futures?: 'coinm' | 'usdm',
) {
  const rooms = new Set<string>()
  for (let i = 0; i < count; i++) {
    rooms.add(c.getCandleRoomName(`SYM${i}USDT`, exchange, '1m'))
  }
  c.subscribedCandlesMap.set(exchange, rooms)
  c.binanceTimers.set(exchange, { timer: null, execute: true })
  await c.connectBinanceCandleStreams(us, futures)
}

const BRANCHES: {
  exchange: ExchangeEnum
  field: string
  us: boolean
  futures?: 'coinm' | 'usdm'
}[] = [
  { exchange: ExchangeEnum.binance, field: 'binanceClientCandle', us: false },
  {
    exchange: ExchangeEnum.binanceCoinm,
    field: 'binanceClientCandleCoinm',
    us: false,
    futures: 'coinm',
  },
  {
    exchange: ExchangeEnum.binanceUsdm,
    field: 'binanceClientCandleUsdm',
    us: false,
    futures: 'usdm',
  },
  {
    exchange: ExchangeEnum.binanceUS,
    field: 'binanceClientCandleUs',
    us: true,
  },
]

test('spec 014 §1.1a/§1.1b — closeBinanceCandleStream closes every socket the branch dialled', async () => {
  for (const b of BRANCHES) {
    const { c, fakes, restore } = buildConnector()
    try {
      await connectCandles(c, b.exchange, 3, b.us, b.futures)
      const sockets = fakes[b.field].sockets
      assert.equal(sockets.length, 1, `${b.exchange}: one socket dialled`)
      assert.equal(sockets[0].readyState, 1, `${b.exchange}: socket is open`)

      await c.closeBinanceCandleStream(b.us, b.futures)

      assert.equal(
        sockets[0].closeCalls,
        1,
        `${b.exchange}: the dialled socket must actually be closed`,
      )
      assert.notEqual(
        sockets[0].readyState,
        1,
        `${b.exchange}: the socket must leave readyState OPEN`,
      )
      // §3.3e — the SDK-side teardown is still performed. Twice: once by
      // `connectBinanceCandleStreams` before it dials, once by the explicit
      // call above.
      assert.equal(
        fakes[b.field].closed,
        2,
        `${b.exchange}: closeAll() is still called on the client`,
      )
    } finally {
      restore()
    }
  }
})

test('spec 014 §3.3d — the SDK handlers are detached before the socket is closed', async () => {
  const { c, fakes, restore } = buildConnector()
  try {
    await connectCandles(c, ExchangeEnum.binance, 3, false)
    const ws = fakes.binanceClientCandle.sockets[0]
    await c.closeBinanceCandleStream(false)

    // A socket torn down with its handlers still attached publishes during the
    // close handshake (`onmessage`), can raise an `exception` into
    // `binanceErrorCb` (`onerror`) — which spec 013 answers with a full family
    // restart — and trips the SDK's unintentional-close recovery (`onclose`).
    assert.equal(ws.onmessage, null, 'onmessage detached')
    assert.equal(ws.onerror, null, 'onerror detached')
    assert.equal(ws.onclose, null, 'onclose detached')
    assert.equal(ws.onopen, null, 'onopen detached')
  } finally {
    restore()
  }
})

test('spec 014 §1.1c — re-dialling replaces the branch sockets instead of adding to them', async () => {
  const { c, fakes, restore } = buildConnector()
  try {
    c.subscribedCandlesMap.set(
      ExchangeEnum.binance,
      new Set([c.getCandleRoomName('BTCUSDT', ExchangeEnum.binance, '1m')]),
    )
    for (let run = 0; run < 3; run++) {
      c.binanceTimers.set(ExchangeEnum.binance, { timer: null, execute: true })
      await c.connectBinanceCandleStreams(false)
    }
    // Three full dial cycles: each must have closed what the previous left.
    const sockets = fakes.binanceClientCandle.sockets
    assert.equal(sockets.length, 3, 'three dial cycles ⇒ three sockets dialled')
    const stillOpen = sockets.filter((s) => s.readyState === 1)
    assert.ok(
      stillOpen.length <= 1,
      `at most the newest dial stays open; ${stillOpen.length} of ${sockets.length} are still open`,
    )
  } finally {
    restore()
  }
})

test('spec 014 §1.1d — stopBinance leaves no socket of the outgoing candle clients running', async () => {
  const { c, fakes, restore } = buildConnector()
  try {
    for (const b of BRANCHES) {
      await connectCandles(c, b.exchange, 3, b.us, b.futures)
    }
    const dialled = BRANCHES.flatMap((b) => fakes[b.field].sockets)
    assert.equal(dialled.length, 4, 'one candle socket per branch')

    c.stopBinance()

    for (const ws of dialled) {
      assert.notEqual(ws.readyState, 1, `stopBinance must close ${ws.url}`)
    }
  } finally {
    restore()
  }
})

test('spec 014 §3.3f — chunking is unchanged: every 200-stream chunk still gets its own socket', async () => {
  const { c, fakes, restore } = buildConnector()
  try {
    await connectCandles(c, ExchangeEnum.binance, 450, false)
    const sockets = fakes.binanceClientCandle.sockets
    assert.equal(sockets.length, 3, '450 streams ⇒ 200 + 200 + 50')
    assert.ok(
      sockets.every((s) =>
        s.url.startsWith('wss://stream.binance.com:9443/stream?streams='),
      ),
      'every chunk keeps the combined-stream URL shape',
    )
    const streams = sockets.flatMap(
      (s) => s.url.split('?streams=')[1]?.split('/') ?? [],
    )
    assert.equal(streams.length, 450, 'no stream is dropped across the chunks')
    assert.equal(new Set(streams).size, 450, 'no stream is duplicated')
  } finally {
    restore()
  }
})

test('spec 014 §3.3g/§1.3 — an opened line is logged per dialled candle socket', async () => {
  const { c, fakes, logged, restore } = buildConnector()
  try {
    await connectCandles(c, ExchangeEnum.binance, 450, false)
    // The SDK emits `open` on the socket; the connector must report it, since
    // `connectToWsUrl` never drives the client-level `open` event (spec §1.3).
    fakes.binanceClientCandle.sockets.forEach((s) => s.emit('open'))
    const opened = logged.filter((l) => l.includes('BINANCE candle opened'))
    assert.equal(opened.length, 3, 'one opened line per chunk')
  } finally {
    restore()
  }
})
